import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'node:http';

// A time-range REPORT leaves out recurring objects on servers that expand
// them wrongly (#129). The server below answers a time-range query the way
// SabreDAV 4.7.1 / vobject 4.6.1 (Baïkal 0.12.1) was measured to:
//  - RRULE together with RDATE: only DTSTART and the RDATEs are instances;
//  - RDATE without RRULE: only the first instance (the stored last
//    occurrence is its end);
//  - an override stored before the master: only the override's own span.
// Property filters without a time range it evaluates on the stored text, as
// SabreDAV does. The tools must list what the series really holds.
const { tsdavManager } = await import('../src/tsdav-client.js');
const { calendarQuery } = await import('../src/tools/calendar/calendar-query.js');
const { listEvents } = await import('../src/tools/calendar/list-events.js');
const { freeBusyQuery } = await import('../src/tools/calendar/freebusy-query.js');

const CALENDAR = '/calendars/user/work/';
const WEEK = 7 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

const ical = (...vevents) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
  ...vevents.flatMap((lines) => ['BEGIN:VEVENT', 'DTSTAMP:20261101T000000Z', ...lines, 'END:VEVENT']),
  'END:VCALENDAR', '',
].join('\r\n');

// Weekly Mondays at 09:00 UTC from 2 Nov 2026, ten of them
const WEEKLY = ['DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=10'];

const OBJECTS = {
  'plain.ics': ical(['UID:plain', ...WEEKLY, 'SUMMARY:Plain weekly']),
  'rrule-rdate.ics': ical(['UID:rrule-rdate', ...WEEKLY, 'RDATE:20261205T090000Z', 'SUMMARY:Weekly with extra date']),
  'rdate-only.ics': ical(['UID:rdate-only', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z',
    'RDATE:20261123T090000Z,20261210T090000Z', 'SUMMARY:Extra dates only']),
  'override-first.ics': ical(
    ['UID:override-first', 'RECURRENCE-ID:20261109T090000Z', 'DTSTART:20261109T130000Z', 'DTEND:20261109T140000Z', 'SUMMARY:Override first (moved)'],
    ['UID:override-first', ...WEEKLY, 'SUMMARY:Override first']),
  'single.ics': ical(['UID:single', 'DTSTART:20261116T120000Z', 'DTEND:20261116T130000Z', 'SUMMARY:Single lunch']),
  'finished.ics': ical(['UID:finished', 'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z',
    'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Finished series']),
  // matches the RRULE filter on the server, but cannot be read
  'broken.ics': 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Broken series\r\n',
};

const utc = (text) => Date.UTC(+text.slice(0, 4), +text.slice(4, 6) - 1, +text.slice(6, 8),
  +text.slice(9, 11), +text.slice(11, 13), +text.slice(13, 15));
const value = (lines, name) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1);

/** The instances SabreDAV 4.7.1 answers a time-range query with, [start, end] in ms */
function sabreInstances(data) {
  const first = data.split('BEGIN:VEVENT\r\n')[1].split('END:VEVENT')[0].split('\r\n');
  const start = utc(value(first, 'DTSTART'));
  const length = utc(value(first, 'DTEND')) - start;
  const rdates = value(first, 'RDATE')?.split(',').map(utc) ?? [];
  const rrule = value(first, 'RRULE');
  let starts = [start];
  if (rrule && rdates.length) starts = [start, ...rdates];
  else if (rrule) {
    const count = Number(/COUNT=(\d+)/.exec(rrule)[1]);
    starts = Array.from({ length: count }, (_, k) => start + k * WEEK);
  }
  return starts.map((s) => [s, s + length]);
}

const multistatus = (responses) =>
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">' +
  `${responses}</d:multistatus>`;
const response = (href, prop) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function davServer() {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://local').pathname;
      const xml = (responses) => {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(multistatus(responses));
      };
      if (path.startsWith('/.well-known/')) { res.writeHead(404); return res.end(); }
      if (body.includes('current-user-principal')) {
        return xml(response(path, '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'));
      }
      if (body.includes('calendar-home-set')) {
        return xml(response(path, '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>'));
      }
      if (req.method === 'PROPFIND' && path === '/calendars/user/') {
        return xml(response(CALENDAR,
          '<d:displayname>Work</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>' +
          '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>'));
      }
      if (req.method === 'REPORT' && path === CALENDAR) {
        const etagOnly = (names) => xml(names.map((name) => response(`${CALENDAR}${name}`, '<d:getetag>"1"</d:getetag>')).join(''));
        if (body.includes('calendar-multiget')) {
          const names = [...body.matchAll(/<(?:\w+:)?href>([^<]+)</g)].map((m) => m[1].split('/').pop());
          log.push({ kind: 'multiget', names });
          return xml(names.map((name) => response(`${CALENDAR}${name}`,
            `<d:getetag>"1"</d:getetag><cal:calendar-data>${escape(OBJECTS[name])}</cal:calendar-data>`)).join(''));
        }
        const range = /time-range start="(\w+)" end="(\w+)"/.exec(body);
        const property = /prop-filter name="([\w-]+)"/.exec(body)?.[1];
        if (range) {
          const [from, to] = [utc(range[1]), utc(range[2])];
          const names = server.correctAnswer ? server.correctAnswer() : Object.keys(OBJECTS).filter((name) => {
            try {
              return sabreInstances(OBJECTS[name]).some(([s, e]) => s < to && e > from);
            } catch {
              return false;
            }
          });
          log.push({ kind: 'range', names });
          return etagOnly(names);
        }
        if (property) {
          log.push({ kind: 'property', property });
          if (server.extra === 'refuse') { res.writeHead(501); return res.end(); }
          if (server.extra === 'drop') return req.socket.destroy();
          const pattern = new RegExp(`\\r\\n${property}[:;]`);
          return etagOnly(Object.keys(OBJECTS).filter((name) => pattern.test(OBJECTS[name])));
        }
        log.push({ kind: 'all' });
        if (server.extra === 'drop') return req.socket.destroy();
        return etagOnly(Object.keys(OBJECTS));
      }
      if (req.method === 'PROPFIND' || req.method === 'REPORT') return xml('');
      res.writeHead(404);
      res.end();
    });
  });
  return {
    server,
    log,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.origin = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

const text = (result) => result.content[0].text;
const range = (start, end) => ({ time_range_start: start, time_range_end: end });

describe('a server whose time-range answer leaves out recurring events (#129)', () => {
  let dav;
  beforeAll(async () => {
    dav = await davServer().start();
    await tsdavManager.initialize({ serverUrl: `${dav.origin}/`, authMethod: 'Basic', username: 'user', password: 'secret' });
  });
  afterAll(() => dav.stop());
  beforeEach(() => {
    dav.log.length = 0;
    dav.server.extra = 'answer';
  });

  test('the stand-in really under-reports: its range answer for 16 Nov holds only the plain series and the single event', async () => {
    const [calendar] = await tsdavManager.getCalDavClient().fetchCalendars();
    const found = await tsdavManager.getCalDavClient().fetchCalendarObjects({
      calendar, timeRange: { start: '2026-11-16T00:00:00Z', end: '2026-11-17T00:00:00Z' },
    });
    expect(found.map((o) => o.url.split('/').pop()).sort()).toEqual(['plain.ics', 'single.ics']);
  });

  test('calendar_query lists every series with an occurrence in the range', async () => {
    const result = text(await calendarQuery.handler(range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z')));
    expect(result).toContain('Plain weekly');
    expect(result).toContain('Weekly with extra date');
    expect(result).toContain('Override first');
    expect(result).toContain('Single lunch');
    // no occurrence on 16 Nov, and a broken object the server did not place in the range
    expect(result).not.toContain('Extra dates only');
    expect(result).not.toContain('Finished series');
    // a broken object only the extra queries found is reported, not dropped
    expect(result).toMatch(/Not checked: \*\*1\*\*[\s\S]*broken\.ics/);
    expect(result).not.toContain('### 5.');
  });

  test('list_events finds an extra date of a series without a rule', async () => {
    const result = text(await listEvents.handler({
      calendar_url: `${dav.origin}${CALENDAR}`, ...range('2026-11-23T00:00:00Z', '2026-11-24T00:00:00Z'),
    }));
    expect(result).toContain('Extra dates only');
    expect(result).toContain('Plain weekly');
    expect(result).toContain('Weekly with extra date');
    expect(result).toContain('Override first');
  });

  test('freebusy_query counts an occurrence the range answer left out as busy', async () => {
    const result = text(await freeBusyQuery.handler({
      ...range('2026-12-10T08:00:00Z', '2026-12-10T12:00:00Z'), include_event_details: true,
    }));
    expect(result).toContain('### Busy (1)');
    expect(result).toContain('Extra dates only');
  });

  test('a series moved earlier by an override stored first is busy every week, not only at the override', async () => {
    const result = text(await freeBusyQuery.handler({
      ...range('2026-11-30T08:00:00Z', '2026-11-30T12:00:00Z'), include_event_details: true,
    }));
    expect(result).toContain('Override first');
  });

  test('costs one range query, the three property queries, and one multiget of what the range answer lacked', async () => {
    await calendarQuery.handler(range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z'));
    expect(dav.log.filter((r) => r.kind === 'range')).toHaveLength(1);
    expect(dav.log.filter((r) => r.kind === 'property').map((r) => r.property).sort()).toEqual(['RDATE', 'RECURRENCE-ID', 'RRULE']);
    const multigets = dav.log.filter((r) => r.kind === 'multiget').map((r) => r.names.sort());
    expect(multigets).toEqual([
      ['plain.ics', 'single.ics'], // the range answer
      ['broken.ics', 'finished.ics', 'override-first.ics', 'rdate-only.ics', 'rrule-rdate.ics'], // every other recurring object, once
    ]);
  });

  test('a failure of the extra queries leaves the range answer standing, with a note per calendar', async () => {
    dav.server.extra = 'drop';
    const result = text(await calendarQuery.handler(range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z')));
    expect(result).toContain('Plain weekly');
    expect(result).toContain('Single lunch');
    expect(result).toMatch(/Not checked: \*\*1\*\*[\s\S]*calendars\/user\/work\/ — its recurring events could not be fetched/);
    const busy = text(await freeBusyQuery.handler(range('2026-11-16T08:00:00Z', '2026-11-16T12:00:00Z')));
    expect(busy).toContain('### Busy (1)');
    expect(busy).toContain('**Warning**: incomplete');
  });

  test('a server that refuses property filters is asked for all its events instead, and the listing stays complete', async () => {
    dav.server.extra = 'refuse';
    const result = text(await calendarQuery.handler(range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z')));
    expect(dav.log.some((r) => r.kind === 'all')).toBe(true);
    expect(result).toContain('Weekly with extra date');
    expect(result).toContain('Override first');
    expect(result).not.toContain('Finished series');
  });
});

// Extra objects must never cost what the server's own answer needs (review
// of #170): a correct server returns only a series that is expensive to
// expand (Friday the 13th, walked month by month from 1990), and the extra
// queries bring many yearly series that are out of range.
describe('extra recurring objects do not take expansion budget from the range answer', () => {
  let dav;
  const saved = { ...OBJECTS };
  const friday13 = ical(['UID:f13', 'DTSTART:19900713T090000Z', 'DURATION:PT1H',
    'RRULE:FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', 'SUMMARY:Friday the 13th']);
  const birthdays = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const month = String(1 + (i % 9)).padStart(2, '0');
    const day = String(1 + (i % 28)).padStart(2, '0');
    return [`b${i}.ics`, ical([`UID:b${i}`, `DTSTART;VALUE=DATE:1980${month}${day}`, 'RRULE:FREQ=YEARLY', `SUMMARY:Birthday ${i}`])];
  }));
  const use = (objects) => {
    for (const name of Object.keys(OBJECTS)) delete OBJECTS[name];
    Object.assign(OBJECTS, objects);
  };

  beforeAll(async () => {
    dav = await davServer().start();
    // a correct server: the range answer is the one series in the range
    dav.server.correctAnswer = () => ['f13.ics'];
    await tsdavManager.initialize({ serverUrl: `${dav.origin}/`, authMethod: 'Basic', username: 'user', password: 'secret' });
  });
  afterAll(async () => {
    use(saved);
    await dav.stop();
  });

  test.each([300, 5000])('with %i yearly series out of range, Friday the 13th is still listed and busy', async (count) => {
    use({ 'f13.ics': friday13, ...birthdays(count) });
    const started = Date.now();
    const listed = text(await calendarQuery.handler(range('2026-11-13T00:00:00Z', '2026-11-14T00:00:00Z')));
    expect(listed).toContain('Friday the 13th');
    expect(listed).not.toMatch(/Friday the 13th[\s\S]*incomplete/);
    const busy = text(await freeBusyQuery.handler(range('2026-11-13T08:00:00Z', '2026-11-13T12:00:00Z')));
    expect(busy).toContain('### Busy (1)');
    // the extra objects' expansion is bounded by their own pool, not by their number
    expect(Date.now() - started).toBeLessThan(count > 1000 ? 30000 : 10000);
  }, 60000);

  test('series whose bounds rule the range out are dropped before any expansion', async () => {
    use({
      'f13.ics': friday13,
      'ended.ics': ical(['UID:ended', 'DTSTART:20200106T090000Z', 'DTEND:20200106T100000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20200301T000000Z', 'SUMMARY:Ended by UNTIL']),
      'counted.ics': ical(['UID:counted', 'DTSTART:20200106T090000Z', 'DTEND:20200106T100000Z', 'RRULE:FREQ=DAILY;COUNT=30', 'SUMMARY:Ended by COUNT']),
      'later.ics': ical(['UID:later', 'DTSTART:20300106T090000Z', 'DTEND:20300106T100000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Starts later']),
    });
    const { resetExpansionWork, expansionWork } = await import('../src/occurrences.js');
    const [calendar] = await tsdavManager.getCalDavClient().fetchCalendars();
    const { fetchRangeCandidates, isRangeExtra } = await import('../src/tools/shared/range-candidates.js');
    resetExpansionWork();
    const { objects } = await fetchRangeCandidates(tsdavManager.getCalDavClient(), calendar,
      { start: '2026-11-13T00:00:00Z', end: '2026-11-14T00:00:00Z' });
    expect(objects.filter(isRangeExtra)).toHaveLength(0);
    expect(expansionWork.calls).toBe(0);
  });
});

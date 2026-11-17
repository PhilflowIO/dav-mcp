import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');

// freebusy_query read only VEVENTs, so busy time a calendar stores as
// VFREEBUSY (published by another system) was reported as free. RFC 4791 7.10
// counts its FREEBUSY periods, by their FBTYPE (#111).

const FREEBUSY = 'https://dav.example.com/calendars/user/freebusy/';
const OPEN = 'https://dav.example.com/calendars/user/open/';
const EVENTS = 'https://dav.example.com/calendars/user/events/';

const { calendarTimezoneValue } = await import('../src/calendar-zone.js');

let calendars;
let stored;
let events;
// how the server answers the stored free/busy query: 'refuse' (a DAV
// error), 'ignore-filter' (the events again), or normally
let storedQuery;
// recurring events the range answer leaves out; found by the property listing
let recurring;
const fetchCalendarObjects = jest.fn(async ({ calendar, filters, objectUrls }) => {
  if (objectUrls) return (recurring[calendar.url] ?? []).filter((object) => objectUrls.includes(object.url));
  const isStored = filters?.[0]?.['comp-filter']?.['comp-filter']?._attributes?.name === 'VFREEBUSY';
  if (isStored && storedQuery === 'refuse') throw new Error('REPORT returned 501 Not Implemented');
  if (isStored && storedQuery === 'ignore-filter') {
    return [...(events[calendar.url] ?? []), ...(recurring[calendar.url] ?? []), ...(stored[calendar.url] ?? [])];
  }
  return (isStored ? stored : events)[calendar.url] ?? [];
});

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    // calendarQuery: the recurring-object listing (range-candidates.js) finds
    // nothing beyond the range answer
    getCalDavClient: () => ({ fetchCalendars: async () => calendars, fetchCalendarObjects, calendarQuery: async ({ url }) => (recurring[url] ?? []).map((object) => ({ href: object.url })) }),
    getCardDavClient: () => ({}),
  },
}));

const { freeBusyQuery } = await import('../src/tools/calendar/freebusy-query.js');

const calendarObject = (name, lines) => ({
  url: `${FREEBUSY}${name}.ics`,
  etag: '"1"',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n'),
});
const freebusy = (name, ...lines) => calendarObject(name, [
  'BEGIN:VFREEBUSY', `UID:${name}@test`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VFREEBUSY',
]);
const event = (name, start, end) => calendarObject(name, [
  'BEGIN:VEVENT', `UID:${name}@test`, 'DTSTAMP:20260101T000000Z', `SUMMARY:${name}`,
  `DTSTART:${start}`, `DTEND:${end}`, 'END:VEVENT',
]);

const WINDOW = { time_range_start: '2026-05-25T09:00:00Z', time_range_end: '2026-05-25T17:00:00Z' };
const call = async (args = {}) => (await freeBusyQuery.handler({
  ...WINDOW,
  calendar_url: FREEBUSY,
  ...args,
})).content[0].text;
const section = (output, title) => (output.split(`### ${title}`)[1] ?? '').split('\n### ')[0];
// the busy lines as "10:00-11:00" or "10:00-11:00 BUSY-TENTATIVE", 24h UTC
const busyLines = (output) => section(output, 'Busy').split('\n').filter((line) => line.startsWith('- '))
  .map((line) => {
    const [from, to] = [...line.matchAll(/(\d\d):(\d\d) ([AP]M)/g)].map(([, h, m, half]) =>
      `${String((Number(h) % 12) + (half === 'PM' ? 12 : 0)).padStart(2, '0')}:${m}`);
    const type = line.match(/— (\S+)$/)?.[1];
    return type ? `${from}-${to} ${type}` : `${from}-${to}`;
  });

beforeEach(() => {
  fetchCalendarObjects.mockClear();
  calendars = [
    { url: FREEBUSY, displayName: 'Free/busy', components: ['VEVENT', 'VFREEBUSY'], timezone: calendarTimezoneValue('UTC').text },
    { url: OPEN, displayName: 'Any component', components: [] },
    { url: EVENTS, displayName: 'Events', components: ['VEVENT', 'VTODO'] },
  ];
  stored = {};
  events = {};
  storedQuery = null;
  recurring = {};
});

describe('the stored free/busy query', () => {
  test('asks for VFREEBUSY, without a time-range, where a calendar can hold them', async () => {
    await freeBusyQuery.handler(WINDOW);
    const byCalendar = (url) => fetchCalendarObjects.mock.calls.map(([options]) => options)
      .filter((options) => options.calendar.url === url);
    // told apart by what they ask for, not by the order they are sent in
    const asksFor = (options, name) => options.filters?.[0]?.['comp-filter']?.['comp-filter']?._attributes?.name === name;
    const storedQueries = (url) => byCalendar(url).filter((options) => asksFor(options, 'VFREEBUSY'));
    const rangeQueries = (url) => byCalendar(url).filter((options) => options.timeRange);

    // the one that names VFREEBUSY and the one that names no types (RFC 4791 5.2.3)
    for (const url of [FREEBUSY, OPEN]) {
      expect(rangeQueries(url)).toHaveLength(1);
      expect(rangeQueries(url)[0].filters).toBeUndefined();
      expect(storedQueries(url)).toHaveLength(1);
      expect(storedQueries(url)[0].filters).toEqual([{
        'comp-filter': { _attributes: { name: 'VCALENDAR' }, 'comp-filter': { _attributes: { name: 'VFREEBUSY' } } },
      }]);
      expect(storedQueries(url)[0].timeRange).toBeUndefined();
    }
    // one that leaves VFREEBUSY out costs no stored query
    expect(storedQueries(EVENTS)).toHaveLength(0);
    expect(rangeQueries(EVENTS)).toHaveLength(1);
  });
});

describe('stored VFREEBUSY periods', () => {
  test('a period without FBTYPE is busy, a FREE one is not', async () => {
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY:20260525T100000Z/20260525T110000Z',
      'FREEBUSY;FBTYPE=FREE:20260525T130000Z/20260525T140000Z')];
    const output = await call();
    expect(busyLines(output)).toEqual(['10:00-11:00']);
    expect(section(output, 'Free')).toContain('(6h)');
  });

  test('tentative and unavailable periods are reported with their type', async () => {
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260525T100000Z/20260525T110000Z',
      'FREEBUSY;FBTYPE=busy-unavailable:20260525T120000Z/20260525T130000Z',
      'FREEBUSY;FBTYPE=BUSY:20260525T140000Z/20260525T150000Z')];
    expect(busyLines(await call())).toEqual([
      '10:00-11:00 BUSY-TENTATIVE', '12:00-13:00 BUSY-UNAVAILABLE', '14:00-15:00',
    ]);
  });

  test('an unknown FBTYPE is busy (RFC 5545 3.2.9)', async () => {
    stored[FREEBUSY] = [freebusy('published', 'FREEBUSY;FBTYPE=X-OUT-OF-OFFICE:20260525T100000Z/20260525T110000Z')];
    expect(busyLines(await call())).toEqual(['10:00-11:00']);
  });

  test('several periods in one value, given as start/end and start/duration', async () => {
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260525T100000Z/PT30M,20260525T120000Z/20260525T123000Z,20260525T150000Z/PT1H15M')];
    expect(busyLines(await call())).toEqual([
      '10:00-10:30 BUSY-TENTATIVE', '12:00-12:30 BUSY-TENTATIVE', '15:00-16:15 BUSY-TENTATIVE',
    ]);
  });

  test('periods are clipped to the window and ones outside it are left out', async () => {
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY:20260525T070000Z/20260525T093000Z,20260525T163000Z/PT2H',
      'FREEBUSY:20260525T050000Z/20260525T090000Z,20260525T170000Z/PT1H')];
    expect(busyLines(await call())).toEqual(['09:00-09:30', '16:30-17:00']);
  });

  test('a period without Z is read in the calendar\'s zone', async () => {
    calendars[0].timezone = calendarTimezoneValue('Europe/Berlin').text;
    // 12:00 in Berlin (summer time) is 10:00 UTC; shown in the calendar's zone
    stored[FREEBUSY] = [freebusy('published', 'FREEBUSY:20260525T120000/20260525T130000')];
    const output = await call();
    expect(section(output, 'Busy')).toMatch(/12:00 PM.*→.*01:00 PM/);
    expect(section(output, 'Free')).toMatch(/11:00 AM.*→.*12:00 PM/);
  });

  test('merged with event busy time, the stronger type holds where they overlap', async () => {
    events[FREEBUSY] = [event('Meeting', '20260525T100000Z', '20260525T110000Z')];
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260525T103000Z/20260525T120000Z',
      // touching the meeting, with the same type: one block
      'FREEBUSY:20260525T090000Z/20260525T100000Z')];
    expect(busyLines(await call())).toEqual(['09:00-11:00', '11:00-12:00 BUSY-TENTATIVE']);
  });

  test('event details name the stored objects behind the busy blocks', async () => {
    events[FREEBUSY] = [event('Meeting', '20260525T100000Z', '20260525T110000Z')];
    stored[FREEBUSY] = [
      freebusy('published', 'FREEBUSY:20260525T140000Z/PT1H'),
      freebusy('elsewhere', 'FREEBUSY:20260526T140000Z/PT1H'),
    ];
    const output = await call({ include_event_details: true });
    expect(section(output, 'Events behind the busy blocks')).toContain('Meeting');
    const behind = section(output, 'Stored free/busy behind the busy blocks');
    expect(behind).toContain(`${FREEBUSY}published.ics`);
    expect(behind).not.toContain('elsewhere');
  });

  test('BUSY-UNAVAILABLE outranks an event over it (RFC 5545 3.2.9)', async () => {
    events[FREEBUSY] = [event('Meeting', '20260525T113000Z', '20260525T120000Z')];
    stored[FREEBUSY] = [freebusy('published', 'FREEBUSY;FBTYPE=BUSY-UNAVAILABLE:20260525T110000Z/20260525T130000Z')];
    expect(busyLines(await call())).toEqual(['11:00-13:00 BUSY-UNAVAILABLE']);
  });

  test('a period that cannot be read leaves the others counted and the answer incomplete', async () => {
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY:20260525T100000Z/PT1H,garbage,20260525T120000Z/20260525T110000Z,20260525T140000Z/PT1H')];
    const output = await call();
    expect(busyLines(output)).toEqual(['10:00-11:00', '14:00-15:00']);
    expect(output).toContain('**Warning**: incomplete — stored free/busy in an object cannot be read in full');
    expect(output).toContain(`- ${FREEBUSY}published.ics: 2 FREEBUSY periods cannot be read`);
    expect(output).not.toContain('an event could not be read');
  });

  test('a very large object is read whole', async () => {
    // 150,000 back-to-back one-minute periods, about 104 days: one busy block
    const minute = 60000;
    const first = Date.UTC(2026, 0, 1);
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
    const values = Array.from({ length: 150000 }, (_, i) => `${stamp(first + i * minute)}/PT1M`);
    stored[FREEBUSY] = [freebusy('published', `FREEBUSY:${values.join(',')}`)];
    const output = await call({ time_range_start: '2026-01-01T00:00:00Z', time_range_end: '2026-06-01T00:00:00Z' });
    expect(output).toContain('### Busy (1)');
    expect(section(output, 'Busy')).toMatch(/January 1, 2026.*→ April 15, 2026, 04:00 AM/);
    expect(output).not.toContain('incomplete');
  });
});

describe('stored VFREEBUSY read as RFC 5545 content lines', () => {
  const lines = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...body, 'END:VCALENDAR'];
  const raw = (name, data) => ({ url: `${FREEBUSY}${name}.ics`, etag: '"1"', data });

  test('an FBTYPE inside a quoted parameter value is text, not the type', async () => {
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY;X-NOTE="x;FBTYPE=FREE;y";FBTYPE=BUSY-TENTATIVE:20260525T100000Z/PT1H')];
    expect(busyLines(await call())).toEqual(['10:00-11:00 BUSY-TENTATIVE']);
  });

  test('CR-only line endings and a folded BEGIN line are read', async () => {
    stored[FREEBUSY] = [
      raw('cr', lines('BEGIN:VFREEBUSY', 'UID:cr@test', 'FREEBUSY:20260525T100000Z/PT1H', 'END:VFREEBUSY').join('\r')),
      raw('folded', lines('BEGIN:VFREE', ' BUSY', 'UID:folded@test', 'FREEBUSY:20260525T1200', ' 00Z/PT1H', 'END:VFREEBUSY').join('\n')),
    ];
    expect(busyLines(await call())).toEqual(['10:00-11:00', '12:00-13:00']);
  });

  test('a TZID is honoured: the object\'s VTIMEZONE, else the IANA zone', async () => {
    stored[FREEBUSY] = [
      // 09:00 in New York (summer time) is 13:00 UTC
      freebusy('iana', 'FREEBUSY;TZID=America/New_York:20260525T090000/PT1H'),
      // the object's own zone, three hours east of UTC: 13:00 there is 10:00 UTC
      calendarObject('own', [
        'BEGIN:VTIMEZONE', 'TZID:Custom/East', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
        'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0300', 'END:STANDARD', 'END:VTIMEZONE',
        'BEGIN:VFREEBUSY', 'UID:own@test', 'DTSTAMP:20260101T000000Z',
        'FREEBUSY;TZID=Custom/East:20260525T130000/20260525T140000', 'END:VFREEBUSY',
      ]),
      // a Z is UTC whatever the TZID says
      freebusy('utc', 'FREEBUSY;TZID=America/New_York:20260525T150000Z/PT1H'),
    ];
    expect(busyLines(await call())).toEqual(['10:00-11:00', '13:00-14:00', '15:00-16:00']);
  });

  test('a TZID that names no zone is read as an event\'s would be: in the calendar\'s zone', async () => {
    calendars[0].timezone = calendarTimezoneValue('Europe/Berlin').text;
    stored[FREEBUSY] = [freebusy('published', 'FREEBUSY;TZID=Nowhere/Land:20260525T120000/20260525T130000')];
    events[FREEBUSY] = [calendarObject('event', [
      'BEGIN:VEVENT', 'UID:event@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Same zone',
      'DTSTART;TZID=Nowhere/Land:20260525T150000', 'DTEND;TZID=Nowhere/Land:20260525T160000', 'END:VEVENT',
    ])];
    const output = await call();
    // both in Berlin summer time, shown there
    expect(section(output, 'Busy')).toMatch(/12:00 PM.*→.*01:00 PM/);
    expect(section(output, 'Busy')).toMatch(/03:00 PM.*→.*04:00 PM/);
    expect(output).not.toContain('incomplete');
  });

  test('a period\'s start and end are both read in its TZID', async () => {
    // 09:00 to 10:00 New York time, across no change: 13:00 to 14:00 UTC
    stored[FREEBUSY] = [freebusy('published', 'FREEBUSY;TZID=America/New_York:20260525T090000/20260525T100000')];
    expect(busyLines(await call())).toEqual(['13:00-14:00']);
  });

  test('a resource with a VEVENT and a VFREEBUSY with a bad period keeps the event\'s busy time', async () => {
    stored[FREEBUSY] = [calendarObject('mixed', [
      'BEGIN:VEVENT', 'UID:mixed@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Planning',
      'DTSTART:20260525T100000Z', 'DTEND:20260525T110000Z', 'END:VEVENT',
      'BEGIN:VFREEBUSY', 'UID:mixed-fb@test', 'DTSTAMP:20260101T000000Z',
      'FREEBUSY:20260525T140000Z/PT1H,garbage', 'END:VFREEBUSY',
    ])];
    const output = await call({ include_event_details: true });
    expect(busyLines(output)).toEqual(['10:00-11:00', '14:00-15:00']);
    expect(section(output, 'Events behind the busy blocks')).toContain('Planning');
    expect(output).toContain(`- ${FREEBUSY}mixed.ics: a FREEBUSY period cannot be read`);
  });

  test('components that do not nest make the object unreadable, and its event is still read', async () => {
    stored[FREEBUSY] = [
      // an X-FOO opened inside the VFREEBUSY and never closed
      calendarObject('unclosed', [
        'BEGIN:VFREEBUSY', 'UID:unclosed@test', 'BEGIN:X-FOO', 'FREEBUSY:20260525T140000Z/PT1H', 'END:VFREEBUSY',
        'BEGIN:VEVENT', 'UID:unclosed-event@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Kept',
        'DTSTART:20260525T100000Z', 'DTEND:20260525T110000Z', 'END:VEVENT',
      ]),
      // an END:VEVENT inside the VFREEBUSY
      calendarObject('stray', [
        'BEGIN:VFREEBUSY', 'UID:stray@test', 'END:VEVENT', 'FREEBUSY:20260525T150000Z/PT1H', 'END:VFREEBUSY',
      ]),
    ];
    const output = await call();
    expect(output).not.toContain('Nothing blocks this window');
    expect(output).toContain(`- ${FREEBUSY}unclosed.ics: cannot be read — its components do not nest`);
    expect(output).toContain(`- ${FREEBUSY}stray.ics: cannot be read — its components do not nest`);
  });

  test('the event beside a VFREEBUSY is read from the object as written, lone CRs in a value included', async () => {
    stored[FREEBUSY] = [calendarObject('mixed', [
      'BEGIN:VEVENT', 'UID:cr@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Notes',
      'DESCRIPTION:first\rsecond', 'DTSTART:20260525T100000Z', 'DTEND:20260525T110000Z', 'END:VEVENT',
      'BEGIN:VFREEBUSY', 'UID:cr-fb@test', 'FREEBUSY:20260525T140000Z/PT1H', 'END:VFREEBUSY',
    ])];
    const output = await call({ include_event_details: true });
    expect(busyLines(output)).toEqual(['10:00-11:00', '14:00-15:00']);
    expect(section(output, 'Events behind the busy blocks')).toContain('Notes');
    expect(output).not.toContain('incomplete');
  });

  test('only FREEBUSY directly in the VFREEBUSY counts, not one in a component nested in it', async () => {
    stored[FREEBUSY] = [freebusy('published',
      'FREEBUSY:20260525T100000Z/PT1H',
      'BEGIN:X-ARCHIVE',
      'FREEBUSY:20260525T140000Z/PT1H',
      'END:X-ARCHIVE')];
    expect(busyLines(await call())).toEqual(['10:00-11:00']);
  });
});

describe('the stored free/busy query going wrong', () => {
  test('a refused query leaves the answer incomplete, not failed', async () => {
    storedQuery = 'refuse';
    events[FREEBUSY] = [event('Meeting', '20260525T100000Z', '20260525T110000Z')];
    const output = await call();
    expect(busyLines(output)).toEqual(['10:00-11:00']);
    expect(output).toContain('**Warning**: incomplete — the server refused the query for stored free/busy of a calendar');
    expect(output).toContain(`- ${FREEBUSY}: REPORT returned 501 Not Implemented`);
    expect(output).not.toContain('an event could not be read');
  });

  test('a server that ignores the filter does not count an event twice', async () => {
    storedQuery = 'ignore-filter';
    events[FREEBUSY] = [event('Meeting', '20260525T100000Z', '20260525T110000Z')];
    stored[FREEBUSY] = [freebusy('published', 'FREEBUSY:20260525T140000Z/PT1H')];
    const output = await call({ include_event_details: true });
    expect(output).toContain('### Events behind the busy blocks (1)');
    expect(busyLines(output)).toEqual(['10:00-11:00', '14:00-15:00']);
  });

  test('nor a recurring event found both by the recurring listing and by the stored query', async () => {
    storedQuery = 'ignore-filter';
    recurring[FREEBUSY] = [calendarObject('Standup', [
      'BEGIN:VEVENT', 'UID:standup@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Standup',
      'DTSTART:20260518T120000Z', 'DTEND:20260518T123000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    ])];
    const output = await call({ include_event_details: true });
    expect(busyLines(output)).toEqual(['12:00-12:30']);
    expect(output).toContain('### Events behind the busy blocks (1)');
    expect(output).not.toContain('incomplete');
  });
});

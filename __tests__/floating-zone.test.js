import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');

// A floating time (no TZID, no Z) and a date name no instant of their own.
// RFC 4791 9.9 reads them in the calendar's calendar-timezone; dav-mcp read
// them on the clock of the machine it runs on, so a server in UTC put a 09:00
// Berlin meeting at 09:00 UTC (#117). Now: the calendar's zone, else the
// server's (TZ), so the answer no longer depends on where dav-mcp runs.

const BERLIN = 'https://dav.example.com/calendars/user/berlin/';
const NEW_YORK = 'https://dav.example.com/calendars/user/new-york/';

const { calendarTimezoneValue } = await import('../src/calendar-zone.js');

let objectsByCalendar;
const calendars = [
  { url: BERLIN, displayName: 'Berlin', timezone: calendarTimezoneValue('Europe/Berlin').text },
  { url: NEW_YORK, displayName: 'New York', timezone: 'America/New_York' }, // the bare form dav-mcp wrote before 5.0.0
];
const fetchCalendarObjects = jest.fn(async ({ calendar }) => objectsByCalendar[calendar.url] ?? []);
const propfind = jest.fn(async ({ url }) => [{
  ok: true, status: 207,
  props: { calendarTimezone: calendars.find((c) => c.url === url)?.timezone ?? '' },
}]);

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => calendars,
      fetchCalendarObjects,
      fetchTodos: async ({ calendar }) => objectsByCalendar[calendar.url] ?? [],
      propfind,
    }),
    getCardDavClient: () => ({}),
  },
}));

const { calendarQuery } = await import('../src/tools/calendar/calendar-query.js');
const { todoQuery } = await import('../src/tools/todos/todo-query.js');
const { listTodos } = await import('../src/tools/todos/list-todos.js');
const { listEvents } = await import('../src/tools/calendar/list-events.js');
const { freeBusyQuery } = await import('../src/tools/calendar/freebusy-query.js');

const object = (calendarUrl, name, component, ...lines) => ({
  url: `${calendarUrl}${name}.ics`,
  etag: '"1"',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', `BEGIN:${component}`, `UID:${name}@test`,
    'DTSTAMP:20260101T000000Z', `SUMMARY:${name}`, ...lines, `END:${component}`, 'END:VCALENDAR'].join('\r\n'),
});
const urls = (result) => [...result.content[0].text.matchAll(/- \*\*URL\*\*: (\S+)/g)].map((m) => m[1].split('/').pop());

beforeEach(() => {
  objectsByCalendar = {};
  propfind.mockClear();
  fetchCalendarObjects.mockClear();
});

describe('floating times are read in their calendar\'s zone', () => {
  test('the same 09:00 is 07:00 UTC in a Berlin calendar and 13:00 UTC in a New York one', async () => {
    const daily = (url, name) => object(url, name, 'VEVENT',
      'DTSTART:20261009T090000', 'DTEND:20261009T100000', 'RRULE:FREQ=DAILY;COUNT=3');
    objectsByCalendar = { [BERLIN]: [daily(BERLIN, 'berlin')], [NEW_YORK]: [daily(NEW_YORK, 'new-york')] };
    const listed = async (start, end) => {
      const text = (await calendarQuery.handler({ time_range_start: start, time_range_end: end })).content[0].text;
      return text.split(/^### \d+\. /m).slice(1).map((entry) => [
        entry.split('\n')[0],
        /- \*\*When\*\*: (.*?) to/.exec(entry)[1],
      ]).sort();
    };
    // a series with no occurrence in the range, as read here, is not listed
    expect(await listed('2026-10-10T06:30:00Z', '2026-10-10T07:30:00Z')).toEqual([
      ['berlin', 'October 10, 2026, 09:00 AM GMT+2'],
    ]);
    expect(await listed('2026-10-10T12:30:00Z', '2026-10-10T13:30:00Z')).toEqual([
      ['new-york', 'October 10, 2026, 09:00 AM EDT'],
    ]);
  });

  test('a floating todo DUE is filtered and shown in the calendar\'s zone', async () => {
    objectsByCalendar = { [BERLIN]: [object(BERLIN, 'todo', 'VTODO', 'DUE:20261010T090000')] };
    const range = (start, end) => todoQuery.handler({ calendar_url: BERLIN, time_range_start: start, time_range_end: end });
    expect(urls(await range('2026-10-10T06:30:00Z', '2026-10-10T07:30:00Z'))).toEqual(['todo.ics']);
    expect(urls(await range('2026-10-10T08:30:00Z', '2026-10-10T09:30:00Z'))).toEqual([]);

    // list_todos knows the calendar only by its URL: it asks for the zone
    const text = (await listTodos.handler({ calendar_url: BERLIN })).content[0].text;
    expect(text).toContain('- **Due**: October 10, 2026, 09:00 AM GMT+2');
    expect(propfind).toHaveBeenCalledWith(expect.objectContaining({ url: BERLIN, depth: '0' }));
  });

  test('an all-day todo DUE covers the calendar\'s day', async () => {
    objectsByCalendar = { [BERLIN]: [object(BERLIN, 'todo', 'VTODO', 'DUE;VALUE=DATE:20261010')] };
    const range = (start, end) => todoQuery.handler({ calendar_url: BERLIN, time_range_start: start, time_range_end: end });
    // 23:00-23:30 UTC on the 9th is already the 10th in Berlin
    expect(urls(await range('2026-10-09T22:30:00Z', '2026-10-09T23:00:00Z'))).toEqual(['todo.ics']);
    expect(urls(await range('2026-10-10T22:30:00Z', '2026-10-10T23:00:00Z'))).toEqual([]);
  });
});

describe('the range is decided here, not by the server', () => {
  // A server applies its own reading of floating times to a time-range
  // REPORT: Nextcloud and Baïkal (SabreDAV) read them as UTC, so a floating
  // 09:00 in a Berlin calendar was not returned for 07:30-08:30 UTC. The
  // server is asked for a range wide enough for any zone, and the tools keep
  // what touches the range as read in the calendar's zone.
  const RANGE = { time_range_start: '2026-10-26T07:30:00Z', time_range_end: '2026-10-26T08:30:00Z' };
  const WIDE = { start: '2026-10-25T05:30:00.000Z', end: '2026-10-27T10:30:00.000Z' };
  const standup = () => object(BERLIN, 'standup', 'VEVENT', 'DTSTART:20261026T090000', 'DTEND:20261026T100000');
  const lunch = () => object(BERLIN, 'lunch', 'VEVENT', 'DTSTART:20261026T120000', 'DTEND:20261026T130000');
  const weekly = () => object(BERLIN, 'weekly', 'VEVENT', 'DTSTART:20261019T170000', 'DTEND:20261019T180000', 'RRULE:FREQ=WEEKLY');

  test.each([
    ['list_events', () => listEvents.handler({ calendar_url: BERLIN, ...RANGE })],
    ['calendar_query', () => calendarQuery.handler({ calendar_url: BERLIN, ...RANGE })],
    ['freebusy_query', () => freeBusyQuery.handler({ calendar_url: BERLIN, ...RANGE, include_event_details: true })],
  ])('%s asks for a wider range and keeps only what touches the one asked', async (_, run) => {
    objectsByCalendar = { [BERLIN]: [standup(), lunch(), weekly()] };
    const result = await run();
    expect(fetchCalendarObjects).toHaveBeenCalledWith(expect.objectContaining({ timeRange: WIDE }));
    expect(urls(result)).toEqual(['standup.ics']);
  });
});

describe('whatever zone dav-mcp runs in', () => {
  const script = fileURLToPath(new URL('./fixtures/floating-zone.mjs', import.meta.url));
  const run = (hostZone, calendarZone) => JSON.parse(execFileSync(process.execPath, [script, calendarZone], {
    env: { ...process.env, TZ: hostZone, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
  }).trim().split('\n').pop());

  // Berlin: summer time ends Sun 25 Oct 2026 and starts Sun 28 Mar 2027
  const BERLIN_BUSY = [
    // 02:30 shown twice on 25 Oct: its first pass, summer time (RFC 5545 3.3.5)
    '2026-10-10T07:00:00.000Z/2026-10-10T08:00:00.000Z',
    '2026-10-19T07:00:00.000Z/2026-10-19T08:00:00.000Z',
    '2026-10-24T22:00:00.000Z/2026-10-25T23:00:00.000Z', // the 25-hour day, both events in it merged
    '2026-10-26T08:00:00.000Z/2026-10-26T09:00:00.000Z',
    '2026-11-02T08:00:00.000Z/2026-11-02T09:00:00.000Z',
    '2027-03-22T08:00:00.000Z/2027-03-22T09:00:00.000Z',
    // 02:30 skipped on 28 Mar: read with the offset before the change, 03:30 CEST
    '2027-03-28T01:30:00.000Z/2027-03-28T01:45:00.000Z',
    '2027-03-29T07:00:00.000Z/2027-03-29T08:00:00.000Z',
  ];

  test.each(['UTC', 'America/New_York', 'Europe/Berlin'])(
    'a Berlin calendar reads them in Berlin on a host in %s', (hostZone) => {
      const { busy, when, note } = run(hostZone, 'Europe/Berlin');
      expect(busy).toEqual(BERLIN_BUSY);
      expect(note).toBe(false);
      expect(when).toBe('October 26, 2026, 09:00 AM GMT+1 to October 26, 2026, 10:00 AM GMT+1');
    });

  test('a calendar without a zone is read in the server\'s (TZ)', () => {
    const { busy } = run('America/New_York', '');
    // New York leaves summer time on 1 Nov 2026 and enters it on 14 Mar 2027
    expect(busy).toContain('2026-10-26T13:00:00.000Z/2026-10-26T14:00:00.000Z');
    expect(busy).toContain('2026-11-02T14:00:00.000Z/2026-11-02T15:00:00.000Z');
    expect(busy).toContain('2026-10-25T04:00:00.000Z/2026-10-26T04:00:00.000Z');
  });
});

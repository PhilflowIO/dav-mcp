import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');

// Review of #135: the calendar's time zone is data from the server, and a
// lookup can fail. Reading it is bounded and cached, it has one reader
// whatever form tsdav hands it in, a failed lookup never moves a write onto
// dav-mcp's clock unsaid, every IANA zone can be set, and a write that a
// zone's DST change makes ambiguous or impossible is refused instead of
// stored shifted.

const BERLIN = 'https://dav.example.com/calendars/user/berlin/';
const EVENT_URL = `${BERLIN}event.ics`;

const zoneModule = await import('../src/calendar-zone.js');
const { calendarTimezoneValue, readTimezoneProperty, floatingZoneFor, MAX_TIMEZONE_LENGTH } = zoneModule;
const BERLIN_TZ = calendarTimezoneValue('Europe/Berlin').text;

let calendars;
let propfindAnswer;
let stored = '';
const written = [];
const client = {
  fetchCalendars: jest.fn(async () => calendars),
  fetchCalendarObjects: jest.fn(async () => [{ url: EVENT_URL, etag: '"1"', data: stored }]),
  fetchTodos: jest.fn(async () => []),
  propfind: jest.fn(async () => propfindAnswer()),
  davRequest: jest.fn(async () => [{ ok: true, status: 207, props: {} }]),
  createCalendarObject: jest.fn(async ({ iCalString }) => {
    written.push(iCalString);
    return { url: EVENT_URL, etag: '"1"' };
  }),
  updateCalendarObject: jest.fn(async ({ calendarObject }) => {
    written.push(calendarObject.data);
    return { etag: '"2"' };
  }),
};

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => client, getCardDavClient: () => ({}) },
}));

const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { listTodos } = await import('../src/tools/todos/list-todos.js');
const { listEvents } = await import('../src/tools/calendar/list-events.js');
const { listCalendars } = await import('../src/tools/calendar/list-calendars.js');
const { updateCalendar } = await import('../src/tools/calendar/update-calendar.js');
const { makeCalendar } = await import('../src/tools/calendar/make-calendar.js');
const { writeEventFields } = await import('../src/tools/shared/ical-dates.js');

const vcalendar = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'UID:s@test',
  'DTSTAMP:20260101T000000Z', 'SUMMARY:x', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const lines = (text, name) => text.replace(/\r\n[ \t]/g, '').split('\r\n').filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
const berlin = () => floatingZoneFor({ timezone: BERLIN_TZ });
const text = (result) => result.content[0].text;

beforeEach(() => {
  calendars = [{ url: BERLIN, displayName: 'Berlin', timezone: BERLIN_TZ }];
  propfindAnswer = () => [{ ok: true, status: 207, props: { calendarTimezone: BERLIN_TZ } }];
  written.length = 0;
  jest.clearAllMocks();
});

describe('reading the property', () => {
  test('a value over the size limit is unreadable, without being parsed', () => {
    const big = BERLIN_TZ.replace('END:VTIMEZONE', `${'X-PAD:'.padEnd(70, 'x')}\r\n`.repeat(MAX_TIMEZONE_LENGTH / 70 + 10) + 'END:VTIMEZONE');
    const started = performance.now();
    const read = readTimezoneProperty(big);
    expect(read.status).toBe('unreadable');
    expect(read.reason).toMatch(/larger than/);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test('a line with too many parameters is refused by the parse guard', () => {
    const params = Array.from({ length: 2000 }, (_, i) => `P${i}=x`).join(';');
    const read = readTimezoneProperty(BERLIN_TZ.replace('TZID:Europe/Berlin', `TZID;${params}:Europe/Berlin`));
    expect(read.status).toBe('unreadable');
  });

  test('the parse is cached by text', () => {
    expect(readTimezoneProperty(BERLIN_TZ)).toBe(readTimezoneProperty(BERLIN_TZ));
  });

  test('CDATA, as some servers send it, is the same value', () => {
    expect(readTimezoneProperty({ _cdata: BERLIN_TZ })).toMatchObject({ status: 'zone', tzid: 'Europe/Berlin' });
    expect(readTimezoneProperty({ _text: 'Europe/Berlin' })).toMatchObject({ status: 'zone', tzid: 'Europe/Berlin' });
  });

  test('a VTIMEZONE without rules is read by its IANA name, not as UTC', () => {
    const empty = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nEND:VTIMEZONE\r\nEND:VCALENDAR';
    const zone = floatingZoneFor({ timezone: empty });
    expect(zone.source).toBe('calendar');
    expect(zone.converter.offsetAt(new Date('2026-07-01T12:00:00Z'))).toBe(7200);
  });

  test('a VTIMEZONE without rules under a name that is no IANA zone is unreadable', () => {
    const empty = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Foo/Bar\r\nEND:VTIMEZONE\r\nEND:VCALENDAR';
    expect(floatingZoneFor({ timezone: empty })).toMatchObject({ source: 'server', failure: expect.stringContaining('Foo/Bar') });
  });
});

describe('one reader for every tool', () => {
  test('a zone tsdav hands over as CDATA (projected) is used by list_events and shown by list_calendars', async () => {
    // tsdav up to 2.4 drops a CDATA calendar-timezone from `timezone`; the
    // raw property comes through projectedProps
    calendars = [{ url: BERLIN, displayName: 'Berlin', timezone: '', projectedProps: { calendarTimezone: { _cdata: BERLIN_TZ } } }];
    client.fetchCalendarObjects.mockResolvedValueOnce([{
      url: EVENT_URL, etag: '"1"', data: vcalendar('DTSTART:20261010T090000', 'DTEND:20261010T100000'),
    }]);
    const listed = text(await listEvents.handler({ calendar_url: BERLIN }));
    expect(listed).toContain('October 10, 2026, 09:00 AM GMT+2');
    expect(text(await listCalendars.handler({}))).toContain('- **Time zone**: Europe/Berlin');
  });

  test('update_calendar reads the zone back from CDATA too', async () => {
    calendars = [{ url: BERLIN, displayName: 'Berlin', timezone: '', projectedProps: { calendarTimezone: { _cdata: BERLIN_TZ } } }];
    expect(text(await updateCalendar.handler({ calendar_url: BERLIN, timezone: 'Europe/Berlin' }))).toContain('- Timezone: Europe/Berlin\n');
  });

  test('update_calendar: a calendar the server no longer lists is a NotFoundError', async () => {
    calendars = [];
    await expect(updateCalendar.handler({ calendar_url: BERLIN, display_name: 'x' }))
      .rejects.toMatchObject({ name: 'NotFoundError' });
  });
});

describe('a failed lookup', () => {
  const FLOATING = vcalendar('DTSTART:20261019T090000', 'DTEND:20261019T100000', 'RRULE:FREQ=WEEKLY');
  const move = () => updateEventFields.handler({
    event_url: EVENT_URL, event_etag: '"1"', start_date: '2026-10-20T08:00:00Z', end_date: '2026-10-20T09:00:00Z',
  });

  test.each([
    ['the request fails', () => { throw new Error('socket hang up'); }],
    ['the server answers 500', () => [{ ok: false, status: 500, statusText: 'Internal Server Error' }]],
    ['the property is unreadable', () => [{ ok: true, status: 207, props: { calendarTimezone: 'BEGIN:VCALENDAR\r\ngarbage' } }]],
  ])('refuses a write when %s, and writes nothing', async (_, answer) => {
    propfindAnswer = answer;
    stored = FLOATING;
    await expect(move()).rejects.toThrow(/time zone of the calendar .* could not be read/);
    expect(written).toEqual([]);
  });

  test('a calendar without a zone is not a failure: the write goes ahead in dav-mcp\'s zone', async () => {
    propfindAnswer = () => [{ ok: true, status: 207, props: {} }];
    stored = FLOATING;
    await move();
    expect(written).toHaveLength(1);
  });

  test('create_event refuses too when the calendar\'s zone is unreadable', async () => {
    calendars = [{ url: BERLIN, displayName: 'Berlin', timezone: 'BEGIN:VCALENDAR\r\ngarbage' }];
    await expect(createEvent.handler({
      calendar_url: BERLIN, summary: 'x', start_date: '2026-10-10T09:00:00', end_date: '2026-10-10T10:00:00',
    })).rejects.toThrow(/could not be read/);
    expect(written).toEqual([]);
  });

  test('a read goes ahead in dav-mcp\'s zone and says so', async () => {
    propfindAnswer = () => { throw new Error('socket hang up'); };
    const result = text(await listTodos.handler({ calendar_url: BERLIN }));
    expect(result).toMatch(/time zone of the calendar .* could not be read .*socket hang up/);
    expect(result).toContain(`read in ${zoneModule.serverZone().tzid}`);
  });
});

describe('every IANA zone can be set', () => {
  test('Africa/Monrovia (local mean time until 1972) gets a VTIMEZONE', async () => {
    client.davRequest.mockResolvedValueOnce([{ ok: true, status: 201 }]);
    const value = calendarTimezoneValue('Africa/Monrovia');
    expect(value.tzid).toBe('Africa/Monrovia');
    expect(readTimezoneProperty(value.text)).toMatchObject({ status: 'zone', tzid: 'Africa/Monrovia' });
  });

  // every zone Intl knows: swept once (Node 22, 418 zones, 0 failures; see
  // the pull request), not on every run: generating a VTIMEZONE takes
  // ~0.3 s per zone

  test('make_calendar with one never fails internally', async () => {
    client.createCalendarObject.mockClear();
    client.makeCalendar = jest.fn(async () => [{ ok: true, status: 201 }]);
    client.account = { homeUrl: 'https://dav.example.com/calendars/user/' };
    const result = await makeCalendar.handler({ display_name: 'Liberia', timezone: 'Africa/Monrovia' });
    expect(text(result)).toContain('"timezone": "Africa/Monrovia"');
  });
});

describe('a write the zone\'s DST change makes impossible or ambiguous is refused', () => {
  const FLOATING = vcalendar('DTSTART:20261019T090000', 'DTEND:20261019T100000', 'RRULE:FREQ=WEEKLY;COUNT=10');
  const NEW = vcalendar();

  test('an instant in the second pass of the October 02:00-03:00 hour, for a floating series', () => {
    // 01:30Z on 25 Oct 2026 is the second 02:30 in Berlin; written without a
    // zone it would read as the first, an hour earlier
    expect(() => writeEventFields(FLOATING, {}, { startDate: '2026-10-25T01:30:00Z', endDate: '2026-10-25T02:30:00Z' }, berlin()))
      .toThrow(/02:30 on 2026-10-25 occurs twice in Europe\/Berlin/);
  });

  test('a range across the fold that would come back shorter', () => {
    // 00:30Z-01:45Z is 75 minutes; as local times 02:30-02:45 it reads as 15
    expect(() => writeEventFields(FLOATING, {}, { startDate: '2026-10-25T00:30:00Z', endDate: '2026-10-25T01:45:00Z' }, berlin()))
      .toThrow(/occurs twice in Europe\/Berlin/);
  });

  test('a local time the spring change skips, for a new event', () => {
    expect(() => writeEventFields(NEW, {}, { startDate: '2026-03-29T02:30:00', endDate: '2026-03-29T03:30:00' }, berlin()))
      .toThrow(/02:30 on 2026-03-29 does not exist in Europe\/Berlin/);
  });

  test('a local time the spring change skips, for a floating series', () => {
    expect(() => writeEventFields(FLOATING, {}, { startDate: '2027-03-28T02:30:00', endDate: '2027-03-28T03:30:00' }, berlin()))
      .toThrow(/does not exist in Europe\/Berlin/);
  });

  test('a local time the autumn change shows twice, for a new event: which one is meant', () => {
    expect(() => writeEventFields(NEW, {}, { startDate: '2026-10-25T02:30:00', endDate: '2026-10-25T03:30:00' }, berlin()))
      .toThrow(/occurs twice in Europe\/Berlin.*offset/);
  });

  test('the same local time is fine for a floating series: it is stored as given', () => {
    const data = writeEventFields(FLOATING, {}, { startDate: '2026-10-25T02:30:00', endDate: '2026-10-25T03:30:00' }, berlin());
    expect(lines(data, 'DTSTART')).toEqual(['DTSTART:20261025T023000']);
  });
});

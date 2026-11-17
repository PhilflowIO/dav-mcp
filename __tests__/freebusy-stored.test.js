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
const fetchCalendarObjects = jest.fn(async ({ calendar, filters }) => {
  const isStored = filters?.[0]?.['comp-filter']?.['comp-filter']?._attributes?.name === 'VFREEBUSY';
  return (isStored ? stored : events)[calendar.url] ?? [];
});

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({ fetchCalendars: async () => calendars, fetchCalendarObjects }),
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
});

describe('the stored free/busy query', () => {
  test('asks for VFREEBUSY, without a time-range, where a calendar can hold them', async () => {
    await freeBusyQuery.handler(WINDOW);
    const byCalendar = (url) => fetchCalendarObjects.mock.calls.map(([options]) => options)
      .filter((options) => options.calendar.url === url);

    // the one that names VFREEBUSY and the one that names no types (RFC 4791 5.2.3)
    for (const url of [FREEBUSY, OPEN]) {
      const [eventQuery, storedQuery] = byCalendar(url);
      expect(eventQuery.filters).toBeUndefined();
      expect(storedQuery.filters).toEqual([{
        'comp-filter': { _attributes: { name: 'VCALENDAR' }, 'comp-filter': { _attributes: { name: 'VFREEBUSY' } } },
      }]);
      expect(storedQuery.timeRange).toBeUndefined();
    }
    // one that leaves VFREEBUSY out costs no second query
    expect(byCalendar(EVENTS)).toHaveLength(1);
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
    expect(output).toContain('**Warning**: incomplete');
    expect(output).toContain(`Stored free/busy (${FREEBUSY}published.ics): cannot be read — 2 FREEBUSY periods in it`);
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

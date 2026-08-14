import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { calculateFreeBusy } from '../src/tools/shared/freebusy.js';

const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';

const fetchCalendarObjects = jest.fn();

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [
        { url: CALENDAR_URL, displayName: 'Work' },
        { url: 'https://dav.example.com/calendars/user/home/', displayName: 'Home' },
      ],
      fetchCalendarObjects,
    }),
    getCardDavClient: () => ({}),
  },
}));

const { freeBusyQuery } = await import('../src/tools/calendar/freebusy-query.js');

const object = (properties) => ({
  url: `${CALENDAR_URL}${Math.random().toString(36).slice(2)}.ics`,
  etag: '"1"',
  data: [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Test//EN',
    'BEGIN:VEVENT',
    'UID:e@example.com',
    ...properties,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'),
});

const meeting = (startHour, endHour, extra = []) => object([
  `DTSTART:20260525T${String(startHour).padStart(2, '0')}0000Z`,
  `DTEND:20260525T${String(endHour).padStart(2, '0')}0000Z`,
  'SUMMARY:Meeting',
  ...extra,
]);

const DAY = {
  start: new Date('2026-05-25T09:00:00Z'),
  end: new Date('2026-05-25T17:00:00Z'),
};

const hours = (intervals) => intervals.map(
  i => `${i.start.toISOString().slice(11, 16)}-${i.end.toISOString().slice(11, 16)}`
);

describe('calculateFreeBusy', () => {
  test('an empty calendar is free for the whole window', () => {
    const { busy, free } = calculateFreeBusy([], DAY);
    expect(busy).toEqual([]);
    expect(hours(free)).toEqual(['09:00-17:00']);
  });

  test('one meeting splits the window', () => {
    const { busy, free } = calculateFreeBusy([meeting(12, 13)], DAY);
    expect(hours(busy)).toEqual(['12:00-13:00']);
    expect(hours(free)).toEqual(['09:00-12:00', '13:00-17:00']);
  });

  test('overlapping meetings merge into one busy block', () => {
    const { busy } = calculateFreeBusy([meeting(10, 12), meeting(11, 13)], DAY);
    expect(hours(busy)).toEqual(['10:00-13:00']);
  });

  test('back-to-back meetings merge — a zero-length gap is not free time', () => {
    const { busy, free } = calculateFreeBusy([meeting(10, 11), meeting(11, 12)], DAY);
    expect(hours(busy)).toEqual(['10:00-12:00']);
    expect(hours(free)).toEqual(['09:00-10:00', '12:00-17:00']);
  });

  test('a meeting inside another does not reopen free time', () => {
    const { busy } = calculateFreeBusy([meeting(10, 15), meeting(11, 12)], DAY);
    expect(hours(busy)).toEqual(['10:00-15:00']);
  });

  test('events are clipped to the window', () => {
    const overnight = object([
      'DTSTART:20260524T220000Z',
      'DTEND:20260525T100000Z',
      'SUMMARY:Long haul',
    ]);
    const { busy, free } = calculateFreeBusy([overnight], DAY);
    expect(hours(busy)).toEqual(['09:00-10:00']);
    expect(hours(free)).toEqual(['10:00-17:00']);
  });

  test('a fully booked window has no free time', () => {
    const { free } = calculateFreeBusy([meeting(9, 17)], DAY);
    expect(free).toEqual([]);
  });

  test('TRANSPARENT events do not block time', () => {
    const { busy, free } = calculateFreeBusy([meeting(12, 13, ['TRANSP:TRANSPARENT'])], DAY);
    expect(busy).toEqual([]);
    expect(hours(free)).toEqual(['09:00-17:00']);
  });

  test('OPAQUE is explicit busy', () => {
    const { busy } = calculateFreeBusy([meeting(12, 13, ['TRANSP:OPAQUE'])], DAY);
    expect(hours(busy)).toEqual(['12:00-13:00']);
  });

  test('cancelled events do not block time', () => {
    const { busy } = calculateFreeBusy([meeting(12, 13, ['STATUS:CANCELLED'])], DAY);
    expect(busy).toEqual([]);
  });

  test('an all-day event blocks the UTC day it covers, whatever the host zone', () => {
    const allDay = object([
      'DTSTART;VALUE=DATE:20260525',
      'DTEND;VALUE=DATE:20260526',
      'SUMMARY:Conference',
    ]);
    const { busy, free } = calculateFreeBusy([allDay], DAY);
    expect(hours(busy)).toEqual(['09:00-17:00']);
    expect(free).toEqual([]);
  });

  test('an unparseable object is skipped rather than taking the answer down', () => {
    const broken = { url: 'u', etag: '"1"', data: 'this is not iCalendar' };
    const { busy } = calculateFreeBusy([broken, meeting(12, 13)], DAY);
    expect(hours(busy)).toEqual(['12:00-13:00']);
  });
});

describe('recurring events', () => {
  const daily = object([
    'DTSTART:20260101T100000Z',
    'DTEND:20260101T110000Z',
    'SUMMARY:Daily standup',
    'RRULE:FREQ=DAILY',
  ]);

  test('an occurrence inside the window blocks it', () => {
    const { busy } = calculateFreeBusy([daily], DAY);
    expect(hours(busy)).toEqual(['10:00-11:00']);
  });

  test('every occurrence in a multi-day window is counted', () => {
    const week = {
      start: new Date('2026-05-25T00:00:00Z'),
      end: new Date('2026-05-28T00:00:00Z'),
    };
    const { busy } = calculateFreeBusy([daily], week);
    expect(busy).toHaveLength(3);
  });

  test('EXDATE removes an occurrence', () => {
    const withExdate = object([
      'DTSTART:20260101T100000Z',
      'DTEND:20260101T110000Z',
      'SUMMARY:Daily standup',
      'RRULE:FREQ=DAILY',
      'EXDATE:20260525T100000Z',
    ]);
    const { busy } = calculateFreeBusy([withExdate], DAY);
    expect(busy).toEqual([]);
  });

  test('a degenerate series does not stall the calculation', () => {
    const minutely = object([
      'DTSTART:19700101T000000Z',
      'DTEND:19700101T000100Z',
      'SUMMARY:Pathological',
      'RRULE:FREQ=MINUTELY',
    ]);
    const started = process.hrtime.bigint();
    calculateFreeBusy([minutely], DAY);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('freebusy_query tool', () => {
  beforeEach(() => fetchCalendarObjects.mockReset());

  const call = (args) => freeBusyQuery.handler({
    time_range_start: '2026-05-25T09:00:00Z',
    time_range_end: '2026-05-25T17:00:00Z',
    ...args,
  });

  test('searches every calendar by default', async () => {
    fetchCalendarObjects.mockResolvedValue([]);
    const text = (await call({})).content[0].text;
    expect(fetchCalendarObjects).toHaveBeenCalledTimes(2);
    expect(text).toContain('**Scope**: 2 calendars');
  });

  test('can be restricted to one calendar', async () => {
    fetchCalendarObjects.mockResolvedValue([]);
    const text = (await call({ calendar_url: CALENDAR_URL })).content[0].text;
    expect(fetchCalendarObjects).toHaveBeenCalledTimes(1);
    expect(text).toContain('**Scope**: 1 calendar');
  });

  test('reports free slots with their duration', async () => {
    fetchCalendarObjects.mockResolvedValue([meeting(12, 13)]);
    const text = (await call({ calendar_url: CALENDAR_URL })).content[0].text;
    expect(text).toContain('### Free (2)');
    expect(text).toContain('(3h)');
    expect(text).toContain('### Busy (1)');
    expect(text).toContain('(1h)');
  });

  test('says so when nothing is free', async () => {
    fetchCalendarObjects.mockResolvedValue([meeting(9, 17)]);
    const text = (await call({ calendar_url: CALENDAR_URL })).content[0].text;
    expect(text).toContain('No free time');
  });

  test('event details are off by default and available on request', async () => {
    fetchCalendarObjects.mockResolvedValue([meeting(12, 13)]);
    const withoutDetails = (await call({ calendar_url: CALENDAR_URL })).content[0].text;
    expect(withoutDetails).not.toContain('Events behind the busy blocks');

    fetchCalendarObjects.mockResolvedValue([meeting(12, 13)]);
    const withDetails = (await call({
      calendar_url: CALENDAR_URL,
      include_event_details: true,
    })).content[0].text;
    expect(withDetails).toContain('Events behind the busy blocks');
    expect(withDetails).toContain('Meeting');
  });

  test('an inverted range is rejected', async () => {
    await expect(freeBusyQuery.handler({
      time_range_start: '2026-05-25T17:00:00Z',
      time_range_end: '2026-05-25T09:00:00Z',
    })).rejects.toThrow(/must be after/);
  });

  test('an unknown calendar names the available ones', async () => {
    await expect(call({ calendar_url: 'https://dav.example.com/calendars/user/nope/' }))
      .rejects.toThrow(/Available calendar URLs/);
  });
});

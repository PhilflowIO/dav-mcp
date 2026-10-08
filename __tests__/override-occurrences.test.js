import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ICAL from 'ical.js';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');

const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
let stored = [];

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Work' }],
      fetchCalendarObjects: async () => stored,
    }),
    getCardDavClient: () => ({}),
  },
}));

const { calculateFreeBusy } = await import('../src/tools/shared/freebusy.js');
const { formatEvent } = await import('../src/formatters.js');
const { readSeries, shownEvent } = await import('../src/ical-components.js');
const { relateSeries, seriesOccurrences } = await import('../src/occurrences.js');
const { createRecurrenceBudget } = await import('tsdav-utils');
const { calendarQuery } = await import('../src/tools/calendar/calendar-query.js');
const { listEvents } = await import('../src/tools/calendar/list-events.js');
const { freeBusyQuery } = await import('../src/tools/calendar/freebusy-query.js');

// Issue #98: a daily 09:00-10:00 UTC series from the 1st of October 2026
const vevent = (...lines) => ['BEGIN:VEVENT', 'UID:standup@example.com', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const MASTER = (...extra) => vevent('SUMMARY:Standup', 'DTSTART:20261001T090000Z', 'DTEND:20261001T100000Z',
  'RRULE:FREQ=DAILY', ...extra);
const override = (recurrenceId, start, end, ...extra) => vevent(`SUMMARY:Standup (${recurrenceId.slice(6, 8)})`,
  `RECURRENCE-ID:${recurrenceId}`, `DTSTART:${start}`, `DTEND:${end}`, ...extra);
const object = (...vevents) => ({
  url: `${CALENDAR_URL}standup.ics`,
  etag: '"1"',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...vevents.flat(), 'END:VCALENDAR'].join('\r\n'),
});
const BERLIN = ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];

const day = (date) => ({ start: new Date(`${date}T00:00:00Z`), end: new Date(`${date}T23:59:59Z`) });
const iso = (d) => d.toISOString().slice(0, 16);
const busyOn = (obj, date) => calculateFreeBusy([obj], day(date)).busy.map((b) => `${iso(b.start)}-${iso(b.end).slice(11)}`);
const isoRange = (date) => ({ start: `${date}T00:00:00Z`, end: `${date}T23:59:59Z` });

describe('free/busy judges each occurrence as it now stands (#98)', () => {
  test('a cancelled occurrence does not block time', () => {
    const series = object(MASTER(), override('20261013T090000Z', '20261013T090000Z', '20261013T100000Z', 'STATUS:CANCELLED'));
    expect(busyOn(series, '2026-10-13')).toEqual([]);
    expect(busyOn(series, '2026-10-12')).toEqual(['2026-10-12T09:00-10:00']);
  });

  test('a transparent occurrence does not block time', () => {
    const series = object(MASTER(), override('20261013T090000Z', '20261013T090000Z', '20261013T100000Z', 'TRANSP:TRANSPARENT'));
    expect(busyOn(series, '2026-10-13')).toEqual([]);
  });

  test('an occurrence moved in from outside the range blocks it, and leaves its old day', () => {
    const series = object(MASTER('EXDATE:20261014T090000Z'),
      override('20261020T090000Z', '20261014T150000Z', '20261014T160000Z'));
    expect(busyOn(series, '2026-10-14')).toEqual(['2026-10-14T15:00-16:00']);
    expect(busyOn(series, '2026-10-20')).toEqual([]);
  });

  test('an opaque occurrence of a transparent series blocks time', () => {
    const series = object(MASTER('TRANSP:TRANSPARENT'),
      override('20261013T090000Z', '20261013T110000Z', '20261013T120000Z', 'TRANSP:OPAQUE'));
    expect(busyOn(series, '2026-10-13')).toEqual(['2026-10-13T11:00-12:00']);
    expect(busyOn(series, '2026-10-12')).toEqual([]);
  });

  test('an override of an EXDATEd or non-existent occurrence is ignored, as a full expansion ignores it', () => {
    const series = object(MASTER('EXDATE:20261020T090000Z'),
      override('20261020T090000Z', '20261014T150000Z', '20261014T160000Z'),
      override('20261021T091500Z', '20261014T170000Z', '20261014T180000Z'));
    expect(busyOn(series, '2026-10-14')).toEqual(['2026-10-14T09:00-10:00']);
  });

  test('RANGE=THISANDFUTURE moves every later occurrence', () => {
    const series = object(MASTER(), vevent('SUMMARY:Standup (later)',
      'RECURRENCE-ID;RANGE=THISANDFUTURE:20261015T090000Z', 'DTSTART:20261015T130000Z', 'DTEND:20261015T140000Z'));
    expect(busyOn(series, '2026-10-14')).toEqual(['2026-10-14T09:00-10:00']);
    expect(busyOn(series, '2026-10-30')).toEqual(['2026-10-30T13:00-14:00']);
  });

  test('event details list only what blocks the window, as the occurrence in it', async () => {
    stored = [
      object(MASTER(), override('20261020T090000Z', '20261014T150000Z', '20261014T160000Z')),
      { ...object(vevent('SUMMARY:Holiday', 'DTSTART:20261014T000000Z', 'DTEND:20261015T000000Z', 'TRANSP:TRANSPARENT')),
        url: `${CALENDAR_URL}holiday.ics` },
    ];
    const text = (await freeBusyQuery.handler({
      time_range_start: '2026-10-14T12:00:00Z', time_range_end: '2026-10-14T18:00:00Z', include_event_details: true,
    })).content[0].text;
    expect(text).toContain('Events behind the busy blocks (1)');
    expect(text).toContain('Standup (20)');
    expect(text).toContain('October 14, 2026');
    expect(text).not.toContain('Holiday');
  });
});

describe('queries and display list occurrences by their effective time (#98)', () => {
  const MOVED = object(MASTER(),
    override('20261020T090000Z', '20261014T150000Z', '20261014T160000Z'));
  const ENDED = object(vevent('SUMMARY:Standup', 'DTSTART:20261001T090000Z', 'DTEND:20261001T100000Z',
    'RRULE:FREQ=DAILY;UNTIL=20261013T090000Z'), override('20261005T090000Z', '20261014T150000Z', '20261014T160000Z'));

  test('an occurrence moved into the range is shown there, with its own title', () => {
    const output = formatEvent(ENDED, 'Work', isoRange('2026-10-14'));
    expect(output).toContain('## Standup (05)');
    expect(output).toContain('October 14, 2026');
    expect(output).not.toContain('no occurrence');
  });

  test('an occurrence moved out of the range is no longer reported in it', () => {
    const lastDay = object(vevent('SUMMARY:Standup', 'DTSTART:20261001T090000Z', 'DTEND:20261001T100000Z',
      'RRULE:FREQ=DAILY;UNTIL=20261013T090000Z'), override('20261013T090000Z', '20261103T090000Z', '20261103T100000Z'));
    expect(formatEvent(lastDay, 'Work', isoRange('2026-10-13'))).toContain('no occurrence of this series falls inside');
    expect(formatEvent(lastDay, 'Work', isoRange('2026-11-03'))).toContain('November 3, 2026');
  });

  test('the earliest occurrence by its moved start is the one listed', () => {
    // the 14th proper is at 09:00, the 20th moved to 08:00 on the 14th
    const earlier = object(MASTER(), override('20261020T090000Z', '20261014T080000Z', '20261014T083000Z'));
    expect(formatEvent(earlier, 'Work', isoRange('2026-10-14'))).toContain('## Standup (20)');
    expect(formatEvent(MOVED, 'Work', isoRange('2026-10-14'))).toContain('## Standup\n');
  });

  test('a cancelled occurrence says so', () => {
    const cancelled = object(MASTER(), override('20261013T090000Z', '20261013T090000Z', '20261013T100000Z', 'STATUS:CANCELLED'));
    expect(formatEvent(cancelled, 'Work', isoRange('2026-10-13'))).toContain('- **Status**: CANCELLED');
    expect(formatEvent(cancelled, 'Work', isoRange('2026-10-12'))).not.toContain('**Status**');
  });

  test('calendar_query finds an occurrence moved into the range by its title', async () => {
    stored = [ENDED];
    const text = (await calendarQuery.handler({
      summary_filter: 'standup (05)', time_range_start: '2026-10-14T00:00:00Z', time_range_end: '2026-10-15T00:00:00Z',
    })).content[0].text;
    expect(text).toContain('### 1. Standup (05)');
    expect(text).toContain('October 14, 2026');
  });
});

describe('one definition of "in the range" everywhere (RFC 4791 9.9)', () => {
  const tools = async (range) => {
    const text = async (tool, args) => (await tool.handler({ ...args, ...range })).content[0].text;
    return {
      freebusy: await text(freeBusyQuery, { include_event_details: true }),
      query: await text(calendarQuery, {}),
      list: await text(listEvents, { calendar_url: CALENDAR_URL }),
    };
  };
  const WINDOW = { time_range_start: '2026-10-14T10:00:00Z', time_range_end: '2026-10-14T12:00:00Z' };

  test('a meeting running into the window is in it for free/busy, calendar_query and list_events alike', async () => {
    stored = [object(vevent('SUMMARY:Workshop', 'DTSTART:20261001T090000Z', 'DTEND:20261001T110000Z', 'RRULE:FREQ=DAILY'))];
    const { freebusy, query, list } = await tools(WINDOW);
    expect(freebusy).toContain('### Busy (1)');
    for (const text of [freebusy, query, list]) {
      expect(text).toContain('Workshop');
      expect(text).toContain('October 14, 2026, 09:00 AM UTC to October 14, 2026, 11:00 AM UTC');
      expect(text).not.toContain('no occurrence');
    }
  });

  test('one starting exactly at the window end is in none of them', async () => {
    stored = [object(vevent('SUMMARY:Edge', 'DTSTART:20261001T120000Z', 'DTEND:20261001T130000Z', 'RRULE:FREQ=DAILY'))];
    const { freebusy, query, list } = await tools(WINDOW);
    expect(freebusy).toContain('Nothing blocks this window');
    expect(freebusy).toContain('Events behind the busy blocks (0)');
    for (const text of [query, list]) {
      expect(text).toContain('no occurrence of this series falls inside the queried range');
      expect(text).not.toContain('October 14');
    }
  });

  test('an occurrence without duration is in [start, end)', () => {
    const series = (root) => relateSeries(readSeries(root, 'vevent').master, []);
    const root = new ICAL.Component(ICAL.parse(object(vevent('SUMMARY:Tick', 'DTSTART:20261001T100000Z', 'RRULE:FREQ=DAILY')).data));
    const at = (from, to) => seriesOccurrences(series(root), { start: Date.parse(from), end: Date.parse(to) })
      .occurrences.map((o) => o.startDate.toString());
    expect(at('2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z')).toEqual(['2026-10-14T10:00:00Z']);
    expect(at('2026-10-14T09:00:00Z', '2026-10-14T10:00:00Z')).toEqual([]);
  });
});

describe('RECURRENCE-ID is matched by the instant it names', () => {
  test('a THISANDFUTURE override with a UTC RECURRENCE-ID on a Berlin series moves it by its own move', () => {
    const series = object(BERLIN,
      vevent('SUMMARY:Daily', 'DTSTART;TZID=Europe/Berlin:20261001T100000', 'DTEND;TZID=Europe/Berlin:20261001T103000', 'RRULE:FREQ=DAILY'),
      vevent('SUMMARY:Daily moved', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261005T080000Z',
        'DTSTART;TZID=Europe/Berlin:20261005T110000', 'DTEND;TZID=Europe/Berlin:20261005T113000'));
    // 11:00 CEST
    expect(busyOn(series, '2026-10-07')).toEqual(['2026-10-07T09:00-09:30']);
    expect(busyOn(series, '2026-10-04')).toEqual(['2026-10-04T08:00-08:30']);
  });

  test('a UTC RECURRENCE-ID on a floating series names nothing: the series has no zone to read it in', () => {
    // as tsdav-utils reads it, whatever the host's zone
    const series = object(
      vevent('SUMMARY:Floating', 'DTSTART:20261001T090000', 'DTEND:20261001T100000', 'RRULE:FREQ=DAILY'),
      vevent('SUMMARY:Floating', 'RECURRENCE-ID:20261013T090000Z', 'DTSTART:20261013T090000', 'DTEND:20261013T100000',
        'STATUS:CANCELLED'));
    const local = (h) => new Date(2026, 9, 13, h);
    const { busy } = calculateFreeBusy([series], { start: local(0), end: local(23) });
    expect(busy).toEqual([{ start: local(9), end: local(10) }]);
  });

  test('a THISANDFUTURE override of no occurrence, or of an EXDATEd one, is ignored', () => {
    for (const extra of [[], ['EXDATE:20261005T100000Z']]) {
      const rid = extra.length ? '20261005T100000Z' : '20261005T100700Z';
      const series = object(
        vevent('SUMMARY:x', 'DTSTART:20261001T100000Z', 'DTEND:20261001T103000Z', 'RRULE:FREQ=DAILY', ...extra),
        vevent('SUMMARY:x', `RECURRENCE-ID;RANGE=THISANDFUTURE:${rid}`, `DTSTART:${rid}`, 'DURATION:PT30M', 'STATUS:CANCELLED'));
      expect(busyOn(series, '2026-10-07')).toEqual(['2026-10-07T10:00-10:30']);
    }
  });
});

describe('STATUS and TRANSP', () => {
  test('are compared case-insensitively', () => {
    const series = object(MASTER(), override('20261013T090000Z', '20261013T090000Z', '20261013T100000Z', 'STATUS:cancelled'),
      override('20261014T090000Z', '20261014T090000Z', '20261014T100000Z', 'TRANSP:transparent'));
    expect(busyOn(series, '2026-10-13')).toEqual([]);
    expect(busyOn(series, '2026-10-14')).toEqual([]);
  });

  test('an override without STATUS of a cancelled series is not cancelled: it is a full component', () => {
    const series = object(MASTER('STATUS:CANCELLED'), override('20261013T090000Z', '20261013T120000Z', '20261013T130000Z'));
    expect(busyOn(series, '2026-10-13')).toEqual(['2026-10-13T12:00-13:00']);
    expect(busyOn(series, '2026-10-12')).toEqual([]);
  });
});

describe('RECURRENCE-ID and EXDATE in another frame than DTSTART (review of #110)', () => {
  const allDay = (rid) => object(BERLIN,
    vevent('SUMMARY:AD', 'DTSTART;VALUE=DATE:20261001', 'DTEND;VALUE=DATE:20261002', 'RRULE:FREQ=DAILY'),
    vevent('SUMMARY:x', rid, 'DTSTART;VALUE=DATE:20261013', 'DTEND;VALUE=DATE:20261014', 'STATUS:CANCELLED'));
  const days = (obj) => busyOn(obj, '2026-10-12').concat(busyOn(obj, '2026-10-13'));

  test.each([
    ['Berlin midnight', 'RECURRENCE-ID;TZID=Europe/Berlin:20261013T000000'],
    ['floating midnight', 'RECURRENCE-ID:20261013T000000'],
    ['UTC midnight', 'RECURRENCE-ID:20261013T000000Z'],
  ])('a timed RECURRENCE-ID (%s) on an all-day series names the date it is written on', (_, rid) => {
    expect(days(allDay(rid))).toEqual(['2026-10-12T00:00-23:59']);
  });

  test('at the autumn DST fold, a RECURRENCE-ID matches the instant it names', () => {
    // 25 October 2026, 02:00 in Berlin happens twice; 01:00Z is the second
    const series = object(BERLIN,
      vevent('SUMMARY:Night', 'DTSTART;TZID=Europe/Berlin:20261001T020000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY'),
      vevent('SUMMARY:Moved', 'RECURRENCE-ID:20261025T010000Z', 'DTSTART:20261030T103000Z', 'DURATION:PT1H'));
    expect(busyOn(series, '2026-10-30')).toEqual(['2026-10-30T01:00-02:00', '2026-10-30T10:30-11:30']);
    expect(busyOn(series, '2026-10-25')).toEqual([]);
  });

  test('an EXDATE and an override written in UTC on a floating series name nothing', () => {
    const series = object(
      vevent('SUMMARY:Floating', 'DTSTART:20261001T090000', 'DTEND:20261001T100000', 'RRULE:FREQ=DAILY', 'EXDATE:20261013T090000Z'),
      vevent('SUMMARY:Override', 'RECURRENCE-ID:20261013T090000Z', 'DTSTART:20261013T120000', 'DTEND:20261013T130000'));
    const local = (h) => new Date(2026, 9, 13, h);
    // the 09:00 occurrence stays, unmoved
    expect(calculateFreeBusy([series], { start: local(0), end: local(23) }).busy).toEqual([{ start: local(9), end: local(10) }]);
  });

});

describe('the step cap is never silent', () => {
  const window = { time_range_start: '2026-10-12T00:00:00Z', time_range_end: '2026-10-12T12:00:00Z' };

  test('free/busy names a series it could not expand fully instead of reporting the time free', async () => {
    // COUNT with BYDAY cannot start near the range: ~400 000 steps to get there
    stored = [object(vevent('SUMMARY:Polling', 'DTSTART:20260101T000000Z', 'DURATION:PT10M',
      'RRULE:FREQ=MINUTELY;BYDAY=MO,TU,WE,TH,FR;COUNT=999999'))];
    const text = (await freeBusyQuery.handler(window)).content[0].text;
    expect(text).toContain('**Warning**');
    expect(text).toContain(`Polling (${CALENDAR_URL}standup.ics)`);
    expect(text).not.toContain('Nothing blocks this window');
  });

  test('a dense rule is expanded from the range, not from a day before it', () => {
    // two occurrences a minute: a week is 20 160 of them
    const dense = object(vevent('SUMMARY:Ticks', 'DTSTART:20200101T000000Z', 'DURATION:PT10S', 'RRULE:FREQ=MINUTELY;BYSECOND=0,30'));
    const { busy, incomplete } = calculateFreeBusy([dense],
      { start: new Date('2026-10-14T10:00:00Z'), end: new Date('2026-10-21T10:00:00Z') });
    expect(incomplete).toEqual([]);
    expect(busy).toHaveLength(20160);
  });

  test('a time-of-day part that limits the rule is walked from DTSTART, not shifted', () => {
    // ical.js does not step HOURLY;BYHOUR on a fixed grid, so a shifted
    // start would yield other hours than the series has
    const plan = (rule) => relateSeries(readSeries(new ICAL.Component(ICAL.parse(object(
      vevent('SUMMARY:x', 'DTSTART:20230623T230700Z', 'DURATION:PT1H', `RRULE:${rule}`)).data)), 'vevent').master, []).plan;
    expect(plan('FREQ=HOURLY;INTERVAL=5;BYHOUR=20,23')).toBeNull();
    expect(plan('FREQ=DAILY;BYHOUR=9,17')).not.toBeNull();
    expect(plan('FREQ=HOURLY;BYMINUTE=0,30')).not.toBeNull();
  });

  test('hourly and minutely series start near the range like daily ones', async () => {
    stored = [object(vevent('SUMMARY:Hourly', 'DTSTART:20250101T000000Z', 'DURATION:PT10M', 'RRULE:FREQ=HOURLY'))];
    const text = (await freeBusyQuery.handler(window)).content[0].text;
    expect(text).toContain('### Busy (12)');
    expect(text).not.toContain('Warning');
  });
});

describe('the near-range start and the budget, at their edges', () => {
  const seriesOf = (...vevents) => {
    const root = new ICAL.Component(ICAL.parse(object(...vevents).data));
    const { master, overrides } = readSeries(root, 'vevent');
    return relateSeries(master, overrides);
  };
  const OCT = { start: Date.UTC(2026, 9, 12), end: Date.UTC(2026, 9, 19) };

  test('a period start the rule does not generate is no occurrence, even when an override names it', () => {
    // Tuesdays, from a Monday: only that first Monday is an occurrence
    // (RFC 5545 counts DTSTART). 14 September is a Monday a whole number of
    // weeks later: the check of an override naming it starts its walk there
    const series = seriesOf(
      vevent('SUMMARY:Tuesdays', 'DTSTART:20200106T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=TU'),
      vevent('SUMMARY:Orphan', 'RECURRENCE-ID:20260914T090000Z', 'DTSTART:20261014T120000Z', 'DURATION:PT1H'));
    const names = seriesOccurrences(series, OCT).occurrences.map((o) => o.item.summary);
    expect(names).toEqual(['Tuesdays']);
  });

  test('a period start after UNTIL is no occurrence, even when an override names it', () => {
    // every third day at 23:00 in Kolkata until 7 November; an override of
    // 10 November, on the grid but after the end, is moved into the range
    const series = seriesOf(
      vevent('SUMMARY:Every third day', 'DTSTART;TZID=Asia/Kolkata:20000206T230000', 'DURATION:PT10M',
        'RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261107T173001Z'),
      vevent('SUMMARY:After the end', 'RECURRENCE-ID;TZID=Asia/Kolkata:20261110T230000',
        'DTSTART;TZID=Asia/Kolkata:20261104T103000', 'DURATION:PT1H'));
    const range = { start: Date.UTC(2026, 10, 3, 18), end: Date.UTC(2026, 10, 6, 18) };
    expect(seriesOccurrences(series, range).occurrences.map((o) => o.item.summary)).toEqual(['Every third day']);
  });

  test('when the budget runs out before a THISANDFUTURE override is checked, nothing it might move is reported', () => {
    const daily = vevent('SUMMARY:Daily', 'DTSTART:20000101T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY');
    const future = vevent('SUMMARY:Later', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20100105T090000Z',
      'DTSTART:20100105T110000Z', 'DURATION:PT1H');
    // what the walk over the range alone costs
    const probe = createRecurrenceBudget(1e6);
    seriesOccurrences(seriesOf(daily), OCT, { budget: probe });
    const mainOnly = 1e6 - probe.remaining;
    // with that much, the walk over the range completes but the override
    // before it cannot be checked
    const result = seriesOccurrences(seriesOf(daily, future), OCT, { budget: createRecurrenceBudget(mainOnly) });
    expect(result.truncated).toBe(true);
    expect(result.occurrences).toEqual([]);
    // with enough, every occurrence is moved to 11:00
    const whole = seriesOccurrences(seriesOf(daily, future), OCT);
    expect(whole.truncated).toBe(false);
    expect(whole.occurrences.map((o) => new Date(o.startAt).toISOString().slice(11, 16))).toEqual(Array(7).fill('11:00'));
  });
});

describe('no series can stall a tool call (ical.js loops between candidates)', () => {
  const week = { time_range_start: '2026-10-12T00:00:00Z', time_range_end: '2026-10-19T00:00:00Z' };
  const timed = async (objects, tool = freeBusyQuery, args = {}) => {
    stored = objects;
    const started = performance.now();
    const text = (await tool.handler({ ...week, ...args })).content[0].text;
    return { text, elapsed: performance.now() - started };
  };
  const one = (uid, ...lines) => ({ ...object(vevent('SUMMARY:x', ...lines)), url: `${CALENDAR_URL}${uid}.ics` });

  test('a limiting BYHOUR on SECONDLY since 1950 is reported incomplete, fast', async () => {
    const { text, elapsed } = await timed([one('s', 'DTSTART:19500101T090000Z', 'DURATION:PT1M',
      'RRULE:FREQ=SECONDLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0')]);
    expect(text).toContain('**Warning**');
    expect(elapsed).toBeLessThan(2000);
  });

  test('50 such series in one call share one budget', async () => {
    const objects = Array.from({ length: 50 }, (_, i) => one(`m${i}`, 'DTSTART:19600101T100000Z', 'DURATION:PT1M',
      'RRULE:FREQ=MINUTELY;BYHOUR=10;BYMINUTE=0'));
    for (const [tool, args] of [[freeBusyQuery, {}], [calendarQuery, {}], [listEvents, { calendar_url: CALENDAR_URL }]]) {
      const { elapsed } = await timed(objects, tool, args);
      expect(elapsed).toBeLessThan(2000);
    }
  });

  test('a rule no date satisfies (30 February) returns', async () => {
    const { text, elapsed } = await timed([one('feb', 'DTSTART:20260101T100000Z', 'DURATION:PT1H',
      'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30')], calendarQuery);
    expect(text).toContain('no occurrence of this series falls inside the queried range');
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('the expansion still starts near the range', () => {
  beforeEach(() => jest.restoreAllMocks());

  test('an override moved from 2031 into 2026 is found without walking the series from 2000', () => {
    const root = new ICAL.Component(ICAL.parse(object(
      vevent('SUMMARY:Daily', 'DTSTART:20000101T090000Z', 'DTEND:20000101T100000Z', 'RRULE:FREQ=DAILY'),
      override('20310601T090000Z', '20261014T150000Z', '20261014T160000Z'),
    ).data));
    const { master, overrides } = readSeries(root, 'vevent');

    const start = Date.UTC(2026, 9, 14);
    const series = relateSeries(master, overrides);
    const near = createRecurrenceBudget(1e6);
    const { occurrences, truncated } = seriesOccurrences(series, { start, end: start + 86400000 }, { budget: near });

    expect(truncated).toBe(false);
    expect(occurrences.map((o) => o.item.summary)).toEqual(['Daily', 'Standup (01)']);
    // ~9700 days since DTSTART, ~1800 more to the override: what a walk from
    // DTSTART spends, a near start does not
    series.plan = null;
    const far = createRecurrenceBudget(1e6);
    seriesOccurrences(series, { start, end: start + 86400000 }, { budget: far });
    expect(1e6 - near.remaining).toBeLessThan((1e6 - far.remaining) / 20);
  });

  test('1000 overrides of an every-minute series from 2000 on are checked within one budget', () => {
    const lines = [...vevent('SUMMARY:Minutely', 'DTSTART:20000101T000000Z', 'DURATION:PT1M', 'RRULE:FREQ=MINUTELY')];
    for (let i = 0; i < 1000; i++) {
      const rid = new Date(Date.UTC(2000, 0, 1) + i * 11 * 86400000 + i * 60000).toISOString().replace(/[-:]|\.000/g, '');
      const at = new Date(Date.UTC(2026, 9, 12) + i * 60000).toISOString().replace(/[-:]|\.000/g, '');
      lines.push(...vevent(`SUMMARY:ov ${i}`, `RECURRENCE-ID:${rid}`, `DTSTART:${at}`, 'DURATION:PT20M'));
    }
    const heavy = object(lines);
    // one day: the 1440 occurrences of the day itself are not what is measured
    const day = { start: new Date('2026-10-12T00:00:00Z'), end: new Date('2026-10-13T00:00:00Z') };

    // 123 s before the step budget, ~0.2 s now
    const started = performance.now();
    const { incomplete } = calculateFreeBusy([heavy], day);
    const shown = shownEvent(new ICAL.Component(ICAL.parse(heavy.data)),
      { start: day.start.toISOString(), end: day.end.toISOString() }, (v) => /^ov /.test(v.getFirstPropertyValue('summary')));
    const elapsed = performance.now() - started;

    expect(incomplete).toEqual([]);
    expect(shown.item.summary).toBe('ov 0');
    expect(elapsed).toBeLessThan(2000);
  });

  test('200 overrides moved in from years away are checked in one pass', () => {
    // DAILY;COUNT=20000 from 2000, overrides of 2027-2030 moved into one week of 2026
    const lines = [...BERLIN, ...vevent('SUMMARY:Daily', 'DTSTART;TZID=Europe/Berlin:20000101T100000',
      'DTEND;TZID=Europe/Berlin:20000101T110000', 'RRULE:FREQ=DAILY;COUNT=20000')];
    for (let i = 0; i < 200; i++) {
      const rid = new Date(Date.UTC(2027, 0, 1) + i * 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(...vevent(`SUMMARY:ov ${i}`, `RECURRENCE-ID;TZID=Europe/Berlin:${rid}T100000`,
        `DTSTART;TZID=Europe/Berlin:202610${12 + (i % 5)}T${String(6 + (i % 10)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00`,
        'DURATION:PT1H'));
    }
    const heavy = object(lines);
    const week = { start: new Date('2026-10-12T00:00:00Z'), end: new Date('2026-10-19T00:00:00Z') };

    const started = performance.now();
    const { busy, incomplete } = calculateFreeBusy([heavy], week);
    const shown = shownEvent(new ICAL.Component(ICAL.parse(heavy.data)),
      { start: week.start.toISOString(), end: week.end.toISOString() });
    const elapsed = performance.now() - started;

    expect(incomplete).toEqual([]);
    expect(busy.length).toBeGreaterThan(7);
    expect(shown.item.summary).toMatch(/^ov /);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('differential: fast path against a full expansion from DTSTART', () => {
  test('random series, overrides and ranges agree in four host zones', async () => {
    const script = fileURLToPath(new URL('./fixtures/override-differential.mjs', import.meta.url));
    const zones = ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati'];
    // one child per zone, in parallel: the zone is fixed per process
    const results = await Promise.all(zones.map(async (zone) => {
      const { stdout } = await promisify(execFile)(process.execPath, [script, '100', '98'], {
        env: { ...process.env, TZ: zone, LOG_LEVEL: 'silent' },
        encoding: 'utf8',
      });
      return { zone, ...JSON.parse(stdout.trim().split('\n').pop()) };
    }));
    for (const result of results) {
      expect(result.examples).toEqual([]);
      expect(result).toMatchObject({ compared: 400, deviations: 0 });
      // the step cap is exercised, and only ever drops occurrences
      expect(result.truncated).toBeGreaterThan(0);
    }
  }, 90000);
});

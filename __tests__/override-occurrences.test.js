import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
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
const { readSeries, seriesOccurrences } = await import('../src/ical-components.js');
const { calendarQuery } = await import('../src/tools/calendar/calendar-query.js');
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

describe('the expansion still starts near the range', () => {
  beforeEach(() => jest.restoreAllMocks());

  test('an override moved from 2031 into 2026 is found without walking the series from 2000', () => {
    const root = new ICAL.Component(ICAL.parse(object(
      vevent('SUMMARY:Daily', 'DTSTART:20000101T090000Z', 'DTEND:20000101T100000Z', 'RRULE:FREQ=DAILY'),
      override('20310601T090000Z', '20261014T150000Z', '20261014T160000Z'),
    ).data));
    const { master, overrides } = readSeries(root, 'vevent');
    const event = new ICAL.Event(master);
    overrides.forEach((o) => event.relateException(o));

    const next = jest.spyOn(ICAL.RecurExpansion.prototype, 'next');
    const start = Date.UTC(2026, 9, 14) / 1000;
    const { occurrences, truncated } = seriesOccurrences(event, { start, end: start + 86400 },
      (o) => o.startDate.toUnixTime() >= start && o.startDate.toUnixTime() < start + 86400);

    expect(truncated).toBe(false);
    expect(occurrences.map((o) => o.item.summary)).toEqual(['Daily', 'Standup (01)']);
    // ~9700 days since DTSTART, ~1800 more to the override: a walk covers neither
    expect(next.mock.calls.length).toBeLessThan(100);
  });
});

describe('differential: fast path against a full expansion from DTSTART', () => {
  test.each(['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati'])(
    'random series, overrides and ranges agree (host %s)', (zone) => {
      const script = fileURLToPath(new URL('./fixtures/override-differential.mjs', import.meta.url));
      const out = execFileSync(process.execPath, [script, '80', '98'], {
        env: { ...process.env, TZ: zone, LOG_LEVEL: 'silent' },
        encoding: 'utf8',
      });
      const result = JSON.parse(out.trim().split('\n').pop());
      expect(result.examples).toEqual([]);
      expect(result).toMatchObject({ compared: 320, deviations: 0, truncated: 0 });
    },
    60000,
  );
});

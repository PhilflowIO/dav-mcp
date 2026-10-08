import { describe, test, expect } from '@jest/globals';

// Issue #126: listings name each occurrence of a recurring event or todo the
// way cancel_occurrences / restore_occurrences take it — its ORIGINAL start,
// in the series' own form — and show the exclusions (EXDATE) and changed
// occurrences (overrides) in that same form, whatever zone each is stored in.
// The round trip through the handlers is in cancel-occurrences.test.js.
const { formatEvent, formatEventList } = await import('../src/formatters.js');

const EVENT_URL = 'https://dav.example.com/calendars/user/work/event.ics';

const VTIMEZONE_BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const calendar = (type, ...components) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...VTIMEZONE_BERLIN,
  ...components.flatMap((props) => [`BEGIN:${type}`, 'DTSTAMP:20260101T000000Z', ...props, `END:${type}`]),
  'END:VCALENDAR',
].join('\r\n');

const SERIES = [
  'UID:weekly@test', 'SUMMARY:Planning',
  'DTSTART;TZID=Europe/Berlin:20261001T100000', 'DTEND;TZID=Europe/Berlin:20261001T110000',
  'RRULE:FREQ=WEEKLY',
  'EXDATE;TZID=Europe/Berlin:20261224T100000',
  'EXDATE:20261231T090000Z',
];
const OVERRIDE = [
  'UID:weekly@test', 'SUMMARY:Planning (moved)', 'RECURRENCE-ID;TZID=Europe/Berlin:20261105T100000',
  'DTSTART;TZID=Europe/Berlin:20261105T150000', 'DTEND;TZID=Europe/Berlin:20261105T160000',
];

describe('listings name occurrences as the update tools take them (#126)', () => {
  test('a series without a range: its start, exclusions in its own form, changed occurrences', () => {
    const text = formatEvent({ url: EVENT_URL, data: calendar('VEVENT', SERIES, OVERRIDE) }, 'Work');
    expect(text).toContain('- **Occurrence ID**: 2026-10-01T10:00:00 (series start)\n');
    // the UTC-stored exclusion is shown on the Berlin wall clock
    expect(text).toContain('- **Cancelled occurrences**: 2026-12-24T10:00:00, 2026-12-31T10:00:00\n');
    expect(text).toMatch(/- \*\*Changed occurrences\*\* \(by original start\): 2026-11-05T10:00:00 \(now November 5, 2026, 03:00 PM GMT\+1\)\n/);
  });

  test('an occurrence in a range: its original start; a changed one says so', () => {
    const data = calendar('VEVENT', SERIES, OVERRIDE);
    const plain = formatEvent({ url: EVENT_URL, data }, 'Work',
      { start: '2026-10-14T00:00:00Z', end: '2026-10-16T00:00:00Z' });
    expect(plain).toContain('- **Occurrence ID**: 2026-10-15T10:00:00 (this occurrence)\n');

    const moved = formatEvent({ url: EVENT_URL, data }, 'Work',
      { start: '2026-11-04T00:00:00Z', end: '2026-11-06T00:00:00Z' });
    expect(moved).toContain('- **Occurrence ID**: 2026-11-05T10:00:00 (this occurrence, changed — now at November 5, 2026, 03:00 PM GMT+1)\n');
  });

  test('UTC and all-day series are named in their own form; a non-recurring event gets no lines', () => {
    const utc = formatEvent({ url: EVENT_URL, data: calendar('VEVENT', [
      'UID:u@test', 'SUMMARY:Sync', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z',
      'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Berlin:20261012T110000',
    ]) }, 'Work');
    expect(utc).toContain('- **Occurrence ID**: 2026-10-05T09:00:00Z (series start)\n');
    expect(utc).toContain('- **Cancelled occurrences**: 2026-10-12T09:00:00Z\n');

    const allDay = formatEvent({ url: EVENT_URL, data: calendar('VEVENT', [
      'UID:d@test', 'SUMMARY:Bins', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006',
      'RRULE:FREQ=WEEKLY', 'EXDATE;VALUE=DATE:20261012',
    ]) }, 'Work');
    expect(allDay).toContain('- **Occurrence ID**: 2026-10-05 (series start)\n');
    expect(allDay).toContain('- **Cancelled occurrences**: 2026-10-12\n');

    const single = formatEvent({ url: EVENT_URL, data: calendar('VEVENT', [
      'UID:s@test', 'SUMMARY:Once', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z',
    ]) }, 'Work');
    expect(single).not.toContain('Occurrence ID');
  });

  test('a whole-day exclusion of a timed series is labelled', () => {
    const text = formatEventList([{ url: EVENT_URL, etag: '"1"', data: calendar('VEVENT', [
      'UID:twice@test', 'SUMMARY:Check',
      'DTSTART;TZID=Europe/Berlin:20261005T090000', 'DTEND;TZID=Europe/Berlin:20261005T093000',
      'RRULE:FREQ=DAILY;BYHOUR=9,17', 'EXDATE;VALUE=DATE:20261007',
    ]) }], 'Work').content[0].text;
    expect(text).toContain('- **Cancelled occurrences**: 2026-10-07 (whole day)\n');
  });
});

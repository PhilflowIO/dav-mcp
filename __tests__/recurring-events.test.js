import { describe, test, expect } from '@jest/globals';
import { formatEvent, formatEventList } from '../src/formatters.js';

const NEW_YORK_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZNAME:EDT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZNAME:EST',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

const calendarObject = (vevents, vtimezone = '') => ({
  url: 'https://dav.example.com/calendars/user/work/e.ics',
  etag: '"1"',
  data: [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Test//EN',
    ...(vtimezone ? [vtimezone] : []),
    ...vevents,
    'END:VCALENDAR',
  ].join('\r\n'),
});

// A weekly series created in January, i.e. in EST (UTC-5).
const WEEKLY = calendarObject([
  [
    'BEGIN:VEVENT',
    'UID:weekly@example.com',
    'SUMMARY:Weekly standup',
    'DTSTART;TZID=America/New_York:20260105T090000',
    'DTEND;TZID=America/New_York:20260105T093000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
    'END:VEVENT',
  ].join('\r\n'),
], NEW_YORK_VTIMEZONE);

const range = (start, end) => ({ start, end });
const when = (output) => output.split('\n').find(l => l.startsWith('- **When**')).replace('- **When**: ', '');

describe('recurring events resolve to the occurrence in the queried range', () => {
  test('without a range, the series start is shown', () => {
    expect(when(formatEvent(WEEKLY, 'Work'))).toContain('January 5, 2026');
  });

  test('an August query shows the August occurrence, not January', () => {
    const output = formatEvent(WEEKLY, 'Work', range('2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z'));
    expect(when(output)).toContain('August 3, 2026');
    expect(output).not.toContain('January');
  });

  test('the occurrence carries the offset in force on that date, not the series start offset', () => {
    // January is EST (UTC-5); an August occurrence is EDT (UTC-4). The wall
    // time stays 9 AM either way — that is what the user booked.
    const output = formatEvent(WEEKLY, 'Work', range('2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z'));
    expect(when(output)).toContain('09:00 AM');
    expect(when(output)).toContain('EDT');
    expect(when(output)).not.toContain('EST');
  });

  test('the duration of the occurrence is preserved', () => {
    const output = formatEvent(WEEKLY, 'Work', range('2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z'));
    expect(when(output)).toContain('09:30 AM');
  });

  test('formatEventList passes the range to every event', () => {
    const text = formatEventList([WEEKLY], 'Work', range('2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z')).content[0].text;
    expect(text).toContain('August 3, 2026');
    expect(text).not.toContain('January');
  });

  test('a range in a "+02:00" offset form is honoured, not read as floating', () => {
    const output = formatEvent(WEEKLY, 'Work', range('2026-08-03T02:00:00+02:00', '2026-08-10T02:00:00+02:00'));
    expect(when(output)).toContain('August 3, 2026');
  });

  test('a range with milliseconds is accepted', () => {
    const output = formatEvent(WEEKLY, 'Work', range('2026-08-03T00:00:00.000Z', '2026-08-10T00:00:00.000Z'));
    expect(when(output)).toContain('August 3, 2026');
  });
});

describe('RECURRENCE-ID overrides', () => {
  const MOVED = calendarObject([
    [
      'BEGIN:VEVENT',
      'UID:weekly@example.com',
      'SUMMARY:Weekly standup',
      'DTSTART;TZID=America/New_York:20260105T090000',
      'DTEND;TZID=America/New_York:20260105T093000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'END:VEVENT',
    ].join('\r\n'),
    [
      'BEGIN:VEVENT',
      'UID:weekly@example.com',
      'RECURRENCE-ID;TZID=America/New_York:20260803T090000',
      'SUMMARY:Weekly standup (moved to 14:00)',
      'DTSTART;TZID=America/New_York:20260803T140000',
      'DTEND;TZID=America/New_York:20260803T143000',
      'END:VEVENT',
    ].join('\r\n'),
  ], NEW_YORK_VTIMEZONE);

  test('a moved occurrence is shown at its new time with its new title', () => {
    const output = formatEvent(MOVED, 'Work', range('2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z'));
    expect(output).toContain('moved to 14:00');
    expect(when(output)).toContain('02:00 PM');
  });

  test('the master is still used for other weeks', () => {
    const output = formatEvent(MOVED, 'Work', range('2026-08-10T00:00:00Z', '2026-08-17T00:00:00Z'));
    expect(when(output)).toContain('August 10, 2026');
    expect(when(output)).toContain('09:00 AM');
    expect(output).not.toContain('moved to 14:00');
  });

  test('an override serialized first does not hide the series', () => {
    const overrideFirst = calendarObject([
      [
        'BEGIN:VEVENT',
        'UID:weekly@example.com',
        'RECURRENCE-ID;TZID=America/New_York:20260803T090000',
        'SUMMARY:Weekly standup (moved to 14:00)',
        'DTSTART;TZID=America/New_York:20260803T140000',
        'DTEND;TZID=America/New_York:20260803T143000',
        'END:VEVENT',
      ].join('\r\n'),
      [
        'BEGIN:VEVENT',
        'UID:weekly@example.com',
        'SUMMARY:Weekly standup',
        'DTSTART;TZID=America/New_York:20260105T090000',
        'DTEND;TZID=America/New_York:20260105T093000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'END:VEVENT',
      ].join('\r\n'),
    ], NEW_YORK_VTIMEZONE);

    const output = formatEvent(overrideFirst, 'Work', range('2026-08-10T00:00:00Z', '2026-08-17T00:00:00Z'));
    expect(when(output)).toContain('August 10, 2026');
  });
});

describe('when nothing falls in the range, the output says so', () => {
  test('EXDATE removes the only occurrence in the range', () => {
    const withExdate = calendarObject([
      [
        'BEGIN:VEVENT',
        'UID:weekly@example.com',
        'SUMMARY:Weekly standup',
        'DTSTART;TZID=America/New_York:20260105T090000',
        'DTEND;TZID=America/New_York:20260105T093000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'EXDATE;TZID=America/New_York:20260803T090000',
        'END:VEVENT',
      ].join('\r\n'),
    ], NEW_YORK_VTIMEZONE);

    const output = formatEvent(withExdate, 'Work', range('2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z'));
    expect(output).toContain('no occurrence of this series falls inside the queried range');
  });

  test('a series that ended before the range', () => {
    const ended = calendarObject([
      [
        'BEGIN:VEVENT',
        'UID:weekly@example.com',
        'SUMMARY:Weekly standup',
        'DTSTART;TZID=America/New_York:20260105T090000',
        'DTEND;TZID=America/New_York:20260105T093000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260204T090000Z',
        'END:VEVENT',
      ].join('\r\n'),
    ], NEW_YORK_VTIMEZONE);

    const output = formatEvent(ended, 'Work', range('2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z'));
    expect(output).toContain('no occurrence of this series falls inside the queried range');
  });

  test('a non-recurring event is never annotated', () => {
    const single = calendarObject([
      [
        'BEGIN:VEVENT',
        'UID:single@example.com',
        'SUMMARY:One-off',
        'DTSTART:20260525T100000Z',
        'DTEND:20260525T110000Z',
        'END:VEVENT',
      ].join('\r\n'),
    ]);

    const output = formatEvent(single, 'Work', range('2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z'));
    expect(output).not.toContain('no occurrence');
  });
});

describe('expansion is bounded', () => {
  test('a degenerate series far in the past does not stall the formatter', () => {
    const everyMinuteSince1970 = calendarObject([
      [
        'BEGIN:VEVENT',
        'UID:minutely@example.com',
        'SUMMARY:Pathological',
        'DTSTART:19700101T000000Z',
        'DTEND:19700101T000100Z',
        'RRULE:FREQ=MINUTELY',
        'END:VEVENT',
      ].join('\r\n'),
    ]);

    const started = process.hrtime.bigint();
    const output = formatEvent(everyMinuteSince1970, 'Work', range('2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z'));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(2000);
    expect(output).toContain('too many occurrences to expand');
    // it must not claim there is no occurrence — it simply did not get there
    expect(output).not.toContain('no occurrence of this series falls inside');
  });
});

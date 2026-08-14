import { describe, test, expect } from '@jest/globals';
import { formatEvent } from '../src/formatters.js';

// These assertions are deliberately host-timezone independent: an event that
// carries its own zone must render the same wall time no matter where the
// server runs, which is precisely what was broken.
const BERLIN_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n');

const event = (properties, vtimezone = '') => ({
  url: 'https://dav.example.com/calendars/user/work/e.ics',
  etag: '"1"',
  data: [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Test//EN',
    ...(vtimezone ? [vtimezone] : []),
    'BEGIN:VEVENT',
    'UID:e@example.com',
    'SUMMARY:Standup',
    ...properties,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'),
});

const when = (ev) => formatEvent(ev, 'Work')
  .split('\n')
  .find(line => line.startsWith('- **When**'))
  .replace('- **When**: ', '');

describe('formatDateTime', () => {
  test('a UTC event renders in UTC, whatever the host zone', () => {
    const output = when(event(['DTSTART:20260715T140000Z', 'DTEND:20260715T150000Z']));
    expect(output).toBe('July 15, 2026, 02:00 PM UTC to July 15, 2026, 03:00 PM UTC');
  });

  test('a zoned event renders the wall time the user booked', () => {
    const output = when(event([
      'DTSTART;TZID=Europe/Berlin:20260715T140000',
      'DTEND;TZID=Europe/Berlin:20260715T150000',
    ], BERLIN_VTIMEZONE));
    expect(output).toBe('July 15, 2026, 02:00 PM GMT+2 to July 15, 2026, 03:00 PM GMT+2');
  });

  test('an all-day event renders a date with no time and no offset', () => {
    const output = when(event(['DTSTART;VALUE=DATE:20260715', 'DTEND;VALUE=DATE:20260716']));
    expect(output).toBe('July 15, 2026 to July 16, 2026');
    expect(output).not.toMatch(/AM|PM|UTC|GMT/);
  });

  test('an all-day event does not shift date across host zones', () => {
    // the bug this guards: toJSDate() anchors a floating DATE to the host
    // offset, so 2026-07-15 rendered as 2026-07-14 east of Greenwich
    const output = when(event(['DTSTART;VALUE=DATE:20260715', 'DTEND;VALUE=DATE:20260716']));
    expect(output).toContain('July 15, 2026');
  });

  test('a TZID that Intl does not know still renders a date', () => {
    // Exchange and Outlook emit these; handing one to toLocaleDateString
    // throws RangeError, which used to be swallowed into an empty string
    const output = when(event([
      'DTSTART;TZID=W. Europe Standard Time:20260715T140000',
      'DTEND;TZID=W. Europe Standard Time:20260715T150000',
    ], BERLIN_VTIMEZONE.replace(/Europe\/Berlin/, 'W. Europe Standard Time')));
    expect(output).not.toBe('');
    expect(output).toContain('July 15, 2026');
  });

  test('a floating time renders without throwing', () => {
    const output = when(event(['DTSTART:20260715T140000', 'DTEND:20260715T150000']));
    expect(output).toContain('July 15, 2026');
    expect(output).toMatch(/02:00 PM/);
  });
});

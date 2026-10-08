import { describe, test, expect, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

connectTo('https://dav.example.com/');

// Review of #126: every Occurrence ID a listing shows, passed back to
// cancel_occurrences, cancels exactly that occurrence — across zones, UTC
// series, extra dates (RDATE) stored in another zone or in UTC, overrides
// whose RECURRENCE-ID is written in UTC, and existing exclusions. The listing
// (real formatter) and the cancel (real handler, installed tsdav-utils) are
// checked against tsdav-utils' own expansion.
const URL = 'https://dav.example.com/calendars/user/work/event.ics';
let stored = '';
const updateCalendarObject = jest.fn(async () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) }));

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendarObjects: async () => [{ url: URL, etag: '"1"', data: stored }],
      updateCalendarObject,
    }),
    getCardDavClient: () => ({}),
  },
}));

const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { formatEvent } = await import('../src/formatters.js');
const { expandOccurrences, createRecurrenceBudget } = await import('tsdav-utils');

const ZONES = {
  'Europe/Berlin': ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
    'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
    'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'],
  'America/New_York': ['BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE'],
};

const series = (lines, overrides = []) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...ZONES['Europe/Berlin'], ...ZONES['America/New_York'],
  'BEGIN:VEVENT', 'UID:rt@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Round trip', ...lines, 'END:VEVENT',
  ...overrides.flatMap((o) => ['BEGIN:VEVENT', 'UID:rt@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Moved', ...o, 'END:VEVENT']),
  'END:VCALENDAR',
].join('\r\n');

const B = 'TZID=Europe/Berlin';
const CASES = {
  'Berlin weekly across the DST change': series([`DTSTART;${B}:20261019T090000`, `DTEND;${B}:20261019T100000`, 'RRULE:FREQ=WEEKLY;COUNT=4']),
  'Berlin daily, RDATE in UTC and in New York, EXDATE in UTC': series([
    `DTSTART;${B}:20261012T090000`, `DTEND;${B}:20261012T093000`, 'RRULE:FREQ=DAILY;COUNT=5',
    'RDATE:20261014T090000Z', 'RDATE;TZID=America/New_York:20261015T030000', 'EXDATE:20261013T070000Z',
  ]),
  'Berlin 09:00/17:00, a whole-day exclusion': series([
    `DTSTART;${B}:20261005T090000`, `DTEND;${B}:20261005T093000`, 'RRULE:FREQ=DAILY;COUNT=8;BYHOUR=9,17',
    'EXDATE;VALUE=DATE:20261006',
  ]),
  'Berlin weekly, override with a UTC RECURRENCE-ID': series(
    [`DTSTART;${B}:20261105T100000`, `DTEND;${B}:20261105T110000`, 'RRULE:FREQ=WEEKLY;COUNT=4'],
    [['RECURRENCE-ID:20261112T090000Z', `DTSTART;${B}:20261112T150000`, `DTEND;${B}:20261112T160000`]],
  ),
  'New York weekly, RDATE in Berlin': series([
    'DTSTART;TZID=America/New_York:20261026T080000', 'DTEND;TZID=America/New_York:20261026T090000',
    'RRULE:FREQ=WEEKLY;COUNT=3', `RDATE;${B}:20261028T200000`,
  ]),
  'UTC series, RDATE in Berlin, EXDATE in Berlin': series([
    'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=4',
    `RDATE;${B}:20261007T120000`, `EXDATE;${B}:20261012T110000`,
  ]),
};

const occurrencesOf = (data) => expandOccurrences(data, {
  budget: createRecurrenceBudget(), from: '2026-01-01T00:00:00Z', until: '2027-06-01T00:00:00Z',
}).occurrences;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('every listed Occurrence ID cancels exactly that occurrence', () => {
  for (const [name, data] of Object.entries(CASES)) {
    test(name, async () => {
      const before = occurrencesOf(data);
      expect(before.length).toBeGreaterThan(2);
      for (const occurrence of before) {
        // list the occurrence where it is now (an override moved elsewhere
        // is found at its new time) and read back its original start
        const at = Date.parse(occurrence.start.instant);
        const text = formatEvent({ url: URL, data }, 'Work', { start: iso(at), end: iso(at + 1000) });
        const id = /\*\*Occurrence ID\*\*: (\S+)/.exec(text)[1];
        // the listing names it as the library does
        expect([occurrence.recurrenceId.value, id]).toEqual([id, id]);

        stored = data;
        updateCalendarObject.mockClear();
        await updateEventFields.handler({ event_url: URL, event_etag: '"1"', cancel_occurrences: [id] });
        const after = occurrencesOf(updateCalendarObject.mock.calls[0][0].calendarObject.data);
        expect(after.map((o) => o.recurrenceId.instant))
          .toEqual(before.filter((o) => o !== occurrence).map((o) => o.recurrenceId.instant));
      }
    });
  }
});

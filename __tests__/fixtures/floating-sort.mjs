// Runs calendar_query in a child process whose timezone the parent fixes via
// the TZ variable: a floating time becomes an instant only on the host clock,
// so the order under test exists only for a known host zone. Prints the URLs
// listed for limit 1 and limit 2 as JSON.
import { tsdavManager } from '../../src/tsdav-client.js';
import { calendarQuery } from '../../src/tools/calendar/calendar-query.js';

const CALENDAR_URL = 'https://dav.example.com/calendars/user/main/';
const ics = (name, ...lines) => ({
  url: `${CALENDAR_URL}${name}.ics`,
  etag: '"1"',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${name}@test`,
    'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
});

tsdavManager.calDavClient = {
  fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Main' }],
  fetchCalendarObjects: async () => [
    ics('utc2300', 'DTSTART:20261007T230000Z', 'DTEND:20261008T020000Z', 'SUMMARY:Single'),
    ics('float0030', 'DTSTART:20260101T003000', 'DURATION:PT15M', 'RRULE:FREQ=DAILY', 'SUMMARY:Floating'),
    ics('late', 'DTSTART:20261008T200000Z', 'DURATION:PT1H', 'SUMMARY:Late'),
  ],
};

const range = { time_range_start: '2026-10-08T00:00:00Z', time_range_end: '2026-10-09T00:00:00Z' };
const urls = async (limit) => {
  const text = (await calendarQuery.handler({ ...range, limit })).content[0].text;
  return [...text.matchAll(/- \*\*URL\*\*: (\S+)/g)].map((m) => m[1].split('/').pop());
};
console.log(JSON.stringify([await urls(1), await urls(2)]));

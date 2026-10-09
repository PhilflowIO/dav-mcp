// Reads floating times and dates of a calendar in a child process whose host
// zone the parent sets via TZ, so the test shows which clock they are read on:
// the calendar's calendar-timezone (argv[2], an IANA name, or "" for none),
// else the host's. Prints one JSON line: the busy intervals free/busy finds
// (ISO UTC) and the "When" line list_events shows for the occurrence in a
// range.
import { connectTo } from '../support/request-origins.js';
import { calculateFreeBusy } from '../../src/tools/shared/freebusy.js';
import { calendarTimezoneValue, floatingZoneFor, withFloatingZone } from '../../src/calendar-zone.js';
import { tsdavManager } from '../../src/tsdav-client.js';
import { listEvents } from '../../src/tools/calendar/list-events.js';

connectTo('https://dav.example.com/');
const CALENDAR_URL = 'https://dav.example.com/calendars/user/main/';
const tzid = process.argv[2] ?? '';
const calendar = { url: CALENDAR_URL, displayName: 'Main', timezone: tzid ? calendarTimezoneValue(tzid).text : '' };

const ics = (name, ...lines) => ({
  url: `${CALENDAR_URL}${name}.ics`,
  etag: '"1"',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${name}@test`,
    'DTSTAMP:20260101T000000Z', `SUMMARY:${name}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
});

const objects = () => [
  // a single floating hour
  ics('single', 'DTSTART:20261010T090000', 'DTEND:20261010T100000'),
  // weekly 09:00 across the end of summer time (Berlin: Sun 25 Oct 2026)
  ics('autumn', 'DTSTART:20261019T090000', 'DTEND:20261019T100000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
  // and across its start (Berlin: Sun 28 Mar 2027)
  ics('spring', 'DTSTART:20270322T090000', 'DTEND:20270322T100000', 'RRULE:FREQ=WEEKLY;COUNT=2'),
  // an all-day event on the 25-hour day
  ics('allday', 'DTSTART;VALUE=DATE:20261025', 'DTEND;VALUE=DATE:20261026'),
  // 02:30 does not exist on 28 Mar 2027 in Berlin, and exists twice on 25 Oct 2026
  ics('gap', 'DTSTART:20270328T023000', 'DTEND:20270328T024500'),
  ics('overlap', 'DTSTART:20261025T023000', 'DTEND:20261025T024500'),
];

const range = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2027-04-01T00:00:00Z') };
const { busy } = calculateFreeBusy(withFloatingZone(objects(), floatingZoneFor(calendar)), range);

tsdavManager.calDavClient = {
  fetchCalendars: async () => [calendar],
  fetchCalendarObjects: async () => objects().filter((o) => o.url.endsWith('autumn.ics')),
};
const text = (await listEvents.handler({
  calendar_url: CALENDAR_URL,
  time_range_start: '2026-10-26T07:30:00Z',
  time_range_end: '2026-10-26T08:30:00Z',
})).content[0].text;

console.log(JSON.stringify({
  busy: busy.map(({ start, end }) => `${start.toISOString()}/${end.toISOString()}`),
  when: (/- \*\*When\*\*: (.*)/.exec(text) ?? [])[1] ?? null,
  note: /no occurrence of this series falls inside/.test(text),
}));

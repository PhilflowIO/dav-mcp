import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');

// freebusy_query printed its intervals in UTC ("01:30 PM UTC") while
// list_events and calendar_query print local times ("08:30 AM GMT+2"), and a
// model answering "when am I free?" for a Berlin user easily passed the UTC
// times off as local ones (#125). Free/busy now prints the zone the listings
// read the calendar in (#117), and says which one it is.

const BERLIN = 'https://dav.example.com/calendars/user/berlin/';
const NEW_YORK = 'https://dav.example.com/calendars/user/new-york/';
const PLAIN = 'https://dav.example.com/calendars/user/plain/';

const { calendarTimezoneValue, serverZone } = await import('../src/calendar-zone.js');

let objectsByCalendar = {};
const calendars = [
  { url: BERLIN, displayName: 'Berlin', timezone: calendarTimezoneValue('Europe/Berlin').text },
  { url: NEW_YORK, displayName: 'New York', timezone: calendarTimezoneValue('America/New_York').text },
  { url: PLAIN, displayName: 'Plain', timezone: '' },
];

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => calendars,
      fetchCalendarObjects: async ({ calendar }) => objectsByCalendar[calendar.url] ?? [],
    }),
    getCardDavClient: () => ({}),
  },
}));

const { freeBusyQuery } = await import('../src/tools/calendar/freebusy-query.js');
const { listEvents } = await import('../src/tools/calendar/list-events.js');

const object = (calendarUrl, name, ...lines) => ({
  url: `${calendarUrl}${name}.ics`,
  etag: '"1"',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${name}@test`,
    'DTSTAMP:20260101T000000Z', `SUMMARY:${name}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
});
const text = (result) => result.content[0].text;
const section = (output, title) => (output.split(`### ${title}`)[1] ?? '').split('\n### ')[0];

beforeEach(() => {
  objectsByCalendar = {};
});

describe('free/busy shows the times list_events shows', () => {
  test('a Berlin calendar: the same wall times, across the end of summer time', async () => {
    objectsByCalendar = {
      [BERLIN]: [
        // floating, read in the calendar's zone: 09:00 CET on the 26th
        object(BERLIN, 'standup', 'DTSTART:20261019T090000', 'DTEND:20261019T093000', 'RRULE:FREQ=WEEKLY'),
        // with the zone written out, before the change: 14:00 CEST on the 24th
        object(BERLIN, 'review', 'DTSTART;TZID=Europe/Berlin:20261024T140000', 'DTEND;TZID=Europe/Berlin:20261024T150000'),
      ],
    };
    const range = { time_range_start: '2026-10-24T00:00:00Z', time_range_end: '2026-10-27T00:00:00Z' };
    const freebusy = text(await freeBusyQuery.handler({ ...range, calendar_url: BERLIN }));

    expect(freebusy).toContain('- **Time zone**: Europe/Berlin (the calendar\'s)');
    expect(section(freebusy, 'Busy')).toContain('October 24, 2026, 02:00 PM GMT+2 → October 24, 2026, 03:00 PM GMT+2 (1h)');
    expect(section(freebusy, 'Busy')).toContain('October 26, 2026, 09:00 AM GMT+1 → October 26, 2026, 09:30 AM GMT+1 (30m)');
    expect(freebusy).not.toMatch(/ UTC/);
    // the window, too, in that zone: 00:00Z on the 24th is 02:00 in Berlin
    expect(freebusy).toContain('- **Window**: October 24, 2026, 02:00 AM GMT+2 to October 27, 2026, 01:00 AM GMT+1');

    const listed = text(await listEvents.handler({
      calendar_url: BERLIN, time_range_start: '2026-10-26T00:00:00Z', time_range_end: '2026-10-27T00:00:00Z',
    }));
    expect(listed).toContain('- **When**: October 26, 2026, 09:00 AM GMT+1 to October 26, 2026, 09:30 AM GMT+1');
  });

  test('a 25-hour busy day is 25 hours long in the zone it is shown in', async () => {
    objectsByCalendar = { [BERLIN]: [object(BERLIN, 'away', 'DTSTART;VALUE=DATE:20261025', 'DTEND;VALUE=DATE:20261026')] };
    const freebusy = text(await freeBusyQuery.handler({
      calendar_url: BERLIN, time_range_start: '2026-10-24T00:00:00Z', time_range_end: '2026-10-27T00:00:00Z',
    }));
    expect(section(freebusy, 'Busy')).toContain('October 25, 2026, 12:00 AM GMT+2 → October 26, 2026, 12:00 AM GMT+1 (25h)');
  });

  test('several calendars that agree on a zone are shown in it', async () => {
    const agreeing = [calendars[0], { ...calendars[1], timezone: calendars[0].timezone }, calendars[2]];
    const saved = calendars.splice(0, calendars.length, ...agreeing);
    try {
      objectsByCalendar = { [BERLIN]: [object(BERLIN, 'call', 'DTSTART:20261010T090000', 'DTEND:20261010T100000')] };
      const freebusy = text(await freeBusyQuery.handler({
        time_range_start: '2026-10-10T00:00:00Z', time_range_end: '2026-10-11T00:00:00Z',
      }));
      expect(freebusy).toContain('- **Time zone**: Europe/Berlin (the calendars\')');
      expect(section(freebusy, 'Busy')).toContain('October 10, 2026, 09:00 AM GMT+2 → October 10, 2026, 10:00 AM GMT+2');
    } finally {
      calendars.splice(0, calendars.length, ...saved);
    }
  });

  test('calendars in different zones are shown in the server\'s, and the answer says so', async () => {
    objectsByCalendar = {
      [BERLIN]: [object(BERLIN, 'berlin', 'DTSTART:20261010T090000', 'DTEND:20261010T100000')],
      [NEW_YORK]: [object(NEW_YORK, 'new-york', 'DTSTART:20261010T090000', 'DTEND:20261010T100000')],
    };
    const freebusy = text(await freeBusyQuery.handler({
      time_range_start: '2026-10-10T00:00:00Z', time_range_end: '2026-10-11T00:00:00Z',
    }));
    const server = serverZone().tzid;
    expect(freebusy).toContain(`- **Time zone**: ${server} (dav-mcp's; the calendars set different ones: Berlin Europe/Berlin, New York America/New_York)`);
    // each event read in its own calendar's zone: 07:00Z and 13:00Z
    const busy = section(freebusy, 'Busy');
    const shown = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: server });
    expect(busy).toContain(shown('2026-10-10T07:00:00Z'));
    expect(busy).toContain(shown('2026-10-10T13:00:00Z'));
  });

  test('a calendar without a zone is shown in dav-mcp\'s', async () => {
    const freebusy = text(await freeBusyQuery.handler({
      calendar_url: PLAIN, time_range_start: '2026-10-10T00:00:00Z', time_range_end: '2026-10-11T00:00:00Z',
    }));
    expect(freebusy).toContain(`- **Time zone**: ${serverZone().tzid} (dav-mcp's; the calendar sets none)`);
  });
});

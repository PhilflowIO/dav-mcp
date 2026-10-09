import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');
import ICAL from 'ical.js';
import { DAVClient } from 'tsdav';

// RFC 4791 5.2.2: CALDAV:calendar-timezone holds an iCalendar object with
// exactly one VTIMEZONE, not a TZID. dav-mcp sent "Europe/Berlin" bare from
// update_calendar and nothing at all from make_calendar (#78).
//
// A real tsdav DAVClient with only fetch stubbed, so the tests see the body
// tsdav serialises.

const SERVER = 'https://dav.example.com';
const HOME = `${SERVER}/calendars/user/`;
const CALENDAR_URL = `${HOME}work/`;

const requests = [];
let answer;
const fetchStub = jest.fn(async (url, init) => {
  requests.push({ url, ...init });
  return answer(url, init);
});

const client = new DAVClient({
  serverUrl: `${SERVER}/`,
  credentials: { username: 'user', password: 'pass' },
  authMethod: 'Basic',
  fetch: fetchStub,
});
client.authHeaders = { authorization: 'Basic dXNlcjpwYXNz' };
client.account = { homeUrl: HOME };

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => client },
}));

const { makeCalendar } = await import('../src/tools/calendar/make-calendar.js');
const { updateCalendar } = await import('../src/tools/calendar/update-calendar.js');
const { formatCalendarList } = await import('../src/formatters.js');
const { calendarTimezoneValue, readCalendarTimezone } = await import('../src/calendar-zone.js');

const created = () => new Response(null, { status: 201, statusText: 'Created' });
const patched = () => new Response(
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:"><d:response><d:href>/calendars/user/work/</d:href>' +
  '<d:propstat><d:prop><cal:calendar-timezone xmlns:cal="urn:ietf:params:xml:ns:caldav"/></d:prop>' +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
  { status: 207, statusText: 'Multi-Status', headers: { 'content-type': 'application/xml; charset=utf-8' } });

const sent = (method) => requests.filter((r) => r.method === method);

/** the calendar-timezone value in a request body, XML-unescaped */
function timezoneIn(body) {
  const match = /<c:calendar-timezone>([\s\S]*?)<\/c:calendar-timezone>/.exec(body);
  if (!match) return null;
  return match[1].replace(/&#13;|&#xD;/gi, '\r').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** the VTIMEZONE it holds, parsed */
function vtimezoneIn(body) {
  const text = timezoneIn(body);
  const root = new ICAL.Component(ICAL.parse(text));
  expect(root.name).toBe('vcalendar');
  const zones = root.getAllSubcomponents('vtimezone');
  expect(zones).toHaveLength(1);
  return zones[0];
}

/** the instant a wall-clock time in a VTIMEZONE names, as ISO UTC */
function instantIn(vtimezone, wall) {
  const zone = new ICAL.Timezone(vtimezone);
  const [y, mo, d, h, mi] = wall.match(/\d+/g).map(Number);
  return new ICAL.Time({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0 }, zone).toJSDate().toISOString();
}

beforeEach(() => {
  requests.length = 0;
  fetchStub.mockClear();
});

describe('make_calendar with a timezone', () => {
  test('sends a VCALENDAR with the zone\'s VTIMEZONE and says it was applied', async () => {
    answer = created;
    const result = await makeCalendar.handler({ display_name: 'Team Plan', timezone: 'Europe/Berlin' });

    const [{ body }] = sent('MKCALENDAR');
    const vtimezone = vtimezoneIn(body);
    expect(vtimezone.getFirstPropertyValue('tzid')).toBe('Europe/Berlin');
    // the rules hold on both sides of the DST changes (last Sundays of March
    // and October), past and future
    expect(instantIn(vtimezone, '2026-03-29T01:30')).toBe('2026-03-29T00:30:00.000Z');
    expect(instantIn(vtimezone, '2026-03-29T03:30')).toBe('2026-03-29T01:30:00.000Z');
    expect(instantIn(vtimezone, '2026-10-25T01:30')).toBe('2026-10-24T23:30:00.000Z');
    expect(instantIn(vtimezone, '2026-10-25T03:30')).toBe('2026-10-25T02:30:00.000Z');
    expect(instantIn(vtimezone, '1996-10-27T03:30')).toBe('1996-10-27T02:30:00.000Z');
    expect(instantIn(vtimezone, '2040-07-01T12:00')).toBe('2040-07-01T10:00:00.000Z');

    const text = result.content[0].text;
    expect(text).toContain('Calendar created successfully');
    expect(text).toContain('"timezone": "Europe/Berlin"');
    expect(text).not.toMatch(/NOT applied|timezoneApplied/);
  });

  test('a zone name in other case is written as IANA spells it', async () => {
    answer = created;
    await makeCalendar.handler({ display_name: 'Team Plan', timezone: 'america/new_york' });
    expect(vtimezoneIn(sent('MKCALENDAR')[0].body).getFirstPropertyValue('tzid')).toBe('America/New_York');
  });

  test.each(['Berlin', 'CEST', '+02:00', 'Mars/Olympus_Mons'])(
    'refuses "%s" as a validation error, before anything is sent', async (timezone) => {
      answer = created;
      await expect(makeCalendar.handler({ display_name: 'Team Plan', timezone }))
        .rejects.toMatchObject({ name: 'ValidationError', message: expect.stringContaining('IANA time zone') });
      expect(requests).toHaveLength(0);
    });

  test('without a timezone none is sent', async () => {
    answer = created;
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(sent('MKCALENDAR')[0].body).not.toContain('calendar-timezone');
    expect(result.content[0].text).not.toMatch(/timezone/i);
  });
});

describe('update_calendar with a timezone', () => {
  beforeEach(() => {
    client.fetchCalendars = jest.fn().mockResolvedValue([{
      url: CALENDAR_URL,
      displayName: 'Work',
      timezone: calendarTimezoneValue('Europe/Berlin').text,
    }]);
  });

  test('sends a VCALENDAR with the VTIMEZONE, not the bare TZID', async () => {
    answer = patched;
    const result = await updateCalendar.handler({ calendar_url: CALENDAR_URL, timezone: 'Europe/Berlin' });

    const [{ body }] = sent('PROPPATCH');
    expect(body).not.toMatch(/<c:calendar-timezone>Europe\/Berlin<\/c:calendar-timezone>/);
    expect(vtimezoneIn(body).getFirstPropertyValue('tzid')).toBe('Europe/Berlin');
    // the zone the server now holds, read back
    expect(result.content[0].text).toContain('- Timezone: Europe/Berlin');
  });

  test('says so when the server does not hold the zone afterwards', async () => {
    answer = patched;
    client.fetchCalendars.mockResolvedValue([{ url: CALENDAR_URL, displayName: 'Work', timezone: '' }]);
    const result = await updateCalendar.handler({ calendar_url: CALENDAR_URL, timezone: 'Europe/Berlin' });
    expect(result.content[0].text).toMatch(/server reports no time zone/i);
  });

  test('UTC is a zone too (it has no slash)', async () => {
    answer = patched;
    await updateCalendar.handler({ calendar_url: CALENDAR_URL, timezone: 'UTC' });
    expect(vtimezoneIn(sent('PROPPATCH')[0].body).getFirstPropertyValue('tzid')).toBe('UTC');
  });

  test('an unknown zone is a validation error, before anything is sent', async () => {
    answer = patched;
    await expect(updateCalendar.handler({ calendar_url: CALENDAR_URL, timezone: 'Berlin' }))
      .rejects.toMatchObject({ name: 'ValidationError' });
    expect(requests).toHaveLength(0);
  });
});

describe('reading a calendar\'s timezone', () => {
  test.each([
    ['the VCALENDAR the RFC asks for', calendarTimezoneValue('Europe/Berlin').text, 'Europe/Berlin'],
    ['a bare TZID, as dav-mcp wrote it before', 'Europe/Berlin', 'Europe/Berlin'],
    ['nothing', '', null],
  ])('%s', (_, value, tzid) => {
    expect(readCalendarTimezone(value)?.tzid ?? null).toBe(tzid);
  });

  test('list_calendars shows it', () => {
    const text = formatCalendarList([
      { url: CALENDAR_URL, displayName: 'Work', timezone: calendarTimezoneValue('Europe/Berlin').text },
      { url: `${HOME}home/`, displayName: 'Home', timezone: '' },
    ]).content[0].text;
    expect(text).toContain('- **Time zone**: Europe/Berlin');
    expect(text.match(/Time zone/g)).toHaveLength(1);
  });
});

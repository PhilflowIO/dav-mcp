import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// make_calendar used to ignore the MKCALENDAR result and report "created" for
// a 405. On Nextcloud that 405 is routine: a deleted calendar keeps its URL in
// the trash bin, so re-creating a calendar with the same name collides (#72).

const HOME = 'https://dav.example.com/calendars/user/';
const makeCalendarMock = jest.fn();

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({ account: { homeUrl: HOME }, makeCalendar: makeCalendarMock }),
  },
}));

const { makeCalendar } = await import('../src/tools/calendar/make-calendar.js');

const created = () => [{ ok: true, status: 201, statusText: 'Created', raw: '' }];
const exists = () => [{
  ok: false,
  status: 405,
  statusText: 'Method Not Allowed',
  raw: '<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">' +
    '<s:exception>Sabre\\DAV\\Exception\\MethodNotAllowed</s:exception>' +
    '<s:message>The resource you tried to create already exists</s:message></d:error>',
}];
const forbidden = () => [{ ok: false, status: 403, statusText: 'Forbidden', raw: '<d:error xmlns:d="DAV:"><s:message xmlns:s="http://sabredav.org/ns">No permission</s:message></d:error>' }];

const urlsTried = () => makeCalendarMock.mock.calls.map(([params]) => params.url);

beforeEach(() => makeCalendarMock.mockReset());

describe('make_calendar', () => {
  test('201 on the first try uses the slug from display_name', async () => {
    makeCalendarMock.mockResolvedValueOnce(created());
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(urlsTried()).toEqual([`${HOME}team-plan/`]);
    expect(result.content[0].text).toContain(`${HOME}team-plan/`);
  });

  test('405 (slug taken) retries with a suffix and returns the URL actually created', async () => {
    makeCalendarMock
      .mockResolvedValueOnce(exists())
      .mockResolvedValueOnce(exists())
      .mockResolvedValueOnce(created());
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });

    expect(urlsTried()).toEqual([`${HOME}team-plan/`, `${HOME}team-plan-2/`, `${HOME}team-plan-3/`]);
    const text = result.content[0].text;
    expect(text).toContain('Calendar created successfully');
    expect(text).toContain(`${HOME}team-plan-3/`);
    expect(text).not.toContain(`${HOME}team-plan/`);
  });

  test('a 403 is an error with the server message, and is not retried', async () => {
    makeCalendarMock.mockResolvedValue(forbidden());
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow('Failed to create calendar https://dav.example.com/calendars/user/team-plan/: server responded 403 Forbidden: No permission');
    expect(makeCalendarMock).toHaveBeenCalledTimes(1);
  });

  test('a 403 resource-must-be-null counts as "taken" (RFC 4791 5.3.1)', async () => {
    makeCalendarMock
      .mockResolvedValueOnce([{ ok: false, status: 403, statusText: 'Forbidden', raw: '<d:error xmlns:d="DAV:"><d:resource-must-be-null/></d:error>' }])
      .mockResolvedValueOnce(created());
    // no <s:message>, so the raw body is the message the check sees
    const result = await makeCalendar.handler({ display_name: 'x' });
    expect(result.content[0].text).toContain(`${HOME}x-2/`);
  });

  test('gives up after a bounded number of taken URLs', async () => {
    makeCalendarMock.mockResolvedValue(exists());
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow(/all taken.*405.*already exists/);
    expect(makeCalendarMock).toHaveBeenCalledTimes(10);
  });

  test('a name without ASCII letters or digits does not target the calendar home', async () => {
    makeCalendarMock.mockResolvedValueOnce(created());
    await makeCalendar.handler({ display_name: '日本' });
    expect(urlsTried()).toEqual([`${HOME}calendar/`]);
  });
});

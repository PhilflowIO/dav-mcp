import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// make_calendar used to ignore the MKCALENDAR result and report "created" for
// a 405. On Nextcloud that 405 is routine: a deleted calendar keeps its URL in
// the trash bin, so re-creating a calendar with the same name collides (#72).
// The status does not say what holds the URL, so the tool looks (PROPFIND):
// a live calendar is an error, anything else moves to the next slug, and an
// empty URL means the MKCALENDAR failure is real.

const HOME = 'https://dav.example.com/calendars/user/';
const makeCalendarMock = jest.fn();
const propfindMock = jest.fn();

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({ account: { homeUrl: HOME }, makeCalendar: makeCalendarMock, propfind: propfindMock }),
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

// PROPFIND Depth 0 answers in tsdav's DAVResponse shape (namespaces stripped,
// names camelCased): Nextcloud reports a trashed calendar as
// <d:collection/><x1:deleted-calendar/> with x1 = http://nextcloud.com/ns.
const occupant = (resourcetype, displayname) => [{
  ok: true, status: 207, statusText: 'Multi-Status', href: '/x/', props: { resourcetype, displayname },
}];
const activeCalendar = (name) => occupant({ collection: {}, calendar: {} }, name);
const trashedCalendar = (name) => occupant({ collection: {}, deletedCalendar: {} }, name);
const plainCollection = () => occupant({ collection: {} }, {});
const nothingThere = () => [{ ok: false, status: 404, statusText: 'Not Found', raw: '' }];

const urlsTried = () => makeCalendarMock.mock.calls.map(([params]) => params.url);

beforeEach(() => {
  makeCalendarMock.mockReset();
  propfindMock.mockReset();
});

describe('make_calendar', () => {
  test('201 on the first try uses the slug from display_name', async () => {
    makeCalendarMock.mockResolvedValueOnce(created());
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(urlsTried()).toEqual([`${HOME}team-plan/`]);
    expect(result.content[0].text).toContain(`${HOME}team-plan/`);
  });

  test('a live calendar at the slug is an error naming it, not a duplicate', async () => {
    makeCalendarMock.mockResolvedValue(exists());
    propfindMock.mockResolvedValueOnce(activeCalendar('Team Plan'));

    const error = await makeCalendar.handler({ display_name: 'Team Plan' }).catch(e => e);

    expect(error.message).toContain(`A calendar already exists at ${HOME}team-plan/ (display name: "Team Plan")`);
    expect(error.code).toBe(-32007); // CONFLICT_ERROR
    expect(makeCalendarMock).toHaveBeenCalledTimes(1);
    // inspected with Depth 0 and without own headers, which would drop auth
    const [params] = propfindMock.mock.calls[0];
    expect(params).toMatchObject({ url: `${HOME}team-plan/`, depth: '0' });
    expect(params).not.toHaveProperty('headers');
  });

  test('a calendar in the Nextcloud trash bin moves on to -2 and returns that URL', async () => {
    makeCalendarMock
      .mockResolvedValueOnce(exists())
      .mockResolvedValueOnce(created());
    propfindMock.mockResolvedValueOnce(trashedCalendar('Team Plan'));

    const result = await makeCalendar.handler({ display_name: 'Team Plan' });

    expect(urlsTried()).toEqual([`${HOME}team-plan/`, `${HOME}team-plan-2/`]);
    const text = result.content[0].text;
    expect(text).toContain('Calendar created successfully');
    expect(text).toContain(`${HOME}team-plan-2/`);
    expect(text).not.toContain(`${HOME}team-plan/`);
  });

  test('a non-calendar resource at the slug also moves on', async () => {
    makeCalendarMock
      .mockResolvedValueOnce(exists())
      .mockResolvedValueOnce(created());
    propfindMock.mockResolvedValueOnce(plainCollection());
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(result.content[0].text).toContain(`${HOME}team-plan-2/`);
  });

  test('nothing at the slug: the original error, one MKCALENDAR, even for a 405', async () => {
    makeCalendarMock.mockResolvedValue(exists());
    propfindMock.mockResolvedValue(nothingThere());
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow(`Failed to create calendar ${HOME}team-plan/: server responded 405 Method Not Allowed: The resource you tried to create already exists`);
    expect(makeCalendarMock).toHaveBeenCalledTimes(1);
  });

  test('a PROPFIND that fails leaves the original error, with the server message', async () => {
    makeCalendarMock.mockResolvedValue(forbidden());
    propfindMock.mockRejectedValue(new Error('socket hang up'));
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow(`Failed to create calendar ${HOME}team-plan/: server responded 403 Forbidden: No permission`);
    expect(makeCalendarMock).toHaveBeenCalledTimes(1);
  });

  test('the same calendar on a numbered URL (earlier call, lost answer) is an error', async () => {
    makeCalendarMock.mockResolvedValue(exists());
    propfindMock
      .mockResolvedValueOnce(trashedCalendar('Team Plan'))
      .mockResolvedValueOnce(activeCalendar('Team Plan'));
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow(`A calendar already exists at ${HOME}team-plan-2/`);
    expect(makeCalendarMock).toHaveBeenCalledTimes(2);
  });

  test('a differently named calendar on a numbered URL is skipped', async () => {
    makeCalendarMock
      .mockResolvedValueOnce(exists())
      .mockResolvedValueOnce(exists())
      .mockResolvedValueOnce(created());
    propfindMock
      .mockResolvedValueOnce(trashedCalendar('Team Plan'))
      .mockResolvedValueOnce(activeCalendar('Team Plan 2'));
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(urlsTried()).toEqual([`${HOME}team-plan/`, `${HOME}team-plan-2/`, `${HOME}team-plan-3/`]);
    expect(result.content[0].text).toContain(`${HOME}team-plan-3/`);
  });

  test('gives up after a bounded number of taken URLs', async () => {
    makeCalendarMock.mockResolvedValue(exists());
    propfindMock.mockResolvedValue(trashedCalendar('Team Plan'));
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

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { DAVClient } from 'tsdav';

// make_calendar used to ignore the MKCALENDAR result and report "created" for
// a 405. On Nextcloud that 405 is routine: a deleted calendar keeps its URL in
// the trash bin, so re-creating a calendar with the same name collides (#72).
// The status does not say what holds the URL, so the tool looks (PROPFIND):
// a live calendar is an error, anything else moves to the next slug, and an
// empty URL means the MKCALENDAR failure is real.
//
// The tool runs through a real tsdav DAVClient here, with only fetch stubbed,
// so the tests see the MKCALENDAR body tsdav serialises and the PROPFIND
// answer the way tsdav parses it — a mocked client is how camelCase property
// names that no server knows went unnoticed.

const SERVER = 'https://dav.example.com';
const HOME = `${SERVER}/calendars/user/`;

const requests = [];
let mkcalendar;
let propfind;
const fetchStub = jest.fn(async (url, init) => {
  requests.push({ url, ...init });
  const queue = init.method === 'MKCALENDAR' ? mkcalendar : propfind;
  const next = queue.length > 1 ? queue.shift() : queue[0];
  if (!next) throw new Error(`unexpected ${init.method} ${url}`);
  return next(url);
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
const { formatMCPError } = await import('../src/error-handler.js');

const xml = (status, statusText, body) => () => new Response(body, {
  status, statusText, headers: { 'content-type': 'application/xml; charset=utf-8' },
});
const sabreError = (exception, message, extra = '') =>
  '<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">' +
  `${extra}<s:exception>${exception}</s:exception><s:message>${message}</s:message></d:error>`;

const created = () => new Response(null, { status: 201, statusText: 'Created' });
const exists = xml(405, 'Method Not Allowed',
  sabreError('Sabre\\DAV\\Exception\\MethodNotAllowed', 'The resource you tried to create already exists'));

// PROPFIND Depth 0 answers as the servers send them. Nextcloud reports a
// trashed calendar as <d:collection/><x1:deleted-calendar/>.
const occupant = (resourcetype, displayname) => (url) => xml(207, 'Multi-Status',
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:x1="http://nextcloud.com/ns">' +
  `<d:response><d:href>${new URL(url).pathname}</d:href><d:propstat><d:prop>` +
  `<d:resourcetype>${resourcetype}</d:resourcetype>${displayname === undefined ? '<d:displayname/>' : `<d:displayname>${displayname}</d:displayname>`}` +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>')();
const activeCalendar = (name) => occupant('<d:collection/><cal:calendar/>', name);
const trashedCalendar = (name) => occupant('<d:collection/><x1:deleted-calendar/>', name);
const plainCollection = () => occupant('<d:collection/>');
const nothingThere = xml(404, 'Not Found', sabreError('Sabre\\DAV\\Exception\\NotFound', 'Not found'));

const sent = (method) => requests.filter(r => r.method === method);
const urlsTried = () => sent('MKCALENDAR').map(r => r.url);
const header = (req, name) =>
  Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === name)?.[1];

beforeEach(() => {
  requests.length = 0;
  fetchStub.mockClear();
  mkcalendar = [];
  propfind = [];
});

describe('make_calendar', () => {
  test('201 on the first try uses the slug from display_name', async () => {
    mkcalendar = [created];
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(urlsTried()).toEqual([`${HOME}team-plan/`]);
    expect(result.content[0].text).toContain(`${HOME}team-plan/`);
    expect(sent('PROPFIND')).toHaveLength(0);
  });

  test('a live calendar at the slug is an error naming it, not a duplicate', async () => {
    mkcalendar = [exists];
    propfind = [activeCalendar('Team Plan')];

    const error = await makeCalendar.handler({ display_name: 'Team Plan' }).catch(e => e);

    expect(error.message).toContain(`A calendar already exists at ${HOME}team-plan/ (display name: "Team Plan")`);
    expect(error.code).toBe(-32007); // CONFLICT_ERROR
    expect(sent('MKCALENDAR')).toHaveLength(1);
    // inspected with Depth 0, authenticated
    const [inspect] = sent('PROPFIND');
    expect(inspect.url).toBe(`${HOME}team-plan/`);
    expect(header(inspect, 'depth')).toBe('0');
    expect(header(inspect, 'authorization')).toBe('Basic dXNlcjpwYXNz');
    expect(inspect.body).toMatch(/<d:resourcetype\/>/);
  });

  test('a calendar in the Nextcloud trash bin moves on to -2 and returns that URL', async () => {
    mkcalendar = [exists, created];
    propfind = [trashedCalendar('Team Plan')];

    const result = await makeCalendar.handler({ display_name: 'Team Plan' });

    expect(urlsTried()).toEqual([`${HOME}team-plan/`, `${HOME}team-plan-2/`]);
    const text = result.content[0].text;
    expect(text).toContain('Calendar created successfully');
    expect(text).toContain(`${HOME}team-plan-2/`);
    expect(text).not.toContain(`${HOME}team-plan/`);
  });

  test('a non-calendar resource at the slug also moves on', async () => {
    mkcalendar = [exists, created];
    propfind = [plainCollection()];
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(result.content[0].text).toContain(`${HOME}team-plan-2/`);
  });

  test('nothing at the slug: the original error, one MKCALENDAR, even for a 405', async () => {
    mkcalendar = [exists];
    propfind = [nothingThere];
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow(`Failed to create calendar ${HOME}team-plan/: server responded 405 Method Not Allowed: The resource you tried to create already exists`);
    expect(sent('MKCALENDAR')).toHaveLength(1);
  });

  test('a PROPFIND that fails leaves the original error, with the server message', async () => {
    mkcalendar = [exists];
    propfind = [() => { throw new Error('socket hang up'); }];
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow(`Failed to create calendar ${HOME}team-plan/: server responded 405 Method Not Allowed: The resource you tried to create already exists`);
    expect(sent('MKCALENDAR')).toHaveLength(1);
  });

  test.each([
    [500, 'Internal Server Error'],
    [507, 'Insufficient Storage'],
    [403, 'Forbidden'],
  ])('a %i is not a collision: the original error, even with a live calendar at the URL', async (status, statusText) => {
    mkcalendar = [xml(status, statusText, sabreError('Sabre\\DAV\\Exception', 'Server said no'))];
    propfind = [activeCalendar('Team Plan')];

    const error = await makeCalendar.handler({ display_name: 'Team Plan' }).catch(e => e);

    expect(error.message).toBe(`Failed to create calendar ${HOME}team-plan/: server responded ${status} ${statusText}: Server said no`);
    expect(error.httpStatus).toBe(status);
    expect(sent('PROPFIND')).toHaveLength(0);
    expect(sent('MKCALENDAR')).toHaveLength(1);
  });

  test.each([
    [409, 'Conflict', ''],
    [403, 'Forbidden', '<d:resource-must-be-null/>'],
  ])('a %i collision is classified by what holds the URL', async (status, statusText, precondition) => {
    mkcalendar = [xml(status, statusText, sabreError('Sabre\\DAV\\Exception', 'Taken', precondition)), created];
    propfind = [trashedCalendar('Team Plan')];
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(result.content[0].text).toContain(`${HOME}team-plan-2/`);
  });

  test('the same calendar on a numbered URL (earlier call, lost answer) is an error', async () => {
    mkcalendar = [exists];
    propfind = [trashedCalendar('Team Plan'), activeCalendar('Team Plan')];
    await expect(makeCalendar.handler({ display_name: 'Team Plan' }))
      .rejects.toThrow(`A calendar already exists at ${HOME}team-plan-2/`);
    expect(sent('MKCALENDAR')).toHaveLength(2);
  });

  test('a differently named calendar on a numbered URL is skipped', async () => {
    mkcalendar = [exists, exists, created];
    propfind = [trashedCalendar('Team Plan'), activeCalendar('Team Plan 2')];
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(urlsTried()).toEqual([`${HOME}team-plan/`, `${HOME}team-plan-2/`, `${HOME}team-plan-3/`]);
    expect(result.content[0].text).toContain(`${HOME}team-plan-3/`);
  });

  test('gives up after a bounded number of taken URLs', async () => {
    mkcalendar = [exists];
    propfind = [trashedCalendar('Team Plan')];
    const error = await makeCalendar.handler({ display_name: 'Team Plan' }).catch(e => e);
    expect(error.message).toMatch(/all taken.*405.*already exists/);
    expect(error.code).toBe(-32007); // CONFLICT_ERROR
    expect(sent('MKCALENDAR')).toHaveLength(10);
  });

  test('all URLs taken is a conflict even when the server says so with 403', async () => {
    mkcalendar = [xml(403, 'Forbidden', sabreError('Sabre\\DAV\\Exception', 'Taken', '<d:resource-must-be-null/>'))];
    propfind = [trashedCalendar('Team Plan')];
    const error = await makeCalendar.handler({ display_name: 'Team Plan' }).catch(e => e);
    expect(error.message).toMatch(/all taken/);
    expect(formatMCPError(error).code).toBe(-32007); // CONFLICT_ERROR, not AUTH_ERROR
  });

  test('properties are sent under their DAV names, so the server applies them', async () => {
    mkcalendar = [created];
    await makeCalendar.handler({
      display_name: 'Work & Life',
      description: 'Shared plans',
      color: '#FF5733',
      components: ['VEVENT'],
    });
    const [{ body, headers }] = sent('MKCALENDAR');

    expect(body).toContain('<d:displayname>Work &amp; Life</d:displayname>');
    expect(body).toContain('<c:calendar-description>Shared plans</c:calendar-description>');
    expect(body).toContain('<ca:calendar-color>#FF5733</ca:calendar-color>');
    expect(body).toMatch(/<c:supported-calendar-component-set>\s*<c:comp name="VEVENT"\/>\s*<\/c:supported-calendar-component-set>/);
    expect(body).not.toMatch(/displayName|calendarColor|<d:description|<d:timezone/);
    expect(Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1]).toBe('Basic dXNlcjpwYXNz');
  });

  test('a timezone is not sent as a bare TZID, and the result says it was not applied', async () => {
    mkcalendar = [created];
    const result = await makeCalendar.handler({ display_name: 'Team Plan', timezone: 'Europe/Berlin' });

    // RFC 4791 §5.2.2: calendar-timezone holds an iCalendar VTIMEZONE, never a TZID
    const [{ body }] = sent('MKCALENDAR');
    expect(body).not.toContain('calendar-timezone');
    expect(body).not.toContain('Europe/Berlin');
    const text = result.content[0].text;
    expect(text).toContain('Calendar created successfully');
    expect(text).toContain('The timezone "Europe/Berlin" was NOT applied');
    expect(text).toContain('issues/78');
    expect(text).toContain('"timezoneApplied": false');
  });

  test('without a timezone the result carries no timezone note', async () => {
    mkcalendar = [created];
    const result = await makeCalendar.handler({ display_name: 'Team Plan' });
    expect(result.content[0].text).not.toMatch(/timezone/i);
  });

  test('a name without ASCII letters or digits does not target the calendar home', async () => {
    mkcalendar = [created];
    await makeCalendar.handler({ display_name: '日本' });
    expect(urlsTried()).toEqual([`${HOME}calendar/`]);
  });
});

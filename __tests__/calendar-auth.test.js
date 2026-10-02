import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { DAVClient } from 'tsdav';

// The calendar collection tools run through a real tsdav DAVClient here, with
// only fetch stubbed, so the test sees the request tsdav actually sends. A
// mocked deleteObject cannot show that caller headers replaced the auth header
// — that is exactly how delete_calendar went out unauthenticated (#72).

const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const AUTH = 'Basic dXNlcjpwYXNz';

const requests = [];
let nextResponse;
const fetchStub = jest.fn(async (url, init) => {
  requests.push({ url, ...init });
  return nextResponse();
});

const client = new DAVClient({
  serverUrl: 'https://dav.example.com/',
  credentials: { username: 'user', password: 'pass' },
  authMethod: 'Basic',
  fetch: fetchStub,
});
client.authHeaders = { authorization: AUTH };

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => client },
}));

const { deleteCalendar } = await import('../src/tools/calendar/delete-calendar.js');
const { updateCalendar } = await import('../src/tools/calendar/update-calendar.js');

const response = (status, statusText, body = '', contentType = 'application/xml; charset=utf-8') =>
  () => new Response(status === 204 ? null : body, { status, statusText, headers: { 'content-type': contentType } });

const multistatus = (propStatus) =>
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:"><d:response>' +
  `<d:href>/calendars/user/work/</d:href><d:propstat><d:prop><d:displayname/></d:prop>` +
  `<d:status>HTTP/1.1 ${propStatus}</d:status></d:propstat></d:response></d:multistatus>`;

const header = (req, name) =>
  Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === name)?.[1];

beforeEach(() => {
  requests.length = 0;
  fetchStub.mockClear();
});

describe('delete_calendar', () => {
  test('sends the DELETE with the client auth header and no Content-Type', async () => {
    nextResponse = response(204, 'No Content');
    await deleteCalendar.handler({ calendar_url: CALENDAR_URL });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].url).toBe(CALENDAR_URL);
    expect(header(requests[0], 'authorization')).toBe(AUTH);
    expect(header(requests[0], 'content-type')).toBeUndefined();
  });

  test('a 401 is reported, not swallowed', async () => {
    nextResponse = response(401, 'Unauthorized', 'No public access to this resource.', 'text/plain');
    await expect(deleteCalendar.handler({ calendar_url: CALENDAR_URL }))
      .rejects.toThrow(/401 Unauthorized.*still exists/);
  });
});

describe('update_calendar', () => {
  beforeEach(() => {
    client.fetchCalendars = jest.fn().mockResolvedValue([{ url: CALENDAR_URL, displayName: 'Work & Life' }]);
  });

  test('sends PROPPATCH through tsdav with the client auth header', async () => {
    nextResponse = response(207, 'Multi-Status', multistatus('200 OK'));
    await updateCalendar.handler({ calendar_url: CALENDAR_URL, display_name: 'Work & Life' });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('PROPPATCH');
    expect(header(requests[0], 'authorization')).toBe(AUTH);
    // escaped, so the body is well-formed XML
    expect(requests[0].body).toContain('<d:displayname>Work &amp; Life</d:displayname>');
    expect(requests[0].body).toContain('<d:propertyupdate');
  });

  test('a property the server refuses inside the 207 is an error', async () => {
    nextResponse = response(207, 'Multi-Status', multistatus('403 Forbidden'));
    await expect(updateCalendar.handler({ calendar_url: CALENDAR_URL, display_name: 'x' }))
      .rejects.toThrow(/update calendar.*403 Forbidden/);
  });

  test('a non-207 failure is an error', async () => {
    nextResponse = response(401, 'Unauthorized', '', 'text/plain');
    await expect(updateCalendar.handler({ calendar_url: CALENDAR_URL, display_name: 'x' }))
      .rejects.toThrow(/401/);
  });
});

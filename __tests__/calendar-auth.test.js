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
  return nextResponse(url, init);
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

// What a PROPFIND Depth 0 on the calendar URL answers before the DELETE
const collection = (resourcetype) => response(207, 'Multi-Status',
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:x1="http://nextcloud.com/ns">' +
  `<d:response><d:href>/calendars/user/work/</d:href><d:propstat><d:prop><d:resourcetype>${resourcetype}</d:resourcetype>` +
  '<d:displayname>Work</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
const liveCalendar = collection('<d:collection/><cal:calendar/>');
const trashedCalendar = collection('<d:collection/><x1:deleted-calendar/>');
const answer = (inspect, del) => (url, init) => (init.method === 'PROPFIND' ? inspect : del)();

describe('delete_calendar', () => {
  test('sends the DELETE with the client auth header and no Content-Type', async () => {
    nextResponse = answer(liveCalendar, response(204, 'No Content'));
    const result = await deleteCalendar.handler({ calendar_url: CALENDAR_URL });

    expect(requests.map(r => r.method)).toEqual(['PROPFIND', 'DELETE']);
    const del = requests[1];
    expect(del.url).toBe(CALENDAR_URL);
    expect(header(del, 'authorization')).toBe(AUTH);
    expect(header(del, 'content-type')).toBeUndefined();
    expect(header(requests[0], 'authorization')).toBe(AUTH);
    expect(result.content[0].text).toContain('Calendar deleted successfully');
    expect(result.content[0].text).not.toContain('permanently');
  });

  test('a 401 is reported, not swallowed', async () => {
    nextResponse = response(401, 'Unauthorized', 'No public access to this resource.', 'text/plain');
    await expect(deleteCalendar.handler({ calendar_url: CALENDAR_URL }))
      .rejects.toThrow(/401 Unauthorized.*still exists/);
  });

  test('a calendar already in the trash bin is reported as already deleted, without a DELETE', async () => {
    // Nextcloud answers a DELETE on a trashed calendar like one on a live calendar
    nextResponse = answer(trashedCalendar, response(204, 'No Content'));
    const result = await deleteCalendar.handler({ calendar_url: CALENDAR_URL });

    expect(requests.map(r => r.method)).toEqual(['PROPFIND']);
    const text = result.content[0].text;
    expect(text).toContain('Calendar was already deleted');
    expect(text).toContain("in the server's trash bin");
    expect(text).toContain('"alreadyDeleted": true');
    expect(text).not.toContain('deleted successfully');
  });

  test('no calendar at the URL (404 to lookup and DELETE): not found, never "deleted"', async () => {
    nextResponse = response(404, 'Not Found');
    const error = await deleteCalendar.handler({ calendar_url: CALENDAR_URL }).catch(e => e);

    expect(requests.map(r => r.method)).toEqual(['PROPFIND', 'DELETE']);
    expect(error.message).toBe(`No calendar at ${CALENDAR_URL} — nothing was deleted.`);
    expect(error.code).toBe(-32006); // NOT_FOUND_ERROR
  });

  test('a calendar seen by the lookup that answers 404 to the DELETE existed and is gone: deleted', async () => {
    nextResponse = answer(liveCalendar, response(404, 'Not Found'));
    const result = await deleteCalendar.handler({ calendar_url: CALENDAR_URL });
    expect(result.content[0].text).toContain('Calendar deleted successfully');
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

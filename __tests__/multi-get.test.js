import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { DAVClient } from 'tsdav';

// The multiget tools run through a real tsdav DAVClient here, with only fetch
// stubbed, so the test sees the REPORT tsdav actually serialises and the
// multistatus it actually parses. A mocked calendarMultiGet is how the tools
// shipped asking for no properties at all and returning empty objects (#77).

const SERVER = 'https://dav.example.com';
const CALENDAR_URL = `${SERVER}/calendars/user/work/`;
const TASKS_URL = `${SERVER}/calendars/user/tasks/`;
const BOOK_URL = `${SERVER}/addressbooks/user/contacts/`;

const requests = [];
let respond;
const fetchStub = jest.fn(async (url, init) => {
  requests.push({ url, ...init });
  return respond(url, init);
});

const client = new DAVClient({
  serverUrl: `${SERVER}/`,
  credentials: { username: 'user', password: 'pass' },
  authMethod: 'Basic',
  fetch: fetchStub,
});
client.authHeaders = { authorization: 'Basic dXNlcjpwYXNz' };

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => client, getCardDavClient: () => client },
}));

const { calendarMultiGet } = await import('../src/tools/calendar/calendar-multi-get.js');
const { todoMultiGet } = await import('../src/tools/todos/todo-multi-get.js');
const { addressbookMultiGet } = await import('../src/tools/contacts/addressbook-multi-get.js');

const ics = (uid, summary, component = 'VEVENT') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:${component}\r\nUID:${uid}\r\n` +
  `DTSTAMP:20260101T000000Z\r\n${component === 'VEVENT' ? 'DTSTART:20261001T100000Z\r\nDTEND:20261001T110000Z\r\n' : ''}` +
  `SUMMARY:${summary}\r\nEND:${component}\r\nEND:VCALENDAR\r\n`;

const vcard = (uid, name) =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${name}\r\nN:${name};;;;\r\nEND:VCARD\r\n`;

const found = (href, etag, dataTag, data) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
  `<d:getetag>&quot;${etag}&quot;</d:getetag><${dataTag}>${data}</${dataTag}>` +
  `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

// SabreDAV (Nextcloud, Baikal) reports a multiget href that does not exist like this
const notFound = (href) =>
  `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;

const multistatus = (...members) => () => new Response(
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
  `xmlns:card="urn:ietf:params:xml:ns:carddav">${members.join('')}</d:multistatus>`,
  { status: 207, statusText: 'Multi-Status', headers: { 'content-type': 'application/xml; charset=utf-8' } },
);

const text = (result) => result.content[0].text;
const rawData = (result) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text(result))[1]);

beforeEach(() => {
  requests.length = 0;
  fetchStub.mockClear();
});

describe('calendar_multi_get', () => {
  const urls = [`${CALENDAR_URL}a.ics`, `${CALENDAR_URL}b.ics`];

  test('sends a calendar-multiget REPORT asking for getetag and calendar-data', async () => {
    respond = multistatus(
      found('/calendars/user/work/a.ics', 'e-a', 'cal:calendar-data', ics('a', 'Alpha')),
      found('/calendars/user/work/b.ics', 'e-b', 'cal:calendar-data', ics('b', 'Beta')),
    );
    await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: urls });

    expect(requests).toHaveLength(1);
    const { method, url, body } = requests[0];
    expect(method).toBe('REPORT');
    expect(url).toBe(CALENDAR_URL);
    expect(body).toMatch(/<c:calendar-multiget[^>]*xmlns:c="urn:ietf:params:xml:ns:caldav"/);
    expect(body).toMatch(/<d:prop>\s*<d:getetag\/>\s*<c:calendar-data\/>\s*<\/d:prop>/);
    expect(body).toContain('<d:href>/calendars/user/work/a.ics</d:href>');
    expect(body).toContain('<d:href>/calendars/user/work/b.ics</d:href>');
  });

  test('returns url, etag and data for every event', async () => {
    respond = multistatus(
      found('/calendars/user/work/a.ics', 'e-a', 'cal:calendar-data', ics('a', 'Alpha')),
      found('/calendars/user/work/b.ics', 'e-b', 'cal:calendar-data', ics('b', 'Beta')),
    );
    const result = await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: urls });

    expect(rawData(result)).toEqual([
      { url: urls[0], etag: '"e-a"', data: expect.stringContaining('SUMMARY:Alpha') },
      { url: urls[1], etag: '"e-b"', data: expect.stringContaining('SUMMARY:Beta') },
    ]);
    expect(text(result)).toContain('Alpha');
    expect(text(result)).not.toContain('Not found');
  });

  test('a URL the server reports as 404 is listed as not found, the rest still returned', async () => {
    const gone = `${CALENDAR_URL}gone.ics`;
    respond = multistatus(
      found('/calendars/user/work/a.ics', 'e-a', 'cal:calendar-data', ics('a', 'Alpha')),
      notFound('/calendars/user/work/gone.ics'),
      found('/calendars/user/work/b.ics', 'e-b', 'cal:calendar-data', ics('b', 'Beta')),
    );
    const result = await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: [...urls, gone] });

    expect(rawData(result).map(e => e.url)).toEqual(urls);
    expect(text(result)).toContain('Not found: **1**');
    expect(text(result)).toContain(`- ${gone} — not found`);
  });

  test('a URL left out of the multistatus is reported as not found, not silently dropped', async () => {
    // Nextcloud answers an unknown href with an empty 207 instead of a 404 member
    respond = multistatus(found('/calendars/user/work/a.ics', 'e-a', 'cal:calendar-data', ics('a', 'Alpha')));
    const result = await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: urls });

    expect(rawData(result).map(e => e.url)).toEqual([urls[0]]);
    expect(text(result)).toContain(`- ${urls[1]} — not found (not returned by the server)`);
  });

  test('an empty multistatus reports every URL as not found instead of failing', async () => {
    // Nextcloud's answer when none of the hrefs exist
    respond = multistatus();
    const result = await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: urls });

    expect(text(result)).toContain('No events found.');
    expect(text(result)).toContain('Not found: **2**');
    expect(text(result)).toContain(`- ${urls[0]} — not found (not returned by the server)`);
  });

  test('a failed REPORT is an error for the whole call', async () => {
    respond = () => new Response('No public access to this resource.', {
      status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'text/plain' },
    });
    await expect(calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: urls }))
      .rejects.toThrow(/Failed to fetch objects from .*401 Unauthorized/);
  });
});

describe('todo_multi_get', () => {
  test('requests calendar-data and maps todos to url, etag and data', async () => {
    const urls = [`${TASKS_URL}t1.ics`, `${TASKS_URL}t2.ics`, `${TASKS_URL}nope.ics`];
    respond = multistatus(
      found('/calendars/user/tasks/t1.ics', 'e-1', 'cal:calendar-data', ics('t1', 'Task one', 'VTODO')),
      found('/calendars/user/tasks/t2.ics', 'e-2', 'cal:calendar-data', ics('t2', 'Task two', 'VTODO')),
      notFound('/calendars/user/tasks/nope.ics'),
    );
    const result = await todoMultiGet.handler({ todo_urls: urls });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(TASKS_URL);
    expect(requests[0].body).toMatch(/<d:prop>\s*<d:getetag\/>\s*<c:calendar-data\/>\s*<\/d:prop>/);
    expect(rawData(result)).toEqual([
      { url: urls[0], etag: '"e-1"', data: expect.stringContaining('SUMMARY:Task one') },
      { url: urls[1], etag: '"e-2"', data: expect.stringContaining('SUMMARY:Task two') },
    ]);
    expect(text(result)).toContain(`- ${urls[2]} — not found`);
  });

  test('todos from two task lists each go to their own collection', async () => {
    const other = `${SERVER}/calendars/user/errands/`;
    respond = (url) => url === TASKS_URL
      ? multistatus(found('/calendars/user/tasks/t1.ics', 'e-1', 'cal:calendar-data', ics('t1', 'Task one', 'VTODO')))()
      : multistatus(found('/calendars/user/errands/t9.ics', 'e-9', 'cal:calendar-data', ics('t9', 'Errand', 'VTODO')))();
    const result = await todoMultiGet.handler({ todo_urls: [`${TASKS_URL}t1.ics`, `${other}t9.ics`] });

    expect(requests.map(r => r.url)).toEqual([TASKS_URL, other]);
    expect(rawData(result).map(t => t.url)).toEqual([`${TASKS_URL}t1.ics`, `${other}t9.ics`]);
  });
});

describe('addressbook_multi_get', () => {
  test('sends an addressbook-multiget asking for getetag and address-data, 404 reported per URL', async () => {
    const urls = [`${BOOK_URL}c1.vcf`, `${BOOK_URL}c2.vcf`, `${BOOK_URL}missing.vcf`];
    respond = multistatus(
      found('/addressbooks/user/contacts/c1.vcf', 'e-c1', 'card:address-data', vcard('c1', 'Ada Lovelace')),
      found('/addressbooks/user/contacts/c2.vcf', 'e-c2', 'card:address-data', vcard('c2', 'Alan Turing')),
      notFound('/addressbooks/user/contacts/missing.vcf'),
    );
    const result = await addressbookMultiGet.handler({ addressbook_url: BOOK_URL, contact_urls: urls });

    expect(requests).toHaveLength(1);
    const { body } = requests[0];
    expect(body).toMatch(/<card:addressbook-multiget[^>]*xmlns:card="urn:ietf:params:xml:ns:carddav"/);
    expect(body).toMatch(/<d:prop>\s*<d:getetag\/>\s*<card:address-data\/>\s*<\/d:prop>/);
    expect(rawData(result)).toEqual([
      { url: urls[0], etag: '"e-c1"', data: expect.stringContaining('FN:Ada Lovelace') },
      { url: urls[1], etag: '"e-c2"', data: expect.stringContaining('FN:Alan Turing') },
    ]);
    expect(text(result)).toContain(`- ${urls[2]} — not found`);
  });
});

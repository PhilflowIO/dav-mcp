import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');
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
// the PROPFIND for a calendar's time zone, in which floating times and dates
// are shown (#117): kept apart from the multiget requests under test
const zoneLookups = [];
let respond;
const fetchStub = jest.fn(async (url, init) => {
  if (init.method === 'PROPFIND' && /calendar-timezone/.test(init.body)) {
    zoneLookups.push(url);
    return new Response('<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:"/>',
      { status: 207, statusText: 'Multi-Status', headers: { 'content-type': 'application/xml; charset=utf-8' } });
  }
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
// The collections exist; the tools look calendar_url / addressbook_url up first.
client.fetchCalendars = async () => [{ url: CALENDAR_URL }, { url: TASKS_URL }];
client.fetchAddressBooks = async () => [{ url: BOOK_URL }];

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => client, getCardDavClient: () => client },
}));

const { calendarMultiGet } = await import('../src/tools/calendar/calendar-multi-get.js');
const { todoMultiGet } = await import('../src/tools/todos/todo-multi-get.js');
const { addressbookMultiGet } = await import('../src/tools/contacts/addressbook-multi-get.js');
const { updateEventRaw } = await import('../src/tools/calendar/update-event-raw.js');

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
  zoneLookups.length = 0;
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

describe('large URL lists', () => {
  test('250 URLs go out as three REPORTs of at most 100 hrefs, results in request order', async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `${CALENDAR_URL}e${i}.ics`);
    respond = (url, init) => multistatus(
      ...[...init.body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map(([, href]) =>
        found(href, `e-${href}`, 'cal:calendar-data', ics(href, `Event ${href}`))),
    )();
    const result = await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: urls });

    expect(requests.map(r => (r.body.match(/<d:href>/g) || []).length)).toEqual([100, 100, 50]);
    expect(rawData(result).map(e => e.url)).toEqual(urls);
  });

  test('a chunk that fails is an error for the whole call', async () => {
    const urls = Array.from({ length: 150 }, (_, i) => `${CALENDAR_URL}e${i}.ics`);
    let call = 0;
    respond = () => (++call === 1
      ? multistatus()()
      : new Response('', { status: 500, statusText: 'Internal Server Error' }));
    await expect(calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: urls }))
      .rejects.toThrow(/Failed to fetch objects from .*500 Internal Server Error/);
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
    // each list's own time zone, asked once per list
    expect(zoneLookups).toEqual([TASKS_URL, other]);
  });
});

describe('todo_multi_get with a failing collection', () => {
  const gone = `${SERVER}/calendars/user/deleted-list/`;
  const urls = [`${TASKS_URL}t1.ics`, `${gone}t7.ics`, `${gone}t8.ics`];
  const tasksAnswer = multistatus(found('/calendars/user/tasks/t1.ics', 'e-1', 'cal:calendar-data', ics('t1', 'Task one', 'VTODO')));
  const failWith = (status, statusText) => (url) => url === TASKS_URL
    ? tasksAnswer()
    : new Response('<d:error xmlns:d="DAV:"/>', { status, statusText, headers: { 'content-type': 'application/xml' } });

  test.each([[404, 'Not Found'], [410, 'Gone']])(
    'a task list that answers %i only loses its own todos', async (status, statusText) => {
      respond = failWith(status, statusText);
      const result = await todoMultiGet.handler({ todo_urls: urls });

      expect(rawData(result).map(t => t.url)).toEqual([urls[0]]);
      expect(text(result)).toContain('Not found: **2**');
      expect(text(result)).toContain(`- ${urls[1]} — not found (task list ${gone} does not exist)`);
      expect(text(result)).toContain(`- ${urls[2]} — not found (task list ${gone} does not exist)`);
    });

  test.each([[401, 'Unauthorized'], [500, 'Internal Server Error']])(
    'a task list that answers %i fails the call and names the collection', async (status, statusText) => {
      respond = failWith(status, statusText);
      const error = await todoMultiGet.handler({ todo_urls: urls }).catch(e => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(`Failed to fetch objects from ${gone}`);
      expect(error.message).toContain(`${status} ${statusText}`);
      expect(error.httpStatus).toBe(status);
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

// #107: update_event edits a whole series and refuses RECURRENCE-ID; one
// occurrence is changed by the route its refusal and the descriptions name —
// calendar_multi_get, edit the override in the Raw Data block, update_event_raw.
describe('changing a single occurrence through the raw route (#107)', () => {
  test('the Raw Data of calendar_multi_get, with one override edited, goes back unchanged otherwise', async () => {
    const url = `${CALENDAR_URL}weekly.ics`;
    const series = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
      'BEGIN:VEVENT', 'UID:weekly@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Planning',
      'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:weekly@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Planning (moved)',
      'RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T140000Z', 'DTEND:20261012T150000Z', 'END:VEVENT',
      'END:VCALENDAR', '',
    ].join('\r\n');
    respond = multistatus(found('/calendars/user/work/weekly.ics', 'e-1', 'cal:calendar-data', series));

    const [object] = rawData(await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: [url] }));
    expect(object).toEqual({ url, etag: '"e-1"', data: series });

    // the model edits the override of 12 October only
    const edited = object.data
      .replace('DTSTART:20261012T140000Z', 'DTSTART:20261012T160000Z')
      .replace('DTEND:20261012T150000Z', 'DTEND:20261012T170000Z');
    respond = () => new Response(null, { status: 204, headers: { etag: '"e-2"' } });
    const reply = await updateEventRaw.handler({ event_url: object.url, event_etag: object.etag, updated_ical_data: edited });

    const put = requests.at(-1);
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(url);
    expect(put.headers['If-Match'] ?? put.headers['if-match']).toBe('"e-1"');
    expect(put.body).toBe(edited);
    // the master and the rule are as they were
    expect(put.body).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO\r\n');
    expect(put.body).toContain('DTSTART:20261005T090000Z\r\n');
    expect(reply.content[0].text).toContain('"e-2"');
  });
});

// A weak getetag can never satisfy If-Match (RFC 9110 13.1.1), and the write
// tools refuse it (#124). Handed out as `etag`, the model passes it to an
// update and is refused, with nothing else to try. So an `etag` field is only
// ever one a write can use; a weak one is shown as such, with the reason.
describe('a weak getetag', () => {
  const weak = (href, dataTag, data) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
    `<d:getetag>W/&quot;w-1&quot;</d:getetag><${dataTag}>${data}</${dataTag}>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

  const expectMarkedWeak = (object) => {
    expect(object).not.toHaveProperty('etag');
    expect(object.etag_note).toContain('weak ETag');
    expect(object.etag_note).toContain('W/"w-1"');
    expect(object.etag_note).toContain('cannot be updated or deleted');
  };

  test('calendar_multi_get does not hand it out as a usable etag', async () => {
    const url = `${CALENDAR_URL}a.ics`;
    respond = multistatus(weak('/calendars/user/work/a.ics', 'cal:calendar-data', ics('a', 'Alpha')));
    const [object] = rawData(await calendarMultiGet.handler({ calendar_url: CALENDAR_URL, event_urls: [url] }));
    expect(object.url).toBe(url);
    expect(object.data).toContain('SUMMARY:Alpha');
    expectMarkedWeak(object);
  });

  test('todo_multi_get says so in the entry instead of "required for updates"', async () => {
    const url = `${TASKS_URL}t.ics`;
    respond = multistatus(weak('/calendars/user/tasks/t.ics', 'cal:calendar-data', ics('t', 'Task', 'VTODO')));
    const result = await todoMultiGet.handler({ todo_urls: [url] });
    expectMarkedWeak(rawData(result)[0]);
    const etagLine = text(result).split('\n').find(line => line.startsWith('- **ETag**'));
    expect(etagLine).toContain('weak ETag');
    expect(etagLine).not.toContain('required for updates');
  });

  test('addressbook_multi_get does not hand it out as a usable etag', async () => {
    const url = `${BOOK_URL}c.vcf`;
    respond = multistatus(weak('/addressbooks/user/contacts/c.vcf', 'card:address-data', vcard('c', 'Carol')));
    const [object] = rawData(await addressbookMultiGet.handler({ addressbook_url: BOOK_URL, contact_urls: [url] }));
    expectMarkedWeak(object);
  });

  test('a strong one is handed out as before, todos still saying it is required for updates', async () => {
    const url = `${TASKS_URL}t.ics`;
    respond = multistatus(found('/calendars/user/tasks/t.ics', 'e-t', 'cal:calendar-data', ics('t', 'Task', 'VTODO')));
    const result = await todoMultiGet.handler({ todo_urls: [url] });
    expect(rawData(result)[0]).toEqual({ url, etag: '"e-t"', data: expect.any(String) });
    expect(text(result)).toContain('- **ETag**: "e-t" *(required for updates)*');
  });
});

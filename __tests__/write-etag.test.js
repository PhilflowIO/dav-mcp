import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');
import { DAVClient } from 'tsdav';

// The write tools run through a real tsdav DAVClient here, with only fetch
// stubbed by a small in-memory DAV server. A mocked createCalendarObject is how
// `etag: response.etag` went unnoticed (#76): the mocks returned `{ etag }`,
// tsdav returns a fetch Response, and the ETag is a header on it. Here the
// test sees the header the server sends and the If-Match the next write
// carries, so "the returned ETag can be fed straight back" is checked on the
// wire and not against a mock's idea of it.

const SERVER = 'https://dav.example.com';
const CALENDAR_URL = `${SERVER}/calendars/user/work/`;
const BOOK_URL = `${SERVER}/addressbooks/user/contacts/`;

const store = new Map();
const requests = [];
let revision = 0;
// What the server puts in the ETag header of a successful PUT
let etagHeader;

const header = (init, name) =>
  Object.entries(init.headers || {}).find(([k]) => k.toLowerCase() === name)?.[1];

const multiget = (body) => {
  const members = [...body.matchAll(/<(?:[\w-]+:)?href>([^<]+)</g)]
    .map(match => new URL(match[1], SERVER).href)
    .filter(url => store.has(url))
    .map(url => {
      const { etag, data } = store.get(url);
      const dataTag = url.endsWith('.vcf') ? 'card:address-data' : 'cal:calendar-data';
      return `<d:response><d:href>${new URL(url).pathname}</d:href><d:propstat><d:prop>` +
        `<d:getetag>${etag.replace(/"/g, '&quot;')}</d:getetag><${dataTag}>${data}</${dataTag}>` +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    });
  return new Response(
    '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
    `xmlns:card="urn:ietf:params:xml:ns:carddav">${members.join('')}</d:multistatus>`,
    { status: 207, statusText: 'Multi-Status', headers: { 'content-type': 'application/xml; charset=utf-8' } },
  );
};

const fetchStub = jest.fn(async (url, init = {}) => {
  requests.push({ url, ...init });
  if (init.method === 'REPORT') return multiget(String(init.body));
  if (init.method !== 'PUT') return new Response(null, { status: 405, statusText: 'Method Not Allowed' });

  const existing = store.get(url);
  const ifMatch = header(init, 'if-match');
  const refused = (header(init, 'if-none-match') === '*' && existing) ||
    (ifMatch !== undefined && (!existing || existing.etag !== ifMatch));
  if (refused) return new Response('', { status: 412, statusText: 'Precondition Failed' });

  const etag = `"rev-${++revision}"`;
  store.set(url, { etag, data: String(init.body) });
  const sent = etagHeader(etag);
  const response = new Response(null, {
    status: existing ? 204 : 201,
    statusText: existing ? 'No Content' : 'Created',
    headers: sent === undefined ? {} : { etag: sent },
  });
  // a Response that came from fetch knows its URL; one built by hand does not
  Object.defineProperty(response, 'url', { value: url });
  return response;
});

const client = new DAVClient({
  serverUrl: `${SERVER}/`,
  credentials: { username: 'user', password: 'pass' },
  authMethod: 'Basic',
  fetch: fetchStub,
});
client.authHeaders = { authorization: 'Basic dXNlcjpwYXNz' };
// Collection discovery is not what this suite is about
client.fetchCalendars = async () => [{ url: CALENDAR_URL, displayName: 'Work', components: ['VEVENT', 'VTODO'] }];
client.fetchAddressBooks = async () => [{ url: BOOK_URL, displayName: 'Contacts' }];

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => client, getCardDavClient: () => client },
}));

const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { updateEventRaw } = await import('../src/tools/calendar/update-event-raw.js');
const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { createTodo } = await import('../src/tools/todos/create-todo.js');
const { updateTodoRaw } = await import('../src/tools/todos/update-todo-raw.js');
const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');
const { createContact } = await import('../src/tools/contacts/create-contact.js');
const { updateContactRaw } = await import('../src/tools/contacts/update-contact-raw.js');
const { updateContactFields } = await import('../src/tools/contacts/update-contact-fields.js');
const { etagAfterWrite } = await import('../src/tools/shared/helpers.js');

const text = (result) => result.content[0].text;
const rawData = (result) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text(result))[1]);
const puts = () => requests.filter(r => r.method === 'PUT');

const NO_ETAG = 'no ETag returned — fetch the object before the next update';

// One row per object type: how to create it, and how to update it by raw data
// and by fields, given the URL and the ETag a caller holds.
const kinds = [
  {
    kind: 'event',
    create: () => createEvent.handler({
      calendar_url: CALENDAR_URL, summary: 'Review',
      start_date: '2026-12-01T10:00:00Z', end_date: '2026-12-01T11:00:00Z',
    }),
    updateRaw: (url, etag, data) => updateEventRaw.handler({ event_url: url, event_etag: etag, updated_ical_data: data }),
    updateFields: (url, etag) => updateEventFields.handler({ event_url: url, event_etag: etag, fields: { SUMMARY: 'Review (moved)' } }),
    edit: (data) => data.replace('SUMMARY:Review', 'SUMMARY:Review\r\nLOCATION:Room 2'),
  },
  {
    kind: 'todo',
    create: () => createTodo.handler({ calendar_url: CALENDAR_URL, summary: 'File report' }),
    updateRaw: (url, etag, data) => updateTodoRaw.handler({ todo_url: url, todo_etag: etag, updated_ical_data: data }),
    updateFields: (url, etag) => updateTodoFields.handler({ todo_url: url, todo_etag: etag, fields: { SUMMARY: 'File the report' } }),
    edit: (data) => data.replace('SUMMARY:File report', 'SUMMARY:File report\r\nPRIORITY:1'),
  },
  {
    kind: 'contact',
    create: () => createContact.handler({ addressbook_url: BOOK_URL, full_name: 'Ada Lovelace' }),
    updateRaw: (url, etag, data) => updateContactRaw.handler({ vcard_url: url, vcard_etag: etag, updated_vcard_data: data }),
    updateFields: (url, etag) => updateContactFields.handler({ vcard_url: url, vcard_etag: etag, fields: { FN: 'Ada King' } }),
    edit: (data) => data.replace('FN:Ada Lovelace', 'FN:Ada Lovelace\r\nNOTE:met in 1833'),
  },
];

beforeEach(() => {
  store.clear();
  requests.length = 0;
  revision = 0;
  etagHeader = (etag) => etag;
  fetchStub.mockClear();
});

describe.each(kinds)('ETag round trip: $kind', ({ create, updateRaw, updateFields, edit }) => {
  test('create returns the ETag header, and that value is accepted as-is by the next updates', async () => {
    const created = await create();
    const { url, etag } = rawData(created);

    // exactly what the server sent, quotes included
    expect(etag).toBe('"rev-1"');
    expect(etag).toBe(store.get(url).etag);
    expect(text(created)).toContain('- **ETag**: "rev-1"');

    // raw update: the ETag from the create result is the If-Match on the wire
    const afterRaw = await updateRaw(url, etag, edit(store.get(url).data));
    expect(header(puts()[1], 'if-match')).toBe('"rev-1"');
    expect(rawData(afterRaw).etag).toBe('"rev-2"');
    expect(text(afterRaw)).toContain('- **ETag**: "rev-2"');

    // field update: the ETag from the previous update result works the same way
    const afterFields = await updateFields(url, rawData(afterRaw).etag);
    expect(header(puts()[2], 'if-match')).toBe('"rev-2"');
    expect(rawData(afterFields).etag).toBe('"rev-3"');
    expect(store.get(url).etag).toBe('"rev-3"');
  });

  test('an ETag from before the last write is refused, so the returned one is the one that counts', async () => {
    const { url, etag: first } = rawData(await create());
    await updateRaw(url, first, edit(store.get(url).data));

    const error = await updateRaw(url, first, store.get(url).data).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.httpStatus).toBe(412);
  });

  test('a write the server answers without an ETag says so instead of returning nothing', async () => {
    etagHeader = () => undefined;

    const created = await create();
    expect(rawData(created)).not.toHaveProperty('etag');
    expect(rawData(created).etag_note).toBe(NO_ETAG);
    expect(text(created)).toContain(`- **ETag**: ${NO_ETAG}`);

    const { url } = rawData(created);
    const stored = store.get(url);
    for (const updated of [await updateRaw(url, stored.etag, edit(stored.data)), await updateFields(url, store.get(url).etag)]) {
      expect(rawData(updated)).not.toHaveProperty('etag');
      expect(text(updated)).toContain(`- **ETag**: ${NO_ETAG}`);
    }
  });
});

describe('etagAfterWrite', () => {
  const responseWith = (etag) => new Response(null, { status: 204, headers: etag === undefined ? {} : { etag } });

  test('passes a strong ETag through unchanged', () => {
    expect(etagAfterWrite(responseWith('"abc"'))).toEqual({ etag: '"abc"' });
    // a server that forgets the quotes gets back what it sent, too
    expect(etagAfterWrite(responseWith('abc'))).toEqual({ etag: 'abc' });
  });

  // If-Match compares strongly, so a weak ETag can never satisfy the next update
  test('does not hand out a weak ETag as if it were usable', () => {
    const result = etagAfterWrite(responseWith('W/"abc"'));
    expect(result).not.toHaveProperty('etag');
    expect(result.etag_note).toContain('weak ETag');
    expect(result.etag_note).toContain('W/"abc"');
    expect(result.etag_note).toContain('fetch the object before the next update');
    // the weak prefix is case-sensitive (RFC 9110 8.8.3): this is not one
    expect(etagAfterWrite(responseWith('w/"abc"'))).toEqual({ etag: 'w/"abc"' });
  });

  test.each([
    ['no ETag header', responseWith(undefined)],
    ['an empty ETag header', responseWith('')],
    ['a result that is not a Response', { url: 'https://dav.example.com/x.ics', etag: '"1"' }],
    ['nothing at all', undefined],
  ])('%s is reported as no ETag', (_, response) => {
    expect(etagAfterWrite(response)).toEqual({ etag_note: NO_ETAG });
  });
});

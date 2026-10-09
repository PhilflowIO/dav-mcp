import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// A caller's mistake has to come back as one: a URL that names nothing is a
// not-found error, content the server refuses as malformed is a validation
// error (#115). Untyped, these errors were classified by the words in their
// message — and the message carries the URL, so on a host like
// caldav.icloud.com a calendar_url typo read as a CalDAV server failure.
//
// Every case goes through the real tool handler and the response a client
// gets.

const CALDAV = 'https://caldav.example.com/';
const CARDDAV = 'https://carddav.example.com/';
connectTo(CALDAV, CARDDAV);

const CALENDAR_URL = `${CALDAV}calendars/user/work/`;
const TYPO_CALENDAR_URL = `${CALDAV}calendars/user/wrok/`;
const ADDRESSBOOK_URL = `${CARDDAV}addressbooks/user/contacts/`;
const TYPO_ADDRESSBOOK_URL = `${CARDDAV}addressbooks/user/contcts/`;

const caldav = {
  fetchCalendars: jest.fn(),
  fetchCalendarObjects: jest.fn(),
  fetchTodos: jest.fn(),
  createCalendarObject: jest.fn(),
  updateCalendarObject: jest.fn(),
  davRequest: jest.fn(),
  updateTodo: jest.fn(),
  createTodo: jest.fn(),
  deleteObject: jest.fn(),
  propfind: jest.fn(),
  account: { homeUrl: `${CALDAV}calendars/user/` },
};
const carddav = {
  fetchAddressBooks: jest.fn(),
  davRequest: jest.fn(),
  fetchVCards: jest.fn(),
  createVCard: jest.fn(),
  updateVCard: jest.fn(),
};

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => caldav,
    getCardDavClient: () => carddav,
  },
}));

const { tools } = await import('../src/tools/index.js');
const { createToolErrorResponse, MCP_ERROR_CODES } = await import('../src/error-handler.js');

const tool = (name) => tools.find(t => t.name === name);

/** What a client gets back when the handler throws. */
async function call(name, args) {
  try {
    await tool(name).handler(args);
  } catch (error) {
    return { name: error.name, ...JSON.parse(createToolErrorResponse(error).content[0].text) };
  }
  throw new Error(`${name} did not fail`);
}

const fetchResponse = (status, statusText, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  url: CALENDAR_URL,
  headers: new Headers(),
  text: async () => body,
});

beforeEach(() => {
  [...Object.values(caldav), ...Object.values(carddav)]
    .forEach(m => typeof m === 'function' && m.mockReset());
  caldav.fetchCalendars.mockResolvedValue([{ url: CALENDAR_URL, displayName: 'Work', components: ['VEVENT', 'VTODO'] }]);
  caldav.fetchCalendarObjects.mockResolvedValue([]);
  caldav.fetchTodos.mockResolvedValue([]);
  caldav.propfind.mockResolvedValue([{ ok: false, status: 404 }]);
  caldav.deleteObject.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' });
  carddav.fetchAddressBooks.mockResolvedValue([{ url: ADDRESSBOOK_URL, displayName: 'Contacts' }]);
  carddav.fetchVCards.mockResolvedValue([]);
});

describe('a calendar_url that is not one of the calendars', () => {
  test.each([
    ['calendar_query', { calendar_url: TYPO_CALENDAR_URL }],
    ['todo_query', { calendar_url: TYPO_CALENDAR_URL }],
    ['freebusy_query', {
      calendar_url: TYPO_CALENDAR_URL,
      time_range_start: '2026-10-01T00:00:00Z',
      time_range_end: '2026-10-02T00:00:00Z',
    }],
    ['list_events', { calendar_url: TYPO_CALENDAR_URL }],
    ['create_event', {
      calendar_url: TYPO_CALENDAR_URL,
      summary: 'Standup',
      start_date: '2026-10-01T09:00:00Z',
      end_date: '2026-10-01T09:15:00Z',
    }],
    ['list_todos', { calendar_url: TYPO_CALENDAR_URL }],
    ['create_todo', { calendar_url: TYPO_CALENDAR_URL, summary: 'Call back' }],
    ['calendar_multi_get', { calendar_url: TYPO_CALENDAR_URL, event_urls: [`${TYPO_CALENDAR_URL}a.ics`] }],
    ['delete_calendar', { calendar_url: TYPO_CALENDAR_URL }],
  ])('%s: a not-found error naming calendar_url and the calendars there are', async (name, args) => {
    const error = await call(name, args);

    expect(error.code).toBe(MCP_ERROR_CODES.NOT_FOUND_ERROR);
    expect(error.name).toBe('NotFoundError');
    expect(error.message).toContain('calendar_url');
    expect(error.message).toContain(TYPO_CALENDAR_URL);
    expect(error.message).toContain(CALENDAR_URL);
    expect(error.message).toContain('list_calendars');
  });
});

describe('an addressbook_url that is not one of the address books', () => {
  test.each([
    ['list_contacts', { addressbook_url: TYPO_ADDRESSBOOK_URL }],
    ['create_contact', { addressbook_url: TYPO_ADDRESSBOOK_URL, full_name: 'Ada Lovelace' }],
    ['addressbook_query', { addressbook_url: TYPO_ADDRESSBOOK_URL, name_filter: 'Ada' }],
    ['addressbook_multi_get', { addressbook_url: TYPO_ADDRESSBOOK_URL, contact_urls: [`${TYPO_ADDRESSBOOK_URL}a.vcf`] }],
  ])('%s: a not-found error naming addressbook_url and the address books there are', async (name, args) => {
    const error = await call(name, args);

    expect(error.code).toBe(MCP_ERROR_CODES.NOT_FOUND_ERROR);
    expect(error.name).toBe('NotFoundError');
    expect(error.message).toContain('addressbook_url');
    expect(error.message).toContain(TYPO_ADDRESSBOOK_URL);
    expect(error.message).toContain(ADDRESSBOOK_URL);
    expect(error.message).toContain('list_addressbooks');
  });
});

test('nothing is written after an unknown calendar_url', async () => {
  await call('create_todo', { calendar_url: TYPO_CALENDAR_URL, summary: 'Call back' });
  expect(caldav.createTodo).not.toHaveBeenCalled();
});

test('addressbook_query says the parameter can be left out', async () => {
  const error = await call('addressbook_query', { addressbook_url: TYPO_ADDRESSBOOK_URL, name_filter: 'Ada' });
  expect(error.message).toContain('omit addressbook_url to search all address books');
});

test('a long list of calendars is cut at 20, naming how many more list_calendars shows', async () => {
  const many = Array.from({ length: 27 }, (_, i) => ({ url: `${CALDAV}calendars/user/c${i}/` }));
  caldav.fetchCalendars.mockResolvedValue(many);

  const error = await call('list_events', { calendar_url: TYPO_CALENDAR_URL });

  expect(error.message).toContain(many[19].url);
  expect(error.message).not.toContain(many[20].url);
  expect(error.message).toContain('and 7 more (list_calendars lists them all)');
});

describe('an object URL with nothing behind it', () => {
  test.each([
    ['update_event', 'event_url', `${CALENDAR_URL}gone.ics`, { event_etag: '"1"', fields: { SUMMARY: 'x' } }],
    ['update_todo', 'todo_url', `${CALENDAR_URL}gone.ics`, { todo_etag: '"1"', fields: { SUMMARY: 'x' } }],
    ['update_contact', 'vcard_url', `${ADDRESSBOOK_URL}gone.vcf`, { vcard_etag: '"1"', fields: { FN: 'x' } }],
  ])('%s: a not-found error naming %s and its URL', async (name, parameter, url, rest) => {
    const error = await call(name, { [parameter]: url, ...rest });

    expect(error.code).toBe(MCP_ERROR_CODES.NOT_FOUND_ERROR);
    expect(error.name).toBe('NotFoundError');
    expect(error.message).toContain(parameter);
    expect(error.message).toContain(url);
  });
});

describe('content the server refuses as invalid', () => {
  const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VCALENDAR\r\n';
  const SABRE = 'This resource only supports valid iCalendar 2.0 data.';

  // SabreDAV (Nextcloud, Baïkal) answers an unparseable object with 415,
  // Radicale with 400; 422 is the generic "understood, cannot process".
  test.each([
    [400, 'Bad Request'],
    [415, 'Unsupported Media Type'],
    [422, 'Unprocessable Content'],
  ])('%i %s on data the caller wrote (update_event_raw) is a validation error saying what to correct',
    async (status, statusText) => {
      caldav.updateCalendarObject.mockResolvedValue(fetchResponse(status, statusText, SABRE));

      const error = await call('update_event_raw', {
        event_url: `${CALENDAR_URL}a.ics`, event_etag: '"1"', updated_ical_data: ICS,
      });

      expect(error.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
      expect(error.message).toContain(`The server refused the event as invalid (${status} ${statusText})`);
      expect(error.message).toContain(SABRE);
      expect(error.message).toContain('updated_ical_data');
    });

  test.each([
    ['update_todo_raw', 'updateTodo', {
      todo_url: `${CALENDAR_URL}t.ics`, todo_etag: '"1"', updated_ical_data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    }, 'updated_ical_data'],
    ['update_contact_raw', 'updateVCard', {
      vcard_url: `${ADDRESSBOOK_URL}c.vcf`, vcard_etag: '"1"', updated_vcard_data: 'BEGIN:VCARD\r\nEND:VCARD',
    }, 'updated_vcard_data'],
  ])('%s: a 415 names the parameter to correct', async (name, method, args, parameter) => {
    const client = method === 'updateVCard' ? carddav : caldav;
    client[method].mockResolvedValue(fetchResponse(415, 'Unsupported Media Type', 'bad data'));

    const error = await call(name, args);

    expect(error.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toContain(parameter);
  });

  test('a field write (create_event) refused as invalid is a validation error naming the fields', async () => {
    caldav.createCalendarObject.mockResolvedValue(fetchResponse(400, 'Bad Request', 'bad DTSTART'));

    const error = await call('create_event', {
      calendar_url: CALENDAR_URL, summary: 'x', start_date: '2026-10-01T09:00:00Z', end_date: '2026-10-01T10:00:00Z',
    });

    expect(error.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toContain('The server refused the event as invalid (400 Bad Request): bad DTSTART');
  });

  // A request body dav-mcp builds itself is not the caller's to fix: a 415 on
  // it is dav-mcp's or the server's fault, and calling it invalid input sends
  // the model into a loop of "correcting" what it sent.
  test('a 415 on a request dav-mcp built (multi-get REPORT) is an internal error', async () => {
    caldav.davRequest.mockResolvedValue([
      { ok: false, status: 415, statusText: 'Unsupported Media Type', raw: '', href: CALENDAR_URL },
    ]);

    const error = await call('calendar_multi_get', {
      calendar_url: CALENDAR_URL, event_urls: [`${CALENDAR_URL}a.ics`],
    });

    expect(error.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
    expect(error.message).not.toContain('Correct');
  });
});

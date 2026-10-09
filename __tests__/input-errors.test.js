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
  account: { homeUrl: `${CALDAV}calendars/user/` },
};
const carddav = {
  fetchAddressBooks: jest.fn(),
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

describe('content the server refuses as malformed', () => {
  const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VCALENDAR\r\n';

  // SabreDAV (Nextcloud, Baikal) answers an unparseable object with 415,
  // Radicale with 400; 422 is the generic "understood, cannot process".
  test.each([
    [400, 'Bad Request'],
    [415, 'Unsupported Media Type'],
    [422, 'Unprocessable Content'],
  ])('%i %s from update_event_raw is a validation error', async (status, statusText) => {
    caldav.updateCalendarObject.mockResolvedValue(fetchResponse(status, statusText, 'This resource only supports valid iCalendar 2.0 data.'));

    const error = await call('update_event_raw', {
      event_url: `${CALENDAR_URL}a.ics`, event_etag: '"1"', updated_ical_data: ICS,
    });

    expect(error.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toContain(`${status} ${statusText}`);
    expect(error.message).toContain('valid iCalendar 2.0 data');
  });
});

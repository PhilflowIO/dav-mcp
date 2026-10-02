import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// tsdav never rejects on an HTTP error: object writes return the bare fetch
// Response, XML requests return DAVResponse[] with ok:false. Every write tool
// has to look at that result, or a refused write is reported as done (#72).

const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/contacts/';

const caldav = {
  fetchCalendars: jest.fn(),
  createCalendarObject: jest.fn(),
  updateCalendarObject: jest.fn(),
  createTodo: jest.fn(),
  updateTodo: jest.fn(),
  fetchTodos: jest.fn(),
  makeCalendar: jest.fn(),
  account: { homeUrl: 'https://dav.example.com/calendars/user/' },
};
const carddav = {
  fetchAddressBooks: jest.fn(),
  createVCard: jest.fn(),
  updateVCard: jest.fn(),
};

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => caldav,
    getCardDavClient: () => carddav,
  },
}));

const { assertDavSuccess, davFailure } = await import('../src/tools/shared/helpers.js');
const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { updateEventRaw } = await import('../src/tools/calendar/update-event-raw.js');
const { createContact } = await import('../src/tools/contacts/create-contact.js');
const { updateContactRaw } = await import('../src/tools/contacts/update-contact-raw.js');
const { createTodo } = await import('../src/tools/todos/create-todo.js');
const { updateTodoRaw } = await import('../src/tools/todos/update-todo-raw.js');
const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');

const fetchResponse = (status, statusText = '', body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  url: 'https://dav.example.com/x',
  text: async () => body,
});

const sabreError = (message) =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">\n' +
  '  <s:exception>Sabre\\DAV\\Exception\\MethodNotAllowed</s:exception>\n' +
  `  <s:message>${message}</s:message>\n` +
  '</d:error>';

beforeEach(() => {
  Object.values(caldav).forEach(m => typeof m === 'function' && m.mockReset());
  Object.values(carddav).forEach(m => m.mockReset());
  caldav.fetchCalendars.mockResolvedValue([{ url: CALENDAR_URL }]);
  carddav.fetchAddressBooks.mockResolvedValue([{ url: ADDRESSBOOK_URL }]);
});

describe('assertDavSuccess', () => {
  test('accepts a 2xx fetch Response', async () => {
    await expect(assertDavSuccess(fetchResponse(201, 'Created'), 'x')).resolves.toBeUndefined();
  });

  test('rejects a non-2xx fetch Response with status and body', async () => {
    await expect(assertDavSuccess(fetchResponse(412, 'Precondition Failed', 'etag mismatch'), 'update event'))
      .rejects.toThrow('Failed to update event: server responded 412 Precondition Failed: etag mismatch');
  });

  test('surfaces the Sabre <s:message>, not the whole XML body', async () => {
    const error = await assertDavSuccess(
      [{ ok: false, status: 405, statusText: 'Method Not Allowed', raw: sabreError('The resource you tried to create already exists') }],
      'create calendar',
    ).catch(e => e);
    expect(error.message).toBe(
      'Failed to create calendar: server responded 405 Method Not Allowed: The resource you tried to create already exists'
    );
    expect(error.details).toMatchObject({ status: 405, serverMessage: 'The resource you tried to create already exists' });
  });

  test('accepts a DAVResponse[] that is ok', async () => {
    await expect(assertDavSuccess([{ ok: true, status: 201, statusText: 'Created' }], 'x')).resolves.toBeUndefined();
  });

  test('rejects a 207 whose propstat refused a property (PROPPATCH)', async () => {
    const raw = {
      multistatus: {
        response: {
          href: '/calendars/user/work/',
          propstat: [
            { prop: { displayname: {} }, status: 'HTTP/1.1 200 OK' },
            { prop: { calendarTimezone: {} }, status: 'HTTP/1.1 403 Forbidden' },
          ],
        },
      },
    };
    await expect(assertDavSuccess([{ ok: true, status: 207, statusText: 'Multi-Status', raw }], 'update calendar'))
      .rejects.toThrow('server responded 403 Forbidden');
  });

  test('a result without a status is not turned into a failure', async () => {
    await expect(davFailure(undefined)).resolves.toBeNull();
    await expect(davFailure({ url: 'x' })).resolves.toBeNull();
  });
});

describe('every write tool reports a refused write', () => {
  test('create_event', async () => {
    caldav.createCalendarObject.mockResolvedValue(fetchResponse(403, 'Forbidden'));
    await expect(createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'x',
      start_date: '2026-10-01T10:00:00Z',
      end_date: '2026-10-01T11:00:00Z',
    })).rejects.toThrow(/create event.*403/);
  });

  test('update_event_raw', async () => {
    caldav.updateCalendarObject.mockResolvedValue(fetchResponse(412, 'Precondition Failed'));
    await expect(updateEventRaw.handler({
      event_url: `${CALENDAR_URL}e.ics`,
      event_etag: '"1"',
      updated_ical_data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    })).rejects.toThrow(/412/);
  });

  test('create_contact', async () => {
    carddav.createVCard.mockResolvedValue(fetchResponse(507, 'Insufficient Storage'));
    await expect(createContact.handler({ addressbook_url: ADDRESSBOOK_URL, full_name: 'A B' }))
      .rejects.toThrow(/create contact.*507/);
  });

  test('update_contact_raw', async () => {
    carddav.updateVCard.mockResolvedValue(fetchResponse(412, 'Precondition Failed'));
    await expect(updateContactRaw.handler({
      vcard_url: `${ADDRESSBOOK_URL}c.vcf`,
      vcard_etag: '"1"',
      updated_vcard_data: 'BEGIN:VCARD\r\nEND:VCARD',
    })).rejects.toThrow(/412/);
  });

  test('create_todo', async () => {
    caldav.createTodo.mockResolvedValue(fetchResponse(403, 'Forbidden'));
    await expect(createTodo.handler({ calendar_url: CALENDAR_URL, summary: 'x' }))
      .rejects.toThrow(/create todo.*403/);
  });

  test('update_todo_raw', async () => {
    caldav.updateTodo.mockResolvedValue(fetchResponse(412, 'Precondition Failed'));
    await expect(updateTodoRaw.handler({
      todo_url: `${CALENDAR_URL}t.ics`,
      todo_etag: '"1"',
      updated_ical_data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    })).rejects.toThrow(/412/);
  });

  test('update_todo (field-based)', async () => {
    caldav.fetchTodos.mockResolvedValue([{
      url: `${CALENDAR_URL}t.ics`,
      etag: '"1"',
      data: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:t\r\nSUMMARY:old\r\nEND:VTODO\r\nEND:VCALENDAR\r\n',
    }]);
    caldav.updateTodo.mockResolvedValue(fetchResponse(403, 'Forbidden'));
    await expect(updateTodoFields.handler({
      todo_url: `${CALENDAR_URL}t.ics`,
      todo_etag: '"1"',
      fields: { SUMMARY: 'new' },
    })).rejects.toThrow(/403/);
  });

  test('a 2xx write still succeeds', async () => {
    caldav.createTodo.mockResolvedValue(fetchResponse(201, 'Created'));
    const result = await createTodo.handler({ calendar_url: CALENDAR_URL, summary: 'x' });
    expect(result.content[0].text).toContain('Todo created successfully');
  });
});

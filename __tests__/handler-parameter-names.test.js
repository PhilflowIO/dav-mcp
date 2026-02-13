/**
 * Tests that handlers pass correct parameter names to tsdav client methods.
 *
 * Background: tsdav (PhilflowIO fork) expects { calendarObject: {...} }
 * but the handlers previously used { todo: {...} }, causing
 * "TypeError: Cannot read properties of undefined (reading 'etag')"
 *
 * Also verifies that update-*-fields handlers do NOT catch errors internally
 * (error handling is done centrally in server-stdio.js).
 */

import { jest } from '@jest/globals';

// --- Mock tsdav-utils ---
const mockUpdateFields = jest.fn((obj, fields) => 'UPDATED_ICAL_DATA');
jest.unstable_mockModule('tsdav-utils', () => ({
  updateFields: mockUpdateFields,
}));

// --- Mock tsdavManager ---
const mockUpdateTodo = jest.fn().mockResolvedValue({ url: 'http://x/todo.ics', etag: '"new-etag"' });
const mockDeleteTodo = jest.fn().mockResolvedValue({});
const mockFetchTodos = jest.fn().mockResolvedValue([{ url: 'http://x/todo.ics', data: 'VCAL_DATA', etag: '"old"' }]);

const mockUpdateCalendarObject = jest.fn().mockResolvedValue({ url: 'http://x/event.ics', etag: '"new-etag"' });
const mockFetchCalendarObjects = jest.fn().mockResolvedValue([{ url: 'http://x/event.ics', data: 'VCAL_DATA', etag: '"old"' }]);

const mockUpdateVCard = jest.fn().mockResolvedValue({ url: 'http://x/contact.vcf', etag: '"new-etag"' });
const mockFetchVCards = jest.fn().mockResolvedValue([{ url: 'http://x/contact.vcf', data: 'VCARD_DATA', etag: '"old"' }]);

const mockCalDavClient = {
  updateTodo: mockUpdateTodo,
  deleteTodo: mockDeleteTodo,
  fetchTodos: mockFetchTodos,
  updateCalendarObject: mockUpdateCalendarObject,
  fetchCalendarObjects: mockFetchCalendarObjects,
};

const mockCardDavClient = {
  updateVCard: mockUpdateVCard,
  fetchVCards: mockFetchVCards,
};

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => mockCalDavClient,
    getCardDavClient: () => mockCardDavClient,
  },
}));

// --- Import handlers after mocks ---
const { deleteTodo } = await import('../src/tools/todos/delete-todo.js');
const { updateTodoRaw } = await import('../src/tools/todos/update-todo-raw.js');
const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');
const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { updateContactFields } = await import('../src/tools/contacts/update-contact-fields.js');

// ============================================================
// Tests
// ============================================================

describe('Todo handlers: calendarObject parameter name', () => {
  beforeEach(() => jest.clearAllMocks());

  test('delete_todo passes calendarObject (not todo) to client.deleteTodo', async () => {
    await deleteTodo.handler({
      todo_url: 'http://example.com/cal/todo.ics',
      todo_etag: '"etag-123"',
    });

    expect(mockDeleteTodo).toHaveBeenCalledTimes(1);
    const callArg = mockDeleteTodo.mock.calls[0][0];

    // Must have calendarObject
    expect(callArg).toHaveProperty('calendarObject');
    expect(callArg.calendarObject).toEqual({
      url: 'http://example.com/cal/todo.ics',
      etag: '"etag-123"',
    });

    // Must NOT have todo
    expect(callArg).not.toHaveProperty('todo');
  });

  test('update_todo_raw passes calendarObject (not todo) to client.updateTodo', async () => {
    await updateTodoRaw.handler({
      todo_url: 'http://example.com/cal/todo.ics',
      todo_etag: '"etag-123"',
      updated_ical_data: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
    });

    expect(mockUpdateTodo).toHaveBeenCalledTimes(1);
    const callArg = mockUpdateTodo.mock.calls[0][0];

    expect(callArg).toHaveProperty('calendarObject');
    expect(callArg.calendarObject).toEqual({
      url: 'http://example.com/cal/todo.ics',
      data: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      etag: '"etag-123"',
    });
    expect(callArg).not.toHaveProperty('todo');
  });

  test('update_todo (fields) passes calendarObject (not todo) to client.updateTodo', async () => {
    await updateTodoFields.handler({
      todo_url: 'http://example.com/cal/todo.ics',
      todo_etag: '"etag-123"',
      fields: { SUMMARY: 'New title' },
    });

    expect(mockUpdateTodo).toHaveBeenCalledTimes(1);
    const callArg = mockUpdateTodo.mock.calls[0][0];

    expect(callArg).toHaveProperty('calendarObject');
    expect(callArg.calendarObject.url).toBe('http://example.com/cal/todo.ics');
    expect(callArg.calendarObject.etag).toBe('"etag-123"');
    expect(callArg).not.toHaveProperty('todo');
  });
});

describe('Error propagation (no internal try-catch)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('update_todo (fields) propagates errors to caller', async () => {
    mockFetchTodos.mockRejectedValueOnce(new Error('Network error'));

    await expect(
      updateTodoFields.handler({
        todo_url: 'http://example.com/cal/todo.ics',
        todo_etag: '"etag-123"',
        fields: { SUMMARY: 'x' },
      })
    ).rejects.toThrow('Network error');
  });

  test('update_event (fields) propagates errors to caller', async () => {
    mockFetchCalendarObjects.mockRejectedValueOnce(new Error('Server down'));

    await expect(
      updateEventFields.handler({
        event_url: 'http://example.com/cal/event.ics',
        event_etag: '"etag-123"',
        fields: { SUMMARY: 'x' },
      })
    ).rejects.toThrow('Server down');
  });

  test('update_contact (fields) propagates errors to caller', async () => {
    mockFetchVCards.mockRejectedValueOnce(new Error('Auth failed'));

    await expect(
      updateContactFields.handler({
        vcard_url: 'http://example.com/addr/c.vcf',
        vcard_etag: '"etag-123"',
        fields: { FN: 'x' },
      })
    ).rejects.toThrow('Auth failed');
  });

  test('update_todo (fields) does NOT swallow errors into formatError', async () => {
    mockFetchTodos.mockRejectedValueOnce(new Error('Boom'));

    let caught;
    try {
      await updateTodoFields.handler({
        todo_url: 'http://example.com/cal/todo.ics',
        todo_etag: '"etag-123"',
        fields: {},
      });
    } catch (e) {
      caught = e;
    }

    // It should be a real Error, not a formatted MCP response
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('Boom');
  });
});

describe('Event handler: calendarObject parameter name', () => {
  beforeEach(() => jest.clearAllMocks());

  test('update_event (fields) passes calendarObject to client.updateCalendarObject', async () => {
    await updateEventFields.handler({
      event_url: 'http://example.com/cal/event.ics',
      event_etag: '"etag-123"',
      fields: { SUMMARY: 'Updated' },
    });

    expect(mockUpdateCalendarObject).toHaveBeenCalledTimes(1);
    const callArg = mockUpdateCalendarObject.mock.calls[0][0];

    expect(callArg).toHaveProperty('calendarObject');
    expect(callArg.calendarObject.url).toBe('http://example.com/cal/event.ics');
    expect(callArg.calendarObject.etag).toBe('"etag-123"');
  });
});

describe('Contact handler: vCard parameter name', () => {
  beforeEach(() => jest.clearAllMocks());

  test('update_contact (fields) passes vCard to client.updateVCard', async () => {
    await updateContactFields.handler({
      vcard_url: 'http://example.com/addr/c.vcf',
      vcard_etag: '"etag-123"',
      fields: { FN: 'New Name' },
    });

    expect(mockUpdateVCard).toHaveBeenCalledTimes(1);
    const callArg = mockUpdateVCard.mock.calls[0][0];

    expect(callArg).toHaveProperty('vCard');
    expect(callArg.vCard.url).toBe('http://example.com/addr/c.vcf');
    expect(callArg.vCard.etag).toBe('"etag-123"');
  });
});

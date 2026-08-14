import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const EVENT_URL = `${CALENDAR_URL}e.ics`;

const deleteObject = jest.fn();
const deleteCalendarObject = jest.fn();
const deleteVCard = jest.fn();
const deleteTodo = jest.fn();

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({ deleteObject, deleteCalendarObject, deleteTodo }),
    getCardDavClient: () => ({ deleteVCard }),
  },
}));

const { deleteCalendar } = await import('../src/tools/calendar/delete-calendar.js');
const { deleteEvent } = await import('../src/tools/calendar/delete-event.js');
const { deleteContact } = await import('../src/tools/contacts/delete-contact.js');
const { deleteTodo: deleteTodoTool } = await import('../src/tools/todos/delete-todo.js');

const davResponse = (status, statusText = '', body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  text: async () => body,
});

beforeEach(() => {
  [deleteObject, deleteCalendarObject, deleteVCard, deleteTodo].forEach(m => m.mockReset());
});

describe('a refused delete is reported as a failure', () => {
  test('delete_calendar throws on 403', async () => {
    deleteObject.mockResolvedValue(davResponse(403, 'Forbidden'));
    await expect(deleteCalendar.handler({ calendar_url: CALENDAR_URL }))
      .rejects.toThrow(/403/);
  });

  test('the error says the object is still there', async () => {
    deleteObject.mockResolvedValue(davResponse(405, 'Method Not Allowed'));
    await expect(deleteCalendar.handler({ calendar_url: CALENDAR_URL }))
      .rejects.toThrow(/still exists on the server/);
  });

  test('the server response body is surfaced', async () => {
    deleteObject.mockResolvedValue(davResponse(403, 'Forbidden', 'collection is read-only'));
    await expect(deleteCalendar.handler({ calendar_url: CALENDAR_URL }))
      .rejects.toThrow(/collection is read-only/);
  });

  test('delete_event throws on 409', async () => {
    deleteCalendarObject.mockResolvedValue(davResponse(409, 'Conflict'));
    await expect(deleteEvent.handler({ event_url: EVENT_URL, event_etag: '"1"' }))
      .rejects.toThrow(/409/);
  });

  test('delete_contact throws on 500', async () => {
    deleteVCard.mockResolvedValue(davResponse(500, 'Internal Server Error'));
    await expect(deleteContact.handler({
      vcard_url: 'https://dav.example.com/addressbooks/user/default/c.vcf',
      vcard_etag: '"1"',
    })).rejects.toThrow(/500/);
  });

  test('delete_todo throws on 403', async () => {
    deleteTodo.mockResolvedValue(davResponse(403, 'Forbidden'));
    await expect(deleteTodoTool.handler({ todo_url: `${CALENDAR_URL}t.ics`, todo_etag: '"1"' }))
      .rejects.toThrow(/403/);
  });
});

describe('a successful delete still succeeds', () => {
  test('204 No Content', async () => {
    deleteObject.mockResolvedValue(davResponse(204, 'No Content'));
    const result = await deleteCalendar.handler({ calendar_url: CALENDAR_URL });
    expect(result.content[0].text).toContain('deleted');
  });

  test('404 counts as done — DELETE is idempotent', async () => {
    deleteCalendarObject.mockResolvedValue(davResponse(404, 'Not Found'));
    await expect(deleteEvent.handler({ event_url: EVENT_URL, event_etag: '"1"' }))
      .resolves.toBeDefined();
  });

  test('a tsdav version that returns no Response is not treated as a failure', async () => {
    deleteObject.mockResolvedValue(undefined);
    await expect(deleteCalendar.handler({ calendar_url: CALENDAR_URL })).resolves.toBeDefined();
  });
});

describe('success messages read as English', () => {
  test('a create message is not doubled', async () => {
    deleteObject.mockResolvedValue(davResponse(204));
    const text = (await deleteCalendar.handler({ calendar_url: CALENDAR_URL })).content[0].text;
    expect(text).not.toMatch(/successfully successful/);
  });

  test('formatSuccess does not append a second success word', async () => {
    const { formatSuccess } = await import('../src/formatters.js');
    const text = formatSuccess('Todo created successfully', { url: 'https://example.com/t.ics' })
      .content[0].text;
    expect(text).toContain('✅ **Todo created successfully**');
    expect(text).not.toContain('successful**');
  });
});

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

  test('a tsdav version that returns no Response is not treated as a failure', async () => {
    deleteObject.mockResolvedValue(undefined);
    await expect(deleteCalendar.handler({ calendar_url: CALENDAR_URL })).resolves.toBeDefined();
  });
});

// A 404 used to count as done ("DELETE is idempotent"), so deleting a URL
// that never existed — a typo, an object someone else removed — was reported
// as "deleted successfully". Nothing was deleted, and the result says so.
describe('a 404 is not a deletion', () => {
  const cases = [
    ['delete_calendar', () => deleteCalendar.handler({ calendar_url: CALENDAR_URL }), deleteObject, 'calendar', CALENDAR_URL],
    ['delete_event', () => deleteEvent.handler({ event_url: EVENT_URL, event_etag: '"1"' }), deleteCalendarObject, 'event', EVENT_URL],
    ['delete_todo', () => deleteTodoTool.handler({ todo_url: `${CALENDAR_URL}t.ics`, todo_etag: '"1"' }), deleteTodo, 'todo', `${CALENDAR_URL}t.ics`],
    ['delete_contact', () => deleteContact.handler({
      vcard_url: 'https://dav.example.com/addressbooks/user/default/c.vcf', vcard_etag: '"1"',
    }), deleteVCard, 'contact', 'https://dav.example.com/addressbooks/user/default/c.vcf'],
  ];

  test.each(cases)('%s reports not found, with the NOT_FOUND code', async (_, run, mock, kind, url) => {
    mock.mockResolvedValue(davResponse(404, 'Not Found'));
    const error = await run().catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`No ${kind} at ${url} — nothing was deleted.`);
    expect(error.code).toBe(-32006); // NOT_FOUND_ERROR
    expect(error.message).not.toMatch(/success|still exists/);
  });
});

describe('a 412 does not claim the object exists', () => {
  // Servers answer a DELETE with If-Match on a missing object with 412, too.
  test('delete_event says the ETag did not match and nothing was deleted', async () => {
    deleteCalendarObject.mockResolvedValue(davResponse(412, 'Precondition Failed'));
    const error = await deleteEvent.handler({ event_url: EVENT_URL, event_etag: '"1"' }).catch(e => e);

    expect(error.message).toContain('412 Precondition Failed');
    expect(error.message).toContain('Nothing was deleted: the ETag does not match');
    expect(error.message).toContain('or it does not exist');
    expect(error.message).not.toContain('still exists');
    expect(error.httpStatus).toBe(412);
  });

  test('other failures still say the object is there', async () => {
    deleteCalendarObject.mockResolvedValue(davResponse(403, 'Forbidden'));
    await expect(deleteEvent.handler({ event_url: EVENT_URL, event_etag: '"1"' }))
      .rejects.toThrow(/403 Forbidden.*still exists/);
  });
});

describe('what the delete tools hand to tsdav', () => {
  // tsdav's client shallow-merges its auth headers with the caller's; before
  // the v2.3.5 sync a caller `headers` object replaced them outright. Passing
  // nothing is what keeps the request authenticated (#72).
  test('delete_calendar passes only the URL — no headers to override auth', async () => {
    deleteObject.mockResolvedValue(davResponse(204));
    await deleteCalendar.handler({ calendar_url: CALENDAR_URL });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith({ url: CALENDAR_URL });
  });

  test('delete_event passes URL and etag, no headers', async () => {
    deleteCalendarObject.mockResolvedValue(davResponse(204));
    await deleteEvent.handler({ event_url: EVENT_URL, event_etag: '"1"' });
    expect(deleteCalendarObject).toHaveBeenCalledWith({
      calendarObject: { url: EVENT_URL, etag: '"1"' },
    });
  });

  test('delete_contact passes URL and etag, no headers', async () => {
    deleteVCard.mockResolvedValue(davResponse(204));
    const url = 'https://dav.example.com/addressbooks/user/default/c.vcf';
    await deleteContact.handler({ vcard_url: url, vcard_etag: '"1"' });
    expect(deleteVCard).toHaveBeenCalledWith({ vCard: { url, etag: '"1"' } });
  });

  test('delete_todo passes URL and etag, no headers', async () => {
    deleteTodo.mockResolvedValue(davResponse(204));
    const url = `${CALENDAR_URL}t.ics`;
    await deleteTodoTool.handler({ todo_url: url, todo_etag: '"1"' });
    expect(deleteTodo).toHaveBeenCalledWith({ calendarObject: { url, etag: '"1"' } });
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

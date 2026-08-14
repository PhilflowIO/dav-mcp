import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// The create tools build their document by hand, so the only way to assert the
// emitted bytes is to drive the handler with a stubbed DAV client.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/default/';

const createCalendarObject = jest.fn(async () => ({ url: `${CALENDAR_URL}e.ics`, etag: '"1"' }));
const createVCard = jest.fn(async () => ({ url: `${ADDRESSBOOK_URL}c.vcf`, etag: '"1"' }));
const createTodoObject = jest.fn(async () => ({ url: `${CALENDAR_URL}t.ics`, etag: '"1"' }));

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Work' }],
      createCalendarObject,
      createTodo: createTodoObject,
    }),
    getCardDavClient: () => ({
      fetchAddressBooks: async () => [{ url: ADDRESSBOOK_URL, displayName: 'Default' }],
      createVCard,
    }),
  },
}));

const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { createContact } = await import('../src/tools/contacts/create-contact.js');
const { createTodo } = await import('../src/tools/todos/create-todo.js');

const assertCrlfOnly = (document) => {
  expect(document).toContain('\r\n');
  // every LF must be preceded by a CR, and no CR may stand alone
  expect(document).not.toMatch(/(^|[^\r])\n/);
  expect(document).not.toMatch(/\r(?!\n)/);
};

beforeEach(() => {
  createCalendarObject.mockClear();
  createVCard.mockClear();
  createTodoObject.mockClear();
});

describe('emitted documents use CRLF line endings', () => {
  test('create_event', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Standup',
      start_date: '2026-05-25T10:00:00Z',
      end_date: '2026-05-25T11:00:00Z',
      description: 'Daily sync',
      location: 'Room 1',
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    assertCrlfOnly(iCalString);
    expect(iCalString).toContain('SUMMARY:Standup');
    expect(iCalString).toContain('DESCRIPTION:Daily sync');
    expect(iCalString).toContain('LOCATION:Room 1');
  });

  test('create_event omits optional properties it was not given', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Standup',
      start_date: '2026-05-25T10:00:00Z',
      end_date: '2026-05-25T11:00:00Z',
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    assertCrlfOnly(iCalString);
    expect(iCalString).not.toContain('DESCRIPTION:');
    expect(iCalString).not.toContain('LOCATION:');
  });

  test('create_contact', async () => {
    await createContact.handler({
      addressbook_url: ADDRESSBOOK_URL,
      full_name: 'Ada Lovelace',
      given_name: 'Ada',
      family_name: 'Lovelace',
      email: 'ada@example.com',
      phone: '+49 30 1234',
      organization: 'Analytical Engines',
      note: 'First programmer',
    });

    const { vCardString } = createVCard.mock.calls[0][0];
    assertCrlfOnly(vCardString);
    expect(vCardString).toContain('FN:Ada Lovelace');
    expect(vCardString).toContain('EMAIL;TYPE=INTERNET:ada@example.com');
  });

  test('create_todo (already correct, guarded against regression)', async () => {
    await createTodo.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Write the report',
    });

    const { iCalString } = createTodoObject.mock.calls[0][0];
    assertCrlfOnly(iCalString.replace(/\r\n$/, ''));
  });
});

describe('hostile input cannot open a new content line', () => {
  test('create_event escapes line breaks in the summary', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Standup\r\nSUMMARY:HIJACKED',
      start_date: '2026-05-25T10:00:00Z',
      end_date: '2026-05-25T11:00:00Z',
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    assertCrlfOnly(iCalString);
    expect(iCalString).toContain('SUMMARY:Standup\\nSUMMARY:HIJACKED');
    expect(iCalString.match(/^SUMMARY:/gm)).toHaveLength(1);
  });

  test('create_contact escapes line breaks in the note', async () => {
    await createContact.handler({
      addressbook_url: ADDRESSBOOK_URL,
      full_name: 'Ada Lovelace',
      note: 'ok\rNOTE:injected',
    });

    const { vCardString } = createVCard.mock.calls[0][0];
    assertCrlfOnly(vCardString);
    expect(vCardString.match(/^NOTE:/gm)).toHaveLength(1);
  });
});

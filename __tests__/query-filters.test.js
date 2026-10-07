import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// Issue #94: the query tools filtered with patterns over the raw text, which
// missed properties with parameters and folded lines, compared escaped text,
// and let /N:(.+)/ match inside other lines. Every filter now reads one ical.js
// parse per object. These tests drive the real handlers with a stubbed client.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/main/';
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/default/';

let storedTodos = [];
let storedEvents = [];
let storedCards = [];

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Main' }],
      fetchTodos: async () => storedTodos,
      fetchCalendarObjects: async () => storedEvents,
    }),
    getCardDavClient: () => ({
      fetchAddressBooks: async () => [{ url: ADDRESSBOOK_URL, displayName: 'Default' }],
      fetchVCards: async () => storedCards,
    }),
  },
}));

const { todoQuery } = await import('../src/tools/todos/todo-query.js');
const { calendarQuery } = await import('../src/tools/calendar/calendar-query.js');
const { addressbookQuery } = await import('../src/tools/contacts/addressbook-query.js');

const ics = (name, ...components) => ({
  url: `${CALENDAR_URL}${name}.ics`,
  etag: '"1"',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...components.flat(), 'END:VCALENDAR'].join('\r\n'),
});

const todo = (name, ...lines) => ics(name, [
  'BEGIN:VTODO', `UID:${name}@test`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VTODO',
]);

const vevent = (uid, ...lines) => [
  'BEGIN:VEVENT', `UID:${uid}@test`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT',
];

const card = (name, ...lines) => ({
  url: `${ADDRESSBOOK_URL}${name}.vcf`,
  etag: '"1"',
  data: ['BEGIN:VCARD', 'VERSION:3.0', `UID:${name}@test`, ...lines, 'END:VCARD'].join('\r\n'),
});

const MALFORMED = { url: `${CALENDAR_URL}broken.ics`, etag: '"1"', data: 'BEGIN:VCALENDAR\r\nnot ical at all' };

/** the object URLs a query answered with, in order */
const urls = async (tool, args) => {
  const text = (await tool.handler(args)).content[0].text;
  return [...text.matchAll(/- \*\*URL\*\*: (\S+)/g)].map((m) => m[1].split('/').pop());
};

beforeEach(() => {
  storedTodos = [];
  storedEvents = [];
  storedCards = [];
});

describe('todo_query', () => {
  test('SUMMARY with a parameter, folded across lines, matches', async () => {
    storedTodos = [
      todo('param', 'SUMMARY;LANGUAGE=de:Quartalsbericht schreiben'),
      todo('folded', 'SUMMARY:Quartals', ' bericht prüfen'),
      todo('other', 'SUMMARY:Einkaufen'),
    ];
    expect(await urls(todoQuery, { summary_filter: 'quartalsbericht' }))
      .toEqual(['param.ics', 'folded.ics']);
  });

  test('SUMMARY is compared unescaped', async () => {
    storedTodos = [todo('milk', 'SUMMARY:Milch\\, Eier\\; Brot')];
    expect(await urls(todoQuery, { summary_filter: 'Milch, Eier; Brot' })).toEqual(['milk.ics']);
  });

  test('a missing STATUS counts as NEEDS-ACTION; STATUS with a parameter is read', async () => {
    storedTodos = [
      todo('none', 'SUMMARY:A'),
      todo('done', 'SUMMARY:B', 'STATUS;X-SOURCE=app:COMPLETED'),
      todo('open', 'SUMMARY:C', 'STATUS:NEEDS-ACTION'),
    ];
    expect(await urls(todoQuery, { status_filter: 'NEEDS-ACTION' })).toEqual(['none.ics', 'open.ics']);
    expect(await urls(todoQuery, { status_filter: 'COMPLETED' })).toEqual(['done.ics']);
  });

  test('a malformed todo is skipped, not fatal', async () => {
    storedTodos = [MALFORMED, todo('fine', 'SUMMARY:Report')];
    expect(await urls(todoQuery, { summary_filter: 'report' })).toEqual(['fine.ics']);
    expect(await urls(todoQuery, { status_filter: 'NEEDS-ACTION' })).toEqual(['fine.ics']);
  });

  test('a recurring todo is matched on its master, whatever the order', async () => {
    storedTodos = [ics('series',
      ['BEGIN:VTODO', 'UID:s@test', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20260108T090000Z',
        'SUMMARY:Water plants (skipped)', 'STATUS:CANCELLED', 'END:VTODO'],
      ['BEGIN:VTODO', 'UID:s@test', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260101T090000Z',
        'RRULE:FREQ=WEEKLY', 'SUMMARY:Water plants', 'END:VTODO'],
    )];
    expect(await urls(todoQuery, { status_filter: 'NEEDS-ACTION' })).toEqual(['series.ics']);
    expect(await urls(todoQuery, { status_filter: 'CANCELLED' })).toEqual([]);
  });
});

describe('calendar_query', () => {
  test('SUMMARY and LOCATION with parameters match', async () => {
    storedEvents = [
      ics('a', vevent('a', 'DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z',
        'SUMMARY;LANGUAGE=en:Design review', 'LOCATION;ALTREP="https://example.com/b":Room B\\, 2nd floor')),
      ics('b', vevent('b', 'DTSTART:20260602T100000Z', 'DTEND:20260602T110000Z',
        'SUMMARY:Lunch', 'LOCATION:Canteen')),
    ];
    expect(await urls(calendarQuery, { summary_filter: 'design review' })).toEqual(['a.ics']);
    expect(await urls(calendarQuery, { location_filter: 'room b, 2nd' })).toEqual(['a.ics']);
  });

  test('a malformed event is skipped, not fatal', async () => {
    storedEvents = [MALFORMED, ics('ok', vevent('ok', 'DTSTART:20260601T100000Z', 'SUMMARY:Standup'))];
    expect(await urls(calendarQuery, { summary_filter: 'standup' })).toEqual(['ok.ics']);
  });

  describe('a recurring event with a renamed occurrence', () => {
    // the override comes first, as some servers store it
    const series = () => ics('series',
      vevent('s', 'RECURRENCE-ID:20260615T090000Z', 'DTSTART:20260615T140000Z', 'DTEND:20260615T150000Z',
        'SUMMARY:Standup with customer', 'LOCATION:Room B'),
      vevent('s', 'DTSTART:20260601T090000Z', 'DTEND:20260601T091500Z', 'RRULE:FREQ=WEEKLY;COUNT=8',
        'SUMMARY:Standup', 'LOCATION:Room A'),
    );

    beforeEach(() => { storedEvents = [series()]; });

    test("the master's SUMMARY and LOCATION match", async () => {
      expect(await urls(calendarQuery, { summary_filter: 'standup' })).toEqual(['series.ics']);
      expect(await urls(calendarQuery, { location_filter: 'room a' })).toEqual(['series.ics']);
    });

    test('the override matches when no range is given', async () => {
      expect(await urls(calendarQuery, { summary_filter: 'customer' })).toEqual(['series.ics']);
      expect(await urls(calendarQuery, { location_filter: 'room b' })).toEqual(['series.ics']);
    });

    test('the override matches when its occurrence is in the range', async () => {
      expect(await urls(calendarQuery, {
        summary_filter: 'customer',
        time_range_start: '2026-06-15T00:00:00Z',
        time_range_end: '2026-06-16T00:00:00Z',
      })).toEqual(['series.ics']);
    });

    test('the override does not match when its occurrence is outside the range', async () => {
      expect(await urls(calendarQuery, {
        summary_filter: 'customer',
        time_range_start: '2026-06-01T00:00:00Z',
        time_range_end: '2026-06-02T00:00:00Z',
      })).toEqual([]);
    });
  });
});

describe('addressbook_query', () => {
  test('name matches FN with a parameter and N in natural order', async () => {
    storedCards = [
      card('joerg', 'FN;CHARSET=UTF-8:Jörg Müller', 'N:Müller;Jörg;;;'),
      card('nofn', 'N:Smith;John;;Dr.;'),
      card('other', 'FN:Ada Lovelace', 'N:Lovelace;Ada;;;'),
    ];
    expect(await urls(addressbookQuery, { name_filter: 'jörg' })).toEqual(['joerg.vcf']);
    expect(await urls(addressbookQuery, { name_filter: 'Dr. John Smith' })).toEqual(['nofn.vcf']);
  });

  test('name does not match text from other lines', async () => {
    // /N:(.+)/ matched "BEGIN:VCARD" and a NOTE that mentions a name
    storedCards = [card('bob', 'FN:Bob Stone', 'N:Stone;Bob;;;', 'NOTE:Introduced by ANN: at the fair')];
    expect(await urls(addressbookQuery, { name_filter: 'vcard' })).toEqual([]);
    expect(await urls(addressbookQuery, { name_filter: 'at the fair' })).toEqual([]);
  });

  test('email matches any of several addresses', async () => {
    storedCards = [card('two', 'FN:Two Mails', 'EMAIL;TYPE=WORK:two@work.example', 'EMAIL;TYPE=HOME:two@home.example')];
    expect(await urls(addressbookQuery, { email_filter: '@home.example' })).toEqual(['two.vcf']);
    expect(await urls(addressbookQuery, { email_filter: '@work.example' })).toEqual(['two.vcf']);
  });

  test('ORG is structured and unescaped', async () => {
    storedCards = [card('acme', 'FN:Ann Lee', 'ORG:Acme\\, Inc.;Sales')];
    expect(await urls(addressbookQuery, { organization_filter: 'Acme, Inc.' })).toEqual(['acme.vcf']);
    expect(await urls(addressbookQuery, { organization_filter: 'Acme, Inc., Sales' })).toEqual(['acme.vcf']);
    expect(await urls(addressbookQuery, { organization_filter: 'sales' })).toEqual(['acme.vcf']);
  });

  describe('a vCard 2.1 card with bare parameters', () => {
    // Outlook/Android export form; ical.js alone rejects "EMAIL;PREF;INTERNET:"
    const legacy = () => ({
      url: `${ADDRESSBOOK_URL}legacy.vcf`,
      etag: '"1"',
      data: ['BEGIN:VCARD', 'VERSION:2.1', 'N:Doe;John', 'FN:John Doe',
        'EMAIL;PREF;INTERNET:john@doe.com', 'TEL;CELL:+49 170 1234567', 'ORG:Initech', 'END:VCARD'].join('\r\n'),
    });

    beforeEach(() => { storedCards = [legacy()]; });

    test('name, email and organization filters match it', async () => {
      expect(await urls(addressbookQuery, { name_filter: 'john doe' })).toEqual(['legacy.vcf']);
      expect(await urls(addressbookQuery, { email_filter: 'john@doe.com' })).toEqual(['legacy.vcf']);
      expect(await urls(addressbookQuery, { organization_filter: 'initech' })).toEqual(['legacy.vcf']);
    });

    test('the display shows it', async () => {
      const text = (await addressbookQuery.handler({ name_filter: 'john' })).content[0].text;
      expect(text).toContain('### 1. John Doe');
      expect(text).toContain('- **Email**: john@doe.com (PREF, INTERNET)');
      expect(text).toContain('- **Organization**: Initech');
    });
  });

  test('a quoted parameter value keeps its semicolons and colons', async () => {
    storedCards = [card('quoted', 'FN:Quoted Person', 'EMAIL;X-LABEL="Work; HQ: main";PREF:q@example.com')];
    expect(await urls(addressbookQuery, { email_filter: 'q@example.com' })).toEqual(['quoted.vcf']);
  });

  test('a one-part N is the family name, not split into letters', async () => {
    storedCards = [card('cher', 'N:Cher')];
    expect(await urls(addressbookQuery, { name_filter: 'cher' })).toEqual(['cher.vcf']);
    expect(await urls(addressbookQuery, { name_filter: 'c h' })).toEqual([]);
    const text = (await addressbookQuery.handler({ name_filter: 'cher' })).content[0].text;
    expect(text).toContain('- **Full Name**: Cher');
  });

  test('ORG is filtered and displayed with the same join', async () => {
    storedCards = [card('units', 'FN:Unit Person', 'ORG:Acme;;Sales')];
    expect(await urls(addressbookQuery, { organization_filter: 'Acme, Sales' })).toEqual(['units.vcf']);
    const text = (await addressbookQuery.handler({ organization_filter: 'acme' })).content[0].text;
    expect(text).toContain('- **Organization**: Acme, Sales');
  });

  test('a capped contact list says it is the first by name', async () => {
    storedCards = [card('c', 'FN:Cora'), card('a', 'FN:Alo'), card('b', 'FN:Bob')];
    const text = (await addressbookQuery.handler({ name_filter: 'o', limit: 2 })).content[0].text;
    expect(text).toContain('Found contacts: **2** of 3 (showing the first 2 by name');
    expect(text).not.toContain('earliest');
  });

  test('a malformed vCard is skipped, not fatal', async () => {
    storedCards = [
      { url: `${ADDRESSBOOK_URL}broken.vcf`, etag: '"1"', data: 'BEGIN:VCARD\r\ngarbage' },
      card('fine', 'FN:Fine Person'),
    ];
    expect(await urls(addressbookQuery, { name_filter: 'person' })).toEqual(['fine.vcf']);
  });
});

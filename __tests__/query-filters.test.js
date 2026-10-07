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

/** the listing a reader sees, without the Raw Data block */
const shown = (result) => result.content[0].text.split('<details>')[0];

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

  test('a recurring todo is filtered and listed by its master, whatever the order', async () => {
    storedTodos = [ics('series',
      ['BEGIN:VTODO', 'UID:s@test', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20260108T090000Z',
        'SUMMARY:Water plants (done early)', 'STATUS:COMPLETED', 'END:VTODO'],
      ['BEGIN:VTODO', 'UID:s@test', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260101T090000Z',
        'RRULE:FREQ=WEEKLY', 'SUMMARY:Water plants', 'END:VTODO'],
    )];
    const text = shown(await todoQuery.handler({ status_filter: 'NEEDS-ACTION' }));
    expect(text).toContain('series.ics');
    expect(text).toContain('- **Status**: NEEDS-ACTION');
    expect(text).not.toContain('done early');
    expect(await urls(todoQuery, { status_filter: 'COMPLETED' })).toEqual([]);
    expect(await urls(todoQuery, { summary_filter: 'done early' })).toEqual([]);
  });

  test('a lower-case STATUS is filtered and listed as its RFC value', async () => {
    storedTodos = [todo('lower', 'SUMMARY:Lower', 'STATUS:completed')];
    const text = (await todoQuery.handler({ status_filter: 'COMPLETED' })).content[0].text;
    expect(text).toContain('- **Status**: COMPLETED');
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

  describe('a recurring event with a renamed occurrence: found and listed as the same occurrence', () => {
    // weekly from Mon 1 June; the 15 June occurrence is renamed and moved.
    // The override comes first, as some servers store it.
    const series = () => ics('series',
      vevent('s', 'RECURRENCE-ID:20260615T090000Z', 'DTSTART:20260615T140000Z', 'DTEND:20260615T150000Z',
        'SUMMARY:Standup with customer', 'LOCATION:Room B'),
      vevent('s', 'DTSTART:20260601T090000Z', 'DTEND:20260601T091500Z', 'RRULE:FREQ=WEEKLY;COUNT=8',
        'SUMMARY:Standup', 'LOCATION:Room A'),
    );
    const listed = async (args) => shown(await calendarQuery.handler(args));
    const JUNE_8_TO_16 = { time_range_start: '2026-06-08T00:00:00Z', time_range_end: '2026-06-16T00:00:00Z' };

    beforeEach(() => { storedEvents = [series()]; });

    test('without a range only the series is searched', async () => {
      expect(await urls(calendarQuery, { summary_filter: 'standup' })).toEqual(['series.ics']);
      expect(await listed({ summary_filter: 'standup' })).toContain('### 1. Standup\n');
      expect(await urls(calendarQuery, { location_filter: 'room a' })).toEqual(['series.ics']);
      expect(await urls(calendarQuery, { summary_filter: 'customer' })).toEqual([]);
      expect(await urls(calendarQuery, { location_filter: 'room b' })).toEqual([]);
    });

    test('a search finds the renamed occurrence inside the range and lists it', async () => {
      const text = await listed({ summary_filter: 'customer', ...JUNE_8_TO_16 });
      expect(text).toContain('### 1. Standup with customer');
      expect(text).toContain('- **When**: June 15, 2026, 02:00 PM UTC');
      expect(text).toContain('- **Where**: Room B');
      const byPlace = await listed({ location_filter: 'room b', ...JUNE_8_TO_16 });
      expect(byPlace).toContain('June 15, 2026');
    });

    test('a search the series itself passes lists its first occurrence in the range', async () => {
      const text = await listed({ summary_filter: 'standup', ...JUNE_8_TO_16 });
      expect(text).toContain('### 1. Standup\n');
      expect(text).toContain('- **When**: June 8, 2026, 09:00 AM UTC');
      expect(text).toContain('- **Where**: Room A');
    });

    test('both filters must hold on the same occurrence', async () => {
      expect(await urls(calendarQuery, { summary_filter: 'customer', location_filter: 'room a', ...JUNE_8_TO_16 }))
        .toEqual([]);
      expect(await urls(calendarQuery, { summary_filter: 'customer', location_filter: 'room b', ...JUNE_8_TO_16 }))
        .toEqual(['series.ics']);
    });

    test('a renamed occurrence outside the range is not found', async () => {
      expect(await urls(calendarQuery, { summary_filter: 'customer',
        time_range_start: '2026-06-01T00:00:00Z', time_range_end: '2026-06-09T00:00:00Z' })).toEqual([]);
    });

    test('the cap sorts by the listed occurrence, not the series start', async () => {
      // the series starts 1 June but is listed as 15 June; "single" is on 10 June
      storedEvents = [series(), ics('single', vevent('single', 'DTSTART:20260610T120000Z',
        'DTEND:20260610T130000Z', 'SUMMARY:Customer lunch'))];
      expect(await urls(calendarQuery, { summary_filter: 'customer', ...JUNE_8_TO_16, limit: 1 }))
        .toEqual(['single.ics']);
    });
  });

  describe('long-running series with a range', () => {
    const OCTOBER = { time_range_start: '2026-10-01T00:00:00Z', time_range_end: '2026-10-31T23:59:59Z' };
    const BERLIN = [
      'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE',
    ];
    const when = async (args) => shown(await calendarQuery.handler(args)).match(/- \*\*When\*\*: ([^\n]*)/)?.[1];

    // expansion starts a whole number of periods before the range instead of
    // at 2020; these pin that it lands on the same occurrences
    test('every other week on Tue/Thu since 2020, first in-range one excluded', async () => {
      storedEvents = [ics('biweekly', vevent('bw', 'DTSTART:20200107T090000Z', 'DURATION:PT1H',
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', 'EXDATE:20261006T090000Z', 'SUMMARY:Sync'))];
      expect(await when({ summary_filter: 'sync', ...OCTOBER })).toMatch(/^October 8, 2026, 09:00 AM/);
    });

    test('every third day since 2020 in a named timezone', async () => {
      storedEvents = [ics('third', BERLIN, vevent('t', 'DTSTART;TZID=Europe/Berlin:20200101T090000',
        'DURATION:PT1H', 'RRULE:FREQ=DAILY;INTERVAL=3', 'SUMMARY:Water'))];
      expect(await when({ summary_filter: 'water', ...OCTOBER })).toMatch(/^October 2, 2026, 09:00 AM/);
    });

    test('a COUNT series is still walked from its start', async () => {
      // 2020-01-06 + 352 weeks = Monday 5 October 2026: the 353rd and last occurrence
      storedEvents = [ics('counted', vevent('c', 'DTSTART:20200106T090000Z', 'DURATION:PT1H',
        'RRULE:FREQ=WEEKLY;COUNT=353', 'SUMMARY:Counted'))];
      expect(await when({ summary_filter: 'counted', ...OCTOBER })).toMatch(/^October 5, 2026, 09:00 AM/);
    });

    test('the cap sorts a series by its occurrence in the range, not its start', async () => {
      const weekly = ics('weekly', vevent('w', 'DTSTART:20200106T080000Z', 'DURATION:PT1H',
        'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly')); // first October occurrence: Mon 5 Oct
      storedEvents = [weekly, ics('oct1', vevent('o1', 'DTSTART:20261001T080000Z', 'DURATION:PT1H', 'SUMMARY:Oct 1'))];
      expect(await urls(calendarQuery, { ...OCTOBER, limit: 1 })).toEqual(['oct1.ics']);
      storedEvents = [ics('oct20', vevent('o20', 'DTSTART:20261020T080000Z', 'DURATION:PT1H', 'SUMMARY:Oct 20')), weekly];
      expect(await urls(calendarQuery, { ...OCTOBER, limit: 1 })).toEqual(['weekly.ics']);
    });
  });

  test('detached instances without a master: the one in range is listed and matched', async () => {
    storedEvents = [ics('detached',
      vevent('d', 'RECURRENCE-ID:20261001T090000Z', 'DTSTART:20261001T090000Z', 'DTEND:20261001T100000Z',
        'SUMMARY:Review (Oct 1)'),
      vevent('d', 'RECURRENCE-ID:20261008T090000Z', 'DTSTART:20261008T090000Z', 'DTEND:20261008T100000Z',
        'SUMMARY:Review (Oct 8)'),
    )];
    const oct8 = { time_range_start: '2026-10-08T00:00:00Z', time_range_end: '2026-10-09T00:00:00Z' };
    const text = shown(await calendarQuery.handler({ summary_filter: 'oct 8', ...oct8 }));
    expect(text).toContain('### 1. Review (Oct 8)');
    expect(await urls(calendarQuery, { summary_filter: 'oct 1', ...oct8 })).toEqual([]);
    // without a range the first in document order is listed, as before
    expect(await urls(calendarQuery, { summary_filter: 'oct 1' })).toEqual(['detached.ics']);
    expect(await urls(calendarQuery, { summary_filter: 'oct 8' })).toEqual([]);
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

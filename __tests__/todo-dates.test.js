import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import ICAL from 'ical.js';

// Issue #91: update_todo wrote DUE through a raw string, so the iCal basic form
// it advertised failed, offsets were dropped (a floating time hours off for a
// reader elsewhere) and a stale TZID or VALUE=DATE survived. Dates are now
// encoded in one place (tsdav-utils, via writeFields); these tests drive the
// real handlers with a stubbed DAV client and assert the emitted bytes.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/tasks/';
const TODO_URL = `${CALENDAR_URL}todo.ics`;
const EVENT_URL = `${CALENDAR_URL}event.ics`;
const CARD_URL = 'https://dav.example.com/addressbooks/user/contacts/card.vcf';

const ok = () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) });
const updateTodo = jest.fn(async () => ok());
const createTodo = jest.fn(async () => ({ ...ok(), status: 201, url: TODO_URL }));
const updateCalendarObject = jest.fn(async () => ok());
const createCalendarObject = jest.fn(async () => ({ ...ok(), status: 201, url: EVENT_URL }));
const updateVCard = jest.fn(async () => ok());

// what the fetch calls hand back; each test sets what it needs
let storedTodo = '';
let storedTodos = [];
let storedEvent = '';
let storedCard = '';

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Tasks', components: ['VTODO'] }],
      fetchTodos: async ({ objectUrls } = {}) => objectUrls
        ? [{ url: TODO_URL, etag: '"1"', data: storedTodo }]
        : storedTodos,
      updateTodo,
      createTodo,
      fetchCalendarObjects: async () => [{ url: EVENT_URL, etag: '"1"', data: storedEvent }],
      updateCalendarObject,
      createCalendarObject,
    }),
    getCardDavClient: () => ({
      fetchVCards: async () => [{ url: CARD_URL, etag: '"1"', data: storedCard }],
      updateVCard,
    }),
  },
}));

const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');
const { createTodo: createTodoTool } = await import('../src/tools/todos/create-todo.js');
const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { updateContactFields } = await import('../src/tools/contacts/update-contact-fields.js');
const { todoQuery } = await import('../src/tools/todos/todo-query.js');

const vtodo = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VTODO', 'UID:todo-1@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:File the report',
  ...lines,
  'END:VTODO', 'END:VCALENDAR',
].join('\r\n');

const vevent = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VEVENT', 'UID:event-1@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Standup',
  ...lines,
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

/** the same document with a Europe/Berlin VTIMEZONE, as servers send it */
const withBerlinZone = (document) => document.replace('BEGIN:VTODO', [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE', 'BEGIN:VTODO',
].join('\r\n'));

/** every line of a document for one property, parameters included */
const lines = (document, name) =>
  document.split(/\r?\n/).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

const emittedTodo = () => updateTodo.mock.calls[0][0].calendarObject.data;
const setTodo = (fields) => updateTodoFields.handler({ todo_url: TODO_URL, todo_etag: '"1"', fields });

/** the UTC basic form of a wall-clock time read in the host timezone */
const hostLocalAsUtc = (...args) =>
  new Date(...args).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

beforeEach(() => {
  for (const mock of [updateTodo, createTodo, updateCalendarObject, createCalendarObject, updateVCard]) mock.mockClear();
  storedTodo = vtodo('DUE:20260101T000000Z');
});

describe('update_todo writes DUE as the instant the caller gave (#91)', () => {
  test.each([
    ['2026-10-26T18:00:00Z', 'DUE:20261026T180000Z'],
    // the form the tool description used to advertise, which failed
    ['20261026T180000Z', 'DUE:20261026T180000Z'],
    ['2026-10-26T18:00:00+00:00', 'DUE:20261026T180000Z'],
    ['2026-10-26T14:00:00-04:00', 'DUE:20261026T180000Z'],
    ['2026-10-26T18:00:00.000Z', 'DUE:20261026T180000Z'],
  ])('%s -> %s', async (value, expected) => {
    await setTodo({ DUE: value });
    expect(lines(emittedTodo(), 'DUE')).toEqual([expected]);
  });

  test('a date makes an all-day DUE', async () => {
    await setTodo({ DUE: '2026-10-26' });
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE;VALUE=DATE:20261026']);
  });

  test('a zoned value replaces a TZID instead of keeping it next to a UTC value', async () => {
    storedTodo = vtodo('DUE;TZID=Europe/Berlin:20260101T100000');
    await setTodo({ DUE: '2026-10-26T18:00:00Z' });
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE:20261026T180000Z']);
  });

  test('a value without a zone keeps the TZID the todo already has', async () => {
    storedTodo = vtodo('DUE;TZID=Europe/Berlin:20260101T100000');
    await setTodo({ DUE: '2026-10-26T18:00:00' });
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE;TZID=Europe/Berlin:20261026T180000']);
  });

  test('a value without a zone on an unzoned todo is read in the server timezone', async () => {
    await setTodo({ DUE: '2026-10-26T18:00:00' });
    expect(lines(emittedTodo(), 'DUE')).toEqual([`DUE:${hostLocalAsUtc(2026, 9, 26, 18, 0, 0)}`]);
  });

  test('a date-time over an all-day DUE drops VALUE=DATE', async () => {
    storedTodo = vtodo('DUE;VALUE=DATE:20260101');
    await setTodo({ DUE: '2026-10-26T18:00:00Z' });
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE:20261026T180000Z']);
  });

  test('COMPLETED without a zone is written as UTC, as RFC 5545 requires', async () => {
    await setTodo({ COMPLETED: '2026-10-26T18:00:00' });
    expect(lines(emittedTodo(), 'COMPLETED')).toEqual([`COMPLETED:${hostLocalAsUtc(2026, 9, 26, 18, 0, 0)}`]);
  });

  test('an unparseable date fails before anything is written, naming the field', async () => {
    await expect(setTodo({ DUE: 'next friday' })).rejects.toThrow(/DUE: "next friday".*Accepted forms/);
    expect(updateTodo).not.toHaveBeenCalled();
  });
});

describe('update_todo keeps DUE, DTSTART and DURATION coherent', () => {
  test('setting DUE replaces a DURATION (RFC 5545 3.6.2)', async () => {
    storedTodo = vtodo('DTSTART:20261020T090000Z', 'DURATION:PT2H');
    await setTodo({ DUE: '2026-10-26T18:00:00Z' });
    expect(lines(emittedTodo(), 'DURATION')).toEqual([]);
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE:20261026T180000Z']);
  });

  test('setting DURATION replaces a DUE', async () => {
    storedTodo = vtodo('DTSTART:20261020T090000Z', 'DUE:20261026T180000Z');
    await setTodo({ DURATION: 'PT2H' });
    expect(lines(emittedTodo(), 'DUE')).toEqual([]);
    expect(lines(emittedTodo(), 'DURATION')).toEqual(['DURATION:PT2H']);
  });

  test('DUE and DURATION in one call are rejected', async () => {
    await expect(setTodo({ DUE: '2026-10-26T18:00:00Z', DURATION: 'PT2H' })).rejects.toThrow(/either DUE or DURATION/);
    expect(updateTodo).not.toHaveBeenCalled();
  });

  test('DURATION without a DTSTART is rejected', async () => {
    await expect(setTodo({ DURATION: 'PT2H' })).rejects.toThrow(/DURATION needs a DTSTART/);
    expect(updateTodo).not.toHaveBeenCalled();
  });

  test('an all-day DUE next to a timed DTSTART is rejected (RFC 5545 3.8.2.3)', async () => {
    storedTodo = vtodo('DTSTART:20261020T090000Z', 'DUE:20261026T180000Z');
    await expect(setTodo({ DUE: '2026-10-26' })).rejects.toThrow(/DUE needs a time: DTSTART has one/);
    expect(updateTodo).not.toHaveBeenCalled();
  });

  test('an all-day DTSTART next to a timed DUE is rejected', async () => {
    storedTodo = vtodo('DTSTART:20261020T090000Z', 'DUE:20261026T180000Z');
    await expect(setTodo({ DTSTART: '2026-10-20' })).rejects.toThrow(/both be dates or both be date-times/);
    expect(updateTodo).not.toHaveBeenCalled();
  });

  test('a DUE before DTSTART is rejected when the VTIMEZONE says so', async () => {
    // DTSTART 09:00 Berlin on 20 October (still summer time, UTC+2) is
    // 07:00Z: a DUE of 06:30Z is before it, 07:30Z after it
    storedTodo = withBerlinZone(vtodo('DTSTART;TZID=Europe/Berlin:20261020T090000', 'DUE;TZID=Europe/Berlin:20261026T180000'));
    await expect(setTodo({ DUE: '2026-10-20T06:30:00Z' })).rejects.toThrow(/must be later than DTSTART/);
    await setTodo({ DUE: '2026-10-20T07:30:00Z' });
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE:20261020T073000Z']);
  });

  test('a DUE in a TZID next to a UTC DTSTART is not ordered by guesswork', async () => {
    // Tokyo 20:00 is 11:00Z, after DTSTART; without the VTIMEZONE the zone is
    // unknown here, so no order is claimed and the write goes through
    storedTodo = vtodo('DTSTART:20261026T100000Z', 'DUE;TZID=Asia/Tokyo:20261025T200000');
    await setTodo({ DUE: '2026-10-26T20:00:00' });
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE;TZID=Asia/Tokyo:20261026T200000']);
  });

  test('field names are case-insensitive, so the DUE/DURATION guard holds for "due"', async () => {
    await expect(setTodo({ due: '2026-10-26T18:00:00Z', Duration: 'PT2H' })).rejects.toThrow(/either DUE or DURATION/);
  });

  test('a DUE before DTSTART is rejected', async () => {
    storedTodo = vtodo('DTSTART:20261020T090000Z', 'DUE:20261026T180000Z');
    await expect(setTodo({ DUE: '2026-10-19T18:00:00Z' })).rejects.toThrow(/must be later than DTSTART/);
  });

  test('both moved together is fine', async () => {
    storedTodo = vtodo('DTSTART:20261020T090000Z', 'DUE:20261026T180000Z');
    await setTodo({ DTSTART: '2026-11-01', DUE: '2026-11-03' });
    expect(lines(emittedTodo(), 'DTSTART')).toEqual(['DTSTART;VALUE=DATE:20261101']);
    expect(lines(emittedTodo(), 'DUE')).toEqual(['DUE;VALUE=DATE:20261103']);
  });

  test('an update that touches no date leaves an odd stored todo alone', async () => {
    // DURATION without DTSTART is the server's business until a date is changed
    storedTodo = vtodo('DURATION:PT2H');
    await setTodo({ SUMMARY: 'Renamed' });
    expect(lines(emittedTodo(), 'DURATION')).toEqual(['DURATION:PT2H']);
  });
});

describe('todo_query reads DUE by parsing, not by pattern', () => {
  // create_todo now writes an all-day due date as DUE;VALUE=DATE, and
  // update_todo keeps a TZID; a DUE:-only pattern found neither
  test.each([
    ['a date-time DUE inside the range', 'DUE:20261026T180000Z', true],
    ['an all-day DUE covers its whole day', 'DUE;VALUE=DATE:20261026', true],
    // without its VTIMEZONE the zone resolves on the server clock; noon on
    // the 26th lands inside the range from any host zone
    ['a DUE with a TZID', 'DUE;TZID=Europe/Berlin:20261026T120000', true],
    ['a DUE outside the range', 'DUE:20261101T180000Z', false],
    ['no DUE', 'STATUS:NEEDS-ACTION', false],
  ])('%s', async (_label, line, found) => {
    storedTodos = [{ url: TODO_URL, etag: '"1"', data: vtodo(line) }];
    const result = await todoQuery.handler({
      time_range_start: '2026-10-25T20:00:00Z',
      time_range_end: '2026-10-27T04:00:00Z',
    });
    expect(result.content[0].text.includes('File the report')).toBe(found);
  });

  test('a TZID with its VTIMEZONE resolves to the right instant', async () => {
    // 12:00 in Berlin (UTC+1 in late October) is 11:00Z, outside 11:30-12:30Z
    storedTodos = [{ url: TODO_URL, etag: '"1"', data: withBerlinZone(vtodo('DUE;TZID=Europe/Berlin:20261026T120000')) }];
    const result = await todoQuery.handler({
      time_range_start: '2026-10-26T11:30:00Z',
      time_range_end: '2026-10-26T12:30:00Z',
    });
    expect(result.content[0].text.includes('File the report')).toBe(false);
  });

  test('one malformed todo does not fail the query for the others', async () => {
    storedTodos = [
      { url: `${CALENDAR_URL}broken.ics`, etag: '"1"', data: vtodo('DUE:garbage').replace('File the report', 'Broken') },
      { url: TODO_URL, etag: '"1"', data: vtodo('DUE:20261026T120000Z') },
    ];
    const result = await todoQuery.handler({
      time_range_start: '2026-10-26T00:00:00Z',
      time_range_end: '2026-10-27T00:00:00Z',
    });
    expect(result.content[0].text).toContain('File the report');
  });
});

describe('create_todo uses the same encoder', () => {
  const createWith = (due_date) =>
    createTodoTool.handler({ calendar_url: CALENDAR_URL, summary: 'File the report', due_date });
  const emittedCreate = () => createTodo.mock.calls[0][0].iCalString;

  test('an offset is converted to UTC', async () => {
    await createWith('2026-10-26T14:00:00-04:00');
    expect(lines(emittedCreate(), 'DUE')).toEqual(['DUE:20261026T180000Z']);
  });

  test('a date makes an all-day DUE instead of midnight UTC', async () => {
    await createWith('2026-10-26');
    expect(lines(emittedCreate(), 'DUE')).toEqual(['DUE;VALUE=DATE:20261026']);
  });

  test('DTSTAMP is a UTC date-time and the document re-parses', async () => {
    await createWith(undefined);
    expect(lines(emittedCreate(), 'DTSTAMP')[0]).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
    expect(lines(emittedCreate(), 'DUE')).toEqual([]);
    expect(() => ICAL.parse(emittedCreate())).not.toThrow();
  });

  test('an invalid date is rejected by validation', async () => {
    await expect(createWith('26.10.2026')).rejects.toThrow(/Validation failed: due_date/);
    expect(createTodo).not.toHaveBeenCalled();
  });
});

describe('the other field tools get the same encoding', () => {
  test('update_event: an EXDATE with an offset keeps its instant', async () => {
    storedEvent = vevent('DTSTART:20261020T160000Z', 'DTEND:20261020T170000Z', 'RRULE:FREQ=DAILY');
    await updateEventFields.handler({
      event_url: EVENT_URL, event_etag: '"1"', fields: { EXDATE: '2026-10-26T18:00:00+02:00' },
    });
    const data = updateCalendarObject.mock.calls[0][0].calendarObject.data;
    expect(lines(data, 'EXDATE')).toEqual(['EXDATE:20261026T160000Z']);
  });

  test('update_event: a start without a zone stays in the event\'s own timezone', async () => {
    storedEvent = vevent('DTSTART;TZID=Europe/Berlin:20261020T100000', 'DTEND;TZID=Europe/Berlin:20261020T110000');
    await updateEventFields.handler({
      event_url: EVENT_URL, event_etag: '"1"',
      start_date: '2026-10-27T18:00:00', end_date: '2026-10-27T19:00:00',
    });
    const data = updateCalendarObject.mock.calls[0][0].calendarObject.data;
    expect(lines(data, 'DTSTART')).toEqual(['DTSTART;TZID=Europe/Berlin:20261027T180000']);
    expect(lines(data, 'DTEND')).toEqual(['DTEND;TZID=Europe/Berlin:20261027T190000']);
  });

  test('update_event: a start without a zone and an end with one are refused', async () => {
    // on a Los Angeles event, "10:00" is 17:00Z, after an end at 12:00Z
    storedEvent = vevent('DTSTART;TZID=America/Los_Angeles:20261020T090000', 'DTEND;TZID=America/Los_Angeles:20261020T100000');
    await expect(updateEventFields.handler({
      event_url: EVENT_URL, event_etag: '"1"',
      start_date: '2026-05-25T10:00:00', end_date: '2026-05-25T12:00:00Z',
    })).rejects.toThrow(/must both name a timezone/);
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('create_event: the order of times without a zone is checked as written', async () => {
    // "10:00:60" is 10:01:00: a zero-length event, whatever the host zone
    await expect(createEvent.handler({
      calendar_url: CALENDAR_URL, summary: 'Standup',
      start_date: '2026-10-26T10:00:60', end_date: '2026-10-26T10:01:00',
    })).rejects.toThrow(/End date must be after start date/);
    expect(createCalendarObject).not.toHaveBeenCalled();
  });

  test('create_event: a pair across a spring-forward gap is checked as written', async () => {
    // 02:30 does not exist where clocks jump 02:00 -> 03:00; written on such a
    // host it lands after 03:10. Only meaningful on a host with that gap.
    const gap = new Date(2026, 2, 29, 2, 30).getHours() !== 2;
    const attempt = createEvent.handler({
      calendar_url: CALENDAR_URL, summary: 'Standup',
      start_date: '2026-03-29T02:30:00', end_date: '2026-03-29T03:10:00',
    });
    if (gap) {
      await expect(attempt).rejects.toThrow(/End date must be after start date/);
    } else {
      await expect(attempt).resolves.toBeDefined();
    }
  });

  test('create_event: a start without a zone and an end with one are fine, the zone is the server\'s', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL, summary: 'Standup',
      start_date: '2026-10-26T10:00:00', end_date: '2026-10-28T11:00:00Z',
    });
    expect(createCalendarObject).toHaveBeenCalled();
  });

  test('update_event: basic and extended forms mix freely', async () => {
    storedEvent = vevent('DTSTART:20261020T160000Z', 'DTEND:20261020T170000Z');
    await updateEventFields.handler({
      event_url: EVENT_URL, event_etag: '"1"',
      start_date: '20261027T160000Z', end_date: '2026-10-27T17:30Z',
    });
    const data = updateCalendarObject.mock.calls[0][0].calendarObject.data;
    expect(lines(data, 'DTSTART')).toEqual(['DTSTART:20261027T160000Z']);
    expect(lines(data, 'DTEND')).toEqual(['DTEND:20261027T173000Z']);
  });

  test('update_contact: REV with an offset keeps its instant', async () => {
    storedCard = ['BEGIN:VCARD', 'VERSION:4.0', 'UID:card-1', 'FN:Ada', 'REV:20200101T000000Z', 'END:VCARD'].join('\r\n');
    await updateContactFields.handler({
      vcard_url: CARD_URL, vcard_etag: '"1"', fields: { REV: '2026-10-26T20:00:00+02:00' },
    });
    const data = updateVCard.mock.calls[0][0].vCard.data;
    expect(lines(data, 'REV')).toEqual(['REV:20261026T180000Z']);
  });
});

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');
import ICAL from 'ical.js';

// Issue #96: a recurring event or todo is one calendar object holding a series
// master and override components (RECURRENCE-ID) in the server's order.
// updateFields (tsdav-utils 0.4.0) writes the master; every check, cleanup and
// read in dav-mcp has to look at that same component, not the first one in
// the file. These tests store the override FIRST, so "the first component"
// and "the master" differ.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const TODO_URL = `${CALENDAR_URL}todo.ics`;
const EVENT_URL = `${CALENDAR_URL}event.ics`;

const ok = () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) });
const updateTodo = jest.fn(async () => ok());
const updateCalendarObject = jest.fn(async () => ok());

let storedTodo = '';
let storedEvent = '';

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchTodos: async () => [{ url: TODO_URL, etag: '"1"', data: storedTodo }],
      updateTodo,
      fetchCalendarObjects: async () => [{ url: EVENT_URL, etag: '"1"', data: storedEvent }],
      updateCalendarObject,
    }),
    getCardDavClient: () => ({}),
  },
}));

const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');
const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { calculateFreeBusy } = await import('../src/tools/shared/freebusy.js');
const { dueSpan } = await import('../src/tools/shared/ical-dates.js');
const { parseObjects } = await import('../src/tools/shared/query-objects.js');
const { formatTodo, formatEvent } = await import('../src/formatters.js');
const { readSeries, explainWriteRefusal } = await import('../src/ical-components.js');
const { updateFields } = await import('tsdav-utils');
const { createToolErrorResponse, MCP_ERROR_CODES } = await import('../src/error-handler.js');

/** what the LLM gets back for a failed call, as the servers build it */
const errorReply = async (call) => {
  try {
    await call;
  } catch (error) {
    return JSON.parse(createToolErrorResponse(error).content[0].text);
  }
  throw new Error('expected the call to fail');
};

/** a VCALENDAR holding the given components, each a list of property lines */
const calendar = (type, ...components) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  ...components.flatMap((props) => [`BEGIN:${type}`, 'DTSTAMP:20260101T000000Z', ...props, `END:${type}`]),
  'END:VCALENDAR',
].join('\r\n');

/** property lines of the master, and of every override, of a written object */
const parts = (document, type) => {
  const all = new ICAL.Component(ICAL.parse(document)).getAllSubcomponents(type);
  const lines = (c) => c.toString().split(/\r?\n/)
    .filter((l) => !/^(BEGIN|END|DTSTAMP)/.test(l));
  return {
    master: lines(all.find((c) => !c.hasProperty('recurrence-id'))),
    overrides: all.filter((c) => c.hasProperty('recurrence-id')).map(lines),
  };
};

const emittedEvent = () => updateCalendarObject.mock.calls[0][0].calendarObject.data;
const emittedTodo = () => updateTodo.mock.calls[0][0].calendarObject.data;
const setEvent = (args) => updateEventFields.handler({ event_url: EVENT_URL, event_etag: '"1"', ...args });
const setTodo = (fields) => updateTodoFields.handler({ todo_url: TODO_URL, todo_etag: '"1"', fields });

// an override moved to the afternoon, stored before its master
const EVENT_OVERRIDE = [
  'UID:series@test', 'SUMMARY:Standup (moved)',
  'RECURRENCE-ID:20261002T090000Z', 'DTSTART:20261002T140000Z', 'DTEND:20261002T150000Z',
];
const EVENT_MASTER = [
  'UID:series@test', 'SUMMARY:Standup', 'RRULE:FREQ=DAILY;COUNT=5',
  'DTSTART:20261001T090000Z', 'DURATION:PT30M',
];

const TODO_OVERRIDE = [
  'UID:chore@test', 'SUMMARY:Water plants (this week)',
  'RECURRENCE-ID:20261005T080000Z', 'DTSTART:20261005T080000Z', 'DUE:20261005T100000Z',
];
const TODO_MASTER = [
  'UID:chore@test', 'SUMMARY:Water plants', 'RRULE:FREQ=WEEKLY',
  'DTSTART:20260928T080000Z', 'DURATION:PT1H',
];

beforeEach(() => {
  updateTodo.mockClear();
  updateCalendarObject.mockClear();
});

describe('update_event on an override-first object (#96)', () => {
  test('moving it drops the DURATION of the master, which got the new DTEND', async () => {
    storedEvent = calendar('VEVENT', EVENT_OVERRIDE, EVENT_MASTER);
    await setEvent({ start_date: '2026-10-01T10:00:00Z', end_date: '2026-10-01T10:45:00Z' });

    const { master, overrides } = parts(emittedEvent(), 'vevent');
    expect(master).toEqual(expect.arrayContaining(['DTSTART:20261001T100000Z', 'DTEND:20261001T104500Z']));
    expect(master.some((l) => l.startsWith('DURATION'))).toBe(false);
    // the override moves with its series: the +1h shift reaches its
    // RECURRENCE-ID and its own times, so it still names a real occurrence
    expect(overrides).toEqual([[
      'UID:series@test', 'SUMMARY:Standup (moved)',
      'RECURRENCE-ID:20261002T100000Z', 'DTSTART:20261002T150000Z', 'DTEND:20261002T160000Z',
    ]]);
  });

  test('fields go to the master, not the override', async () => {
    storedEvent = calendar('VEVENT', EVENT_OVERRIDE, EVENT_MASTER);
    await setEvent({ fields: { LOCATION: 'Room 4' } });

    const { master, overrides } = parts(emittedEvent(), 'vevent');
    expect(master).toContain('LOCATION:Room 4');
    expect(overrides[0].some((l) => l.startsWith('LOCATION'))).toBe(false);
  });
});

describe('update_event writes fields and dates in one call (#96)', () => {
  test('an RRULE UNTIL follows an all-day move made in the same call', async () => {
    storedEvent = calendar('VEVENT', [
      'UID:series@test', 'SUMMARY:Standup',
      'DTSTART:20261001T090000Z', 'DTEND:20261001T093000Z',
    ]);
    await setEvent({
      fields: { RRULE: 'FREQ=DAILY;UNTIL=2026-10-20' },
      start_date: '2026-10-01',
      end_date: '2026-10-02',
    });

    const { master } = parts(emittedEvent(), 'vevent');
    expect(master).toEqual(expect.arrayContaining([
      'DTSTART;VALUE=DATE:20261001',
      'DTEND;VALUE=DATE:20261002',
      'RRULE:FREQ=DAILY;UNTIL=20261020',
    ]));
  });
});

describe('update_todo on an override-first object (#96)', () => {
  test('setting DUE drops the DURATION of the master', async () => {
    storedTodo = calendar('VTODO', TODO_OVERRIDE, TODO_MASTER);
    await setTodo({ DUE: '2026-09-28T09:30:00Z' });

    const { master, overrides } = parts(emittedTodo(), 'vtodo');
    expect(master).toContain('DUE:20260928T093000Z');
    expect(master.some((l) => l.startsWith('DURATION'))).toBe(false);
    expect(overrides).toEqual([TODO_OVERRIDE]);
  });

  test('setting DURATION drops the DUE of the master, not of the override', async () => {
    storedTodo = calendar('VTODO', TODO_OVERRIDE, [...TODO_MASTER.filter((l) => !l.startsWith('DURATION')), 'DUE:20260928T090000Z']);
    await setTodo({ DURATION: 'PT2H' });

    const { master, overrides } = parts(emittedTodo(), 'vtodo');
    expect(master).toContain('DURATION:PT2H');
    expect(master.some((l) => l.startsWith('DUE'))).toBe(false);
    expect(overrides).toEqual([TODO_OVERRIDE]);
  });

  test('DUE before the master DTSTART is refused, though the override would allow it', async () => {
    storedTodo = calendar('VTODO', TODO_OVERRIDE, TODO_MASTER);
    // after the override's DTSTART (10-05), before the master's (09-28 08:00)
    await expect(setTodo({ DUE: '2026-09-28T07:00:00Z' })).rejects.toThrow(/must be later than DTSTART/);
    expect(updateTodo).not.toHaveBeenCalled();
  });
});

describe('readers show the master of an override-first object (#96)', () => {
  test('a todo is displayed as its master', () => {
    const output = formatTodo({ url: TODO_URL, data: calendar('VTODO', TODO_OVERRIDE, TODO_MASTER) });
    expect(output).toMatch(/## \S+ Water plants\n/);
    expect(output).not.toContain('this week');
  });

  test('todo_query filters on the master DUE', () => {
    const data = calendar('VTODO', TODO_OVERRIDE, [...TODO_MASTER.filter((l) => !l.startsWith('DURATION')), 'DUE:20260928T090000Z']);
    // the todo todo_query parses and filters on
    const [{ main }] = parseObjects([{ data }], 'vtodo');
    expect(dueSpan(main)).toEqual({
      start: Date.UTC(2026, 8, 28, 9), end: Date.UTC(2026, 8, 28, 9),
    });
  });

  test('free/busy expands the master and applies the override', () => {
    const { busy } = calculateFreeBusy(
      [{ data: calendar('VEVENT', EVENT_OVERRIDE, EVENT_MASTER) }],
      { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-03T00:00:00Z') },
    );
    expect(busy.map((b) => [b.start.toISOString(), b.end.toISOString()])).toEqual([
      ['2026-10-01T09:00:00.000Z', '2026-10-01T09:30:00.000Z'],
      ['2026-10-02T14:00:00.000Z', '2026-10-02T15:00:00.000Z'],
    ]);
  });
});

describe('several instances without a master (#96)', () => {
  const first = ['UID:invite@test', 'SUMMARY:Review (Oct 1)', 'RECURRENCE-ID:20261001T090000Z',
    'DTSTART:20261001T090000Z', 'DTEND:20261001T100000Z', 'DUE:20261001T100000Z'];
  const second = ['UID:invite@test', 'SUMMARY:Review (Oct 8)', 'RECURRENCE-ID:20261008T090000Z',
    'DTSTART:20261008T090000Z', 'DTEND:20261008T100000Z', 'DUE:20261008T100000Z'];
  const events = calendar('VEVENT', first.filter((l) => !l.startsWith('DUE')), second.filter((l) => !l.startsWith('DUE')));
  const todos = calendar('VTODO', first.filter((l) => !l.startsWith('DTEND')), second.filter((l) => !l.startsWith('DTEND')));

  test('readSeries falls back to the first instance and lists all of them', () => {
    const series = readSeries(new ICAL.Component(ICAL.parse(events)), 'vevent');
    expect(series.master.getFirstPropertyValue('summary')).toBe('Review (Oct 1)');
    expect(series.overrides).toEqual([]);
    expect(series.detached.map((c) => c.getFirstPropertyValue('summary'))).toEqual(['Review (Oct 1)', 'Review (Oct 8)']);
  });

  test('reading does not throw: display, DUE filter and free/busy', () => {
    expect(formatTodo({ url: TODO_URL, data: todos })).toContain('Review (Oct 1)');
    expect(formatEvent({ url: EVENT_URL, data: events })).toContain('Review (Oct 1)');
    const [{ main }] = parseObjects([{ data: todos }], 'vtodo');
    expect(dueSpan(main)?.start).toBe(Date.UTC(2026, 9, 1, 10));

    // each detached instance is busy on its own
    const { busy } = calculateFreeBusy(
      [{ data: events }],
      { start: new Date('2026-09-30T00:00:00Z'), end: new Date('2026-10-10T00:00:00Z') },
    );
    expect(busy.map((b) => b.start.toISOString())).toEqual(['2026-10-01T09:00:00.000Z', '2026-10-08T09:00:00.000Z']);
  });

  test('update_event refuses with a validation error that names the raw route', async () => {
    storedEvent = events;
    for (const args of [
      { fields: { LOCATION: 'Room 4' } },
      { start_date: '2026-10-01T10:00:00Z', end_date: '2026-10-01T11:00:00Z' },
    ]) {
      const reply = await errorReply(setEvent(args));
      expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
      expect(reply.message).toBe(
        'This event is stored as 2 single occurrences (each with a RECURRENCE-ID) and no series ' +
        'master, so update_event cannot tell which one to change. Fetch it with calendar_multi_get ' +
        '(its Raw Data block holds the full iCalendar text and the etag), edit the VEVENT of the ' +
        'occurrence you mean, and send the whole object with update_event_raw.');
    }
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('update_todo refuses with a validation error that names the raw route', async () => {
    storedTodo = todos;
    const reply = await errorReply(setTodo({ DUE: '2026-10-02T10:00:00Z' }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/2 single occurrences .* update_todo cannot tell .* todo_multi_get .* VTODO .* update_todo_raw\.$/);
    expect(updateTodo).not.toHaveBeenCalled();
  });

  test('a lone detached instance is still updated as it is', async () => {
    storedTodo = calendar('VTODO', first.filter((l) => !l.startsWith('DTEND')));
    await setTodo({ SUMMARY: 'Review (moved)' });
    expect(emittedTodo()).toContain('SUMMARY:Review (moved)');
  });
});

// Issue #107: tsdav-utils 0.5.0 moves the whole series with its master's
// DTSTART, and refuses a move or a rule change the series cannot follow.
// These run through the real handlers and the installed library, so a
// rewording of a refusal there shows up here.
describe('moving a recurring series (#107)', () => {
  // every Monday 09:00; the 12 Oct occurrence moved to the afternoon, 19 Oct cancelled
  const weekly = (rule) => calendar('VEVENT', [
    'UID:weekly@test', 'SUMMARY:Planning', `RRULE:${rule}`,
    'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'EXDATE:20261019T090000Z',
  ], [
    'UID:weekly@test', 'SUMMARY:Planning (moved)', 'RECURRENCE-ID:20261012T090000Z',
    'DTSTART:20261012T140000Z', 'DTEND:20261012T150000Z',
  ]);

  test('Mon -> Tue on an every-Monday series follows with BYDAY=TU, exceptions included', async () => {
    storedEvent = weekly('FREQ=WEEKLY;BYDAY=MO');
    const reply = await setEvent({ start_date: '2026-10-06T10:00:00Z', end_date: '2026-10-06T11:00:00Z' });

    // the reply tells what else moved, so the model can tell the user
    expect(reply.content[0].text).toContain('- **Series**: series start DTSTART:20261005T090000Z -> ' +
      'DTSTART:20261006T100000Z; rule RRULE:FREQ=WEEKLY;BYDAY=MO -> RRULE:FREQ=WEEKLY;BYDAY=TU; ' +
      'moved along: 1 changed occurrence (override), 1 cancelled date (EXDATE)\n');

    const { master, overrides } = parts(emittedEvent(), 'vevent');
    expect(master).toEqual(expect.arrayContaining([
      'RRULE:FREQ=WEEKLY;BYDAY=TU', 'DTSTART:20261006T100000Z', 'DTEND:20261006T110000Z',
      'EXDATE:20261020T100000Z',
    ]));
    // +1 day +1 hour: the override still names its (moved) occurrence and keeps its own offset
    expect(overrides[0]).toEqual(expect.arrayContaining([
      'RECURRENCE-ID:20261013T100000Z', 'DTSTART:20261013T150000Z', 'DTEND:20261013T160000Z',
    ]));
  });

  test('a rule pinning two weekdays refuses a one-day move, with the fix spelled in tool terms', async () => {
    storedEvent = weekly('FREQ=WEEKLY;BYDAY=MO,WE');
    const reply = await errorReply(setEvent({ start_date: '2026-10-06T09:00:00Z', end_date: '2026-10-06T10:00:00Z' }));

    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    // the library's reason and remedy, whole
    expect(reply.message).toMatch(/^Moving DTSTART \(DTSTART:20261005T090000Z to DTSTART:20261006T090000Z\) does not move the whole series: RRULE:FREQ=WEEKLY;BYDAY=MO,WE has BYDAY, .* Give RRULE in the same call to fit the new start/);
    // and where those remedies live in dav-mcp
    expect(reply.message).toMatch(/\. Give what it names in fields of this same update_event call \(e\.g\. fields\.RRULE\)\.$/);
    expect(reply.data.details).toEqual({ code: 'SERIES_MOVE_REFUSED', remedy: 'same-call', property: 'RRULE' });
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('following the hint — RRULE in fields of the same call — makes that move go through', async () => {
    storedEvent = weekly('FREQ=WEEKLY;BYDAY=MO,WE');
    await setEvent({
      start_date: '2026-10-06T09:00:00Z', end_date: '2026-10-06T10:00:00Z',
      fields: { RRULE: 'FREQ=WEEKLY;BYDAY=TU,TH' },
    });
    const { master, overrides } = parts(emittedEvent(), 'vevent');
    expect(master).toEqual(expect.arrayContaining(['RRULE:FREQ=WEEKLY;BYDAY=TU,TH', 'EXDATE:20261020T090000Z']));
    expect(overrides[0]).toContain('RECURRENCE-ID:20261013T090000Z');
  });

  test('RECURRENCE-ID in fields is refused and points to the single-occurrence route', async () => {
    for (const stored of [weekly('FREQ=WEEKLY;BYDAY=MO'), calendar('VEVENT', EVENT_MASTER.filter((l) => !l.startsWith('RRULE')))]) {
      storedEvent = stored;
      const reply = await errorReply(setEvent({ fields: { 'RECURRENCE-ID': '2026-10-12T09:00:00Z', SUMMARY: 'x' } }));
      expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
      expect(reply.message).toMatch(/^RECURRENCE-ID cannot be written on the series master: /);
      expect(reply.message).toMatch(/To change a single occurrence, or to rewrite the whole object: fetch it with calendar_multi_get .* send the whole object with update_event_raw\.$/);
      expect(reply.message).not.toContain('"in the same call"');
    }
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('update_todo: a new RRULE that orphans an override is refused with the todo tools named', async () => {
    storedTodo = calendar('VTODO', TODO_OVERRIDE, TODO_MASTER);
    const reply = await errorReply(setTodo({ RRULE: 'FREQ=WEEKLY;BYDAY=TU' }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/^The new RRULE leaves the override for RECURRENCE-ID:20261005T080000Z naming no occurrence/);
    // the library's own remedy (a complete EXDATE list) is no option here;
    // the hint names what works with these tools
    expect(reply.message).toMatch(/\. Give an RRULE \(fields\.RRULE\) that keeps those occurrences, or bring back the exclusions that would name nothing with restore_occurrences in this same update_todo call .* send the edited whole with update_todo_raw\.$/);
    expect(reply.message).not.toMatch(/list mode|complete EXDATE/);
    expect(reply.data.details.code).toBe('ORPHANED_EXCEPTIONS');
    expect(updateTodo).not.toHaveBeenCalled();
  });

  test('update_todo on an object holding only an event names update_event', async () => {
    storedTodo = calendar('VEVENT', EVENT_MASTER);
    const reply = await errorReply(setTodo({ SUMMARY: 'x' }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toBe('No VTODO found in VCALENDAR (it holds: VEVENT). ' +
      'This object holds no todo, so update_todo cannot change it. Use update_event for its VEVENT.');
  });

  test('update_todo on a journal says there is no field tool for it, not "use update_event"', async () => {
    storedTodo = calendar('VJOURNAL', ['UID:j@test', 'SUMMARY:Notes', 'DTSTART:20261005T090000Z']);
    const reply = await errorReply(setTodo({ SUMMARY: 'x' }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/^No VTODO found in VCALENDAR \(it holds: VJOURNAL\)\. .* dav-mcp has no field-update tool for VJOURNAL\.$/);
  });

  // refusals of a write naming several properties (a move plus a new rule;
  // RRULE plus RDATE), recognised by code whatever the message names
  test('a move plus a new RRULE that orphans the override is a validation error', async () => {
    storedEvent = weekly('FREQ=WEEKLY;BYDAY=MO');
    const reply = await errorReply(setEvent({
      start_date: '2026-10-06T09:00:00Z', end_date: '2026-10-06T10:00:00Z',
      fields: { RRULE: 'FREQ=WEEKLY;BYDAY=WE' },
    }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/^The new [A-Z ]*RRULE leaves the override for RECURRENCE-ID:20261012T090000Z/);
    expect(reply.data.details.code).toBe('ORPHANED_EXCEPTIONS');
  });

  const BERLIN = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
    'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
    'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  // daily at 02:30 Berlin across the spring-forward gap, the 03:30 it turns into excluded
  const acrossTheGap = () => calendar('VEVENT', [
    'UID:gap@test', 'SUMMARY:Night shift', 'RRULE:FREQ=DAILY;COUNT=10',
    'DTSTART;TZID=Europe/Berlin:20260325T023000', 'DTEND;TZID=Europe/Berlin:20260325T030000',
    'EXDATE;TZID=Europe/Berlin:20260329T033000',
  ]).replace('BEGIN:VEVENT', [...BERLIN, 'BEGIN:VEVENT'].join('\r\n'));

  test('a new RRULE and RDATE that would make a twin is a validation error', async () => {
    storedEvent = acrossTheGap();
    // RDATE is no field of update_event since #126; the refusal is mapped the
    // same way for every write, so it is checked on the mapping itself
    let thrown;
    try {
      updateFields(storedEvent, { RRULE: 'FREQ=DAILY;COUNT=12', RDATE: '2026-04-20T02:30:00' }, { type: 'vevent' });
    } catch (error) {
      thrown = error;
    }
    const reply = JSON.parse(createToolErrorResponse(explainWriteRefusal(thrown, 'vevent')).content[0].text);
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/^Writing RRULE and RDATE is refused: /);
    expect(reply.data.details.code).toBe('DST_AMBIGUOUS');
  });

  test('a move that would make a twin is a validation error', async () => {
    storedEvent = acrossTheGap();
    const reply = await errorReply(setEvent({ start_date: '2026-03-25T02:45:00', end_date: '2026-03-25T03:15:00' }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/^Moving DTSTART is refused: /);
  });

  test.each([
    ['an all-day EXDATE on a timed series, moved by an hour', /^DTSTART changed, and the existing EXDATE;VALUE=DATE:20261019 /,
      ['EXDATE;VALUE=DATE:20261019'], { start_date: '2026-10-05T10:00:00Z', end_date: '2026-10-05T11:00:00Z' }],
    ['an EXDATE off the series time, the series made all-day', /^DTSTART changed to a date, and /,
      ['EXDATE:20261019T110000Z'], { start_date: '2026-10-05', end_date: '2026-10-06' }],
  ])('%s is a validation error', async (_, opening, extra, move) => {
    storedEvent = calendar('VEVENT', ['UID:w@test', 'SUMMARY:W', 'RRULE:FREQ=WEEKLY',
      'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', ...extra]);
    const reply = await errorReply(setEvent(move));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(opening);
  });

  test('a start weeks later takes the cancelled date along, and the reply says so', async () => {
    // the trap: an occurrence's date passed as start_date shifts the series
    storedEvent = weekly('FREQ=WEEKLY;BYDAY=MO');
    const reply = await setEvent({ start_date: '2026-11-09T10:00:00Z', end_date: '2026-11-09T11:00:00Z' });
    expect(parts(emittedEvent(), 'vevent').master).toContain('EXDATE:20261123T100000Z');
    const { series } = JSON.parse(reply.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
    expect(series).toEqual(expect.objectContaining({ overrides_moved: 1, exdates_moved: 1, rdates_moved: 0 }));
  });

  test('no Series line for a write that leaves the series shape alone, or for a single event', async () => {
    storedEvent = weekly('FREQ=WEEKLY;BYDAY=MO');
    expect((await setEvent({ fields: { LOCATION: 'Room 4' } })).content[0].text).not.toContain('**Series**');
    storedEvent = calendar('VEVENT', ['UID:one@test', 'SUMMARY:Once', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z']);
    expect((await setEvent({ start_date: '2026-10-06T09:00:00Z', end_date: '2026-10-06T10:00:00Z' })).content[0].text)
      .not.toContain('**Series**');
  });

  test('update_todo reports a moved series too', async () => {
    storedTodo = calendar('VTODO', TODO_OVERRIDE, TODO_MASTER);
    const reply = await setTodo({ DTSTART: '2026-09-28T09:00:00Z' });
    expect(reply.content[0].text).toMatch(/\*\*Series\*\*: series start DTSTART:20260928T080000Z -> DTSTART:20260928T090000Z; moved along: 1 changed occurrence \(override\)/);
  });

  test('a suggested rule from the library is given as the example', async () => {
    storedEvent = weekly('FREQ=MONTHLY;BYDAY=MO');
    const reply = await errorReply(setEvent({ start_date: '2026-10-06T09:00:00Z', end_date: '2026-10-06T10:00:00Z' }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/Give what it names in fields of this same update_event call \(e\.g\. fields\.RRULE "FREQ=MONTHLY;BYDAY=TU"\)\.$/);
    expect(reply.data.details.suggestion).toBe('FREQ=MONTHLY;BYDAY=TU');
  });

  test('a value the library cannot read names the property to correct', async () => {
    storedEvent = weekly('FREQ=WEEKLY;BYDAY=MO');
    // (EXDATE is no field since #126; DTSTAMP takes the same date grammar)
    const reply = await errorReply(setEvent({ fields: { DTSTAMP: 'garbage' } }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/^DTSTAMP: "garbage" is not a date or date-time\. .*Correct DTSTAMP and call update_event again\.$/);
  });

  test('a stored object that does not parse is a CalDAV error, with the repair route', async () => {
    storedEvent = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nnot a content line\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const reply = await errorReply(setEvent({ fields: { SUMMARY: 'x' } }));
    expect(reply.code).toBe(MCP_ERROR_CODES.CALDAV_ERROR);
    expect(reply.message).toMatch(/^The stored event cannot be parsed, so it was not changed \(Failed to parse iCal data: .*\)\. To repair it, fetch it with calendar_multi_get and send a corrected object with update_event_raw\.$/);
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('a call dav-mcp got wrong stays an internal error', () => {
    let thrown;
    try {
      updateFields(weekly('FREQ=WEEKLY'), { SUMMARY: 'x' }, { type: 'vfoo' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe('INVALID_TYPE');
    const reply = JSON.parse(createToolErrorResponse(explainWriteRefusal(thrown, 'vevent')).content[0].text);
    expect(reply.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
    expect(reply.message).toMatch(/^dav-mcp called tsdav-utils wrongly \(INVALID_TYPE\): Invalid type "vfoo"/);
  });

  test('a series in a zone, moved with a UTC start, stays in its zone and keeps its local time after the DST change', async () => {
    // every Monday 09:00 Berlin; "10:00 Berlin on Tuesday" given as 08:00Z (CEST)
    storedEvent = calendar('VEVENT', [
      'UID:berlin@test', 'SUMMARY:Planning', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6',
      'DTSTART;TZID=Europe/Berlin:20261005T090000', 'DTEND;TZID=Europe/Berlin:20261005T100000',
    ]).replace('BEGIN:VEVENT', [...BERLIN, 'BEGIN:VEVENT'].join('\r\n'));
    await setEvent({ start_date: '2026-10-06T08:00:00Z', end_date: '2026-10-06T09:00:00Z' });

    const written = emittedEvent();
    const { master } = parts(written, 'vevent');
    expect(master).toEqual(expect.arrayContaining([
      'DTSTART;TZID=Europe/Berlin:20261006T100000', 'DTEND;TZID=Europe/Berlin:20261006T110000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6',
    ]));
    // after 25 October (CET) the occurrences are still 10:00 in Berlin, i.e. 09:00Z
    const vcalendar = new ICAL.Component(ICAL.parse(written));
    const zone = new ICAL.Timezone(vcalendar.getFirstSubcomponent('vtimezone'));
    ICAL.TimezoneService.register(zone, 'Europe/Berlin');
    const iterator = new ICAL.Event(vcalendar.getFirstSubcomponent('vevent')).iterator();
    const starts = [];
    for (let next = iterator.next(); next; next = iterator.next()) starts.push(next.toJSDate().toISOString());
    ICAL.TimezoneService.remove('Europe/Berlin');
    expect(starts).toEqual([
      '2026-10-06T08:00:00.000Z', '2026-10-13T08:00:00.000Z', '2026-10-20T08:00:00.000Z',
      '2026-10-27T09:00:00.000Z', '2026-11-03T09:00:00.000Z', '2026-11-10T09:00:00.000Z',
    ]);
  });

  test('any other error is passed on as it is', () => {
    const fault = new Error('Failed to parse iCal data: unexpected end');
    expect(explainWriteRefusal(fault, 'vevent')).toBe(fault);
    // a vCard write names no component type, so there is no tool to point to
    const vcard = new Error('No VTODO found in VCALENDAR');
    expect(explainWriteRefusal(vcard, undefined)).toBe(vcard);
    expect(explainWriteRefusal(undefined, 'vtodo')).toBeUndefined();
  });
});

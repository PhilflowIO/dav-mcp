import { describe, test, expect, beforeEach, jest } from '@jest/globals';
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
const { formatTodo, formatEvent } = await import('../src/formatters.js');
const { readSeries } = await import('../src/ical-components.js');

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
    // the override is an instance of its own and keeps what it had
    expect(overrides).toEqual([EVENT_OVERRIDE.map((l) => l)]);
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
    expect(dueSpan(data)).toEqual({
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
    expect(dueSpan(todos)?.start).toBe(Date.UTC(2026, 9, 1, 10));

    // each detached instance is busy on its own
    const { busy } = calculateFreeBusy(
      [{ data: events }],
      { start: new Date('2026-09-30T00:00:00Z'), end: new Date('2026-10-10T00:00:00Z') },
    );
    expect(busy.map((b) => b.start.toISOString())).toEqual(['2026-10-01T09:00:00.000Z', '2026-10-08T09:00:00.000Z']);
  });

  test('update_event refuses with an actionable error and writes nothing', async () => {
    storedEvent = events;
    await expect(setEvent({ fields: { LOCATION: 'Room 4' } }))
      .rejects.toThrow(/2 VEVENT instances .* no master.*rewriting the whole iCalendar object/s);
    await expect(setEvent({ start_date: '2026-10-01T10:00:00Z', end_date: '2026-10-01T11:00:00Z' }))
      .rejects.toThrow(/no master/);
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('update_todo refuses with an actionable error and writes nothing', async () => {
    storedTodo = todos;
    await expect(setTodo({ DUE: '2026-10-02T10:00:00Z' })).rejects.toThrow(/2 VTODO instances .* no master/s);
    expect(updateTodo).not.toHaveBeenCalled();
  });
});

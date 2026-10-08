import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');
import ICAL from 'ical.js';

// Issue #126: with tsdav-utils 0.7.0 an EXDATE written as a field is the
// complete list, so writing one date to cancel one more occurrence brought
// back every occurrence cancelled before. Single occurrences are now
// cancelled and restored by name (cancel_occurrences / restore_occurrences),
// the names the listings show. These run through the real handlers, the real
// formatters and the installed library.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const EVENT_URL = `${CALENDAR_URL}event.ics`;
const TODO_URL = `${CALENDAR_URL}todo.ics`;

const ok = () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) });
const updateCalendarObject = jest.fn(async () => ok());
const updateTodo = jest.fn(async () => ok());

let storedEvent = '';
let storedTodo = '';

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendarObjects: async () => [{ url: EVENT_URL, etag: '"1"', data: storedEvent }],
      updateCalendarObject,
      fetchTodos: async () => [{ url: TODO_URL, etag: '"1"', data: storedTodo }],
      updateTodo,
    }),
    getCardDavClient: () => ({}),
  },
}));

const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');
const { formatEvent, formatTodo } = await import('../src/formatters.js');
const { createToolErrorResponse, MCP_ERROR_CODES } = await import('../src/error-handler.js');
const { expandOccurrences, createRecurrenceBudget } = await import('tsdav-utils');

const errorReply = async (call) => {
  try {
    await call;
  } catch (error) {
    return JSON.parse(createToolErrorResponse(error).content[0].text);
  }
  throw new Error('expected the call to fail');
};

const VTIMEZONE_BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const calendar = (type, ...components) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...VTIMEZONE_BERLIN,
  ...components.flatMap((props) => [`BEGIN:${type}`, 'DTSTAMP:20260101T000000Z', ...props, `END:${type}`]),
  'END:VCALENDAR',
].join('\r\n');

// Weekly on Thursday 10:00 in Berlin. Two exclusions already, written the way
// different clients do: one in the series' zone, one in UTC. The 5 Nov
// occurrence is changed (moved to 15:00).
const SERIES = [
  'UID:weekly@test', 'SUMMARY:Planning',
  'DTSTART;TZID=Europe/Berlin:20261001T100000', 'DTEND;TZID=Europe/Berlin:20261001T110000',
  'RRULE:FREQ=WEEKLY',
  'EXDATE;TZID=Europe/Berlin:20261224T100000',
  'EXDATE:20261231T090000Z',
];
const OVERRIDE = [
  'UID:weekly@test', 'SUMMARY:Planning (moved)', 'RECURRENCE-ID;TZID=Europe/Berlin:20261105T100000',
  'DTSTART;TZID=Europe/Berlin:20261105T150000', 'DTEND;TZID=Europe/Berlin:20261105T160000',
];

const written = () => updateCalendarObject.mock.calls.at(-1)[0].calendarObject.data;
const writtenTodo = () => updateTodo.mock.calls.at(-1)[0].calendarObject.data;
const setEvent = (args) => updateEventFields.handler({ event_url: EVENT_URL, event_etag: '"1"', ...args });
const setTodo = (args) => updateTodoFields.handler({ todo_url: TODO_URL, todo_etag: '"1"', ...args });

/** the original starts of the occurrences in [from, until), as tsdav-utils expands them */
const occurrenceIds = (data, from, until) => expandOccurrences(data, {
  budget: createRecurrenceBudget(), from, until,
}).occurrences.map((o) => o.recurrenceId.value);

/** each EXDATE value of the master as the instant it names, ISO */
const exdateInstants = (data) => {
  const master = new ICAL.Component(ICAL.parse(data)).getAllSubcomponents('vevent')
    .find((c) => !c.hasProperty('recurrence-id'));
  return master.getAllProperties('exdate').flatMap((p) => p.getValues())
    .map((t) => (t.isDate ? t.toString() : t.toJSDate().toISOString())).sort();
};

beforeEach(() => {
  updateCalendarObject.mockClear();
  updateTodo.mockClear();
});

describe('cancel_occurrences adds to the exclusions (#126)', () => {
  test('two exclusions, cancel a third: three remain', async () => {
    storedEvent = calendar('VEVENT', SERIES);
    const reply = await setEvent({ cancel_occurrences: ['2026-12-17T10:00:00'] });

    expect(exdateInstants(written())).toEqual([
      '2026-12-17T09:00:00.000Z', '2026-12-24T09:00:00.000Z', '2026-12-31T09:00:00.000Z',
    ]);
    expect(occurrenceIds(written(), '2026-12-10T00:00:00Z', '2027-01-15T00:00:00Z'))
      .toEqual(['2026-12-10T10:00:00', '2027-01-07T10:00:00', '2027-01-14T10:00:00']);
    // the stored lines are kept as they were; only the new one is added
    expect(written()).toContain('EXDATE;TZID=Europe/Berlin:20261224T100000');
    expect(written()).toContain('EXDATE:20261231T090000Z');
    expect(reply.content[0].text).toContain('- **Occurrences**: cancelled 2026-12-17T10:00:00\n');
  });

  test('restore one of three: two remain, the others untouched', async () => {
    storedEvent = calendar('VEVENT', [...SERIES, 'EXDATE;TZID=Europe/Berlin:20261217T100000']);
    // the UTC-stored exclusion, named as the listing names it: on the Berlin wall clock
    const reply = await setEvent({ restore_occurrences: ['2026-12-31T10:00:00'] });

    expect(exdateInstants(written())).toEqual(['2026-12-17T09:00:00.000Z', '2026-12-24T09:00:00.000Z']);
    expect(reply.content[0].text).toContain('- **Occurrences**: restored 2026-12-31T10:00:00\n');
  });

  test('cancelling a changed occurrence by its original start removes the override and excludes it', async () => {
    storedEvent = calendar('VEVENT', SERIES, OVERRIDE);
    const reply = await setEvent({ cancel_occurrences: ['2026-11-05T10:00:00'] });

    const components = new ICAL.Component(ICAL.parse(written())).getAllSubcomponents('vevent');
    expect(components).toHaveLength(1);
    expect(exdateInstants(written())).toContain('2026-11-05T09:00:00.000Z');
    expect(occurrenceIds(written(), '2026-10-29T00:00:00Z', '2026-11-13T00:00:00Z'))
      .toEqual(['2026-10-29T10:00:00', '2026-11-12T10:00:00']);
    expect(reply.content[0].text).toContain(
      '- **Occurrences**: cancelled 2026-11-05T10:00:00; removed the changed version of 2026-11-05T10:00:00\n');
  });

  test('cancelling an occurrence already cancelled changes nothing and says so', async () => {
    storedEvent = calendar('VEVENT', SERIES);
    const reply = await setEvent({ cancel_occurrences: ['2026-12-24T10:00:00'] });
    // nothing to write, so nothing is written (no new etag on the server)
    expect(updateCalendarObject).not.toHaveBeenCalled();
    expect(reply.content[0].text).toContain('✅ **Event not changed**');
    expect(reply.content[0].text).toContain('- **Occurrences**: no change: already as asked\n');
  });

  test('after a whole-day exclusion on a 09:00/17:00 series, restore brings back only the one named', async () => {
    storedEvent = calendar('VEVENT', [
      'UID:twice@test', 'SUMMARY:Check',
      'DTSTART;TZID=Europe/Berlin:20261005T090000', 'DTEND;TZID=Europe/Berlin:20261005T093000',
      'RRULE:FREQ=DAILY;BYHOUR=9,17', 'EXDATE;VALUE=DATE:20261007',
    ]);
    const reply = await setEvent({ restore_occurrences: ['2026-10-07T09:00:00'] });

    expect(occurrenceIds(written(), '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z'))
      .toEqual(['2026-10-07T09:00:00']);
    expect(reply.content[0].text).toContain(
      '- **Occurrences**: cancelled 2026-10-07T17:00:00; restored 2026-10-07 (whole day)\n');
  });

  test('a wall-clock name on a UTC series is refused, not read in the host zone', async () => {
    storedEvent = calendar('VEVENT', [
      'UID:utc@test', 'SUMMARY:Sync', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'RRULE:FREQ=WEEKLY',
    ]);
    const reply = await errorReply(setEvent({ cancel_occurrences: ['2026-10-12T09:00:00'] }));

    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toBe('cancel_occurrences: "2026-10-12T09:00:00" is not an occurrence name of this series. ' +
      'Occurrences are named by their original start as UTC, with Z (e.g. "2026-10-05T09:00:00Z"). ' +
      'Use the name exactly as calendar_query, list_events or calendar_multi_get list it ("Occurrence ID"), and call again.');
    expect(reply.data.details).toMatchObject({
      code: 'ZONE_MISMATCH', parameter: 'cancel_occurrences', names: ['2026-10-12T09:00:00'],
    });
    expect(updateCalendarObject).not.toHaveBeenCalled();

    // the name the listing gives works
    await setEvent({ cancel_occurrences: ['2026-10-12T09:00:00Z'] });
    expect(written()).toContain('EXDATE:20261012T090000Z');
  });

  test('a name that is no occurrence is refused with the library reason and the listing to use', async () => {
    storedEvent = calendar('VEVENT', SERIES);
    // one good name and one in the wrong hour: only the wrong one is named, in ISO form
    const reply = await errorReply(setEvent({ cancel_occurrences: ['2026-12-10T10:00:00', '2026-12-17T09:00:00'] }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toBe('cancel_occurrences: "2026-12-17T09:00:00" is no occurrence of this series ' +
      '(that day it has "2026-12-17T10:00:00"). Occurrences are named by their original start as wall-clock time ' +
      'in Europe/Berlin (e.g. "2026-10-01T10:00:00"). Use the name exactly as calendar_query, list_events or ' +
      'calendar_multi_get list it ("Occurrence ID"), and call again.');
    expect(reply.data.details).toMatchObject({
      code: 'UNKNOWN_OCCURRENCE', remedy: 'fix-value', names: ['2026-12-17T09:00:00'],
    });
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('restoring an occurrence that is not cancelled is refused, naming restore_occurrences', async () => {
    storedEvent = calendar('VEVENT', SERIES);
    const reply = await errorReply(setEvent({ restore_occurrences: ['2026-12-17T10:00:00'] }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toMatch(/^restore_occurrences: "2026-12-17T10:00:00" is not cancelled \(cancelled are: "2026-12-24T10:00:00", "2026-12-31T10:00:00"\)\./);
    expect(reply.message).toMatch(/list it \("Cancelled occurrences"\), and call again\.$/);
    expect(reply.data.details).toMatchObject({ code: 'NOT_IN_LIST', parameter: 'restore_occurrences' });
  });

  test('cancel and a move in one call: the new exclusion moves with the series', async () => {
    storedEvent = calendar('VEVENT', SERIES);
    await setEvent({
      cancel_occurrences: ['2026-12-17T10:00:00'],
      start_date: '2026-10-01T11:00:00', end_date: '2026-10-01T12:00:00',
    });
    expect(exdateInstants(written())).toEqual([
      '2026-12-17T10:00:00.000Z', '2026-12-24T10:00:00.000Z', '2026-12-31T10:00:00.000Z',
    ]);
  });

  test('one occurrence in both lists is refused, also when named in two forms', async () => {
    storedEvent = calendar('VEVENT', SERIES);
    await expect(setEvent({
      cancel_occurrences: ['2026-12-17T10:00:00'], restore_occurrences: ['2026-12-17T09:00:00Z'],
    })).rejects.toThrow('restore_occurrences: "2026-12-17T09:00:00Z" names an occurrence that cancel_occurrences names too');
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

});

describe('EXDATE and RDATE are not fields (#126)', () => {
  test.each([['EXDATE'], ['exdate'], ['RDATE']])('fields.%s is refused, naming the parameters', async (name) => {
    storedEvent = calendar('VEVENT', SERIES);
    const call = setEvent({ fields: { [name]: '2026-12-17T10:00:00' } });
    await expect(call).rejects.toThrow(name.toUpperCase() === 'EXDATE'
      ? /fields\.EXDATE: EXDATE is not set through fields: written there it replaces every exclusion .* cancel_occurrences .* restore_occurrences/
      : /fields\.RDATE: RDATE is not set through fields: .*update_event_raw/);
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });

  test('update_todo refuses fields.EXDATE too', async () => {
    await expect(setTodo({ fields: { EXDATE: '2026-12-17' } }))
      .rejects.toThrow(/fields\.EXDATE: .*cancel_occurrences/);
  });
});

describe('listed names round-trip through the handlers (#126)', () => {
  test('a listed name round-trips: cancel by Occurrence ID, restore by Cancelled occurrences', async () => {
    storedEvent = calendar('VEVENT', SERIES, OVERRIDE);
    const listed = formatEvent({ url: EVENT_URL, data: storedEvent }, 'Work',
      { start: '2026-11-04T00:00:00Z', end: '2026-11-06T00:00:00Z' });
    const id = /\*\*Occurrence ID\*\*: (\S+)/.exec(listed)[1];
    await setEvent({ cancel_occurrences: [id] });

    storedEvent = written();
    const after = formatEvent({ url: EVENT_URL, data: storedEvent }, 'Work');
    const cancelled = /\*\*Cancelled occurrences\*\*: (.*)\n/.exec(after)[1].split(', ');
    expect(cancelled).toEqual(['2026-11-05T10:00:00', '2026-12-24T10:00:00', '2026-12-31T10:00:00']);
    await setEvent({ restore_occurrences: [cancelled[2]] });
    expect(exdateInstants(written())).toEqual(['2026-11-05T09:00:00.000Z', '2026-12-24T09:00:00.000Z']);
  });

  test('a recurring todo shows its rule, its exclusions and how to name occurrences', async () => {
    storedTodo = calendar('VTODO', [
      'UID:todo@test', 'SUMMARY:Water plants', 'DTSTART;TZID=Europe/Berlin:20261005T080000',
      'DUE;TZID=Europe/Berlin:20261005T090000', 'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Berlin:20261012T080000',
    ]);
    const text = formatTodo({ url: TODO_URL, etag: '"1"', data: storedTodo }, 'Work');
    expect(text).toContain('- **Recurring**: FREQ=WEEKLY\n');
    expect(text).toContain('- **Occurrence ID**: 2026-10-05T08:00:00 (series start');
    expect(text).toContain('- **Cancelled occurrences**: 2026-10-12T08:00:00\n');

    const reply = await setTodo({ cancel_occurrences: ['2026-10-19T08:00:00'] });
    expect(writtenTodo()).toContain('EXDATE;TZID=Europe/Berlin:20261012T080000');
    expect(writtenTodo()).toContain('EXDATE;TZID=Europe/Berlin:20261019T080000');
    expect(reply.content[0].text).toContain('- **Occurrences**: cancelled 2026-10-19T08:00:00\n');
  });
});

describe('a call that asks for nothing writes nothing (#126)', () => {
  test.each([
    [{}],
    [{ cancel_occurrences: [], restore_occurrences: [] }],
    [{ fields: {}, cancel_occurrences: [] }],
  ])('update_event %j: no fetch, no write, a clear reply', async (args) => {
    storedEvent = calendar('VEVENT', SERIES);
    const reply = await setEvent(args);
    expect(updateCalendarObject).not.toHaveBeenCalled();
    expect(reply.content[0].text).toContain('✅ **Event not changed**');
    expect(reply.content[0].text).toContain('- **Message**: Not written: nothing to change');
  });

  test('update_todo with empty lists: no write', async () => {
    const reply = await setTodo({ cancel_occurrences: [] });
    expect(updateTodo).not.toHaveBeenCalled();
    expect(reply.content[0].text).toContain('✅ **Todo not changed**');
  });

  test('a cancel on a VALUE_TYPE refusal (time on an all-day series) is phrased in parameter terms', async () => {
    storedEvent = calendar('VEVENT', [
      'UID:d@test', 'SUMMARY:Bins', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'RRULE:FREQ=WEEKLY',
    ]);
    const reply = await errorReply(setEvent({ cancel_occurrences: ['2026-10-12T09:00:00'] }));
    expect(reply.message).toBe('cancel_occurrences: "2026-10-12T09:00:00" is not an occurrence name of this series. ' +
      'Occurrences are named by their original start as the date (e.g. "2026-10-05"). ' +
      'Use the name exactly as calendar_query, list_events or calendar_multi_get list it ("Occurrence ID"), and call again.');
    expect(reply.message).not.toMatch(/EXDATE|cancelOccurrences/);
  });
});

// Review of #127: names come from instants, exclusions that cancel nothing
// are not listed as cancelled, and the edits refuse what they cannot mean.
describe('names, inert exclusions and refusals (#126 review)', () => {
  const listed = (data, range) => formatEvent({ url: EVENT_URL, data }, 'Work', range);
  const idIn = (text) => /\*\*Occurrence ID\*\*: (\S+)/.exec(text)[1];

  test('an RDATE stored in UTC next to a Berlin series is named on the Berlin wall clock', async () => {
    storedEvent = calendar('VEVENT', [
      'UID:rdate@test', 'SUMMARY:Daily', 'DTSTART;TZID=Europe/Berlin:20261012T090000',
      'DTEND;TZID=Europe/Berlin:20261012T093000', 'RRULE:FREQ=DAILY;COUNT=5', 'RDATE:20261014T090000Z',
    ]);
    const text = listed(storedEvent, { start: '2026-10-14T08:30:00Z', end: '2026-10-14T09:30:00Z' });
    expect(idIn(text)).toBe('2026-10-14T11:00:00');

    await setEvent({ cancel_occurrences: [idIn(text)] });
    // the extra 11:00 occurrence goes, the regular 09:00 one stays
    expect(occurrenceIds(written(), '2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z')).toEqual(['2026-10-14T09:00:00']);
  });

  test('a whole-day exclusion is restored by the text the listing shows', async () => {
    storedEvent = calendar('VEVENT', [
      'UID:twice@test', 'SUMMARY:Check',
      'DTSTART;TZID=Europe/Berlin:20261005T090000', 'DTEND;TZID=Europe/Berlin:20261005T093000',
      'RRULE:FREQ=DAILY;BYHOUR=9,17', 'EXDATE;VALUE=DATE:20261006',
    ]);
    const cancelled = /\*\*Cancelled occurrences\*\*: (.*)\n/.exec(listed(storedEvent))[1];
    expect(cancelled).toBe('2026-10-06 (whole day)');
    await setEvent({ restore_occurrences: [cancelled] });
    expect(occurrenceIds(written(), '2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z'))
      .toEqual(['2026-10-06T09:00:00', '2026-10-06T17:00:00']);
  });

  test.each([['update_event', () => setEvent], ['update_todo', () => setTodo]])(
    '%s refuses cancel/restore on an item that does not recur, and writes nothing', async (tool, call) => {
      storedEvent = calendar('VEVENT', [
        'UID:once@test', 'SUMMARY:Once', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z',
      ]);
      storedTodo = calendar('VTODO', ['UID:t@test', 'SUMMARY:Once', 'DTSTART:20261005T090000Z']);
      const reply = await errorReply(call()({ cancel_occurrences: ['2026-10-05T09:00:00Z'] }));
      expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
      expect(reply.message).toMatch(tool === 'update_event'
        ? /^cancel_occurrences: this event does not recur .* use delete_event/
        : /^cancel_occurrences: this todo does not recur .* use delete_todo/);
      expect(updateCalendarObject).not.toHaveBeenCalled();
      expect(updateTodo).not.toHaveBeenCalled();
    });

  test('exclusions that name no occurrence are listed apart, not as cancelled', () => {
    const text = listed(calendar('VEVENT', [
      'UID:inert@test', 'SUMMARY:Planning',
      'DTSTART;TZID=Europe/Berlin:20261001T100000', 'DTEND;TZID=Europe/Berlin:20261001T110000', 'RRULE:FREQ=WEEKLY',
      'EXDATE;TZID=Europe/Berlin:20261008T100000', // a real one
      'EXDATE:20261015T100000', // floating next to a zoned series: names nothing
      'EXDATE;TZID=Europe/Berlin:20261016T100000', // a Friday: the rule never yields it
    ]));
    expect(text).toContain('- **Cancelled occurrences**: 2026-10-08T10:00:00\n');
    expect(text).toContain('- **Exclusions that match no occurrence** (they cancel nothing): 2026-10-15T10:00:00, 2026-10-16T10:00:00\n');
  });

  test('an RRULE change that would orphan an exclusion names the working path; restore in the same call works', async () => {
    storedEvent = calendar('VEVENT', SERIES);
    const reply = await errorReply(setEvent({ fields: { RRULE: 'FREQ=WEEKLY;BYDAY=FR' } }));
    expect(reply.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    expect(reply.message).toContain('Bring those occurrences back with restore_occurrences in this same update_event call');
    expect(reply.message).not.toMatch(/list mode|complete EXDATE/);
    expect(reply.data.details).toMatchObject({ code: 'ORPHANED_EXCEPTIONS' });

    await setEvent({
      fields: { RRULE: 'FREQ=WEEKLY;BYDAY=FR' },
      restore_occurrences: ['2026-12-24T10:00:00', '2026-12-31T10:00:00'],
    });
    expect(written()).toContain('RRULE:FREQ=WEEKLY;BYDAY=FR');
    expect(written()).not.toContain('EXDATE');
  });

  test('a floating twin of a real exclusion does not hide it', async () => {
    storedEvent = calendar('VEVENT', [
      'UID:twin@test', 'SUMMARY:Daily', 'DTSTART;TZID=Europe/Berlin:20271010T011500',
      'DTEND;TZID=Europe/Berlin:20271010T014500', 'RRULE:FREQ=DAILY;COUNT=5',
      'EXDATE:20271011T011500', 'EXDATE;TZID=Europe/Berlin:20271011T011500',
      'EXDATE:20271012T011500',
    ]);
    const text = listed(storedEvent);
    expect(text).toContain('- **Cancelled occurrences**: 2027-10-11T01:15:00\n');
    expect(text).toContain('(they cancel nothing): 2027-10-12T01:15:00\n');
    // cancelling the occurrence the inert one seemed to name is reported as a cancel
    const reply = await setEvent({ cancel_occurrences: ['2027-10-12T01:15:00'] });
    expect(reply.content[0].text).toContain('- **Occurrences**: cancelled 2027-10-12T01:15:00\n');
  });
});

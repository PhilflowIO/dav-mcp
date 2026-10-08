import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');
import ICAL from 'ical.js';

// Issue #107: a calendar object can hold a VEVENT next to a VTODO. Left to
// choose, tsdav-utils writes into the VEVENT, so update_todo used to put a
// todo's DUE on the event. The write helper now names the component.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const OBJECT_URL = `${CALENDAR_URL}mixed.ics`;

const ok = () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) });
const updateTodo = jest.fn(async () => ok());
const updateCalendarObject = jest.fn(async () => ok());

let stored = '';

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchTodos: async () => [{ url: OBJECT_URL, etag: '"1"', data: stored }],
      updateTodo,
      fetchCalendarObjects: async () => [{ url: OBJECT_URL, etag: '"1"', data: stored }],
      updateCalendarObject,
    }),
    getCardDavClient: () => ({}),
  },
}));

const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');
const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');

const EVENT = [
  'BEGIN:VEVENT', 'UID:event@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Review',
  'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'END:VEVENT',
];
const TODO = [
  'BEGIN:VTODO', 'UID:todo@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Prepare review',
  'DTSTART:20261001T080000Z', 'DUE:20261002T080000Z', 'END:VTODO',
];
const object = (...components) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  ...components.flat(), 'END:VCALENDAR',
].join('\r\n');

/** property lines of the one component of `type` in a written object */
const lines = (document, type) => new ICAL.Component(ICAL.parse(document))
  .getFirstSubcomponent(type).toString().split(/\r?\n/);
const original = (type) => lines(object(EVENT, TODO), type);

beforeEach(() => {
  updateTodo.mockClear();
  updateCalendarObject.mockClear();
  stored = object(EVENT, TODO);
});

describe('an object holding a VEVENT and a VTODO (#107)', () => {
  test('update_todo with DUE changes only the VTODO', async () => {
    await updateTodoFields.handler({
      todo_url: OBJECT_URL, todo_etag: '"1"',
      fields: { DUE: '2026-10-03T08:00:00Z', SUMMARY: 'Prepare the review' },
    });

    const written = updateTodo.mock.calls[0][0].calendarObject.data;
    expect(lines(written, 'vtodo')).toEqual(expect.arrayContaining([
      'DUE:20261003T080000Z', 'SUMMARY:Prepare the review',
    ]));
    expect(lines(written, 'vevent')).toEqual(original('vevent'));
  });

  test('update_todo finds the VTODO when it is stored first', async () => {
    stored = object(TODO, EVENT);
    await updateTodoFields.handler({
      todo_url: OBJECT_URL, todo_etag: '"1"', fields: { DUE: '2026-10-03T08:00:00Z' },
    });

    const written = updateTodo.mock.calls[0][0].calendarObject.data;
    expect(lines(written, 'vtodo')).toContain('DUE:20261003T080000Z');
    expect(lines(written, 'vevent')).toEqual(original('vevent'));
  });

  test('update_event changes only the VEVENT, fields and dates', async () => {
    stored = object(TODO, EVENT);
    await updateEventFields.handler({
      event_url: OBJECT_URL, event_etag: '"1"',
      fields: { SUMMARY: 'Quarterly review' },
      start_date: '2026-10-05T11:00:00Z', end_date: '2026-10-05T12:00:00Z',
    });

    const written = updateCalendarObject.mock.calls[0][0].calendarObject.data;
    expect(lines(written, 'vevent')).toEqual(expect.arrayContaining([
      'SUMMARY:Quarterly review', 'DTSTART:20261005T110000Z', 'DTEND:20261005T120000Z',
    ]));
    expect(lines(written, 'vtodo')).toEqual(original('vtodo'));
  });

  test('update_todo on an object without a VTODO writes nothing', async () => {
    stored = object(EVENT);
    await expect(updateTodoFields.handler({
      todo_url: OBJECT_URL, todo_etag: '"1"', fields: { SUMMARY: 'x' },
    })).rejects.toThrow('No VTODO found in VCALENDAR (it holds: VEVENT)');
    expect(updateTodo).not.toHaveBeenCalled();
  });
});

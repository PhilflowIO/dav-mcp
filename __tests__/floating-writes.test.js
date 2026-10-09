import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://dav.example.com/');

// Moving a floating series (DTSTART without TZID or Z) wrote it back in UTC:
// a time without a zone was read on the host clock and written with Z, so
// the series stopped being floating and its floating overrides sat off by
// the host's offset (#128). A floating series stays floating now; a time
// with Z or an offset given for it is its wall-clock time in the calendar's
// zone — the zone the listings show it in (#117). Where nothing is floating,
// a time without a zone is read in the calendar's zone too, not the host's.

const BERLIN = 'https://dav.example.com/calendars/user/berlin/';
const EVENT_URL = `${BERLIN}event.ics`;
const TODO_URL = `${BERLIN}todo.ics`;

const { calendarTimezoneValue } = await import('../src/calendar-zone.js');
const BERLIN_TZ = calendarTimezoneValue('Europe/Berlin').text;

let stored = '';
const written = [];
const client = {
  fetchCalendars: async () => [{ url: BERLIN, displayName: 'Berlin', timezone: BERLIN_TZ }],
  fetchCalendarObjects: async () => [{ url: EVENT_URL, etag: '"1"', data: stored }],
  fetchTodos: async () => [{ url: TODO_URL, etag: '"1"', data: stored }],
  propfind: jest.fn(async () => [{ ok: true, status: 207, props: { calendarTimezone: BERLIN_TZ } }]),
  createCalendarObject: jest.fn(async ({ iCalString }) => {
    written.push(iCalString);
    return { url: EVENT_URL, etag: '"1"' };
  }),
  createTodo: jest.fn(async ({ iCalString }) => {
    written.push(iCalString);
    return { url: TODO_URL, etag: '"1"' };
  }),
  updateCalendarObject: jest.fn(async ({ calendarObject }) => {
    written.push(calendarObject.data);
    return { etag: '"2"' };
  }),
};
client.updateTodo = client.updateCalendarObject;

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => client, getCardDavClient: () => ({}) },
}));

const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { updateTodoFields } = await import('../src/tools/todos/update-todo-fields.js');
const { createTodo } = await import('../src/tools/todos/create-todo.js');

const calendar = (...components) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  ...components.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', 'UID:s@test', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const unfold = (text) => text.replace(/\r\n[ \t]/g, '');
const lines = (text, name) => unfold(text).split('\r\n').filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
const last = () => written[written.length - 1];

const move = (start, end) => updateEventFields.handler({ event_url: EVENT_URL, event_etag: '"1"', start_date: start, end_date: end });

beforeEach(() => {
  written.length = 0;
});

describe('moving a floating series (#128)', () => {
  // the series of the issue, with a cancelled and a changed occurrence
  const SERIES = calendar(
    vevent('SUMMARY:Review', 'DTSTART:20270402T113000', 'DTEND:20270402T123000', 'RRULE:FREQ=WEEKLY;COUNT=6',
      'EXDATE:20270409T113000'),
    vevent('SUMMARY:Review (later)', 'RECURRENCE-ID:20270416T113000', 'DTSTART:20270416T143000', 'DTEND:20270416T153000'),
  );

  test('a start without a zone keeps it floating, and its exceptions move with it', async () => {
    stored = SERIES;
    await move('2027-04-03T11:30:00', '2027-04-03T12:30:00');
    const data = last();
    expect(lines(data, 'DTSTART')).toEqual(['DTSTART:20270403T113000', 'DTSTART:20270417T143000']);
    expect(lines(data, 'DTEND')).toEqual(['DTEND:20270403T123000', 'DTEND:20270417T153000']);
    expect(lines(data, 'EXDATE')).toEqual(['EXDATE:20270410T113000']);
    expect(lines(data, 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20270417T113000']);
    expect(unfold(data)).not.toMatch(/(DTSTART|DTEND|EXDATE|RECURRENCE-ID)[^\r\n]*Z\r\n/);
  });

  test('a start with Z is its wall-clock time in the calendar\'s zone, still floating', async () => {
    stored = SERIES;
    // 09:30Z is 11:30 in Berlin in April (CEST)
    await move('2027-04-03T09:30:00Z', '2027-04-03T10:30:00Z');
    expect(lines(last(), 'DTSTART')).toEqual(['DTSTART:20270403T113000', 'DTSTART:20270417T143000']);
    expect(lines(last(), 'DTEND')[0]).toBe('DTEND:20270403T123000');
  });

  test.each([
    // Berlin leaves summer time on Sun 25 Oct 2026: 08:00Z on the 30th is 09:00 CET
    ['across the end of summer time', 'DTSTART:20261023T090000', '2026-10-30T08:00:00Z', 'DTSTART:20261030T090000'],
    // and enters it on Sun 28 Mar 2027: 07:00Z on the 29th is 09:00 CEST
    ['across the start of summer time', 'DTSTART:20270322T090000', '2027-03-29T07:00:00Z', 'DTSTART:20270329T090000'],
    ['with an offset', 'DTSTART:20261023T090000', '2026-10-30T09:00:00+01:00', 'DTSTART:20261030T090000'],
  ])('%s', async (_, dtstart, start, expected) => {
    stored = calendar(vevent('SUMMARY:Weekly', dtstart, 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY'));
    const end = start.replace(/T(\d\d)/, (m, h) => `T${String(Number(h) + 1).padStart(2, '0')}`);
    await move(start, end);
    expect(lines(last(), 'DTSTART')).toEqual([expected]);
  });

  test('a single floating event stays floating too', async () => {
    stored = calendar(vevent('SUMMARY:Once', 'DTSTART:20261010T090000', 'DTEND:20261010T100000'));
    await move('2026-10-11T08:00:00Z', '2026-10-11T09:00:00Z');
    expect(lines(last(), 'DTSTART')).toEqual(['DTSTART:20261011T100000']);
  });
});

describe('a time without a zone where nothing is floating', () => {
  test('create_event reads it in the calendar\'s zone, whatever the host', async () => {
    await createEvent.handler({
      calendar_url: BERLIN, summary: 'Standup', start_date: '2026-10-26T09:00:00', end_date: '2026-10-26T09:15:00',
    });
    // 26 Oct is after the change to winter time: 09:00 Berlin is 08:00Z
    expect(lines(last(), 'DTSTART')).toEqual(['DTSTART:20261026T080000Z']);
    expect(lines(last(), 'DTEND')).toEqual(['DTEND:20261026T081500Z']);
  });

  test('update_event on a UTC event reads it in the calendar\'s zone', async () => {
    stored = calendar(vevent('SUMMARY:Call', 'DTSTART:20261010T070000Z', 'DTEND:20261010T080000Z'));
    await move('2026-10-10T10:00:00', '2026-10-10T11:00:00');
    expect(lines(last(), 'DTSTART')).toEqual(['DTSTART:20261010T080000Z']);
  });

  test('an RRULE UNTIL without a zone, on a UTC series, is read there as well', async () => {
    stored = calendar(vevent('SUMMARY:Call', 'DTSTART:20261010T070000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY'));
    await updateEventFields.handler({
      event_url: EVENT_URL, event_etag: '"1"', fields: { RRULE: 'FREQ=DAILY;UNTIL=20261020T090000' },
    });
    expect(lines(last(), 'RRULE')).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261020T070000Z']);
  });

  test('create_todo and update_todo read a DUE without a zone in the calendar\'s zone', async () => {
    await createTodo.handler({ calendar_url: BERLIN, summary: 'Taxes', due_date: '2026-10-10T18:00:00' });
    expect(lines(last(), 'DUE')).toEqual(['DUE:20261010T160000Z']);

    stored = calendar(['BEGIN:VTODO', 'UID:t@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Taxes',
      'DUE:20261010T160000Z', 'END:VTODO']);
    await updateTodoFields.handler({ todo_url: TODO_URL, todo_etag: '"1"', fields: { DUE: '2026-11-10T18:00:00' } });
    expect(lines(last(), 'DUE')).toEqual(['DUE:20261110T170000Z']);
  });

  test('update_todo keeps a floating todo floating', async () => {
    stored = calendar(['BEGIN:VTODO', 'UID:t@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Taxes',
      'DUE:20261010T180000', 'END:VTODO']);
    await updateTodoFields.handler({ todo_url: TODO_URL, todo_etag: '"1"', fields: { DUE: '2026-11-10T17:00:00Z' } });
    expect(lines(last(), 'DUE')).toEqual(['DUE:20261110T180000']);
  });
});

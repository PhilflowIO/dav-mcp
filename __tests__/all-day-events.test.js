import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import ICAL from 'ical.js';

// The tools build/rewrite their document by hand, so the only way to assert the
// emitted bytes is to drive the real handlers with a stubbed DAV client.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const EVENT_URL = `${CALENDAR_URL}event.ics`;

const createCalendarObject = jest.fn(async () => ({ url: EVENT_URL, etag: '"1"' }));
const updateCalendarObject = jest.fn(async () => ({ etag: '"2"' }));

// what fetchCalendarObjects hands back; each test sets it
let storedEvent = '';

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Work' }],
      createCalendarObject,
      fetchCalendarObjects: async () => [{ url: EVENT_URL, etag: '"1"', data: storedEvent }],
      updateCalendarObject,
    }),
  },
}));

const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');
const { formatEvent } = await import('../src/formatters.js');

const ical = (...lines) => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:event-1@test',
  'DTSTAMP:20260101T000000Z',
  'SUMMARY:Sprint review',
  ...lines,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const TIMED_EVENT = ical('DTSTART:20260525T100000Z', 'DTEND:20260525T110000Z');
const TIMED_EVENT_WITH_TZID = ical(
  'DTSTART;TZID=Europe/Berlin:20260525T100000',
  'DTEND;TZID=Europe/Berlin:20260525T110000'
);
const ALL_DAY_EVENT = ical('DTSTART;VALUE=DATE:20260525', 'DTEND;VALUE=DATE:20260526');

/** Re-parse an emitted document the way a CalDAV server or client would. */
const reparse = (document) => {
  const vevent = new ICAL.Component(ICAL.parse(document)).getFirstSubcomponent('vevent');
  return {
    vevent,
    event: new ICAL.Event(vevent),
    dtstartCount: vevent.getAllProperties('dtstart').length,
    dtendCount: vevent.getAllProperties('dtend').length,
    dtstart: vevent.getFirstProperty('dtstart'),
    dtend: vevent.getFirstProperty('dtend'),
  };
};

const emittedUpdate = () => updateCalendarObject.mock.calls[0][0].calendarObject.data;

/** formatSuccess wraps its payload in a fenced JSON block inside the markdown. */
const payload = (result) =>
  JSON.parse(/```json\n([\s\S]*?)\n```/.exec(result.content[0].text)[1]);

beforeEach(() => {
  createCalendarObject.mockClear();
  updateCalendarObject.mockClear();
  storedEvent = TIMED_EVENT;
});

describe('create_event emits DATE values for all-day events', () => {
  test('a bare YYYY-MM-DD start is auto-detected as all-day', async () => {
    const result = await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Conference',
      start_date: '2026-05-25',
      end_date: '2026-05-26',
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    expect(iCalString).toContain('DTSTART;VALUE=DATE:20260525');
    expect(iCalString).toContain('DTEND;VALUE=DATE:20260526');
    expect(iCalString).not.toMatch(/DTSTART[^\r\n]*T\d{6}Z/);
    expect(payload(result).all_day).toBe(true);

    const parsed = reparse(iCalString);
    expect(parsed.dtstartCount).toBe(1);
    expect(parsed.dtendCount).toBe(1);
    expect(parsed.event.startDate.isDate).toBe(true);
    expect(parsed.event.endDate.isDate).toBe(true);
  });

  test('an explicit all_day flag agrees with the date-only format', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Conference',
      start_date: '2026-05-25',
      end_date: '2026-05-28',
      all_day: true,
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    expect(iCalString).toContain('DTSTART;VALUE=DATE:20260525');
    expect(iCalString).toContain('DTEND;VALUE=DATE:20260528');
  });

  test('an all-day document is still CRLF-delimited', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Conference',
      start_date: '2026-05-25',
      end_date: '2026-05-26',
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    expect(iCalString).toContain('\r\n');
    expect(iCalString).not.toMatch(/(^|[^\r])\n/);
    expect(iCalString).not.toMatch(/\r(?!\n)/);
  });

  test('timed events are untouched by the all-day path', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Standup',
      start_date: '2026-05-25T10:00:00Z',
      end_date: '2026-05-25T11:00:00Z',
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    expect(iCalString).toContain('DTSTART:20260525T100000Z');
    expect(iCalString).toContain('DTEND:20260525T110000Z');
    expect(iCalString).not.toContain('VALUE=DATE');
  });

  test('an all-day event round-trips to a plain date in the formatter', async () => {
    await createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'Conference',
      start_date: '2026-05-25',
      end_date: '2026-05-26',
    });

    const { iCalString } = createCalendarObject.mock.calls[0][0];
    const rendered = formatEvent({ data: iCalString, url: EVENT_URL, etag: '"1"' });
    expect(rendered).toContain('May 25, 2026');
    expect(rendered).not.toMatch(/May 25, 2026.*\d{1,2}:\d{2}/);
  });
});

describe('create_event rejects incoherent date pairs', () => {
  const rejects = (args, message) =>
    expect(createEvent.handler({
      calendar_url: CALENDAR_URL,
      summary: 'X',
      ...args,
    })).rejects.toThrow(message);

  test('date-only start with a datetime end', async () => {
    await rejects(
      { start_date: '2026-05-25', end_date: '2026-05-26T10:00:00Z' },
      /must both be date-only/
    );
  });

  test('datetime start with a date-only end (the other direction)', async () => {
    await rejects(
      { start_date: '2026-05-25T10:00:00Z', end_date: '2026-05-26' },
      /must both be date-only/
    );
  });

  test('all_day: false with date-only input names the real problem', async () => {
    await rejects(
      { start_date: '2026-05-25', end_date: '2026-05-26', all_day: false },
      /carries no time.*2026-05-25T09:00:00Z/s
    );
  });

  test('all_day: true with datetime input names the real problem', async () => {
    await rejects(
      { start_date: '2026-05-25T10:00:00Z', end_date: '2026-05-26T10:00:00Z', all_day: true },
      /must be date-only/
    );
  });

  test('same-day all-day is rejected with the exclusive-end spelling', async () => {
    await rejects(
      { start_date: '2026-05-25', end_date: '2026-05-25' },
      /exclusive: to block 2026-05-25 alone, use end_date="2026-05-26"/
    );
  });

  test('an end before the start is still rejected', async () => {
    await rejects(
      { start_date: '2026-05-25', end_date: '2026-05-24' },
      /must be after start_date/
    );
  });
});

describe('update_event converts between all-day and timed', () => {
  test('timed -> all-day emits exactly one DATE-valued DTSTART/DTEND', async () => {
    storedEvent = TIMED_EVENT;

    await updateEventFields.handler({
      event_url: EVENT_URL,
      event_etag: '"1"',
      start_date: '2026-05-25',
      end_date: '2026-05-26',
    });

    const data = emittedUpdate();
    expect(data).toContain('DTSTART;VALUE=DATE:20260525');
    expect(data).toContain('DTEND;VALUE=DATE:20260526');

    const parsed = reparse(data);
    expect(parsed.dtstartCount).toBe(1);
    expect(parsed.dtendCount).toBe(1);
    expect(parsed.event.startDate.isDate).toBe(true);
    expect(parsed.event.endDate.isDate).toBe(true);
  });

  test('all-day -> timed drops the stale VALUE=DATE parameter', async () => {
    storedEvent = ALL_DAY_EVENT;

    await updateEventFields.handler({
      event_url: EVENT_URL,
      event_etag: '"1"',
      start_date: '2026-05-25T10:00:00Z',
      end_date: '2026-05-25T11:00:00Z',
    });

    const data = emittedUpdate();
    expect(data).toContain('DTSTART:20260525T100000Z');
    expect(data).toContain('DTEND:20260525T110000Z');
    expect(data).not.toContain('VALUE=DATE');

    const parsed = reparse(data);
    expect(parsed.dtstartCount).toBe(1);
    expect(parsed.dtendCount).toBe(1);
    // the requested time survives — a leftover VALUE=DATE would discard it
    expect(parsed.event.startDate.isDate).toBe(false);
    expect(parsed.event.startDate.toJSDate().toISOString()).toBe('2026-05-25T10:00:00.000Z');
    expect(parsed.dtstart.getParameter('value')).toBeUndefined();
  });

  test('a UTC value written over a TZID event drops the TZID', async () => {
    storedEvent = TIMED_EVENT_WITH_TZID;

    await updateEventFields.handler({
      event_url: EVENT_URL,
      event_etag: '"1"',
      start_date: '2026-05-25T10:00:00Z',
      end_date: '2026-05-25T11:00:00Z',
    });

    const data = emittedUpdate();
    expect(data).not.toContain('TZID');

    const parsed = reparse(data);
    expect(parsed.dtstartCount).toBe(1);
    expect(parsed.dtstart.getParameter('tzid')).toBeUndefined();
    expect(parsed.event.startDate.toJSDate().toISOString()).toBe('2026-05-25T10:00:00.000Z');
  });

  test('an all-day value written over a TZID event drops the TZID', async () => {
    storedEvent = TIMED_EVENT_WITH_TZID;

    await updateEventFields.handler({
      event_url: EVENT_URL,
      event_etag: '"1"',
      start_date: '2026-05-25',
      end_date: '2026-05-26',
    });

    const data = emittedUpdate();
    expect(data).not.toContain('TZID');

    const parsed = reparse(data);
    expect(parsed.dtstartCount).toBe(1);
    expect(parsed.event.startDate.isDate).toBe(true);
    expect(parsed.event.startDate.year).toBe(2026);
    expect(parsed.event.startDate.month).toBe(5);
    expect(parsed.event.startDate.day).toBe(25);
  });

  test('dates and ordinary fields can change in one call', async () => {
    storedEvent = TIMED_EVENT;

    const result = await updateEventFields.handler({
      event_url: EVENT_URL,
      event_etag: '"1"',
      fields: { SUMMARY: 'Offsite' },
      start_date: '2026-05-25',
      end_date: '2026-05-27',
    });

    const data = emittedUpdate();
    expect(data).toContain('SUMMARY:Offsite');
    expect(data).toContain('DTSTART;VALUE=DATE:20260525');
    expect(reparse(data).vevent.getAllProperties('summary').length).toBe(1);
    expect(payload(result).updated_fields).toEqual(['SUMMARY', 'DTSTART', 'DTEND']);
  });

  test('a fields-only update still leaves the dates alone', async () => {
    storedEvent = ALL_DAY_EVENT;

    await updateEventFields.handler({
      event_url: EVENT_URL,
      event_etag: '"1"',
      fields: { LOCATION: 'Berlin' },
    });

    const data = emittedUpdate();
    expect(data).toContain('LOCATION:Berlin');
    expect(data).toContain('DTSTART;VALUE=DATE:20260525');
    expect(reparse(data).dtstartCount).toBe(1);
  });
});

describe('update_event rejects date changes it cannot express', () => {
  const rejects = (args, message) =>
    expect(updateEventFields.handler({
      event_url: EVENT_URL,
      event_etag: '"1"',
      ...args,
    })).rejects.toThrow(message);

  test('a parameterised key in the fields map is still refused', async () => {
    await rejects(
      { fields: { 'DTSTART;VALUE=DATE': '20260525' } },
      /is not a bare property name/
    );
  });

  test('DTSTART in the fields map alongside start_date', async () => {
    await rejects(
      { fields: { DTSTART: '20260525T100000Z' }, start_date: '2026-05-25', end_date: '2026-05-26' },
      /not with fields.DTSTART/
    );
  });

  test('start_date without end_date', async () => {
    await rejects({ start_date: '2026-05-25' }, /end_date is required/);
  });

  test('all_day alone, with no dates to apply it to', async () => {
    await rejects({ all_day: true }, /start_date is required/);
  });

  test('a mixed pair, in both directions', async () => {
    await rejects(
      { start_date: '2026-05-25', end_date: '2026-05-26T10:00:00Z' },
      /must both be date-only/
    );
    await rejects(
      { start_date: '2026-05-25T10:00:00Z', end_date: '2026-05-26' },
      /must both be date-only/
    );
  });

  test('same-day all-day is answered with the exclusive-end spelling', async () => {
    await rejects(
      { start_date: '2026-05-25', end_date: '2026-05-25' },
      /exclusive: to block 2026-05-25 alone, use end_date="2026-05-26"/
    );
  });

  test('nothing is sent to the server when validation fails', async () => {
    await rejects({ start_date: '2026-05-25' }, /end_date is required/);
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });
});

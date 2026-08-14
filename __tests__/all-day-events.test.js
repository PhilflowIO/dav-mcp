import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import ICAL from 'ical.js';

// The tools build/rewrite their document by hand, so the only way to assert the
// emitted bytes is to drive the real handlers with a stubbed DAV client.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const EVENT_URL = `${CALENDAR_URL}event.ics`;

const createCalendarObject = jest.fn(async () => ({ url: EVENT_URL, etag: '"1"' }));

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Work' }],
      createCalendarObject,
    }),
  },
}));

const { createEvent } = await import('../src/tools/calendar/create-event.js');
const { formatEvent } = await import('../src/formatters.js');

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


/** formatSuccess wraps its payload in a fenced JSON block inside the markdown. */
const payload = (result) =>
  JSON.parse(/```json\n([\s\S]*?)\n```/.exec(result.content[0].text)[1]);

beforeEach(() => {
  createCalendarObject.mockClear();
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

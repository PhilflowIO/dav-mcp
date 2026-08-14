import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { limitResults, DEFAULT_RESULT_LIMIT } from '../src/tools/shared/helpers.js';

const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/default/';

const fetchCalendarObjects = jest.fn();
const fetchVCards = jest.fn();

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Work' }],
      fetchCalendarObjects,
    }),
    getCardDavClient: () => ({
      fetchAddressBooks: async () => [{ url: ADDRESSBOOK_URL, displayName: 'Default' }],
      fetchVCards,
    }),
  },
}));

const { calendarQuery } = await import('../src/tools/calendar/calendar-query.js');
const { addressbookQuery } = await import('../src/tools/contacts/addressbook-query.js');

const event = (day, summary = 'Standup') => ({
  url: `${CALENDAR_URL}${day}.ics`,
  etag: '"1"',
  data: [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${day}@example.com`,
    `DTSTART:202605${String(day).padStart(2, '0')}T100000Z`,
    `DTEND:202605${String(day).padStart(2, '0')}T110000Z`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'),
});

const contact = (name) => ({
  url: `${ADDRESSBOOK_URL}${name}.vcf`,
  etag: '"1"',
  data: [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${name}@example.com`,
    `FN:${name}`,
    `EMAIL;TYPE=INTERNET:${name.toLowerCase()}@example.com`,
    'END:VCARD',
  ].join('\r\n'),
});

describe('limitResults', () => {
  test('returns everything when under the limit', () => {
    const items = [event(3), event(1), event(2)];
    const { items: result, total } = limitResults(items, 20, 'DTSTART');
    expect(total).toBe(3);
    expect(result).toHaveLength(3);
    // untouched, so no needless reordering of a set that fits
    expect(result).toBe(items);
  });

  test('sorts by date before truncating', () => {
    const { items, total } = limitResults([event(9), event(3), event(21), event(1)], 2, 'DTSTART');
    expect(total).toBe(4);
    expect(items.map(i => i.url)).toEqual([`${CALENDAR_URL}1.ics`, `${CALENDAR_URL}3.ics`]);
  });

  test('a DATE and a DATE-TIME sort against each other correctly', () => {
    const allDay = {
      url: `${CALENDAR_URL}allday.ics`,
      etag: '"1"',
      data: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260502\r\nEND:VEVENT\r\nEND:VCALENDAR',
    };
    const { items } = limitResults([event(9), allDay, event(21)], 2, 'DTSTART');
    expect(items.map(i => i.url)).toEqual([`${CALENDAR_URL}allday.ics`, `${CALENDAR_URL}9.ics`]);
  });

  test('objects missing the property sort last, not first', () => {
    const undated = { url: `${CALENDAR_URL}none.ics`, etag: '"1"', data: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:No date\r\nEND:VEVENT\r\nEND:VCALENDAR' };
    const { items } = limitResults([undated, event(9), event(3)], 2, 'DTSTART');
    expect(items.map(i => i.url)).toEqual([`${CALENDAR_URL}3.ics`, `${CALENDAR_URL}9.ics`]);
  });

  test('sorts text properties alphabetically, case-insensitively', () => {
    const { items } = limitResults(
      [contact('Zoe'), contact('ada'), contact('Bob')], 2, 'FN', 'text'
    );
    expect(items.map(i => i.url)).toEqual([`${ADDRESSBOOK_URL}ada.vcf`, `${ADDRESSBOOK_URL}Bob.vcf`]);
  });

  test('does not mutate the input', () => {
    const items = [event(9), event(3)];
    limitResults(items, 1, 'DTSTART');
    expect(items[0].url).toBe(`${CALENDAR_URL}9.ics`);
  });
});

describe('query tools cap their results', () => {
  beforeEach(() => {
    fetchCalendarObjects.mockReset();
    fetchVCards.mockReset();
  });

  const manyEvents = Array.from({ length: 40 }, (_, i) => event(i + 1));

  test('calendar_query defaults to a cap and says what was left out', async () => {
    fetchCalendarObjects.mockResolvedValue(manyEvents);
    const text = (await calendarQuery.handler({
      calendar_url: CALENDAR_URL,
      summary_filter: 'Standup',
    })).content[0].text;

    expect(text).toContain(`Found events: **${DEFAULT_RESULT_LIMIT}** of 40`);
    expect(text).toContain('narrow the query');
  });

  test('an explicit limit is honoured', async () => {
    fetchCalendarObjects.mockResolvedValue(manyEvents);
    const text = (await calendarQuery.handler({
      calendar_url: CALENDAR_URL,
      summary_filter: 'Standup',
      limit: 3,
    })).content[0].text;

    expect(text).toContain('Found events: **3** of 40');
  });

  test('a result set under the limit is not annotated', async () => {
    fetchCalendarObjects.mockResolvedValue([event(1), event(2)]);
    const text = (await calendarQuery.handler({
      calendar_url: CALENDAR_URL,
      summary_filter: 'Standup',
    })).content[0].text;

    expect(text).toContain('Found events: **2**');
    expect(text).not.toContain(' of ');
  });

  test('the capped set is the earliest, not an arbitrary slice', async () => {
    fetchCalendarObjects.mockResolvedValue([event(28), event(2), event(15)]);
    const text = (await calendarQuery.handler({
      calendar_url: CALENDAR_URL,
      summary_filter: 'Standup',
      limit: 1,
    })).content[0].text;

    expect(text).toContain('May 2, 2026');
    expect(text).not.toContain('May 28, 2026');
  });

  test('addressbook_query caps alphabetically', async () => {
    fetchVCards.mockResolvedValue([contact('Zoe'), contact('Ada'), contact('Bob')]);
    const text = (await addressbookQuery.handler({
      addressbook_url: ADDRESSBOOK_URL,
      email_filter: '@example.com',
      limit: 1,
    })).content[0].text;

    expect(text).toContain('Found contacts: **1** of 3');
  });

  test('limit is validated', async () => {
    fetchCalendarObjects.mockResolvedValue(manyEvents);
    await expect(calendarQuery.handler({
      calendar_url: CALENDAR_URL,
      summary_filter: 'Standup',
      limit: 0,
    })).rejects.toThrow(/limit/);
  });
});

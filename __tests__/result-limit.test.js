import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { limitResults, DEFAULT_RESULT_LIMIT } from '../src/tools/shared/helpers.js';
import ICAL from 'ical.js';
import { parseObjects, dateKey, textKey } from '../src/tools/shared/query-objects.js';
import { timezoneFor } from '../src/tools/shared/ical-dates.js';

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

// limitResults sorts what the query tools have parsed; these helpers do the
// same parse and key the tools do
const byStart = (objects, limit) => {
  const { items, total } = limitResults(
    parseObjects(objects, 'vevent'), limit, (p) => dateKey(p, 'dtstart')
  );
  return { urls: items.map(({ object }) => object.url), total };
};

const BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const berlinEvent = (name, localStart) => ({
  url: `${CALENDAR_URL}${name}.ics`,
  etag: '"1"',
  data: [
    'BEGIN:VCALENDAR', 'VERSION:2.0', ...BERLIN,
    'BEGIN:VEVENT', `UID:${name}@example.com`,
    `DTSTART;TZID=Europe/Berlin:${localStart}`, 'SUMMARY:Standup',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n'),
});

describe('limitResults', () => {
  test('returns everything when under the limit', () => {
    const items = [event(3), event(1), event(2)];
    const { items: result, total } = limitResults(items, 20, () => null);
    expect(total).toBe(3);
    expect(result).toHaveLength(3);
    // untouched, so no needless reordering of a set that fits
    expect(result).toBe(items);
  });

  test('sorts by date before truncating', () => {
    const { urls, total } = byStart([event(9), event(3), event(21), event(1)], 2);
    expect(total).toBe(4);
    expect(urls).toEqual([`${CALENDAR_URL}1.ics`, `${CALENDAR_URL}3.ics`]);
  });

  test('a DATE and a DATE-TIME sort against each other correctly', () => {
    const allDay = {
      url: `${CALENDAR_URL}allday.ics`,
      etag: '"1"',
      data: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260502\r\nEND:VEVENT\r\nEND:VCALENDAR',
    };
    const { urls } = byStart([event(9), allDay, event(21)], 2);
    expect(urls).toEqual([`${CALENDAR_URL}allday.ics`, `${CALENDAR_URL}9.ics`]);
  });

  test("the event's DTSTART is the key, not the VTIMEZONE's that comes first", () => {
    // every VTIMEZONE starts in 1970; a pattern over the raw text read that,
    // so all zoned events tied and the cap kept an arbitrary few
    const { urls } = byStart(
      [berlinEvent('late', '20260520T090000'), event(9), berlinEvent('early', '20260502T090000')], 2
    );
    expect(urls).toEqual([`${CALENDAR_URL}early.ics`, `${CALENDAR_URL}9.ics`]);
  });

  test('a TZID resolves to its instant before comparing', () => {
    // 10:30 in Berlin (CEST) is 08:30Z, before 09:00Z on the same day
    const utcNine = {
      url: `${CALENDAR_URL}utc.ics`,
      etag: '"1"',
      data: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260502T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
    };
    const { urls } = byStart([utcNine, berlinEvent('berlin', '20260502T103000')], 1);
    expect(urls).toEqual([`${CALENDAR_URL}berlin.ics`]);
  });

  test('objects missing the property, or not parsing, sort last', () => {
    const undated = { url: `${CALENDAR_URL}none.ics`, etag: '"1"', data: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:No date\r\nEND:VEVENT\r\nEND:VCALENDAR' };
    const broken = { url: `${CALENDAR_URL}broken.ics`, etag: '"1"', data: 'not ical' };
    const { urls } = byStart([undated, broken, event(9), event(3)], 2);
    expect(urls).toEqual([`${CALENDAR_URL}3.ics`, `${CALENDAR_URL}9.ics`]);
  });

  test('sorts text properties alphabetically, case-insensitively', () => {
    const { items } = limitResults(
      parseObjects([contact('Zoe'), contact('ada'), contact('Bob')], 'vcard'), 2, (p) => textKey(p, 'fn')
    );
    expect(items.map(({ object }) => object.url))
      .toEqual([`${ADDRESSBOOK_URL}ada.vcf`, `${ADDRESSBOOK_URL}Bob.vcf`]);
  });

  test('a folded FN sorts by its whole value', () => {
    const folded = {
      url: `${ADDRESSBOOK_URL}folded.vcf`,
      etag: '"1"',
      data: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Zz\r\n top\r\nEND:VCARD',
    };
    const { items } = limitResults(
      parseObjects([contact('Zzb'), folded], 'vcard'), 1, (p) => textKey(p, 'fn')
    );
    // "Zztop" > "Zzb"; the raw first line "Zz" sorted before it
    expect(items.map(({ object }) => object.url)).toEqual([`${ADDRESSBOOK_URL}Zzb.vcf`]);
  });

  test('does not mutate the input', () => {
    const items = [event(9), event(3)];
    limitResults(parseObjects(items, 'vevent'), 1, (p) => dateKey(p, 'dtstart'));
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

describe('timezones are built once per definition', () => {
  const vtimezoneOf = (object) =>
    new ICAL.Component(ICAL.parse(object.data)).getFirstSubcomponent('vtimezone');

  test('two objects with the same VTIMEZONE share one ICAL.Timezone', () => {
    const a = vtimezoneOf(berlinEvent('a', '20260502T090000'));
    const b = vtimezoneOf(berlinEvent('b', '20260601T090000'));
    expect(a).not.toBe(b);
    expect(timezoneFor(a)).toBe(timezoneFor(b));
  });

  test('a different definition under the same TZID gets its own zone', () => {
    const berlin = vtimezoneOf(berlinEvent('a', '20260502T090000'));
    const shifted = vtimezoneOf({
      data: berlinEvent('b', '20260502T090000').data.replaceAll('+0200', '+0300'),
    });
    expect(timezoneFor(shifted)).not.toBe(timezoneFor(berlin));
  });

  test('date-times in parsed objects resolve to the shared zone', () => {
    // ical.js would hydrate a fresh zone per object, recomputing its offset
    // changes since 1970 (~1 ms) each time a series is expanded or compared.
    // Timings are measured in the PR, not asserted: they depend on the host.
    const [a, b] = parseObjects([berlinEvent('a', '20260502T090000'), berlinEvent('b', '20260601T090000')], 'vevent');
    const zoneOf = (parsed) => parsed.main.getFirstPropertyValue('dtstart').zone;
    expect(zoneOf(a)).toBe(zoneOf(b));
    expect(zoneOf(a)).toBe(timezoneFor(a.root.getFirstSubcomponent('vtimezone')));
  });
});

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// Issue #109: ical.js reads a property's parameters in time that grows with
// the number of parameters times the length of the line, so one 1 MB line
// with 500 000 of them (`X-A;x;x;…:v`) took ~11-17 s and stalled the event
// loop. Every parse in dav-mcp — vCard and iCalendar — is bounded first:
// a stored object that is over the bound is skipped in a listing, and an
// edit of it is refused, both in well under a second.
const CALENDAR_URL = 'https://dav.example.com/calendars/user/main/';
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/default/';
connectTo('https://dav.example.com/');

let storedCards = [];
let storedEvents = [];
const updateVCard = jest.fn(async () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) }));
const updateCalendarObject = jest.fn(async () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) }));

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCalDavClient: () => ({
      fetchCalendars: async () => [{ url: CALENDAR_URL, displayName: 'Main' }],
      fetchCalendarObjects: async () => storedEvents,
      updateCalendarObject,
    }),
    getCardDavClient: () => ({
      fetchAddressBooks: async () => [{ url: ADDRESSBOOK_URL, displayName: 'Default' }],
      fetchVCards: async () => storedCards,
      updateVCard,
    }),
  },
}));

const { readVCard } = await import('../src/vcard.js');
const { parseICal, MAX_PARAMETERS } = await import('../src/ical-parse.js');
const { ValidationError } = await import('../src/error-handler.js');
const { listContacts } = await import('../src/tools/contacts/list-contacts.js');
const { addressbookQuery } = await import('../src/tools/contacts/addressbook-query.js');
const { updateContactFields } = await import('../src/tools/contacts/update-contact-fields.js');
const { listEvents } = await import('../src/tools/calendar/list-events.js');
const { calendarQuery } = await import('../src/tools/calendar/calendar-query.js');
const { updateEventFields } = await import('../src/tools/calendar/update-event-fields.js');

const vcard = (...lines) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join('\r\n');
const ics = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z',
  ...lines, 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

// the line from the issue: 1 MB, 500 000 parameters without a name
const HOSTILE_LINE = `X-A${';x'.repeat(500_000)}:v`;
// the same in iCalendar, where a parameter needs a name to be read as one
const HOSTILE_ICAL_LINE = `X-A${';X-P=x'.repeat(170_000)}:v`;

/** run fn, return [result or error, milliseconds] */
async function timed(fn) {
  const start = performance.now();
  let outcome;
  try {
    outcome = await fn();
  } catch (error) {
    outcome = error;
  }
  return [outcome, performance.now() - start];
}

let consoleError;
beforeEach(() => {
  updateVCard.mockClear();
  updateCalendarObject.mockClear();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe('the parameter bound', () => {
  test('the vCard from the issue is refused in well under a second, naming the property and the limit', async () => {
    const [error, ms] = await timed(() => readVCard(vcard('FN:Mallory', HOSTILE_LINE)));
    expect(ms).toBeLessThan(500);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain('X-A');
    expect(error.message).toContain(String(MAX_PARAMETERS));
    expect(error.details).toMatchObject({ code: 'TOO_MANY_PARAMETERS', property: 'X-A', limit: MAX_PARAMETERS });
  });

  test('the same shape in iCalendar is refused in well under a second', async () => {
    const [error, ms] = await timed(() => parseICal(ics('UID:hostile', HOSTILE_ICAL_LINE)));
    expect(ms).toBeLessThan(500);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toMatchObject({ property: 'X-A', limit: MAX_PARAMETERS });
  });

  test('a folded parameter list is counted across its lines', () => {
    const folded = `X-A${';X-P=x'.repeat(MAX_PARAMETERS + 1)}:v`.match(/.{1,74}/g).join('\r\n ');
    expect(() => parseICal(ics('UID:folded', folded))).toThrow(ValidationError);
  });

  test('exactly the limit is read', () => {
    const event = parseICal(ics('UID:limit', `X-A${';X-P=x'.repeat(MAX_PARAMETERS)}:v`));
    expect(Array.isArray(event)).toBe(true);
    const card = readVCard(vcard('FN:Limit', `X-A${';x'.repeat(MAX_PARAMETERS)}:v`));
    expect(card.getFirstPropertyValue('fn')).toBe('Limit');
  });

  test('semicolons in a value or in a quoted parameter value are no parameters', () => {
    const many = ';'.repeat(MAX_PARAMETERS * 2);
    const card = readVCard(vcard('FN:Values', `NOTE:${many}`, `X-A;X-P="${many}":v`, `N:${many}`));
    expect(card.getFirstPropertyValue('fn')).toBe('Values');
    expect(() => parseICal(ics('UID:values', `DESCRIPTION:${many}`, `X-A;X-P="${many}":v`))).not.toThrow();
  });

  test('a quote inside an unquoted parameter value does not hide the parameters after it', () => {
    // ical.js reads a quote only right after "="; anywhere else it is text
    const line = `X-A;X-P=a"b${';X-Q=x'.repeat(MAX_PARAMETERS + 1)}:v"`;
    expect(() => parseICal(ics('UID:quote', line))).toThrow(ValidationError);
  });

  // review of #133: the first guard copied ical.js's tokenizer and lost
  // track where the copy differs — a lone CR, a quoted multi-value going on
  // through `","` — and let 200 000 parameters through (6-8 s in ical.js)
  const PARAMS = ';X-P=1'.repeat(200_000);
  test.each([
    ['iCalendar, plain', () => parseICal(ics('UID:p', `ATTENDEE${PARAMS}:mailto:a@b`))],
    ['iCalendar, a lone CR before a quote', () => parseICal(ics('UID:cr', `ATTENDEE;A=\r"${PARAMS}:mailto:a@b`))],
    ['iCalendar, a quoted multi-value going on through ","', () => parseICal(ics('UID:m', `ATTENDEE;MEMBER="mailto:a","b:c"${PARAMS}:mailto:a@b`))],
    ['vCard, a quoted multi-value going on through ","', () => readVCard(vcard('FN:T', `TEL;TYPE="cell","b:c"${PARAMS}:123`))],
    ['vCard, a lone CR before a quote', () => readVCard(vcard('FN:C', `TEL;A=\r"${PARAMS}:123`))],
  ])('%s is refused in well under a second', async (_, read) => {
    const [error, ms] = await timed(read);
    expect(ms).toBeLessThan(500);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toMatchObject({ code: 'TOO_MANY_PARAMETERS' });
  });

  test('a large real card is read: many typed numbers and addresses, a 1 MB photo', async () => {
    const photo = 'QUJD'.repeat(262_144).match(/.{1,74}/g).join('\r\n ');
    const lines = ['FN:Big Card', 'N:Card;Big;;;'];
    for (let i = 0; i < 200; i++) {
      lines.push(`item${i}.TEL;TYPE=CELL;TYPE=VOICE;TYPE=pref;TYPE=HOME:+49 30 ${100000 + i}`);
      lines.push(`EMAIL;TYPE=INTERNET;TYPE=WORK;TYPE=pref;X-LABEL=Work ${i}:user${i}@example.com`);
    }
    lines.push(`PHOTO;ENCODING=b;TYPE=JPEG:${photo}`);
    const [card, ms] = await timed(() => readVCard(vcard(...lines)));
    expect(card).not.toBeInstanceOf(Error);
    expect(card.getAllProperties('tel')).toHaveLength(200);
    expect(ms).toBeLessThan(1000);
  });
});

describe('a stored object over the bound', () => {
  const goodCard = { url: `${ADDRESSBOOK_URL}good.vcf`, etag: '"1"', data: vcard('UID:good', 'FN:Alice Good') };
  const hostileCard = { url: `${ADDRESSBOOK_URL}hostile.vcf`, etag: '"1"', data: vcard('UID:hostile', 'FN:Mallory', HOSTILE_LINE) };
  const goodEvent = { url: `${CALENDAR_URL}good.ics`, etag: '"1"', data: ics('UID:good', 'SUMMARY:Standup') };
  const hostileEvent = { url: `${CALENDAR_URL}hostile.ics`, etag: '"1"', data: ics('UID:hostile', 'SUMMARY:Mallory', HOSTILE_ICAL_LINE) };

  test('list_contacts lists the other cards and skips that one fast', async () => {
    storedCards = [hostileCard, goodCard];
    const [result, ms] = await timed(() => listContacts.handler({ addressbook_url: ADDRESSBOOK_URL }));
    expect(ms).toBeLessThan(1000);
    expect(result.content[0].text).toContain('Alice Good');
  });

  test('addressbook_query filters past it fast', async () => {
    storedCards = [hostileCard, goodCard];
    const [result, ms] = await timed(() => addressbookQuery.handler({ addressbook_url: ADDRESSBOOK_URL, name_filter: 'a' }));
    expect(ms).toBeLessThan(1000);
    expect(result.content[0].text).toContain('Alice Good');
  });

  test('update_contact refuses to edit it, says why, and writes nothing', async () => {
    storedCards = [hostileCard];
    const [error, ms] = await timed(() => updateContactFields.handler({
      vcard_url: hostileCard.url, vcard_etag: '"1"', fields: { FN: 'Renamed' },
    }));
    expect(ms).toBeLessThan(500);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain('X-A');
    expect(updateVCard).not.toHaveBeenCalled();
  });

  test('list_events and calendar_query list the other events fast', async () => {
    storedEvents = [hostileEvent, goodEvent];
    for (const run of [
      () => listEvents.handler({ calendar_url: CALENDAR_URL }),
      () => calendarQuery.handler({ calendar_url: CALENDAR_URL, summary_filter: 'Standup' }),
    ]) {
      const [result, ms] = await timed(run);
      expect(ms).toBeLessThan(1000);
      expect(result.content[0].text).toContain('Standup');
    }
  });

  test('update_event refuses to edit it and writes nothing', async () => {
    storedEvents = [hostileEvent];
    for (const args of [{ fields: { SUMMARY: 'Renamed' } }, { cancel_occurrences: ['2026-01-05'] }]) {
      const [error, ms] = await timed(() => updateEventFields.handler({
        event_url: hostileEvent.url, event_etag: '"1"', ...args,
      }));
      expect(ms).toBeLessThan(500);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.details).toMatchObject({ code: 'TOO_MANY_PARAMETERS' });
    }
    expect(updateCalendarObject).not.toHaveBeenCalled();
  });
});

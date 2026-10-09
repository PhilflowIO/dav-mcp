import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// Faults that are not the caller's carry their own type, now that nothing is
// guessed from a message (#115): a server that answers a multi-get with
// something other than a multistatus, or reports no calendar home, is a
// CalDAV/CardDAV error; an object dav-mcp cannot read back after writing it
// is an internal error.

connectTo('https://dav.example.com/');
const CALENDAR_URL = 'https://dav.example.com/calendars/user/work/';
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/contacts/';

const caldav = { davRequest: jest.fn(), fetchCalendars: jest.fn(), account: {} };
const carddav = { davRequest: jest.fn(), fetchAddressBooks: async () => [{ url: ADDRESSBOOK_URL }] };
jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCalDavClient: () => caldav, getCardDavClient: () => carddav },
}));

// The library returns text ical.js cannot read back.
let writeResult = null;
const realUtils = await import('tsdav-utils');
jest.unstable_mockModule('tsdav-utils', () => ({
  ...realUtils,
  updateFields: (...args) => writeResult ?? realUtils.updateFields(...args),
}));

const { tools } = await import('../src/tools/index.js');
const { writeEventFields } = await import('../src/tools/shared/ical-dates.js');
const { formatMCPError, MCP_ERROR_CODES } = await import('../src/error-handler.js');

const tool = (name) => tools.find(t => t.name === name);
const failure = (promise) => promise.then(() => { throw new Error('did not fail'); }, e => e);

beforeEach(() => {
  caldav.davRequest.mockReset();
  carddav.davRequest.mockReset();
  caldav.fetchCalendars.mockReset();
  caldav.account = {};
  writeResult = null;
});

describe('a multi-get answered without a multistatus', () => {
  const notMultistatus = [{ ok: true, status: 200, statusText: 'OK', raw: '<html></html>', href: CALENDAR_URL }];

  test('calendar_multi_get: a CalDAV error', async () => {
    caldav.fetchCalendars.mockResolvedValue([{ url: CALENDAR_URL }]);
    caldav.davRequest.mockResolvedValue(notMultistatus);
    const error = await failure(tool('calendar_multi_get').handler({
      calendar_url: CALENDAR_URL, event_urls: [`${CALENDAR_URL}a.ics`],
    }));
    expect(error.name).toBe('CalDAVError');
    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.CALDAV_ERROR);
  });

  test('addressbook_multi_get: a CardDAV error', async () => {
    carddav.davRequest.mockResolvedValue(notMultistatus);
    const error = await failure(tool('addressbook_multi_get').handler({
      addressbook_url: ADDRESSBOOK_URL, contact_urls: [`${ADDRESSBOOK_URL}a.vcf`],
    }));
    expect(error.name).toBe('CardDAVError');
    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.CARDDAV_ERROR);
  });
});

test('make_calendar on a server that reports no calendar home and no calendars: a CalDAV error', async () => {
  caldav.fetchCalendars.mockResolvedValue([]);
  const error = await failure(tool('make_calendar').handler({ display_name: 'Work' }));
  expect(error.name).toBe('CalDAVError');
  expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.CALDAV_ERROR);
});

test('an object dav-mcp cannot read back after writing it: an internal error, not the caller\'s', () => {
  writeResult = 'BEGIN:VCALENDAR\r\nthis is not iCalendar';
  const event = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261001T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  let error;
  try {
    writeEventFields({ data: event }, {}, { startDate: '20261001T090000Z', endDate: '20261001T100000Z' });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(error.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  expect(error.cause).toBeDefined();
});

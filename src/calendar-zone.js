import ICAL from 'ical.js';
import { generateVtimezone, resolveZone, isUpdateFieldsError } from 'tsdav-utils';
import { ValidationError, CalDAVError } from './error-handler.js';
import { parseICal, unreadableReason } from './ical-parse.js';

/**
 * A calendar's time zone: the CALDAV:calendar-timezone property (RFC 4791
 * 5.2.2).
 *
 * The property is an iCalendar object holding exactly one VTIMEZONE, not a
 * TZID. dav-mcp wrote a bare "Europe/Berlin" there until 5.0.0 (#78), and
 * Nextcloud keeps whatever it is given, so both forms are read; only the
 * VCALENDAR is written.
 */

/**
 * The years a VTIMEZONE written to a calendar covers: from 1970 — the IANA
 * time zone database only vouches for its data since then, and older events
 * are rare — up to this year; tsdav-utils carries the zone's current rule on
 * into every later year. Berlin, New York and Moscow take 1-2 KB this way.
 */
const VTIMEZONE_FROM = 1970;

/**
 * The CALDAV:calendar-timezone value for an IANA zone name: a VCALENDAR with
 * the zone's VTIMEZONE, for MKCALENDAR and PROPPATCH.
 *
 * A zone that was on local mean time after 1970 (Africa/Monrovia until
 * 1972) has offsets in seconds before then, which iCalendar cannot express;
 * its VTIMEZONE starts at the first year tsdav-utils can write, so every
 * zone Intl knows can be set.
 *
 * @param {string} name - an IANA zone ("Europe/Berlin"); case-insensitive
 * @returns {{tzid: string, text: string}} tzid spelled as IANA does
 * @throws {ValidationError} for a name that is no IANA zone ("CEST", "+02:00")
 */
export function calendarTimezoneValue(name) {
  const tzid = ianaZoneName(name);
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dav-mcp//EN',
    'CALSCALE:GREGORIAN',
    vtimezoneFor(tzid, name),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  return { tzid, text };
}

function vtimezoneFor(tzid, name) {
  const to = new Date().getUTCFullYear();
  for (let from = VTIMEZONE_FROM; from <= to; from++) {
    try {
      return generateVtimezone(tzid, { from, to });
    } catch (error) {
      if (isUpdateFieldsError(error, 'UNSUPPORTED_VTIMEZONE')) continue;
      if (isUpdateFieldsError(error, 'UNKNOWN_TZID')) throw invalidZone(name);
      throw error;
    }
  }
  throw invalidZone(name);
}

const invalidZone = (name) => new ValidationError(
  `Invalid timezone "${name}": expected an IANA time zone name such as "Europe/Berlin", ` +
  '"America/New_York" or "UTC"'
);

/**
 * The IANA name of a zone, as IANA spells it; a ValidationError naming what
 * is expected otherwise. A name has to be one Intl knows: offsets ("+02:00")
 * and abbreviations ("CEST") are refused, since a calendar zone is a place
 * with rules, not an offset.
 */
function ianaZoneName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || /^[+-]/.test(trimmed)) throw invalidZone(name);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw invalidZone(name);
  }
  let zone;
  try {
    zone = resolveZone(trimmed);
  } catch (error) {
    if (isUpdateFieldsError(error)) throw invalidZone(name);
    throw error;
  }
  if (!zone) throw invalidZone(name);
  return zone.tzid;
}

/**
 * The longest calendar-timezone value read. A VTIMEZONE is a few KB (the one
 * dav-mcp writes for Moscow since 1970: 2 KB; Outlook's: under 1 KB); the
 * value is read for every calendar on every call, and parsing 4.5 MB of
 * RDATE lines took 4.5 s.
 */
export const MAX_TIMEZONE_LENGTH = 64 * 1024;

/**
 * The text of a calendar-timezone property as tsdav hands it over: a string,
 * or a CDATA or text node ({ _cdata } / { _text }) — tsdav up to 2.4 keeps
 * the property in `timezone` only when it is a plain string.
 */
export function timezoneText(value) {
  if (typeof value === 'string') return value;
  const text = value?._cdata ?? value?._text;
  return typeof text === 'string' ? text : '';
}

/**
 * A calendar's calendar-timezone property, whatever form tsdav handed it in:
 * the raw property (projectedProps, which src/tsdav-client.js asks for on
 * every fetchCalendars) before the parsed `timezone`. The one way dav-mcp
 * reads a calendar's zone.
 *
 * @param {{timezone?: unknown, projectedProps?: Object}|null|undefined} calendar
 * @returns {string}
 */
export function calendarTimezoneOf(calendar) {
  return timezoneText(calendar?.projectedProps?.calendarTimezone) || timezoneText(calendar?.timezone);
}

const readCache = new Map();
const MAX_CACHED_READS = 64;

/**
 * What a calendar-timezone property says, cached by its text:
 *  - { status: 'none' }: empty — the calendar has no zone of its own;
 *  - { status: 'zone', tzid, vtimezone }: the VCALENDAR the RFC asks for,
 *    with its VTIMEZONE (null when it holds no rules, which says nothing a
 *    reader can use), or a bare TZID as dav-mcp wrote it before 5.0.0;
 *  - { status: 'unreadable', reason }: too long (MAX_TIMEZONE_LENGTH),
 *    refused by the parse guard (src/ical-parse.js), not iCalendar, or no
 *    VTIMEZONE with a TZID.
 *
 * @param {unknown} value - the property: text, or a CDATA/text node
 */
export function readTimezoneProperty(value) {
  const text = timezoneText(value).trim();
  if (!text) return NONE;
  if (readCache.has(text)) return readCache.get(text);
  const read = parseTimezoneProperty(text);
  if (readCache.size >= MAX_CACHED_READS) readCache.clear();
  readCache.set(text, read);
  return read;
}

const NONE = Object.freeze({ status: 'none' });
const unreadable = (reason) => ({ status: 'unreadable', reason });

function parseTimezoneProperty(text) {
  if (text.length > MAX_TIMEZONE_LENGTH) {
    return unreadable(`its value is larger than ${MAX_TIMEZONE_LENGTH / 1024} KB`);
  }
  if (!/^BEGIN:/i.test(text)) {
    // a bare TZID: one short line
    return !/[\r\n]/.test(text) && text.length <= 100
      ? { status: 'zone', tzid: text, vtimezone: null }
      : unreadable('it is neither iCalendar nor a time zone name');
  }
  let root;
  try {
    const jcal = parseICal(/^BEGIN:VCALENDAR/i.test(text) ? text : `BEGIN:VCALENDAR\r\n${text}\r\nEND:VCALENDAR`);
    root = new ICAL.Component(Array.isArray(jcal[0]) ? jcal[0] : jcal);
  } catch (error) {
    return unreadable(unreadableReason(error, 'iCalendar'));
  }
  const vtimezone = root.name === 'vtimezone' ? root : root.getFirstSubcomponent('vtimezone');
  const tzid = vtimezone?.getFirstPropertyValue('tzid');
  if (!tzid) return unreadable('it holds no VTIMEZONE with a TZID');
  const rules = vtimezone.getAllSubcomponents().some((c) => c.name === 'standard' || c.name === 'daylight');
  return { status: 'zone', tzid: String(tzid), vtimezone: rules ? vtimezone : null };
}

/**
 * The TZID a calendar-timezone property names, for display; null when it
 * has none or cannot be read.
 *
 * @param {unknown} value - the property: text, or a CDATA/text node
 * @returns {{tzid: string, vtimezone: ICAL.Component|null}|null}
 */
export function readCalendarTimezone(value) {
  const read = readTimezoneProperty(value);
  return read.status === 'zone' ? { tzid: read.tzid, vtimezone: read.vtimezone } : null;
}

// ---------------------------------------------------------------------------
// The zone floating values are read in

/**
 * RFC 5545 3.3.5 leaves a floating time (no TZID, no Z) and a date to the
 * reader; RFC 4791 9.9 reads them in the calendar collection's
 * calendar-timezone. dav-mcp read them on the clock of the machine it runs
 * on, which only coincides with the calendar for a local install: a server
 * in UTC placed a 09:00 Berlin event at 09:00 UTC (#117). Now:
 *
 *  1. the calendar's calendar-timezone, by its VTIMEZONE where it has one,
 *     else by the IANA zone of its name;
 *  2. the zone dav-mcp runs in — the TZ environment variable, else the
 *     system's — which is the server setting there is;
 *  3. UTC, should the runtime name no zone at all.
 *
 * A zone here is { tzid, source: 'calendar'|'server', converter, intlName }:
 * converter is tsdav-utils' (RFC 5545 3.3.5 at DST changes: a time shown
 * twice is its first pass, one skipped is read with the offset before),
 * intlName the name to hand Intl for display, or null when Intl does not
 * know it (a VTIMEZONE named "W. Europe Standard Time").
 *
 * Calendar objects carry their zone from the tool that fetched them
 * (withFloatingZone) to the parsed VCALENDAR (setFloatingZone), where every
 * reader of a value finds it (floatingZoneOf). A value nobody tagged is read
 * in the server's zone, as before.
 */

const zoneCache = new Map();
const MAX_CACHED_ZONES = 64;

function makeZone(tzid, vtimezone, source) {
  const key = `${source}\n${tzid}\n${vtimezone ? vtimezone.toString() : ''}`;
  if (zoneCache.has(key)) return zoneCache.get(key);
  let converter = null;
  if (vtimezone) {
    try {
      converter = resolveZone(tzid, vtimezone);
      // a VTIMEZONE whose rules cannot be read throws on first use
      converter?.offsetAt(new Date());
    } catch {
      converter = null;
    }
  }
  if (!converter) {
    try {
      converter = resolveZone(tzid);
    } catch {
      converter = null;
    }
  }
  const zone = converter
    ? { tzid: converter.tzid ?? tzid, source, converter, intlName: intlName(converter.tzid ?? tzid) }
    : null;
  if (zoneCache.size >= MAX_CACHED_ZONES) zoneCache.clear();
  zoneCache.set(key, zone);
  return zone;
}

function intlName(tzid) {
  if (!tzid || /^[+-]/.test(tzid)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return tzid;
  } catch {
    return null;
  }
}

/**
 * The zone dav-mcp runs in (TZ, else the system's), else UTC. Asked of Intl
 * once per value of TZ: building a DateTimeFormat costs more than the
 * conversions it serves.
 */
let server = { env: undefined, zone: null };
export function serverZone() {
  const env = process.env.TZ;
  if (!server.zone || server.env !== env) {
    const tzid = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    server = { env, zone: makeZone(tzid, null, 'server') ?? makeZone('UTC', null, 'server') };
  }
  return server.zone;
}

/**
 * The calendar's own zone, from its calendar-timezone (calendarTimezoneOf);
 * null when it has none dav-mcp can read.
 *
 * @param {{timezone?: unknown, projectedProps?: Object}|null|undefined} calendar
 */
export function calendarZone(calendar) {
  const zone = floatingZoneFor(calendar);
  return zone.source === 'calendar' ? zone : null;
}

/**
 * The zone floating values of a calendar are read in: its own, else the
 * server's. When the calendar has a zone that cannot be read, the server's
 * zone carries `failure` (why): a read goes ahead and says so
 * (zoneFailureNote), a write refuses (writableZone).
 *
 * @param {{timezone?: unknown, projectedProps?: Object, url?: string}|null|undefined} calendar
 */
export function floatingZoneFor(calendar) {
  const read = readTimezoneProperty(calendarTimezoneOf(calendar));
  if (read.status === 'none') return serverZone();
  if (read.status === 'unreadable') return failedZone(calendar?.url, `its calendar-timezone cannot be read: ${read.reason}`);
  return makeZone(read.tzid, read.vtimezone, 'calendar')
    ?? failedZone(calendar?.url, `"${read.tzid}" is not a time zone dav-mcp knows`);
}

/** The server's zone, standing in for a calendar's that could not be read */
function failedZone(calendarUrl, failure) {
  return { ...serverZone(), failure, calendarUrl: calendarUrl ?? null };
}

/**
 * floatingZoneFor a calendar known only by its URL: one PROPFIND (Depth 0)
 * for its calendar-timezone. A calendar without the property (or a 404) has
 * no zone of its own: the server's applies. A request that fails — no
 * answer, an error status — is a failure, as for an unreadable value.
 *
 * @param {Object} client - tsdav DAVClient
 * @param {string} calendarUrl
 */
export async function fetchFloatingZone(client, calendarUrl) {
  let responses;
  try {
    responses = await client.propfind({
      url: calendarUrl,
      props: { 'c:calendar-timezone': {} },
      depth: '0',
    });
  } catch (error) {
    return failedZone(calendarUrl, `the request for it failed: ${error?.message || error}`);
  }
  const list = Array.isArray(responses) ? responses : [];
  const answer = list.find((r) => r?.ok !== false) ?? null;
  if (!answer) {
    const failed = list.find((r) => typeof r?.status === 'number');
    if (!failed || failed.status === 404) return serverZone();
    return failedZone(calendarUrl, `the server answered ${failed.status}${failed.statusText ? ` ${failed.statusText}` : ''}`);
  }
  return floatingZoneFor({ url: calendarUrl, timezone: answer.props?.calendarTimezone });
}

/**
 * The zone a write may place times in. A calendar whose zone could not be
 * read must not have a time placed on dav-mcp's clock instead: a start with
 * Z on a floating series, or a time without a zone, would land shifted by
 * the difference, unsaid.
 *
 * @param {Object} zone - floatingZoneFor / fetchFloatingZone
 * @returns {Object} the zone
 * @throws {CalDAVError} when it stands in for one that could not be read
 */
export function writableZone(zone) {
  if (!zone?.failure) return zone;
  throw new CalDAVError(
    `The time zone of the calendar ${zone.calendarUrl ?? ''} could not be read (${zone.failure}), ` +
    'so nothing was written: a time without a zone, or one for an event stored without a zone, ' +
    `would have been placed on dav-mcp's clock (${zone.tzid}) instead. Retry; if it persists, set the ` +
    'calendar\'s time zone with update_calendar.',
    { calendarUrl: zone.calendarUrl, reason: zone.failure },
  );
}

/**
 * What a read says about zones that could not be read, or '' when none.
 *
 * @param {Iterable<Object>} zones
 * @returns {string}
 */
export function zoneFailureNote(zones) {
  const byCalendar = new Map();
  for (const zone of zones) {
    if (zone?.failure) byCalendar.set(`${zone.calendarUrl}\n${zone.failure}`, zone);
  }
  const failed = [...byCalendar.values()];
  if (failed.length === 0) return '';
  return failed.map((zone) =>
    `\n\n**Note**: the time zone of the calendar ${zone.calendarUrl ?? ''} could not be read (${zone.failure}); ` +
    `times without a zone and all-day dates in it are read in ${zone.tzid}, the zone dav-mcp runs in.`).join('');
}

/**
 * A tool result with zoneFailureNote added to its text.
 *
 * @param {{content: Array<{type: string, text: string}>}} result
 * @param {Iterable<Object>} zones
 */
export function withZoneNote(result, zones) {
  const note = zoneFailureNote(zones);
  if (!note) return result;
  const [first, ...rest] = result.content;
  return { ...result, content: [{ ...first, text: first.text + note }, ...rest] };
}

/**
 * The zone to show times of several calendars in at once (free/busy): the
 * one every calendar that sets a zone agrees on; else dav-mcp's, with why.
 * Calendars without a zone of their own express no preference.
 *
 * @param {Array<{timezone?: unknown, displayName?: unknown, url: string}>} calendars
 * @returns {{zone: Object, why: string}} why: whose zone it is, for the answer
 */
export function displayZoneFor(calendars) {
  const own = calendars
    .map((calendar) => ({ calendar, zone: calendarZone(calendar) }))
    .filter(({ zone }) => zone);
  const names = [...new Set(own.map(({ zone }) => zone.tzid))];
  if (names.length === 1) {
    return { zone: own[0].zone, why: calendars.length === 1 ? 'the calendar\'s' : 'the calendars\'' };
  }
  if (names.length === 0) {
    return { zone: serverZone(), why: `dav-mcp's; the ${calendars.length === 1 ? 'calendar sets' : 'calendars set'} none` };
  }
  const list = own.map(({ calendar, zone }) => `${nameOf(calendar)} ${zone.tzid}`).join(', ');
  return { zone: serverZone(), why: `dav-mcp's; the calendars set different ones: ${list}` };
}

function nameOf(calendar) {
  const name = calendar.displayName;
  if (typeof name === 'string' && name) return name;
  const text = name?._cdata ?? name?._text;
  return typeof text === 'string' && text ? text : calendar.url;
}

const objectZones = new WeakMap();
const rootZones = new WeakMap();

/**
 * Tag fetched calendar objects with the zone their calendar reads floating
 * values in.
 *
 * @template T
 * @param {T[]} objects - as tsdav returns them ({ url, etag, data })
 * @param {Object} zone - floatingZoneFor / fetchFloatingZone
 * @returns {T[]} the same array
 */
export function withFloatingZone(objects, zone) {
  for (const object of objects ?? []) {
    if (object && typeof object === 'object' && zone) objectZones.set(object, zone);
  }
  return objects;
}

/** The zone a fetched object was tagged with, or null */
export function objectFloatingZone(object) {
  return (object && typeof object === 'object' && objectZones.get(object)) || null;
}

/**
 * Give a parsed VCALENDAR the zone its floating values are read in.
 *
 * @param {ICAL.Component} root
 * @param {Object|null} zone - none: the server's
 * @returns {ICAL.Component} root
 */
export function setFloatingZone(root, zone) {
  if (root && zone) rootZones.set(root, zone);
  return root;
}

/**
 * The zone floating values of a component or property are read in: its
 * VCALENDAR's (setFloatingZone), else the server's.
 *
 * @param {ICAL.Component|ICAL.Property|null|undefined} node
 */
export function floatingZoneOf(node) {
  let root = node;
  while (root?.parent) root = root.parent;
  return (root && rootZones.get(root)) || serverZone();
}

/**
 * The instant of a wall-clock time in a zone. `wall` is the wall clock as ms
 * of its digits read as UTC (Date.UTC of its fields), the form occurrences.js
 * computes in.
 *
 * @param {Object} zone
 * @param {number} wall
 * @returns {number} ms since the epoch
 */
export function zoneInstant(zone, wall) {
  return zone.converter.toInstant(new Date(wall).toISOString().slice(0, 19)).getTime();
}

/**
 * The wall clock of an instant in a zone, as ms of its digits read as UTC.
 *
 * @param {Object} zone
 * @param {number} instant - ms since the epoch
 * @returns {number}
 */
export function zoneWall(zone, instant) {
  const [y, mo, d, h = 0, mi = 0, s = 0] = zone.converter.toWallTime(new Date(instant)).match(/\d+/g).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

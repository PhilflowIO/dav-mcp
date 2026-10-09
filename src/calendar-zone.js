import ICAL from 'ical.js';
import { generateVtimezone, resolveZone, isUpdateFieldsError } from 'tsdav-utils';
import { ValidationError } from './error-handler.js';

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
 * @param {string} name - an IANA zone ("Europe/Berlin"); case-insensitive
 * @returns {{tzid: string, text: string}} tzid spelled as IANA does
 * @throws {ValidationError} for a name that is no IANA zone ("CEST", "+02:00")
 */
export function calendarTimezoneValue(name) {
  const tzid = ianaZoneName(name);
  const vtimezone = generateVtimezone(tzid, { from: VTIMEZONE_FROM, to: new Date().getUTCFullYear() });
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dav-mcp//EN',
    'CALSCALE:GREGORIAN',
    vtimezone,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  return { tzid, text };
}

/**
 * The IANA name of a zone, as IANA spells it; a ValidationError naming what
 * is expected otherwise. A name has to be one Intl knows and tsdav-utils can
 * build a VTIMEZONE for: offsets ("+02:00") and abbreviations ("CEST") are
 * refused, since a calendar zone is a place with rules, not an offset.
 */
function ianaZoneName(name) {
  const refuse = () => new ValidationError(
    `Invalid timezone "${name}": expected an IANA time zone name such as "Europe/Berlin", ` +
    '"America/New_York" or "UTC"'
  );
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || /^[+-]/.test(trimmed)) throw refuse();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw refuse();
  }
  let zone;
  try {
    zone = resolveZone(trimmed);
  } catch (error) {
    if (isUpdateFieldsError(error)) throw refuse();
    throw error;
  }
  if (!zone) throw refuse();
  try {
    generateVtimezone(zone.tzid, { from: VTIMEZONE_FROM });
  } catch (error) {
    if (isUpdateFieldsError(error, 'UNKNOWN_TZID')) throw refuse();
    throw error;
  }
  return zone.tzid;
}

/**
 * What a calendar's CALDAV:calendar-timezone property says: its TZID and,
 * when it is the VCALENDAR the RFC asks for, the VTIMEZONE defining it. A
 * bare TZID (written by dav-mcp before 5.0.0, kept by Nextcloud) is read as
 * that name. null when the property is empty or holds neither.
 *
 * @param {unknown} value - the property's text, as tsdav's fetchCalendars gives it
 * @returns {{tzid: string, vtimezone: ICAL.Component|null}|null}
 */
export function readCalendarTimezone(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (/^BEGIN:/i.test(text)) {
    try {
      const jcal = ICAL.parse(/^BEGIN:VCALENDAR/i.test(text) ? text : `BEGIN:VCALENDAR\r\n${text}\r\nEND:VCALENDAR`);
      const root = new ICAL.Component(Array.isArray(jcal[0]) ? jcal[0] : jcal);
      const vtimezone = root.name === 'vtimezone' ? root : root.getFirstSubcomponent('vtimezone');
      const tzid = vtimezone?.getFirstPropertyValue('tzid');
      return tzid ? { tzid: String(tzid), vtimezone } : null;
    } catch {
      return null;
    }
  }
  // a bare TZID: one short line
  return !/[\r\n]/.test(text) && text.length <= 100 ? { tzid: text, vtimezone: null } : null;
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
 * The calendar's own zone, from its calendar-timezone (tsdav's
 * fetchCalendars gives it as `timezone`); null when it has none dav-mcp can
 * read.
 *
 * @param {{timezone?: unknown}|null|undefined} calendar
 */
export function calendarZone(calendar) {
  const read = readCalendarTimezone(calendar?.timezone);
  return read ? makeZone(read.tzid, read.vtimezone, 'calendar') : null;
}

/** The zone floating values of a calendar are read in: its own, else the server's */
export function floatingZoneFor(calendar) {
  return calendarZone(calendar) ?? serverZone();
}

/**
 * floatingZoneFor a calendar known only by its URL: one PROPFIND (Depth 0)
 * for its calendar-timezone. A calendar the server will not describe is read
 * in the server's zone, as one without a zone is: the tool asked about its
 * objects, not about this property.
 *
 * @param {Object} client - tsdav DAVClient
 * @param {string} calendarUrl
 */
export async function fetchFloatingZone(client, calendarUrl) {
  try {
    const responses = await client.propfind({
      url: calendarUrl,
      props: { 'c:calendar-timezone': {} },
      depth: '0',
    });
    const response = (Array.isArray(responses) ? responses : []).find((r) => r?.ok !== false) ?? null;
    return floatingZoneFor({ timezone: davText(response?.props?.calendarTimezone) });
  } catch {
    return serverZone();
  }
}

function davText(value) {
  if (typeof value === 'string') return value;
  const text = value?._cdata ?? value?._text;
  return typeof text === 'string' ? text : '';
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

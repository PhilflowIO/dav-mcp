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

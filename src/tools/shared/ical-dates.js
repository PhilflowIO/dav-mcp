import ICAL from 'ical.js';
import { parseICal, assertParseBounded } from '../../ical-parse.js';
import { updateFields, seriesMaster, resolveZone, parseDateValue } from 'tsdav-utils';
import { serverZone, floatingZoneOf, zoneInstant, zoneWall } from '../../calendar-zone.js';
import { explainWriteRefusal } from '../../ical-components.js';
import { ValidationError } from '../../error-handler.js';

/**
 * Every property dav-mcp writes onto a calendar object or vCard goes through
 * writeFields — the create tools as much as the update tools.
 *
 * Encoding is tsdav-utils' job: a bare date becomes VALUE=DATE, a date-time
 * drops a VALUE=DATE left over from the old value. What a date-time means is
 * decided here, by the form the object's start (its master's DTSTART, a
 * todo's DUE without one) already has, with `zone` the calendar's (see
 * src/calendar-zone.js; RFC 4791 9.9):
 *
 *  - A start with a TZID: a date-time with Z or an offset is written as its
 *    wall-clock time in that zone ('keep-zone'), one without a zone is read
 *    there. A model that moves a weekly 09:00 Europe/Berlin series with
 *    "2026-10-06T08:00:00Z" means 10:00 in Berlin every week; written as UTC,
 *    the series would sit an hour earlier after the DST change.
 *  - A floating start (no TZID, no Z): the object stays floating (#128). A
 *    date-time without a zone is written as it is; one with Z or an offset
 *    becomes its wall-clock time in the calendar's zone — the zone the
 *    listings show the object in — and is written without a zone too. Written
 *    as UTC, the series would no longer be floating, and its floating
 *    overrides and exclusions would sit off by the offset.
 *  - Otherwise (a UTC or all-day start, a new object): a date-time without a
 *    zone is read in the calendar's zone and written as UTC, as create_event
 *    has always done — on the calendar's clock now, not the host's (#117).
 *
 * The same holds for an RRULE UNTIL. COMPLETED, DTSTAMP, CREATED and
 * LAST-MODIFIED are UTC by definition (RFC 5545 3.8.2.1, 3.8.7): one given
 * without a zone is read in the calendar's zone.
 *
 * A calendar object may hold more than one component type — a VEVENT next to
 * a VTODO. Left to choose, tsdav-utils takes the VEVENT first, so the todo
 * tools name 'vtodo' and the event tools 'vevent'; an object without that
 * component is refused by the library ("No VTODO found in VCALENDAR (it holds:
 * VEVENT)"). A vCard has no component type, so the contact tools pass none,
 * and its dates are written as before.
 *
 * What the library refuses — a value it cannot read, a series move the rule
 * cannot follow, a RECURRENCE-ID on the master, no component of the type — is
 * the caller's input meeting this object, not a fault: it comes back as a
 * ValidationError that says how to fix it with these tools
 * (explainWriteRefusal).
 *
 * @param {string|{data: string}} object - calendar object or vCard
 * @param {Record<string, string>} fields - bare property name -> value
 * @param {'vevent'|'vtodo'} [type] - the component to write into
 * @param {Object} [zone] - the calendar's zone (floatingZoneFor /
 *   fetchFloatingZone); the server's when not given
 * @returns {string} the rewritten object
 * @throws {ValidationError} TOO_MANY_PARAMETERS for an object dav-mcp does
 *   not parse (assertParseBounded), before the library sees it
 */
export function writeFields(object, fields, type, zone = null) {
  // updateFields parses the object with ical.js too; see ical-parse.js
  assertParseBounded(object);
  let options = { floatingTime: 'local', absoluteTime: 'keep-zone', type };
  let values = fields;
  if (type) {
    const { frame, ownZone } = startFrame(object, type);
    values = zonedValues(fields, frame, ownZone, zone ?? serverZone());
    // nothing left for the host clock: what has no zone now stays so
    if (frame !== 'tzid') options = { ...options, floatingTime: 'keep' };
  }
  try {
    return updateFields(object, values, options);
  } catch (error) {
    throw explainWriteRefusal(error, type, object);
  }
}

// written in the object's frame, or read as UTC where it has none
const FRAMED_DATES = new Set(['DTSTART', 'DTEND', 'DUE', 'RDATE', 'EXDATE', 'RECURRENCE-ID']);
// UTC whatever the object's frame (RFC 5545 3.8.2.1, 3.8.7)
const UTC_DATES = new Set(['COMPLETED', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED']);

/**
 * The form of the object's start, which the values written take: 'tzid',
 * 'floating', 'utc', 'date', or 'none' (no start, or an object that does
 * not parse — updateFields reports that); and the date properties of the
 * master that carry a TZID of their own, in which tsdav-utils writes them.
 *
 * @returns {{frame: string, ownZone: Set<string>}}
 */
function startFrame(object, type) {
  let master;
  try {
    const root = new ICAL.Component(ICAL.parse(typeof object === 'string' ? object : object.data));
    master = root.name === type ? root : seriesMaster(root, type);
  } catch {
    return { frame: 'none', ownZone: new Set() };
  }
  const ownZone = new Set(master.getAllProperties()
    .filter((property) => property.getParameter('tzid'))
    .map((property) => property.name.toUpperCase()));
  const property = master.getFirstProperty('dtstart') ?? (type === 'vtodo' ? master.getFirstProperty('due') : null);
  let frame;
  if (!property) frame = 'none';
  else if (property.type === 'date' || property.getFirstValue()?.isDate) frame = 'date';
  else if (property.getParameter('tzid')) frame = 'tzid';
  else frame = /Z$/i.test(String(property.toJSON()[3])) ? 'utc' : 'floating';
  return { frame, ownZone };
}

/** The fields with their date-times in the form the frame takes (see writeFields) */
function zonedValues(fields, frame, ownZone, zone) {
  const result = {};
  for (const [name, value] of Object.entries(fields)) {
    const key = name.toUpperCase();
    if (typeof value !== 'string' || (FRAMED_DATES.has(key) && ownZone.has(key))) {
      // a property in a zone of its own: tsdav-utils writes it there
      result[name] = value;
    } else if (UTC_DATES.has(key)) {
      result[name] = mapList(value, (v) => asUtc(v, zone));
    } else if (FRAMED_DATES.has(key) && frame === 'floating') {
      result[name] = mapList(value, (v) => asFloating(v, zone));
    } else if (FRAMED_DATES.has(key) && frame !== 'tzid') {
      result[name] = mapList(value, (v) => asUtc(v, zone));
    } else if (key === 'RRULE' && frame !== 'tzid') {
      result[name] = value.replace(/(UNTIL=)([0-9]{8}T[0-9]{6}Z?)/i, (_, part, until) =>
        part + compact(frame === 'floating' ? asFloating(expand(until), zone) : asUtc(expand(until), zone)));
    } else {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Does a write carry a date-time whose meaning depends on the calendar's
 * zone? Only then is the zone worth a request.
 *
 * @param {Record<string, string>} fields
 * @returns {boolean}
 */
export function writesDates(fields) {
  return Object.keys(fields).some((name) => {
    const key = name.toUpperCase();
    return FRAMED_DATES.has(key) || UTC_DATES.has(key) || key === 'RRULE';
  });
}

const mapList = (value, map) => value.split(',').map((v) => map(v.trim())).join(',');

/** A date-time without a zone, read in `zone`, as UTC; anything else as it is */
function asUtc(value, zone) {
  const parsed = orNull(() => parseDateValue(value));
  if (parsed?.kind !== 'floating') return value;
  return `${new Date(zoneInstant(zone, wallOf(parsed.jcal))).toISOString().slice(0, 19)}Z`;
}

/** "2026-10-26T10:00:60" as ms of its digits read as UTC (a leap second rolls over) */
function wallOf(jcal) {
  const [y, mo, d, h = 0, mi = 0, sec = 0] = jcal.match(/\d+/g).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, sec);
}

/** A date-time with Z or an offset as its wall-clock time in `zone`; anything else as it is */
function asFloating(value, zone) {
  const parsed = orNull(() => parseDateValue(value));
  if (parsed?.kind !== 'utc' || !/T/.test(parsed.jcal)) return value;
  return new Date(zoneWall(zone, Date.parse(parsed.jcal))).toISOString().slice(0, 19);
}

/** "20261020T090000Z" <-> "2026-10-20T09:00:00Z" for RRULE's UNTIL */
const expand = (until) => until.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6');
const compact = (value) => value.replace(/[-:]/g, '');

function orNull(compute) {
  try {
    return compute();
  } catch {
    return null;
  }
}

/**
 * Write an event's fields and, when given, its new dates — in ONE updateFields
 * call.
 *
 * One call, because tsdav-utils writes DTSTART before everything else and
 * anchors the rest to it: an RRULE UNTIL given in `fields` takes the form of
 * the NEW DTSTART (a date for an all-day series, UTC for a timed one; RFC 5545
 * 3.3.10). Written in two calls, the rule would be checked against the old
 * DTSTART and a valid move such as
 * `{ RRULE: 'FREQ=DAILY;UNTIL=2026-10-20' }` + an all-day start_date refused.
 *
 * Start and end are rewritten together. Whether the event is all-day follows
 * from the format of the values (a bare date or a date-time); validation has
 * already rejected a pair that disagrees, or that contradicts an explicit
 * all_day flag.
 *
 * RFC 5545 3.6.1: "'dtend' and 'duration' MUST NOT occur in the same
 * 'eventprop'". An event stored as DTSTART + DURATION has just been given an
 * explicit end, so the DURATION is both redundant and illegal here — and a
 * server is entitled to refuse the PUT. Both that and the end-after-start
 * check act on the series master, the component updateFields wrote.
 *
 * @param {string|{data: string}} object - the current calendar object
 * @param {Record<string, string>} fields - bare property name -> value; must
 *   not hold DTSTART, DTEND or DURATION (the dates come in `dates`)
 * @param {Object} [dates] - omitted when the event is not being moved
 * @param {string} dates.startDate - YYYY-MM-DD or ISO 8601 date-time
 * @param {string} dates.endDate - same form as startDate; exclusive when a date
 * @param {Object} [zone] - the calendar's zone, as for writeFields
 * @returns {string} the rewritten calendar object
 */
export function writeEventFields(object, fields, dates, zone = null) {
  if (!dates) return writeFields(object, fields, 'vevent', zone);

  const written = writeFields(object, {
    ...fields,
    DTSTART: dates.startDate,
    DTEND: dates.endDate,
  }, 'vevent', zone);
  return editComponent(written, 'vevent', (vevent) => {
    vevent.removeAllProperties('duration');
    assertEndAfterStart(vevent);
  });
}

/**
 * Refuse an event whose written DTEND is not after its DTSTART.
 *
 * Checked on the written properties, not on the input: a time without a zone
 * only becomes an instant when it is written — in the event's own zone, or
 * on the server clock, where a spring-forward gap can turn 02:30 -> 03:10
 * into an end before the start. Where the two cannot be ordered without
 * guessing a zone (a TZID without its VTIMEZONE next to UTC) nothing is
 * claimed; see endsBefore.
 *
 * The refusal is the caller's input, so it is a ValidationError: reported as
 * an internal error, an LLM reads it as a broken server instead of fixing the
 * dates.
 *
 * @param {ICAL.Component} vevent
 * @throws {ValidationError} when DTEND is at or before DTSTART
 */
export function assertEndAfterStart(vevent) {
  const dtstart = vevent.getFirstProperty('dtstart');
  const dtend = vevent.getFirstProperty('dtend');
  if (dtstart && dtend && notAfter(dtend, dtstart)) {
    throw new ValidationError(
      `End date must be after start date: as written, the event would run from ` +
      `${dtstart.getFirstValue()} to ${dtend.getFirstValue()}`
    );
  }
}

/**
 * Keep a todo's dates coherent after its fields were written.
 *
 * Only runs the checks for the properties this update touched: a todo that
 * arrived from the server in some other shape is not this call's business.
 *
 *  - RFC 5545 3.6.2: DUE and DURATION MUST NOT both occur. Whichever one the
 *    caller just set replaces the other, the way an explicit end replaces a
 *    DURATION on an event.
 *  - 3.6.2: DURATION requires DTSTART.
 *  - 3.8.2.3: DUE has the same value type as DTSTART (both dates or both
 *    date-times) and is later than it — checked where the two can be ordered
 *    without guessing a zone (see notAfter).
 *
 * @param {string} iCalString - the todo with its fields already written
 * @param {Iterable<string>} changed - property names written by this update
 * Each refusal is the caller's input meeting the stored todo, so it is a
 * ValidationError naming what to send instead — most often DTSTART and DUE
 * together, since a todo moved by its DTSTART alone keeps its old DUE.
 *
 * @returns {string} the todo, with a superseded DUE or DURATION removed
 * @throws {ValidationError} when the dates the caller set cannot form a valid todo
 */
export function reconcileTodoDates(iCalString, changed) {
  const touched = new Set([...changed].map((name) => name.toUpperCase()));
  if (!['DUE', 'DTSTART', 'DURATION'].some((name) => touched.has(name))) {
    return iCalString;
  }

  return editComponent(iCalString, 'vtodo', (vtodo) => {
    if (touched.has('DUE')) {
      vtodo.removeAllProperties('duration');
    } else if (touched.has('DURATION')) {
      vtodo.removeAllProperties('due');
    }

    const dtstart = vtodo.getFirstProperty('dtstart');
    const due = vtodo.getFirstProperty('due');

    if (vtodo.hasProperty('duration') && !dtstart) {
      throw new ValidationError('DURATION needs a DTSTART (RFC 5545 3.6.2): set DTSTART too, or set DUE instead');
    }

    if (dtstart && due) {
      if (dtstart.type !== due.type) {
        const [dateOne, timeOne] = dtstart.type === 'date' ? ['DTSTART', 'DUE'] : ['DUE', 'DTSTART'];
        throw new ValidationError(
          `DUE and DTSTART must both be dates or both be date-times (RFC 5545 3.8.2.3), ` +
          `but ${dateOne} is a date and ${timeOne} has a time. Give DTSTART and DUE together, ` +
          `in the same form`
        );
      }
      if (notAfter(due, dtstart)) {
        throw new ValidationError(
          `DUE (${due.getFirstValue()}) must be later than DTSTART (${dtstart.getFirstValue()}) ` +
          `(RFC 5545 3.8.2.3). To move the todo, give DTSTART and DUE together in fields`
        );
      }
    }
  });
}

/**
 * The instant an ICAL.Time names.
 *
 * A date ("the 25th") and a floating time (no TZID, no Z) have no instant of
 * their own: RFC 4791 9.9 reads them in the calendar's time zone, which is
 * `zone` (see src/calendar-zone.js) — a date as the start of that day there.
 * A TZID ical.js did not resolve (no VTIMEZONE in the object) is read as the
 * IANA zone of that name where there is one, else like a floating time.
 *
 * @param {ICAL.Time} icalTime
 * @param {Object} [zone] - the zone floating values are read in; the
 *   server's when not given
 * @returns {number} milliseconds since the epoch
 */
export function toInstant(icalTime, zone = null) {
  if (!icalTime.isDate && icalTime.zone && icalTime.zone !== ICAL.Timezone.localTimezone) {
    return icalTime.toJSDate().getTime();
  }
  const wall = Date.UTC(icalTime.year, icalTime.month - 1, icalTime.day,
    icalTime.isDate ? 0 : icalTime.hour, icalTime.isDate ? 0 : icalTime.minute, icalTime.isDate ? 0 : icalTime.second);
  const named = !icalTime.isDate && icalTime.timezone && icalTime.timezone !== 'floating' ? ianaZone(icalTime.timezone) : null;
  if (named) return named.toInstant(new Date(wall).toISOString().slice(0, 19)).getTime();
  return zoneInstant(zone ?? serverZone(), wall);
}

const ianaZones = new Map();
function ianaZone(tzid) {
  if (!ianaZones.has(tzid)) {
    if (ianaZones.size >= 64) ianaZones.clear();
    let zone = null;
    try {
      zone = resolveZone(tzid);
    } catch {
      zone = null;
    }
    ianaZones.set(tzid, zone);
  }
  return ianaZones.get(tzid);
}

/**
 * The span a todo's DUE covers, for range queries: an instant for a
 * date-time, the whole day in the calendar's zone for a date (see
 * toInstant). null when there is no todo or it has no DUE.
 *
 * @param {ICAL.Component|null} vtodo - a parsed VTODO (see query-objects.js)
 * @returns {{start: number, end: number} | null}
 */
export function dueSpan(vtodo) {
  const property = vtodo?.getFirstProperty('due');
  if (!property) return null;
  const start = instantOf(property);
  const value = property.getFirstValue();
  if (!value.isDate) return { start, end: start };
  const next = value.clone();
  next.adjust(1, 0, 0, 0);
  return { start, end: toInstant(next, floatingZoneOf(property)) };
}

/**
 * The instant a date or date-time property stands for: resolved against the
 * document's own VTIMEZONE where it names one, otherwise as toInstant reads
 * it — floating values and dates in the zone of the calendar the object was
 * fetched from (floatingZoneOf).
 *
 * `value` reads another time in the property's frame — an occurrence of a
 * recurring DTSTART, which keeps its TZID.
 *
 * @param {ICAL.Property} property
 * @param {ICAL.Time} [value] - defaults to the property's own value
 * @returns {number} milliseconds since the epoch
 */
export function instantOf(property, value = property.getFirstValue()) {
  return absoluteInstant(property, value) ?? toInstant(value, floatingZoneOf(property));
}

/**
 * Does the property name an instant on its own — UTC, or a TZID whose zone
 * is known (its VTIMEZONE in the document, else the IANA zone of that name)?
 * If not (a date, a floating time), instantOf reads it in the calendar's zone.
 *
 * @param {ICAL.Property} property
 * @returns {boolean}
 */
export function hasAbsoluteInstant(property) {
  return absoluteInstant(property) !== null;
}

/**
 * The instant a date-time property names, or null when that needs the
 * calendar's zone: a date, a floating value, or a TZID that is neither in the
 * document nor an IANA name.
 */
function absoluteInstant(property, value = property.getFirstValue()) {
  if (property.type === 'date' || value.isDate) return null;
  const tzid = property.getParameter('tzid');
  if (!tzid) {
    return /Z$/i.test(String(property.toJSON()[3])) ? value.toUnixTime() * 1000 : null;
  }
  const fields = {
    year: value.year, month: value.month, day: value.day,
    hour: value.hour, minute: value.minute, second: value.second,
  };
  const zone = documentZone(property);
  if (!zone) {
    const named = ianaZone(tzid);
    return named ? named.toInstant(new Date(Date.UTC(fields.year, fields.month - 1, fields.day,
      fields.hour, fields.minute, fields.second)).toISOString().slice(0, 19)).getTime() : null;
  }
  return new ICAL.Time(fields, zone).toUnixTime() * 1000;
}

/**
 * The zone a property's TZID names, from the document's own VTIMEZONE; null
 * without a TZID or without that VTIMEZONE.
 *
 * @param {ICAL.Property} property
 * @returns {ICAL.Timezone|null}
 */
function documentZone(property) {
  const tzid = property.getParameter('tzid');
  if (!tzid) return null;
  let calendar = property.parent;
  while (calendar?.parent) calendar = calendar.parent;
  const vtimezone = calendar?.getAllSubcomponents('vtimezone')
    .find((zone) => zone.getFirstPropertyValue('tzid') === tzid);
  return vtimezone ? timezoneFor(vtimezone) : null;
}

/**
 * Make a parsed VCALENDAR resolve its TZIDs to the shared zones of
 * timezoneFor.
 *
 * ical.js resolves a TZID through the root component's getTimeZoneByID, which
 * hydrates a new ICAL.Timezone per parsed object — and a new zone recomputes
 * its offset changes since 1970 on first use (~1 ms). Every time a recurring
 * event is expanded or compared paid that once per object. Overriding the
 * lookup on the root makes every date-time in the document use the zone
 * built once per definition.
 *
 * @param {ICAL.Component} root - a freshly parsed VCALENDAR
 * @returns {ICAL.Component} the same component
 */
export function shareTimezones(root) {
  const zones = root.getAllSubcomponents('vtimezone');
  if (zones.length === 0) return root;
  root.getTimeZoneByID = (tzid) => {
    const vtimezone = zones.find((zone) => zone.getFirstPropertyValue('tzid') === tzid);
    return vtimezone ? timezoneFor(vtimezone) : null;
  };
  return root;
}

/**
 * The ICAL.Timezone for a VTIMEZONE, built once per definition.
 *
 * A new ICAL.Timezone starts with an empty cache of its UTC-offset changes and
 * recomputes them from the zone's first DTSTART (1970 for most) on its first
 * conversion — several milliseconds each. A query over 2000 events in the same
 * zone did that 2000 times. Every calendar object carries its own copy of the
 * VTIMEZONE, so the cache is keyed by the definition's text: identical
 * definitions share one zone, and a different definition under the same TZID
 * still gets its own. Bounded, since the definitions come from the server.
 */
const timezonesByDefinition = new Map();
const timezonesByComponent = new WeakMap();
const MAX_CACHED_TIMEZONES = 64;

export function timezoneFor(vtimezone) {
  let zone = timezonesByComponent.get(vtimezone);
  if (zone) return zone;
  const definition = JSON.stringify(vtimezone.toJSON());
  zone = timezonesByDefinition.get(definition);
  if (!zone) {
    if (timezonesByDefinition.size >= MAX_CACHED_TIMEZONES) timezonesByDefinition.clear();
    zone = new ICAL.Timezone(vtimezone);
    timezonesByDefinition.set(definition, zone);
  }
  timezonesByComponent.set(vtimezone, zone);
  return zone;
}

/**
 * Is `later` at or before `earlier` (an end or DUE against its DTSTART)?
 * Answered only where it needs no guess: both values resolve to instants
 * (UTC, or a TZID whose VTIMEZONE is in the document), or they are
 * wall-clock times in the same frame. Otherwise the answer depends on a zone
 * that is not known here, and a guessed order must not reject a valid write.
 */
function notAfter(later, earlier) {
  const [laterAt, earlierAt] = [absoluteInstant(later), absoluteInstant(earlier)];
  if (laterAt !== null && earlierAt !== null) return laterAt <= earlierAt;
  if (frameOf(later) === frameOf(earlier)) {
    return later.getFirstValue().compare(earlier.getFirstValue()) <= 0;
  }
  return false;
}

/** Dates, UTC, floating, or one TZID: values in one frame order as wall clocks */
function frameOf(property) {
  if (property.type === 'date') return 'date';
  const tzid = property.getParameter('tzid');
  if (tzid) return `tzid:${tzid}`;
  return /Z$/i.test(String(property.toJSON()[3])) ? 'utc' : 'floating';
}

/**
 * Parse, hand the component updateFields just wrote to `edit`, serialize.
 *
 * That component is the series master (tsdav-utils' seriesMaster) of the
 * type written, not the first one in the file: with an override stored first,
 * or a VEVENT next to the VTODO, a check or a DURATION removal on the first
 * component would miss what was written. An object updateFields refused to
 * edit (no component of the type; several instances, no master) cannot reach
 * this point, and seriesMaster would throw the same error if it did.
 */
function editComponent(iCalString, name, edit) {
  let calendar;
  try {
    calendar = new ICAL.Component(parseICal(iCalString));
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }

  const component = calendar.name === name ? calendar : seriesMaster(calendar, name);

  edit(component);
  return calendar.toString();
}

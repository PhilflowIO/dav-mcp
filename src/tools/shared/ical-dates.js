import ICAL from 'ical.js';
import { updateFields, seriesMaster } from 'tsdav-utils';
import { explainWriteRefusal } from '../../ical-components.js';
import { ValidationError } from '../../error-handler.js';

/**
 * Every property dav-mcp writes onto a calendar object or vCard goes through
 * writeFields — the create tools as much as the update tools.
 *
 * Encoding is tsdav-utils' job: a bare date becomes VALUE=DATE, a date-time
 * drops a VALUE=DATE left over from the old value. Two choices are left to the
 * caller:
 *  - A date-time without a zone, where the object has no zone to read it in,
 *    is read in the server's timezone and written as UTC ('local'), which is
 *    what create_event has always done, so the same input lands on the same
 *    instant whichever tool it goes through.
 *  - A date-time with Z or an offset is written as its wall-clock time in the
 *    zone the value already lives in — its own TZID, or DTSTART's
 *    ('keep-zone'). A model that moves a weekly 09:00 Europe/Berlin series
 *    with "2026-10-06T08:00:00Z" means 10:00 in Berlin every week; written as
 *    UTC, the series would sit an hour earlier after the DST change. Where no
 *    zone applies (a new object, a UTC series) the instant is written as UTC.
 *
 * A calendar object may hold more than one component type — a VEVENT next to
 * a VTODO. Left to choose, tsdav-utils takes the VEVENT first, so the todo
 * tools name 'vtodo' and the event tools 'vevent'; an object without that
 * component is refused by the library ("No VTODO found in VCALENDAR (it holds:
 * VEVENT)"). A vCard has no component type, so the contact tools pass none.
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
 * @returns {string} the rewritten object
 */
export function writeFields(object, fields, type) {
  try {
    return updateFields(object, fields, { floatingTime: 'local', absoluteTime: 'keep-zone', type });
  } catch (error) {
    throw explainWriteRefusal(error, type);
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
 * @returns {string} the rewritten calendar object
 */
export function writeEventFields(object, fields, dates) {
  if (!dates) return writeFields(object, fields, 'vevent');

  const written = writeFields(object, {
    ...fields,
    DTSTART: dates.startDate,
    DTEND: dates.endDate,
  }, 'vevent');
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
 * Absolute instant for an ICAL.Time.
 *
 * A date-only value is floating — "the 25th, wherever you are" — and has no
 * instant of its own. toJSDate() would resolve it against whatever zone the
 * server happens to run in, which makes the same query answer differently in
 * Berlin and in Auckland. Reading the fields as UTC is at least deterministic:
 * an all-day value covers the UTC day. The alternative would be to guess a
 * zone, and a wrong guess is worse than a stated convention.
 *
 * @param {ICAL.Time} icalTime
 * @returns {number} milliseconds since the epoch
 */
export function toInstant(icalTime) {
  if (icalTime.isDate) {
    return Date.UTC(icalTime.year, icalTime.month - 1, icalTime.day);
  }
  return icalTime.toJSDate().getTime();
}

/**
 * The span a todo's DUE covers, for range queries: an instant for a
 * date-time, the whole UTC day for a date (see toInstant). null when there is
 * no todo or it has no DUE.
 *
 * @param {ICAL.Component|null} vtodo - a parsed VTODO (see query-objects.js)
 * @returns {{start: number, end: number} | null}
 */
export function dueSpan(vtodo) {
  const property = vtodo?.getFirstProperty('due');
  if (!property) return null;
  const start = instantOf(property);
  return { start, end: property.getFirstValue().isDate ? start + 86400000 : start };
}

/**
 * The instant a date or date-time property stands for: resolved against the
 * document's own VTIMEZONE where it names one, otherwise as toInstant reads it.
 *
 * `value` reads another time in the property's frame — an occurrence of a
 * recurring DTSTART, which keeps its TZID.
 *
 * @param {ICAL.Property} property
 * @param {ICAL.Time} [value] - defaults to the property's own value
 * @returns {number} milliseconds since the epoch
 */
export function instantOf(property, value = property.getFirstValue()) {
  return absoluteInstant(property, value) ?? toInstant(value);
}

/**
 * Does the property name an instant on its own — UTC, a date (read as its
 * UTC day), or a TZID whose VTIMEZONE is in the document? If not (a floating
 * time, a TZID without its VTIMEZONE), instantOf reads it in the host's zone.
 *
 * @param {ICAL.Property} property
 * @returns {boolean}
 */
export function hasAbsoluteInstant(property) {
  return absoluteInstant(property) !== null;
}

/**
 * The instant a date-time property names, or null when that needs a zone
 * this document does not define: a floating value, or a TZID without its
 * VTIMEZONE. A date is its UTC day start, as in toInstant.
 */
function absoluteInstant(property, value = property.getFirstValue()) {
  if (property.type === 'date' || value.isDate) return toInstant(value);
  if (!property.getParameter('tzid')) {
    return /Z$/i.test(String(property.toJSON()[3])) ? value.toUnixTime() * 1000 : null;
  }
  const zone = documentZone(property);
  if (!zone) return null;
  const local = new ICAL.Time({
    year: value.year, month: value.month, day: value.day,
    hour: value.hour, minute: value.minute, second: value.second,
  }, zone);
  return local.toUnixTime() * 1000;
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
    calendar = new ICAL.Component(ICAL.parse(iCalString));
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }

  const component = calendar.name === name ? calendar : seriesMaster(calendar, name);

  edit(component);
  return calendar.toString();
}

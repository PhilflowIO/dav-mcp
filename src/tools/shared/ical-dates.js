import ICAL from 'ical.js';
import { updateFields, seriesMaster } from 'tsdav-utils';

/**
 * Every property dav-mcp writes onto a calendar object or vCard goes through
 * writeFields — the create tools as much as the update tools.
 *
 * Encoding is tsdav-utils' job: a value with an offset is converted to UTC, a
 * bare date becomes VALUE=DATE, and a TZID or VALUE=DATE left over from the old
 * value is dropped. The one choice it leaves to the caller is what a date-time
 * without a zone means. Here it is read in the server's timezone and written as
 * UTC, which is what create_event has always done, so the same input lands on
 * the same instant whichever tool it goes through.
 *
 * @param {string|{data: string}} object - calendar object or vCard
 * @param {Record<string, string>} fields - bare property name -> value
 * @returns {string} the rewritten object
 */
export function writeFields(object, fields) {
  return updateFields(object, fields, { floatingTime: 'local' });
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
  if (!dates) return writeFields(object, fields);

  const written = writeFields(object, {
    ...fields,
    DTSTART: dates.startDate,
    DTEND: dates.endDate,
  });
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
 * @param {ICAL.Component} vevent
 * @throws {Error} when DTEND is at or before DTSTART
 */
export function assertEndAfterStart(vevent) {
  const dtstart = vevent.getFirstProperty('dtstart');
  const dtend = vevent.getFirstProperty('dtend');
  if (dtstart && dtend && notAfter(dtend, dtstart)) {
    throw new Error(
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
 * @returns {string} the todo, with a superseded DUE or DURATION removed
 * @throws {Error} when the dates the caller set cannot form a valid todo
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
      throw new Error('DURATION needs a DTSTART (RFC 5545 3.6.2): set DTSTART too, or set DUE instead');
    }

    if (dtstart && due) {
      if (dtstart.type !== due.type) {
        const [dateOne, timeOne] = dtstart.type === 'date' ? ['DTSTART', 'DUE'] : ['DUE', 'DTSTART'];
        throw new Error(
          `DUE and DTSTART must both be dates or both be date-times (RFC 5545 3.8.2.3), ` +
          `but ${dateOne} is a date and ${timeOne} has a time`
        );
      }
      if (notAfter(due, dtstart)) {
        throw new Error(
          `DUE (${due.getFirstValue()}) must be later than DTSTART (${dtstart.getFirstValue()}) (RFC 5545 3.8.2.3)`
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
 * @param {ICAL.Property} property
 * @returns {number} milliseconds since the epoch
 */
export function instantOf(property) {
  return absoluteInstant(property) ?? toInstant(property.getFirstValue());
}

/**
 * The instant a date-time property names, or null when that needs a zone
 * this document does not define: a floating value, or a TZID without its
 * VTIMEZONE. A date is its UTC day start, as in toInstant.
 */
function absoluteInstant(property) {
  const value = property.getFirstValue();
  if (property.type === 'date') return toInstant(value);
  const tzid = property.getParameter('tzid');
  if (!tzid) {
    return /Z$/i.test(String(property.toJSON()[3])) ? value.toUnixTime() * 1000 : null;
  }
  let calendar = property.parent;
  while (calendar?.parent) calendar = calendar.parent;
  const vtimezone = calendar?.getAllSubcomponents('vtimezone')
    .find((zone) => zone.getFirstPropertyValue('tzid') === tzid);
  if (!vtimezone) return null;
  const local = new ICAL.Time({
    year: value.year, month: value.month, day: value.day,
    hour: value.hour, minute: value.minute, second: value.second,
  }, timezoneFor(vtimezone));
  return local.toUnixTime() * 1000;
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
 * That component is the series master (tsdav-utils' seriesMaster), not the
 * first one in the file: with an override stored first, a check or a
 * DURATION removal on the first component would miss what was written. The
 * object updateFields refused to edit (several instances, no master) cannot
 * reach this point, and seriesMaster would throw the same error if it did.
 */
function editComponent(iCalString, name, edit) {
  let calendar;
  try {
    calendar = new ICAL.Component(ICAL.parse(iCalString));
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }

  if (calendar.name !== name && calendar.getAllSubcomponents(name).length === 0) {
    throw new Error(`No ${name.toUpperCase()} found in the calendar object`);
  }
  const component = calendar.name === name ? calendar : seriesMaster(calendar, name);

  edit(component);
  return calendar.toString();
}

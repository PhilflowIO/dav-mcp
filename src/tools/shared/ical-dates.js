import ICAL from 'ical.js';
import { updateFields } from 'tsdav-utils';

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
 * Move an event: rewrite DTSTART/DTEND together.
 *
 * Whether the event is all-day follows from the format of the values (a bare
 * date or a date-time); validation has already rejected a pair that disagrees,
 * or that contradicts an explicit all_day flag.
 *
 * RFC 5545 3.6.1: "'dtend' and 'duration' MUST NOT occur in the same
 * 'eventprop'". An event stored as DTSTART + DURATION has just been given an
 * explicit end, so the DURATION is both redundant and illegal here — and a
 * server is entitled to refuse the PUT.
 *
 * @param {string} iCalString - the current calendar object
 * @param {Object} dates
 * @param {string} dates.startDate - YYYY-MM-DD or ISO 8601 date-time
 * @param {string} dates.endDate - same form as startDate; exclusive when a date
 * @returns {string} the rewritten calendar object
 */
export function setEventDates(iCalString, { startDate, endDate }) {
  const written = writeFields(iCalString, { DTSTART: startDate, DTEND: endDate });
  return editComponent(written, 'vevent', (vevent) => {
    vevent.removeAllProperties('duration');
  });
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
 *    without guessing a zone (see dueNotAfterStart).
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
      if (dueNotAfterStart(due, dtstart)) {
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
 * date-time, the whole UTC day for a date (see toInstant). null when the todo
 * has no DUE or does not parse.
 *
 * @param {string} iCalString
 * @returns {{start: number, end: number} | null}
 */
export function dueSpan(iCalString) {
  // one malformed todo must not fail the query for all the others
  try {
    const vtodo = new ICAL.Component(ICAL.parse(iCalString)).getFirstSubcomponent('vtodo');
    const property = vtodo?.getFirstProperty('due');
    if (!property) return null;
    const due = property.getFirstValue();
    const start = absoluteInstant(property) ?? toInstant(due);
    return { start, end: due.isDate ? start + 86400000 : start };
  } catch {
    return null;
  }
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
  }, new ICAL.Timezone(vtimezone));
  return local.toUnixTime() * 1000;
}

/**
 * Is DUE at or before DTSTART? Answered only where it needs no guess: both
 * values resolve to instants (UTC, or a TZID whose VTIMEZONE is in the
 * document), or they are wall-clock times in the same frame. Otherwise the
 * answer depends on a zone that is not known here, and a guessed order must
 * not reject a valid write.
 */
function dueNotAfterStart(due, dtstart) {
  const [dueAt, startAt] = [absoluteInstant(due), absoluteInstant(dtstart)];
  if (dueAt !== null && startAt !== null) return dueAt <= startAt;
  if (frameOf(due) === frameOf(dtstart)) {
    return due.getFirstValue().compare(dtstart.getFirstValue()) <= 0;
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
 * Parse, hand the first component of the given kind to `edit`, serialize.
 */
function editComponent(iCalString, name, edit) {
  let calendar;
  try {
    calendar = new ICAL.Component(ICAL.parse(iCalString));
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }

  const component = calendar.name === name ? calendar : calendar.getFirstSubcomponent(name);
  if (!component) {
    throw new Error(`No ${name.toUpperCase()} found in the calendar object`);
  }

  edit(component);
  return calendar.toString();
}

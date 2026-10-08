import ICAL from 'ical.js';
import { seriesMaster } from 'tsdav-utils';
import { ValidationError } from './error-handler.js';

/**
 * Which component of a calendar object a reader shows.
 *
 * A recurring event or todo is stored as one calendar object holding a series
 * master plus override components for single instances: same UID, plus a
 * RECURRENCE-ID (RFC 5545 3.8.4.4), in whatever order the server chose. The
 * master is the one without RECURRENCE-ID. Writes go through tsdav-utils'
 * updateFields, which edits exactly that component (its seriesMaster); every
 * place in dav-mcp that selects a component of a parsed object goes through
 * here, so what is shown, filtered on DUE and counted as busy is the
 * component that was written — never "the first one in the file". The
 * query tools' text filters and sort key read the same selection (see
 * shownEvent and src/tools/shared/query-objects.js).
 *
 * Unlike seriesMaster, this never throws. A read must not fail because a
 * server stores detached instances without their master (as it does for an
 * attendee invited to single occurrences of a series only):
 *
 *  - no component of the type: null.
 *  - a master: it, with every RECURRENCE-ID sibling in `overrides`, ready to
 *    be related to it (ICAL.Event#relateException).
 *  - no master, one instance: that instance (what updateFields edits too).
 *  - no master, several instances: there is nothing to say which one is "the"
 *    object, and updateFields refuses to edit it. The reader falls back to
 *    the FIRST instance in document order as `master`, and lists every
 *    instance (that first one included) in `detached`, so a reader that cares
 *    about all of them — free/busy — can treat each as an occurrence of its
 *    own. `overrides` is empty: there is no series to override.
 *
 * A write that needs the component itself (to check or drop a property after
 * updateFields) should call seriesMaster directly instead: its throw on
 * several detached instances is the same error updateFields raises.
 *
 * @param {ICAL.Component} calendar - the parsed VCALENDAR
 * @param {'vevent'|'vtodo'|'vjournal'} type - component type to look at
 * @returns {{
 *   master: ICAL.Component,
 *   overrides: ICAL.Component[],
 *   detached: ICAL.Component[],
 * } | null}
 */
export function readSeries(calendar, type) {
  const all = calendar.getAllSubcomponents(type);
  if (all.length === 0) return null;

  let master;
  try {
    master = seriesMaster(calendar, type);
  } catch {
    // several instances and no master: see above
    return { master: all[0], overrides: [], detached: all };
  }

  if (master.hasProperty('recurrence-id')) {
    // a lone detached instance
    return { master, overrides: [], detached: [master] };
  }
  return {
    master,
    overrides: all.filter((c) => c !== master && c.hasProperty('recurrence-id')),
    detached: [],
  };
}

// A CalDAV server answers a time-range query with the master VEVENT of a
// recurring series, not with the occurrences inside the range, so the series
// has to be expanded here. The cost of expansion scales with the distance from
// DTSTART to the start of the range rather than with the width of the range —
// a FREQ=MINUTELY series starting in 1970 needs ~29M steps to reach 2026 — so
// the walk is capped. Server-supplied data must not be able to stall the loop.
const MAX_RECURRENCE_ITERATIONS = 10000;

/**
 * Convert a queried time range into ICAL.Time bounds.
 *
 * Goes through Date so that every form the schema accepts — with or without
 * milliseconds, "Z" or a "+02:00" offset — lands on the same absolute instant.
 * ICAL.Time.fromDateTimeString would silently treat an offset form as floating.
 */
function toICALRange(timeRange) {
  if (!timeRange?.start || !timeRange?.end) return null;

  const start = new Date(timeRange.start);
  const end = new Date(timeRange.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  return {
    start: ICAL.Time.fromJSDate(start, true),
    end: ICAL.Time.fromJSDate(end, true),
  };
}

/**
 * Find the first occurrence of a recurring event inside the queried range —
 * the first one `matches` accepts, when given (an occurrence is judged by its
 * own component: the override where there is one, else the master).
 *
 * Returns null when the series has no such occurrence there — the caller must
 * say so rather than fall back to the master DTSTART, which is the wrong-date
 * bug this whole path exists to fix.
 */
function firstOccurrenceInRange(event, range, matches) {
  const expand = new ICAL.RecurExpansion({
    component: event.component,
    dtstart: expansionStart(event, range),
  });

  for (let step = 0; step < MAX_RECURRENCE_ITERATIONS; step++) {
    const next = expand.next();
    if (!next) return { occurrence: null };
    if (next.compare(range.end) > 0) return { occurrence: null };
    if (next.compare(range.start) >= 0) {
      const occurrence = event.getOccurrenceDetails(next);
      if (!matches || matches(occurrence.item.component)) return { occurrence };
    }
  }

  console.error(`Recurrence expansion gave up after ${MAX_RECURRENCE_ITERATIONS} occurrences`);
  return { occurrence: null, truncated: true };
}

// Rule parts that keep a DAILY/WEEKLY series periodic in its INTERVAL: the
// candidates are the same days in every period, so the expansion can start a
// whole number of periods later without changing which occurrences it yields.
const PERIODIC_PARTS = new Set(['BYDAY', 'BYMONTH', 'WKST']);

/**
 * Where to start expanding a series to reach the range: the series start, or
 * — for a DAILY/WEEKLY rule without COUNT — a whole number of periods later,
 * just before the range.
 *
 * Walking from DTSTART costs one step per occurrence since the series began:
 * a daily series from 2020 takes ~2400 steps to reach October 2026, and a
 * query over hundreds of such series took seconds. Shifted by k periods, the
 * walk only covers the range. That is exact here: the rule's candidates
 * repeat every period (only BYDAY/BYMONTH restrict them), there is no COUNT to
 * count from the original start, and no RDATE to miss. EXDATEs and overrides
 * are absolute, so they still apply. The shifted start stays at least one
 * period plus a day before the range, so the start itself — which ical.js
 * always yields, even if the rule would not — never lands inside it, and a
 * zone offset cannot push an occurrence across the range start. Other rules
 * (COUNT, MONTHLY, YEARLY, ...) are walked from DTSTART as before; COUNT
 * bounds that walk, and monthly or yearly series have few occurrences.
 */
function expansionStart(event, range) {
  const start = event.startDate;
  const component = event.component;
  const rules = component.getAllProperties('rrule');
  if (rules.length !== 1 || component.hasProperty('rdate')) return start;
  const rule = rules[0].getFirstValue();
  if (rule.count || !['DAILY', 'WEEKLY'].includes(rule.freq)) return start;
  if (Object.keys(rule.parts ?? {}).some((part) => !PERIODIC_PARTS.has(part))) return start;

  const periodDays = (rule.interval || 1) * (rule.freq === 'WEEKLY' ? 7 : 1);
  const daysToRange = Math.floor((range.start.toUnixTime() - start.toUnixTime()) / 86400);
  const periods = Math.floor((daysToRange - periodDays - 2) / periodDays);
  if (!(periods > 0)) return start;

  const shifted = start.clone();
  shifted.adjust(periods * periodDays, 0, 0, 0);
  return shifted;
}

/**
 * The event as a reader shows it — the one place that decides, so the event
 * list and calendar_query's SUMMARY/LOCATION filters read the same thing.
 *
 *  - No time range: the series master (readSeries). A search without a range
 *    therefore only searches the series, not its renamed occurrences.
 *  - A time range and a recurring series: the first occurrence inside the
 *    range, with its RECURRENCE-ID override applied if it has one — the first
 *    one `matches` accepts, when a search passes it. So a search finds an
 *    occurrence renamed or moved inside the range and lists that occurrence,
 *    with its own title, place and date.
 *  - A time range and several detached instances without a master: the
 *    first instance inside the range (that `matches` accepts, if given),
 *    else the first in document order.
 *
 * @param {ICAL.Component} calendar - the parsed VCALENDAR
 * @param {{start: string, end: string}|null} timeRange
 * @param {((vevent: ICAL.Component) => boolean)|null} [matches] - the search
 * @returns {{
 *   vevent: ICAL.Component, event: ICAL.Event,
 *   occurrence: Object|null, item: ICAL.Event,
 *   outsideRange: boolean, expansionTruncated: boolean,
 * } | null}
 */
export function shownEvent(calendar, timeRange = null, matches = null) {
  const series = readSeries(calendar, 'vevent');
  if (!series) return null;
  const range = toICALRange(timeRange);

  let vevent = series.master;
  if (range && series.detached.length > 1) {
    const inRange = series.detached.filter((instance) => overlaps(new ICAL.Event(instance), range));
    vevent = inRange.find((instance) => !matches || matches(instance)) ?? inRange[0] ?? vevent;
  }
  const event = new ICAL.Event(vevent);
  for (const override of series.overrides) {
    event.relateException(override);
  }

  let occurrence = null;
  let outsideRange = false;
  let expansionTruncated = false;
  if (range && event.isRecurring()) {
    const result = firstOccurrenceInRange(event, range, matches);
    occurrence = result.occurrence;
    expansionTruncated = Boolean(result.truncated);
    outsideRange = !occurrence && !expansionTruncated;
  }

  return {
    vevent, event, occurrence,
    item: occurrence ? occurrence.item : event,
    outsideRange, expansionTruncated,
  };
}

function overlaps(event, range) {
  const { startDate, endDate } = event;
  if (!startDate) return false;
  const end = endDate ?? startDate;
  return startDate.compare(range.end) < 0
    && (end.compare(range.start) > 0 || startDate.compare(range.start) >= 0);
}

/**
 * A todo's STATUS as shown and filtered on: upper-cased (RFC 5545 values are
 * case-insensitive), NEEDS-ACTION when absent — RFC 5545 3.8.1.11 gives no
 * default, but a todo nobody marked is pending.
 *
 * @param {ICAL.Component} vtodo
 * @returns {string}
 */
export function todoStatus(vtodo) {
  return String(vtodo.getFirstPropertyValue('status') || 'NEEDS-ACTION').toUpperCase();
}

const KINDS = {
  vevent: { noun: 'event', update: 'update_event', raw: 'update_event_raw', fetch: 'calendar_multi_get' },
  vtodo: { noun: 'todo', update: 'update_todo', raw: 'update_todo_raw', fetch: 'todo_multi_get' },
};

/**
 * Refuse a field update the object cannot take, before anything is written.
 *
 * A field update edits the series master. An object holding several
 * instances and no master has none, so updateFields throws — with a message
 * that knows nothing about the tools here and surfaces as an internal error.
 * This checks the object itself (readSeries, i.e. the same seriesMaster rule)
 * and answers with a validation error naming the route that does work:
 * fetch the whole object, edit the instance meant, write it back raw.
 *
 * An object that does not parse is left to the write, which reports that.
 *
 * @param {string|{data: string}} object - the calendar object as fetched
 * @param {'vevent'|'vtodo'} type
 * @throws {ValidationError} when there are several instances and no master
 */
export function assertFieldUpdatable(object, type) {
  let calendar;
  try {
    calendar = new ICAL.Component(ICAL.parse(typeof object === 'string' ? object : object.data));
  } catch {
    return;
  }
  const series = readSeries(calendar, type);
  if (!series || series.detached.length < 2) return;

  const { noun, update, raw, fetch } = KINDS[type];
  throw new ValidationError(
    `This ${noun} is stored as ${series.detached.length} single occurrences (each with a ` +
    `RECURRENCE-ID) and no series master, so ${update} cannot tell which one to change. ` +
    `Fetch it with ${fetch} (its Raw Data block holds the full iCalendar text and the etag), ` +
    `edit the ${type.toUpperCase()} of the occurrence you mean, and send the whole object ` +
    `with ${raw}.`
  );
}

/**
 * The refusals of tsdav-utils' updateFields that a field update can run into,
 * recognised by the start of their message.
 *
 * tsdav-utils 0.5.0 throws plain Errors, without a class or code to tell a
 * refusal of the write from a fault, so the message is all there is. Each
 * pattern is anchored on the opening words of one refusal and is exercised
 * against the installed library in __tests__/series-master.test.js; a
 * rewording there fails those tests rather than silently turning the
 * refusal back into an internal error.
 */
const LIBRARY_REFUSALS = [
  // a DTSTART move the rule, an UNTIL, an EXDATE/RDATE or an override cannot follow
  /^Moving DTSTART \(/,
  /^DTSTART changed(?:,| to a date,) and /,
  // a move or a new RRULE/RDATE that would create a twin of an occurrence
  /^(?:Moving DTSTART|Writing [A-Z ]+) is refused: /,
  // a new RRULE/RDATE that leaves overrides or EXDATEs naming no occurrence
  /^The new [A-Z ]+ leaves /,
  // a series too sparse or too irregular to verify within the work limit
  /^Cannot check that /,
  /^RECURRENCE-ID cannot be written on the series master/,
  // the object holds no component of the type the tool writes
  /^No [A-Z, ]+ found in VCALENDAR/,
];

/**
 * Turn a refusal of updateFields into a validation error the caller can act
 * on; leave every other error as it is.
 *
 * The library's own text is kept whole: it says why the write is refused and
 * often what to give instead (an RRULE with the weekday of the new start,
 * say). What it cannot know is how its two remedies are spelled in this
 * server, so they are added in the tool's terms:
 *  - "in the same call" means in `fields` of this same update call;
 *  - "rewrite the whole iCalendar object" — and changing one occurrence of a
 *    series, which a field update never does — means fetching the object
 *    with the multi-get tool and sending it back with the raw update tool.
 *
 * @param {Error} error - what updateFields threw
 * @param {'vevent'|'vtodo'} type - the component the tool writes
 * @returns {Error} a ValidationError for a refusal, otherwise `error`
 */
export function explainWriteRefusal(error, type) {
  const kind = KINDS[type];
  const message = error?.message;
  if (!kind || typeof message !== 'string' || !LIBRARY_REFUSALS.some((p) => p.test(message))) {
    return error;
  }

  const { noun, update, raw, fetch } = kind;
  const hints = [];
  if (/^No [A-Z, ]+ found in VCALENDAR/.test(message)) {
    const other = Object.values(KINDS).find((k) => k !== kind);
    hints.push(
      `This object holds no ${noun}, so ${update} cannot change it. ` +
      `If it is ${other.noun === 'event' ? 'an' : 'a'} ${other.noun}, use ${other.update}.`
    );
  } else {
    if (/in the same call/.test(message)) {
      hints.push(
        `In ${update}, "in the same call" means in fields of this same call ` +
        `(e.g. fields.RRULE${type === 'vevent' ? ', next to start_date and end_date' : ''}).`
      );
    }
    hints.push(
      `To change a single occurrence, or to rewrite the whole object: fetch it with ` +
      `${fetch} (its Raw Data block holds the full iCalendar text and the etag), edit ` +
      `the ${type.toUpperCase()} components, and send the whole object with ${raw}.`
    );
  }
  return new ValidationError(`${message.replace(/\.$/, '')}. ${hints.join(' ')}`);
}

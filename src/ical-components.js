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

// Seconds a wall-clock time can sit away from the same digits read as UTC:
// zone offsets run from UTC-12 to UTC+14. ical.js reads a floating time as
// UTC, the host clock reads it in its own zone, and an override may name its
// RECURRENCE-ID in another zone than the master's DTSTART — so every window
// below is widened by this much and the caller's test decides exactly.
const ZONE_SLACK = 26 * 3600;

/**
 * The occurrences of a recurring event that `accept` takes, judged by what
 * each occurrence is after the overrides apply: its own start, end and
 * component (ical.js getOccurrenceDetails — an override with the same
 * RECURRENCE-ID, or a RANGE=THISANDFUTURE override shifting the ones after
 * it). EXDATEs remove an occurrence and with it any override of it, and an
 * override whose RECURRENCE-ID is no occurrence of the series is ignored,
 * both as in a plain expansion from DTSTART.
 *
 * Without walking the whole series. An occurrence that is not overridden on
 * its own sits at its recurrence id, shifted at most by a THISANDFUTURE
 * override, and lasts at most the longest duration in the series — so only
 * the recurrence ids in `range`, widened by that shift and duration, are
 * walked, starting near the range where the rule allows it (expansionStart).
 * An override moved into the range from anywhere is found from the other
 * side: the overrides are a finite list, each carries its own start, and for
 * one whose effective time `accept` takes but the walk did not pass, a short
 * walk around its RECURRENCE-ID checks that it is an occurrence at all.
 *
 * `accept` must only take occurrences that touch `range`; the window is
 * computed from it.
 *
 * @param {ICAL.Event} event - a recurring master with its overrides related
 * @param {{start: number, end: number}} range - unix seconds
 * @param {(occurrence: Object) => boolean} accept - an occurrence as
 *   getOccurrenceDetails returns it ({recurrenceId, startDate, endDate, item})
 * @param {{first?: boolean}} [options] - first: only the earliest is wanted;
 *   the walk stops once no later recurrence id can start before it
 * @returns {{occurrences: Object[], truncated: boolean}} sorted by start
 *   (then recurrence id); truncated when a walk hit the iteration cap, so an
 *   occurrence may be missing
 */
export function seriesOccurrences(event, range, accept, { first = false } = {}) {
  const { lead, trail, minShift } = reach(event);
  const from = range.start - lead;
  const to = range.end + trail;

  const found = [];
  const seen = new Set();
  let best = Infinity;
  const take = (occurrence) => {
    found.push(occurrence);
    best = Math.min(best, occurrence.startDate.toUnixTime());
  };

  const walk = recurrenceIds(event, from);
  const covered = { from: walk.shifted ? from + ZONE_SLACK : -Infinity, to: -Infinity };
  let truncated = false;
  for (let step = walk.next(); ; step = walk.next()) {
    if (step.done) {
      if (step.value === 'truncated') truncated = true;
      else covered.to = Infinity;
      break;
    }
    const id = step.value;
    const at = id.toUnixTime();
    if (at > to || (first && at + minShift - ZONE_SLACK > best)) {
      covered.to = at - ZONE_SLACK;
      break;
    }
    // a shifted walk yields its own start even where the rule would not
    if (walk.shifted && at < from) continue;
    const key = exceptionKey(event, id);
    if (key) seen.add(key);
    const occurrence = event.getOccurrenceDetails(id);
    if (accept(occurrence)) take(occurrence);
  }

  for (const [key, exception] of Object.entries(event.exceptions)) {
    if (seen.has(key)) continue;
    const occurrence = event.getOccurrenceDetails(exception.recurrenceId);
    if (first && occurrence.startDate.toUnixTime() > best) continue;
    if (!accept(occurrence)) continue;
    const at = exception.recurrenceId.toUnixTime();
    if (at >= covered.from && at <= covered.to) continue; // walked past it: no occurrence
    const id = occurrenceId(event, exception.recurrenceId, key);
    if (id === null) truncated = true;
    // details for the id as the rule yields it, as a plain expansion has them
    if (id) take(event.getOccurrenceDetails(id));
  }

  if (truncated) {
    console.error(`Recurrence expansion gave up after ${MAX_RECURRENCE_ITERATIONS} occurrences`);
  }
  found.sort(byStart);
  return { occurrences: first ? found.slice(0, 1) : found, truncated };
}

function byStart(a, b) {
  return a.startDate.toUnixTime() - b.startDate.toUnixTime()
    || a.recurrenceId.toUnixTime() - b.recurrenceId.toUnixTime();
}

/**
 * How far an occurrence can sit from its recurrence id, in seconds: `lead`
 * back (it may start before its id and run on into the range), `trail`
 * forward, and the most negative shift a THISANDFUTURE override applies.
 */
function reach(event) {
  const shifts = [0];
  const durations = [event.duration?.toSeconds() ?? 0];
  for (const [, key] of event.rangeExceptions) {
    const exception = event.exceptions[key];
    shifts.push(exception.startDate.toUnixTime() - exception.recurrenceId.toUnixTime());
    durations.push(exception.duration?.toSeconds() ?? 0);
  }
  const minShift = Math.min(...shifts);
  return {
    lead: Math.max(...shifts) + Math.max(0, ...durations) + ZONE_SLACK,
    trail: -minShift + ZONE_SLACK,
    minShift,
  };
}

/**
 * The recurrence ids of a series in order, from `from` on (unix seconds) —
 * or from DTSTART where expansionStart cannot shift. Returns 'complete' when
 * the series ends, 'truncated' at the iteration cap. `shifted` tells whether
 * the walk starts later than DTSTART, in which case its first value is that
 * start, an occurrence or not.
 */
function recurrenceIds(event, from) {
  const { dtstart, shifted } = expansionStart(event, from);
  const walk = (function* () {
    const expansion = new ICAL.RecurExpansion({ component: event.component, dtstart });
    for (let step = 0; step < MAX_RECURRENCE_ITERATIONS; step++) {
      const next = expansion.next();
      if (!next) return 'complete';
      yield next;
    }
    return 'truncated';
  })();
  walk.shifted = shifted;
  return walk;
}

/** The key getOccurrenceDetails finds an exact override of `id` under, if any */
function exceptionKey(event, id) {
  const local = id.toString();
  if (local in event.exceptions) return local;
  const utc = id.convertToZone(ICAL.Timezone.utcTimezone).toString();
  return utc in event.exceptions ? utc : null;
}

/**
 * Is the override stored under `key` an occurrence of the series — does the
 * rule, less its EXDATEs, yield its RECURRENCE-ID? Walks only around that id
 * (see expansionStart). The id as the rule yields it (in the series' zone,
 * where the override may have named it in UTC); false if the rule does not
 * yield it, null when the walk hit the iteration cap first.
 */
function occurrenceId(event, recurrenceId, key) {
  const at = recurrenceId.toUnixTime();
  const walk = recurrenceIds(event, at - ZONE_SLACK);
  let step = walk.next();
  for (; !step.done; step = walk.next()) {
    const id = step.value;
    const when = id.toUnixTime();
    if (when > at + ZONE_SLACK) return false;
    if (walk.shifted && when < at - ZONE_SLACK) continue;
    if (exceptionKey(event, id) === key) return id;
  }
  return step.value === 'truncated' ? null : false;
}

// Rule parts that keep a DAILY/WEEKLY series periodic in its INTERVAL: the
// candidates are the same days in every period, so the expansion can start a
// whole number of periods later without changing which occurrences it yields.
const PERIODIC_PARTS = new Set(['BYDAY', 'BYMONTH', 'WKST']);

/**
 * Where to start expanding a series to reach `from` (unix seconds): the
 * series start, or — for a DAILY/WEEKLY rule without COUNT — a whole number
 * of periods later, just before it.
 *
 * Walking from DTSTART costs one step per occurrence since the series began:
 * a daily series from 2020 takes ~2400 steps to reach October 2026, and a
 * query over hundreds of such series took seconds. Shifted by k periods, the
 * walk only covers the range. That is exact here: the rule's candidates
 * repeat every period (only BYDAY/BYMONTH restrict them), there is no COUNT to
 * count from the original start, and no RDATE to miss. EXDATEs and overrides
 * are absolute, so they still apply. The shifted start stays at least one
 * period plus a day before `from`; ical.js always yields it, even if the rule
 * would not, so a shifted walk skips what it yields before `from` (see
 * seriesOccurrences). Other rules (COUNT, MONTHLY, YEARLY, ...) are walked
 * from DTSTART as before; COUNT bounds that walk, and monthly or yearly
 * series have few occurrences.
 *
 * @returns {{dtstart: ICAL.Time, shifted: boolean}}
 */
function expansionStart(event, from) {
  const start = event.startDate;
  const unshifted = { dtstart: start, shifted: false };
  const component = event.component;
  const rules = component.getAllProperties('rrule');
  if (rules.length !== 1 || component.hasProperty('rdate')) return unshifted;
  const rule = rules[0].getFirstValue();
  if (rule.count || !['DAILY', 'WEEKLY'].includes(rule.freq)) return unshifted;
  if (Object.keys(rule.parts ?? {}).some((part) => !PERIODIC_PARTS.has(part))) return unshifted;

  const periodDays = (rule.interval || 1) * (rule.freq === 'WEEKLY' ? 7 : 1);
  const daysToRange = Math.floor((from - start.toUnixTime()) / 86400);
  const periods = Math.floor((daysToRange - periodDays - 2) / periodDays);
  if (!(periods > 0)) return unshifted;

  const shifted = start.clone();
  shifted.adjust(periods * periodDays, 0, 0, 0);
  return { dtstart: shifted, shifted: true };
}

/**
 * The event as a reader shows it — the one place that decides, so the event
 * list and calendar_query's SUMMARY/LOCATION filters read the same thing.
 *
 *  - No time range: the series master (readSeries). A search without a range
 *    therefore only searches the series, not its renamed occurrences.
 *  - A time range and a recurring series: the earliest occurrence that
 *    starts inside the range once its overrides apply (seriesOccurrences) —
 *    the earliest one `matches` accepts, when a search passes it. An
 *    occurrence moved into the range from outside it counts, one moved out
 *    of it does not, and it is listed with its own title, place and date.
 *    A cancelled occurrence is still an occurrence; the display says so.
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
    // listed when it starts in the range, at its own (possibly moved) start
    const inRange = (o) => o.startDate.compare(range.start) >= 0 && o.startDate.compare(range.end) <= 0
      && (!matches || matches(o.item.component));
    const window = { start: range.start.toUnixTime(), end: range.end.toUnixTime() };
    const result = seriesOccurrences(event, window, inRange, { first: true });
    occurrence = result.occurrences[0] ?? null;
    expansionTruncated = !occurrence && result.truncated;
    outsideRange = !occurrence && !result.truncated;
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

import ICAL from 'ical.js';
import { expandOccurrences, createRecurrenceBudget, resolvePropertyZone, resolveZone } from 'tsdav-utils';
import { toInstant, timezoneFor } from './tools/shared/ical-dates.js';
import { floatingZoneOf, setFloatingZone, zoneInstant, zoneWall } from './calendar-zone.js';

/**
 * Which occurrences of a recurring event touch a time range — the one answer
 * free/busy, calendar_query, list_events and the event display all read.
 *
 * A CalDAV server answers a time-range query with the whole calendar object
 * of a recurring series, not with the occurrences inside the range, so the
 * series is expanded here. The expansion itself is tsdav-utils'
 * expandOccurrences — the reader the write side uses too, so dav-mcp and the
 * library agree on which occurrences a series has:
 *
 *  - an override (same UID, RECURRENCE-ID) replaces the occurrence its
 *    RECURRENCE-ID names: read in the series' frame by the instant it names,
 *    a time a DST change shows twice as its first pass (RFC 5545 3.3.5); a
 *    floating one by its digits, a date-time one on an all-day series by its
 *    date. One that names no occurrence (EXDATEd, never generated, or a UTC
 *    id on a floating series, which has no zone to read it in) is ignored.
 *  - an EXDATE excludes by instant; a date on a timed series its whole day; a
 *    floating one in a zoned series, or a UTC one in a floating series, names
 *    nothing.
 *  - expansion is charged to a work budget and never loops: ical.js tests
 *    rule candidates one by one without a bound of its own.
 *
 * On top of that, here: occurrences are judged by where they now are (an
 * override moved into the range from anywhere is found), RANGE=THISANDFUTURE
 * overrides move every later occurrence, and the walk starts near the range
 * rather than at DTSTART.
 *
 * "Touches the range" is RFC 4791 9.9's time-range test, half-open: the
 * occurrence starts before the range ends and ends after it starts; one
 * without duration touches it when it starts in [start, end). A floating time
 * and a date are read in the calendar's zone (src/calendar-zone.js), a date
 * as that whole day there.
 */

/**
 * What one tool call may spend expanding recurring events, in two measures,
 * per pool. A range query has two pools (rangeBudgetPool): one for the
 * objects the server returned for the range, one for the recurring objects
 * fetched on top of that answer (src/tools/shared/range-candidates.js); each
 * gets the amounts below, so a tool call spends at most twice them. Other
 * calls have one pool.
 *
 *  - candidates: tsdav-utils units, one per rule candidate ical.js tests
 *    (deterministic): 300 000 per pool, at most CALL_UNITS of them in
 *    any one call into the library (about 0.5 s here), since a call cannot
 *    be stopped once it runs.
 *  - time: what a request budget (requestBudget, budgetPool) has left of
 *    REQUEST_MS, charged with the measured time of everything
 *    seriesOccurrences does — the library's calls, including what it does not
 *    count (reading the object's VTIMEZONEs anew on every call), the copies
 *    made here, the work on each occurrence.
 *
 * Whichever runs out first ends the expansion, as incomplete. The clock is
 * checked before each call into the library, and every object of the
 * server's answer gets at least MIN_SHARE: so about 1.5 s for that pool plus
 * up to one call per remaining object, which grows with the size of the
 * answer; the extra pool has no floor, so it stays within its 1.5 s and the
 * objects it cannot reach are reported as not checked. Machine load can
 * make a series incomplete. A year of a calendar of 100 ordinary series (daily,
 * weekly, monthly, yearly, with overrides) takes about 1 s and some 280 000
 * candidates. A walk that needs more than CALL_UNITS is incomplete even for
 * a lone series.
 */
export const REQUEST_UNITS = 300000;
export const CALL_UNITS = 100000;
const REQUEST_MS = 1500;

/**
 * What one call into the library costs in candidates on top of those it
 * tests: bounds the number of calls deterministically too.
 */
export const CALL_COST = 100;

/**
 * Each calendar object of a tool call gets at least this much, whatever the
 * objects before it spent: one heavy series cannot starve the rest.
 */
export const MIN_SHARE = { units: 2000, ms: 20 };

// Overrides whose recurrence ids lie at most this many periods apart are
// checked in one call: walking the periods between (a few units each) costs
// less than another call (CALL_COST).
const CLUSTER_PERIODS = 20;

/**
 * The work expand() has done since the last resetExpansionWork(), in
 * deterministic measures: candidates charged (CALL_COST included), calls into
 * the library, and overrides handed to it. The library converts every
 * override it is given, on every call, and counts none of that in
 * candidates, so only the clock bounds that work. Counting only: nothing
 * here reads it. Tests bound a tool call's work by it without a clock, which
 * on a slow runner measured the runner (#138).
 */
export const expansionWork = { units: 0, calls: 0, overridesHanded: 0 };

/** Start expansionWork over from zero, before the work to be counted. */
export function resetExpansionWork() {
  Object.assign(expansionWork, { units: 0, calls: 0, overridesHanded: 0 });
}

const timedBudget = (units, ms) => Object.assign(createRecurrenceBudget(units), { timed: true, timeLeft: ms, granted: { units, ms } });

/** A fresh budget for one tool call that expands one object */
export function requestBudget() {
  return timedBudget(REQUEST_UNITS, REQUEST_MS);
}

/**
 * The budget of a tool call that expands `count` objects, shared fairly:
 * take() gives the next object the larger of an equal share of what is left
 * and MIN_SHARE; give() returns what it did not spend.
 *
 * @param {number} count
 * @returns {{take: () => Object, give: (budget: Object) => void}}
 */
export function budgetPool(count, { floor = true } = {}) {
  let units = REQUEST_UNITS;
  let ms = REQUEST_MS;
  let left = Math.max(1, count);
  // without the floor no object gets more than the pool has left: once it
  // is spent, what follows gets nothing and comes out incomplete
  const cap = (value, rest) => (floor ? value : Math.max(0, Math.min(value, rest)));
  return {
    take() {
      return timedBudget(
        cap(Math.max(MIN_SHARE.units, Math.floor(units / left)), units),
        cap(Math.max(MIN_SHARE.ms, ms / left), ms),
      );
    },
    give(budget) {
      units -= budget.granted.units - Math.max(0, budget.remaining);
      ms -= budget.granted.ms - Math.max(0, budget.timeLeft);
      left = Math.max(1, left - 1);
    },
  };
}

/**
 * The budget of a range query whose objects come in two kinds: those the
 * server returned for the range, and the recurring objects fetched on top
 * because a server's range answer can leave them out (`isExtra`, see
 * src/tools/shared/range-candidates.js). Each kind has a pool of its own, so
 * however many extra objects there are, they never spend what the server's
 * answer needs; the extra pool has no floor, so it bounds their time too.
 * take(object) draws from the object's pool (none given: the first).
 *
 * @param {Object[]} objects
 * @param {(object: Object) => boolean} isExtra
 */
export function rangeBudgetPool(objects, isExtra) {
  const extraCount = objects.filter(isExtra).length;
  const pools = {
    answered: budgetPool(objects.length - extraCount),
    extra: budgetPool(extraCount, { floor: false }),
  };
  const poolOf = new WeakMap();
  return {
    take(object) {
      const pool = object && isExtra(object) ? pools.extra : pools.answered;
      const share = pool.take();
      poolOf.set(share, pool);
      return share;
    },
    give(share) {
      (poolOf.get(share) ?? pools.answered).give(share);
    },
  };
}

/**
 * Milliseconds a wall-clock time can sit away from the same digits read as
 * UTC: zone offsets run from UTC-12 to UTC+14. For bounds that compare a
 * floating time read in the calendar's zone with an instant (calendar_query's
 * sort key), and for windows estimated before the library reads them.
 */
export const ZONE_SLACK_MS = 26 * 3600 * 1000;

/**
 * The range to ask the server for, wider than the one queried by
 * ZONE_SLACK_MS on each side. A server reads floating times and dates in a
 * zone of its own choosing for a time-range REPORT — Nextcloud and Baïkal
 * (SabreDAV) in UTC, not in the calendar's calendar-timezone as RFC 4791 9.9
 * says — so an exact range would lose a floating 09:00 Berlin meeting
 * queried at 07:30-08:30 UTC. The tools decide on their own reading what
 * touches the range (src/calendar-zone.js); the server only has to send
 * every candidate.
 *
 * @param {{start: string, end: string}|undefined} timeRange - ISO 8601
 * @returns {{start: string, end: string}|undefined}
 */
export function serverTimeRange(timeRange) {
  if (!timeRange?.start || !timeRange?.end) return timeRange;
  const start = new Date(timeRange.start).getTime();
  const end = new Date(timeRange.end).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return timeRange;
  return { start: new Date(start - ZONE_SLACK_MS).toISOString(), end: new Date(end + ZONE_SLACK_MS).toISOString() };
}

// A duration or a THISANDFUTURE move added on the wall clock can differ from
// its length in instants by a DST change: this much margin covers it.
const DST_SLACK_MS = 3 * 3600 * 1000;

/**
 * RFC 4791 9.9: does [start, end) touch [range.start, range.end)?
 *
 * @param {number} start - ms
 * @param {number} end - ms; equal to start for an occurrence without duration
 * @param {{start: number, end: number}} range - ms
 */
export function touchesRange(start, end, range) {
  return start < range.end && (end > range.start || start >= range.start);
}

/**
 * The instants an occurrence spans, in ms: those the expansion computed
 * (`startAt`/`endAt`) where it did, else as toInstant reads its times — a
 * floating time or a date in `zone`, by default that of the component the
 * occurrence comes from (`item`).
 *
 * @param {{startDate: ICAL.Time, endDate?: ICAL.Time, startAt?: number, endAt?: number, item?: ICAL.Event}} occurrence
 * @param {Object} [zone] - see src/calendar-zone.js
 * @returns {{start: number, end: number}}
 */
export function spanOf({ startDate, endDate, startAt, endAt, item }, zone = null) {
  const zoneOf = () => zone ?? (zone = floatingZoneOf(item?.component));
  const start = startAt ?? toInstant(startDate, zoneOf());
  const end = endAt ?? (endDate ? toInstant(endDate, zoneOf()) : start);
  return { start, end: Math.max(start, end) };
}

// ---------------------------------------------------------------------------
// Frames: the wall clock a value is written on, and its instants

/**
 * The frame of a date or date-time property: how its wall clock (ms of its
 * digits read as UTC) and instants convert. A TZID is converted by
 * tsdav-utils (the object's VTIMEZONE, else IANA data; RFC 5545 3.3.5 at DST
 * changes); floating times and dates in the calendar's zone (floatingZoneOf),
 * by the same rules. null for a TZID neither knows.
 */
const frames = new WeakMap();
function frameOfProperty(property) {
  if (!frames.has(property)) frames.set(property, readFrame(property));
  return frames.get(property);
}

function readFrame(property) {
  const value = property.getFirstValue();
  if (value.isDate || property.type === 'date') {
    const zone = floatingZoneOf(property);
    return { kind: 'date', toWall: (ms) => utcDay(zoneWall(zone, ms)), toInstant: (wall) => zoneInstant(zone, wall) };
  }
  const tzid = property.getParameter('tzid');
  if (tzid) {
    const zone = orNull(() => zoneOf(property, tzid));
    if (!zone) return null;
    return {
      kind: 'tzid',
      tzid,
      toWall: (ms) => wallOfText(zone.toWallTime(new Date(ms))),
      toInstant: (wall) => zone.toInstant(wallText(wall)).getTime(),
    };
  }
  if (/Z$/i.test(String(property.toJSON()[3]))) return { kind: 'utc', toWall: (ms) => ms, toInstant: (w) => w };
  const zone = floatingZoneOf(property);
  return {
    kind: 'floating',
    toWall: (ms) => zoneWall(zone, ms),
    toInstant: (wall) => zoneInstant(zone, wall),
  };
}

/**
 * The tsdav-utils converter for a TZID, shared by every object that defines
 * the zone the same way: a converter computes its DST changes on first use
 * (several ms), and every calendar object carries its own VTIMEZONE copy.
 * Keyed by the definition's text; bounded, since definitions come from the
 * server.
 */
const zones = new Map();
const definitions = new WeakMap();
const definitionOf = (vtimezone) => {
  if (!definitions.has(vtimezone)) definitions.set(vtimezone, vtimezone.toString());
  return definitions.get(vtimezone);
};
const MAX_ZONES = 64;
function zoneOf(property, tzid) {
  let root = property.parent;
  while (root?.parent) root = root.parent;
  const vtimezone = root?.getAllSubcomponents('vtimezone').find((z) => z.getFirstPropertyValue('tzid') === tzid);
  const key = vtimezone ? `${tzid}\n${definitionOf(vtimezone)}` : tzid;
  if (!zones.has(key)) {
    if (zones.size >= MAX_ZONES) zones.clear();
    zones.set(key, vtimezone ? resolveZone(tzid, vtimezone) : resolvePropertyZone(property));
  }
  return zones.get(key);
}

/**
 * The instant of an ICAL.Time in a zone ical.js resolved from a VTIMEZONE,
 * converted by tsdav-utils (ical.js is up to an hour off near DST changes,
 * ical.js#847; a local time shown twice is its first pass, RFC 5545 3.3.5),
 * with the zone's offset there. null for UTC, floating, dates and zones
 * without their VTIMEZONE.
 *
 * @param {ICAL.Time} time
 * @returns {{at: number, offset: number}|null} ms, and seconds east of UTC
 */
export function zonedInstant(time) {
  const zone = time?.zone;
  if (!zone || time.isDate || !zone.component || !zone.tzid || zone === ICAL.Timezone.utcTimezone) return null;
  const vtimezone = zone.component;
  const key = `${zone.tzid}\n${definitionOf(vtimezone)}`;
  if (!zones.has(key)) {
    if (zones.size >= MAX_ZONES) zones.clear();
    zones.set(key, orNull(() => resolveZone(zone.tzid, vtimezone)));
  }
  const converter = zones.get(key);
  if (!converter) return null;
  return orNull(() => {
    const at = converter.toInstant(wallText(wallOfTime(time))).getTime();
    return { at, offset: converter.offsetAt(new Date(at)) };
  });
}

const utcDay = (ms) => Math.floor(ms / 86400000) * 86400000;
const wallOfTime = (t) => Date.UTC(t.year, t.month - 1, t.day, t.isDate ? 0 : t.hour, t.isDate ? 0 : t.minute, t.isDate ? 0 : t.second);
const wallText = (wall) => new Date(wall).toISOString().slice(0, 19);
function wallOfText(text) {
  const [y, mo, d, h = 0, mi = 0, s = 0] = text.match(/\d+/g).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** An ICAL.Time of a wall clock in a frame, for display (a TZID with its zone) */
function timeOf(wall, frame, root, instant) {
  const d = new Date(wall);
  const fields = {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
  if (frame.kind === 'date') return new ICAL.Time({ ...fields, isDate: true });
  if (frame.kind === 'utc') return new ICAL.Time(fields, ICAL.Timezone.utcTimezone);
  if (frame.kind === 'tzid') {
    const vtimezone = root?.getAllSubcomponents('vtimezone').find((z) => z.getFirstPropertyValue('tzid') === frame.tzid);
    // no VTIMEZONE for ical.js to show it in: the instant, in UTC
    if (!vtimezone) return ICAL.Time.fromJSDate(new Date(instant), true);
    return new ICAL.Time(fields, timezoneFor(vtimezone));
  }
  return new ICAL.Time(fields);
}

/**
 * The wall clock in the series' frame that a RECURRENCE-ID names, read the
 * way tsdav-utils reads it (see the module comment); null when it names
 * nothing the library can place.
 */
function recurrenceWall(property, series) {
  const value = property.getFirstValue();
  const own = frameOfProperty(property);
  const { frame } = series;
  if (!own) return null;
  if (own.kind === 'date' || own.kind === 'floating' || frame.kind === 'date') {
    const wall = wallOfTime(value);
    return frame.kind === 'date' ? utcDay(wall) : wall;
  }
  if (frame.kind === 'floating') return own.kind === 'utc' ? null : wallOfTime(value);
  if (own.kind === frame.kind && own.tzid === frame.tzid) return wallOfTime(value);
  return frame.toWall(own.toInstant(wallOfTime(value)));
}

// ---------------------------------------------------------------------------
// The series

/**
 * A series master with its overrides, ready to expand.
 *
 * @param {ICAL.Component} master
 * @param {ICAL.Component[]} overrides - its RECURRENCE-ID siblings
 */
export function relateSeries(master, overrides) {
  // an empty list: without one, ical.js relates every sibling itself
  const event = new ICAL.Event(master, { exceptions: [] });
  const root = master.parent ?? null;
  const dtstart = master.getFirstProperty('dtstart');
  const frame = dtstart ? frameOfProperty(dtstart) : null;
  const zone = floatingZoneOf(master);
  const series = { event, root, master, frame, zone, overrides: [], byWall: new Map(), futures: [], plan: null };
  if (!frame) return series;

  for (const component of overrides) {
    const property = component.getFirstProperty('recurrence-id');
    if (!property) continue;
    const wall = orNull(() => recurrenceWall(property, series));
    if (wall === null) continue; // names no occurrence the library can place
    const override = { component, wall, event: new ICAL.Event(component) };
    series.overrides.push(override);
    series.byWall.set(wall, override); // a later one with the same id replaces it
  }
  series.overrides = series.overrides.filter((o) => series.byWall.get(o.wall) === o);
  series.futures = series.overrides
    .filter((o) => String(o.component.getFirstProperty('recurrence-id').getParameter('range') ?? '').toUpperCase() === 'THISANDFUTURE')
    .sort((a, b) => a.wall - b.wall);
  series.plan = shiftPlan(series);
  return series;
}

/**
 * The occurrences of a recurring series that touch `range` and that `filter`
 * takes, each as it now stands.
 *
 *  - The occurrences whose recurrence id lies in the range, widened by the
 *    longest duration and the largest THISANDFUTURE move, come from one
 *    expansion — of a copy of the series whose DTSTART is moved to the period
 *    that holds the range, where the rule allows (shiftPlan).
 *  - Overrides are a finite list, each with its own time: one whose
 *    recurrence id lies outside that window but that may touch the range
 *    (moved in from anywhere), and a THISANDFUTURE override before the window,
 *    are checked one by one, each by a small expansion of the period it names.
 *  - All of it from one budget, shared by the whole tool call.
 *
 * @param {ReturnType<typeof relateSeries>} series
 * @param {{start: number, end: number}} range - ms
 * @param {Object} [options]
 * @param {((occurrence: Object) => boolean)|null} [options.filter] - beyond
 *   touching the range (a search, blocking time)
 * @param {boolean} [options.first] - only the earliest is wanted
 * @param {Object} [options.budget] - the tool call's (requestBudget)
 * @returns {{occurrences: Object[], truncated: boolean, stops: Array<'budget'|'library'>, reason?: string}}
 *   sorted by start, then recurrence id; truncated when the budget ran out,
 *   the calendar library gave the rule up, or the series could not be read
 *   (`reason`): some occurrences may then be missing, but none is wrong — an
 *   override that could not be checked is left out, and so is every
 *   occurrence a THISANDFUTURE override that could not be checked might
 *   move. stops: why expansions ended early — 'budget' (the work budget ran
 *   out) and 'library' (from some point on ical.js cannot give the rule's
 *   occurrences as RFC 5545 has them: it skips one, or ends the rule after
 *   28 years without one; tsdav-utils' stoppedBy 'library'); empty when
 *   none did.
 */
export function seriesOccurrences(series, range, { filter = null, first = false, budget = requestBudget() } = {}) {
  if (!series.frame) return { occurrences: [], truncated: false, stops: [] };
  if (!budget.timed) return occurrencesWithin(series, range, filter, first, budget);
  // a request budget pays for all the time spent here, not only in the library
  const timeLeft = budget.timeLeft;
  const started = performance.now();
  try {
    return occurrencesWithin(series, range, filter, first, budget);
  } finally {
    budget.timeLeft = timeLeft - (performance.now() - started);
  }
}

function occurrencesWithin(series, range, filter, first, budget) {
  const accept = (o) => {
    const { start, end } = spanOf(o);
    return touchesRange(start, end, range) && (!filter || filter(o));
  };
  let truncated = false;
  const stops = new Set();

  const { lead, trail } = reach(series);
  const from = series.frame.toWall(range.start - lead) - DST_SLACK_MS;
  const to = series.frame.toWall(range.end + trail) + DST_SLACK_MS;

  // only the overrides whose id lies in the window can replace anything it
  // walks (the others are checked below, or are irrelevant); the library
  // converts every one it is given, on every call
  const inWindow = series.overrides.filter((o) => o.wall >= from && o.wall <= to);
  const main = expand(series, from, to, inWindow, budget);
  if (main.unreadable) return { occurrences: [], truncated: true, stops: [], reason: main.unreadable };
  if (!main.complete) {
    truncated = true;
    stops.add(main.stoppedBy);
  }
  const { reached } = main;

  // which overrides are occurrences: those in the window from the window,
  // the others one by one
  const valid = new Map();
  for (const o of main.occurrences) {
    if (o.overridden) valid.set(o.wall, o);
  }
  const unchecked = new Set();
  const outside = series.overrides.filter((o) => !inWindow.includes(o)
    && (series.futures.includes(o) ? o.wall < from : mayTouch(o, range, series.zone)))
    .sort((a, b) => a.wall - b.wall);
  for (const cluster of clusters(series, outside)) {
    const first = cluster[0].wall;
    const last = cluster[cluster.length - 1].wall;
    const checked = expand(series, first, last, cluster, budget);
    for (const override of cluster) {
      // decided only below where an incomplete expansion stopped
      if (checked.unreadable || override.wall >= checked.reached) {
        unchecked.add(override);
        if (!checked.unreadable) stops.add(checked.stoppedBy);
        continue;
      }
      const own = checked.occurrences.find((o) => o.wall === override.wall && o.overridden);
      if (own) valid.set(override.wall, own);
    }
  }
  truncated ||= unchecked.size > 0;

  // a THISANDFUTURE override nobody could check may move what follows it:
  // nothing from its id on is reported
  const futures = series.futures.filter((f) => valid.has(f.wall));
  const unknown = series.futures.find((f) => unchecked.has(f) || (!valid.has(f.wall) && f.wall >= reached));
  const before = Math.min(reached, unknown ? unknown.wall : Infinity);

  const found = [];
  for (const [wall, raw] of valid) {
    const occurrence = asOccurrence(series, raw, series.byWall.get(wall).event);
    if (accept(occurrence)) found.push(occurrence);
  }
  for (const raw of main.occurrences) {
    if (raw.overridden || raw.wall >= before) continue;
    const occurrence = moved(series, raw, futures) ?? asOccurrence(series, raw, series.event);
    if (accept(occurrence)) found.push(occurrence);
  }

  found.sort(byStart);
  return { occurrences: first ? found.slice(0, 1) : found, truncated, stops: [...stops] };
}

/**
 * Overrides to check together: without a near-range start every expansion
 * walks from DTSTART anyway, so all in one; with one, those whose ids lie
 * close enough that walking between them is cheaper than another call.
 */
function clusters({ plan }, overrides) {
  if (overrides.length === 0) return [];
  if (!plan) return [overrides];
  const result = [[overrides[0]]];
  for (const override of overrides.slice(1)) {
    const current = result[result.length - 1];
    if ((override.wall - current[0].wall) / plan.periodMs <= CLUSTER_PERIODS) current.push(override);
    else result.push([override]);
  }
  return result;
}

/** Could an override's own time touch the range? (its own instants, with slack) */
function mayTouch({ event }, range, zone) {
  const start = orNull(() => toInstant(event.startDate, zone));
  if (start === null) return false;
  const end = orNull(() => toInstant(event.endDate ?? event.startDate, zone)) ?? start;
  return start < range.end + ZONE_SLACK_MS && Math.max(start, end) > range.start - ZONE_SLACK_MS;
}

/**
 * How far an occurrence can sit from its recurrence id, in ms: `lead` back
 * (it may start before its id and run on into the range), `trail` forward —
 * from the longest duration and the THISANDFUTURE moves.
 */
function reach(series) {
  const moves = [0];
  const durations = [durationOf(series.event)];
  for (const { event, wall } of series.futures) {
    const start = orNull(() => toInstant(event.startDate, series.zone));
    if (start !== null) moves.push(start - series.frame.toInstant(wall));
    durations.push(durationOf(event));
  }
  const finite = moves.filter(Number.isFinite);
  return {
    lead: Math.max(0, ...finite) + Math.max(0, ...durations) + ZONE_SLACK_MS,
    trail: -Math.min(0, ...finite) + ZONE_SLACK_MS,
  };
}

function durationOf(event) {
  const ms = orNull(() => event.duration.toSeconds() * 1000);
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/**
 * Expand the series' recurrence ids in the wall-clock window [from, to] with
 * tsdav-utils, over a copy whose DTSTART is moved to the period holding
 * `from` where shiftPlan allows (and only the given overrides). null when the
 * library cannot read the series.
 *
 * @returns {{occurrences: Object[], complete: boolean, stoppedBy: 'budget'|'library'|null, reached: number}|{unreadable: string}}
 *   occurrences: {wall, overridden, start, end} (the library's times);
 *   stoppedBy: why an incomplete list ended (the budget, or ical.js unable
 *   to go on as RFC 5545 has it); reached: the wall clock up to which the list is whole
 */
function expand(series, from, to, overrides, budget) {
  const { frame, plan } = series;
  if (budget.remaining <= 0 || budget.timeLeft <= 0) {
    budget.exhausted = true;
    return { occurrences: [], complete: false, stoppedBy: 'budget', reached: from };
  }
  const startWall = wallOfTime(series.event.startDate);
  let dtstart = startWall;
  let dropStart = false;
  if (plan?.kind === 'fixed') {
    const periods = Math.floor((from - startWall) / plan.periodMs);
    if (periods > 0) {
      dtstart = startWall + periods * plan.periodMs;
      // the library counts DTSTART whatever the rule says (RFC 5545 does,
      // for the real one): a moved one counts only if the rule makes it
      dropStart = !generates(plan.rule, dtstart) || pastUntil(series, dtstart);
    }
  } else if (plan?.kind === 'calendar') {
    // its own (first) period lies before `from`: whatever ical.js makes of
    // a period it starts in the middle of is never used, the moved start
    // itself included
    dtstart = calendarAnchor(plan, startWall, from) ?? startWall;
  }

  const started = performance.now();
  const slice = createRecurrenceBudget(Math.min(budget.remaining, CALL_UNITS));
  const sliced = slice.remaining;
  // toJSON is ical.js' live jCal: clone it, or the copy's DTSTART would move
  // the series itself
  const clone = (component) => new ICAL.Component(structuredClone(component.toJSON()));
  // read in the zone the series is read in
  const copy = setFloatingZone(new ICAL.Component(['vcalendar', [], []]), series.zone);
  for (const vtimezone of series.root?.getAllSubcomponents('vtimezone') ?? []) {
    copy.addSubcomponent(clone(vtimezone));
  }
  const master = clone(series.master);
  // only the EXDATEs near the window can exclude anything in it; the library
  // reads every one it is given, on every call
  for (const property of master.getAllProperties('exdate')) {
    const near = property.getValues().filter((value) => {
      const wall = orNull(() => wallOfTime(value));
      return wall === null || (wall >= from - 2 * 864e5 && wall <= to + 2 * 864e5);
    });
    if (near.length === 0) master.removeProperty(property);
    else if (near.length < property.getValues().length) property.setValues(near);
  }
  if (dtstart !== startWall) {
    const delta = dtstart - startWall;
    master.getFirstProperty('dtstart').setValue(wallValue(dtstart, frame));
    const dtend = master.getFirstProperty('dtend');
    if (dtend) dtend.setValue(wallValue(wallOfTime(dtend.getFirstValue()) + delta, frameOfProperty(dtend)));
  }
  copy.addSubcomponent(master);
  for (const { component } of overrides) copy.addSubcomponent(clone(component));

  const bound = (wall) => (frame.kind === 'date' ? wallText(wall).slice(0, 10) : wallText(wall));
  let result;
  try {
    result = expandOccurrences(copy, {
      budget: slice,
      from: bound(from),
      until: bound(to + (frame.kind === 'date' ? 86400000 : 1000)),
      limit: Number.MAX_SAFE_INTEGER,
    });
  } catch (error) {
    return { unreadable: error?.message || String(error) };
  } finally {
    budget.remaining -= sliced - slice.remaining + CALL_COST;
    if (budget.timed) budget.timeLeft -= performance.now() - started;
    expansionWork.units += sliced - slice.remaining + CALL_COST;
    expansionWork.calls += 1;
    expansionWork.overridesHanded += overrides.length;
  }
  // a library stop spends no budget: the rest of the call may go on
  const stoppedBy = result.complete ? null : result.stoppedBy === 'library' ? 'library' : 'budget';
  if (stoppedBy === 'budget') budget.exhausted = true;

  const occurrences = [];
  for (const o of result.occurrences) {
    const wall = wallOfText(o.recurrenceId.value);
    if (dropStart && wall === dtstart) continue;
    if (plan?.lastWall !== undefined && plan.lastWall !== null && wall > plan.lastWall) continue;
    occurrences.push({ wall, overridden: o.overridden, start: o.start, end: o.end });
  }
  const last = occurrences.length ? occurrences[occurrences.length - 1].wall : from;
  return { occurrences, complete: result.complete, stoppedBy, reached: result.complete ? Infinity : last };
}

/**
 * Where a copy of a MONTHLY or YEARLY series may start for a walk from
 * `from`: DTSTART moved by whole periods on the wall calendar (same day of
 * the month, same time) to a period that ends before the month (or year)
 * holding `from` begins — so the walk's first period, which ical.js may
 * compute from the moved start on (BYSETPOS, days earlier in the month), is
 * never used. A moved day that does not exist (31 in April, 29 February) is
 * passed over for an earlier period. null where no whole period fits.
 */
function calendarAnchor(plan, startWall, from) {
  const s = new Date(startWall);
  const f = new Date(from);
  const index = (d) => (plan.unit === 'month' ? d.getUTCFullYear() * 12 + d.getUTCMonth() : d.getUTCFullYear());
  for (let j = Math.floor((index(f) - index(s)) / plan.interval) - 1; j >= 1; j--) {
    const wall = calendarShift(plan, s, j);
    if (wall !== null) return wall;
  }
  return null;
}

/** DTSTART `periods` periods later on the wall calendar; null when that day does not exist */
function calendarShift(plan, s, periods) {
  const months = plan.unit === 'month' ? periods * plan.interval : periods * plan.interval * 12;
  const wall = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + months, s.getUTCDate(),
    s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds());
  return new Date(wall).getUTCDate() === s.getUTCDate() ? wall : null;
}

/** A wall clock as a value of the frame's form, for the copy's DTSTART */
function wallValue(wall, frame) {
  const d = new Date(wall);
  const fields = {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
  if (frame.kind === 'date') return new ICAL.Time({ ...fields, isDate: true });
  if (frame.kind === 'utc') return new ICAL.Time(fields, ICAL.Timezone.utcTimezone);
  return new ICAL.Time(fields);
}

/** One of the library's occurrences in this module's shape, `item` its component */
function asOccurrence(series, raw, item) {
  const start = timeFrom(series, raw.start);
  // no end given (no DTEND, DURATION, nor one of the master): RFC 5545 3.6.1
  // — a date lasts that day, a date-time no time at all
  const end = raw.end ? timeFrom(series, raw.end)
    : start.time.isDate ? timeFrom(series, { value: wallText(wallOfText(raw.start.value) + 864e5).slice(0, 10), tzid: null, instant: null })
      : start;
  return {
    recurrenceId: timeOf(raw.wall, series.frame, series.root, series.frame.toInstant(raw.wall)),
    startDate: start.time, endDate: end.time,
    startAt: start.at, endAt: end.at,
    item,
  };
}

/** A library OccurrenceTime as an ICAL.Time and its instant */
function timeFrom(series, { value, tzid, instant }) {
  const wall = wallOfText(value);
  if (value.length === 10) return { time: timeOf(wall, { kind: 'date' }), at: zoneInstant(series.zone, wall) };
  if (/Z$/.test(value)) return { time: timeOf(wall, { kind: 'utc' }), at: wall };
  if (tzid) {
    const at = instant ? Date.parse(instant) : wall;
    return { time: timeOf(wall, { kind: 'tzid', tzid }, series.root, at), at };
  }
  return { time: timeOf(wall, { kind: 'floating' }), at: zoneInstant(series.zone, wall) };
}

/**
 * An occurrence moved by the latest valid THISANDFUTURE override at or before
 * it: by that override's own move, as wall-clock time in its DTSTART's frame
 * (10:00 -> 11:00 stays 11:00 across a DST change), with its length and
 * properties. null when none applies.
 */
function moved(series, raw, futures) {
  let future = null;
  for (const candidate of futures) {
    if (candidate.wall > raw.wall) break;
    future = candidate;
  }
  if (!future) return null;
  const startProperty = future.component.getFirstProperty('dtstart');
  const frame = startProperty && frameOfProperty(startProperty);
  if (!frame) return null;
  const { event } = future;
  const ownStart = wallOfTime(event.startDate);
  const move = ownStart - frame.toWall(series.frame.toInstant(future.wall));
  const length = wallOfTime(event.endDate ?? event.startDate) - ownStart;
  const startWall = frame.toWall(series.frame.toInstant(raw.wall)) + move;
  const startAt = frame.toInstant(startWall);
  const endAt = frame.toInstant(startWall + length);
  return {
    recurrenceId: timeOf(raw.wall, series.frame, series.root, series.frame.toInstant(raw.wall)),
    startDate: timeOf(startWall, frame, series.root, startAt),
    endDate: timeOf(startWall + length, frame, series.root, endAt),
    startAt, endAt,
    item: event,
  };
}

// ---------------------------------------------------------------------------
// Where the walk may start

// Rule parts that keep a series periodic in its INTERVAL: the candidates are
// the same in every period, so the expansion can start a whole number of
// periods later without changing which occurrences it yields.
const PERIODIC_PARTS = new Set(['BYDAY', 'BYMONTH', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'WKST']);
const UNIT_SECONDS = { SECONDLY: 1, MINUTELY: 60, HOURLY: 3600, DAILY: 86400, WEEKLY: 604800 };
const TIME_PARTS = { BYHOUR: 3600, BYMINUTE: 60, BYSECOND: 1 };
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Whether, and in which steps, the expansion may start later than DTSTART.
 *
 * Walking from DTSTART costs one step per candidate since the series began:
 * a daily series from 2020 takes ~2400 to reach October 2026, an every-minute
 * one never gets there within a budget. For a SECONDLY to WEEKLY rule whose
 * BY parts are BYDAY (without an ordinal), BYMONTH, WKST, or a BYHOUR,
 * BYMINUTE or BYSECOND finer than the frequency (one that expands it, as
 * BYHOUR does a DAILY rule), the occurrences repeat every period on the
 * series' wall clock. So a DTSTART moved by whole periods yields the same
 * occurrences from there on; one the rule would not generate is dropped.
 * EXDATEs and overrides are absolute and still apply. With COUNT, only a rule
 * without BY parts qualifies: its last occurrence (`lastWall`) is DTSTART plus
 * COUNT-1 periods. Not shifted: RDATE, several RRULEs, MONTHLY, YEARLY, other
 * BY parts, a limiting BYHOUR/BYMINUTE/BYSECOND (BYHOUR on HOURLY: ical.js
 * does not step it on a fixed grid), and a DTEND in another frame than
 * DTSTART (the copy could not keep the length). Those are walked from
 * DTSTART, within the budget.
 */
function shiftPlan({ event, master, frame }) {
  const rules = master.getAllProperties('rrule');
  if (rules.length !== 1 || master.hasProperty('rdate')) return null;
  const rule = rules[0].getFirstValue();
  const dtend = master.getFirstProperty('dtend');
  if (dtend) {
    const own = frameOfProperty(dtend);
    if (!own || own.kind !== frame.kind || own.tzid !== frame.tzid) return null;
  }
  const parts = Object.keys(rule.parts ?? {});
  if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') return calendarPlan(event, rule, parts);

  const unit = UNIT_SECONDS[rule.freq];
  if (!unit) return null;
  if (parts.some((part) => !PERIODIC_PARTS.has(part))) return null;
  if ((rule.parts.BYDAY ?? []).some((day) => !WEEKDAYS.includes(String(day)))) return null;
  if (parts.some((part) => TIME_PARTS[part] && TIME_PARTS[part] >= unit)) return null;

  const period = (rule.interval || 1) * unit;
  if (frame.kind === 'date' && period % 86400 !== 0) return null;
  let lastWall = null;
  if (rule.count) {
    if (parts.some((part) => part !== 'WKST')) return null;
    lastWall = wallOfTime(event.startDate) + (rule.count - 1) * period * 1000;
  }
  return { kind: 'fixed', periodMs: period * 1000, lastWall, rule };
}

/**
 * MONTHLY and YEARLY: every BY part (BYDAY with or without an ordinal,
 * BYMONTHDAY negative or not, BYSETPOS, BYYEARDAY, BYWEEKNO, BYMONTH, the
 * time parts) is evaluated within each month or year, from its calendar and
 * the defaults DTSTART gives: day of the month, month, time of day — all
 * kept when DTSTART moves by whole periods on the wall calendar
 * (calendarAnchor) — provided every period holds an occurrence
 * (everyPeriodHasOne), as ical.js otherwise shifts its INTERVAL grid. Not
 * the weekday: YEARLY;BYWEEKNO without BYDAY takes DTSTART's weekday, which
 * a year later is another, so that is not shifted. COUNT only without BY parts and on a day every month has (1-28): its last
 * occurrence is then DTSTART plus COUNT-1 periods.
 */
function calendarPlan(event, rule, parts) {
  if (!everyPeriodHasOne(rule, parts, wallOfTime(event.startDate))) return null;
  const plan = {
    kind: 'calendar',
    unit: rule.freq === 'MONTHLY' ? 'month' : 'year',
    interval: rule.interval || 1,
    rule,
    lastWall: null,
  };
  plan.periodMs = plan.interval * (plan.unit === 'month' ? 30.44 : 365.25) * 864e5;
  if (rule.count) {
    const start = new Date(wallOfTime(event.startDate));
    if (parts.some((part) => part !== 'WKST') || start.getUTCDate() > 28) return null;
    plan.lastWall = calendarShift(plan, start, rule.count - 1);
  }
  return plan;
}

/**
 * Does every month (MONTHLY) or year (YEARLY) provably hold an occurrence?
 * Only then does ical.js keep its INTERVAL grid from a moved start: where a
 * period can be empty (the 31st, 29 February, a fifth Monday, week 53, day
 * 366 of the year, a BYSETPOS past the set) it shifts the grid, rolls into
 * the next month or stops, so such rules are walked from DTSTART (cheap for
 * monthly and yearly series). Provably non-empty: a BYMONTHDAY within ±28;
 * an ordinal BYDAY within ±4 of a month (±52 of a year); a plain BYDAY; a
 * BYYEARDAY within ±365; a BYWEEKNO within ±52 with BYDAY; DTSTART's day
 * when it is 1-28; BYSETPOS only over plain weekdays, within the four of
 * each a month surely has. Combinations that intersect (BYMONTHDAY with
 * BYDAY, ...) can be empty; so is every month of MONTHLY;BYMONTH that the
 * list leaves out.
 */
function everyPeriodHasOne(rule, parts, startWall) {
  const yearly = rule.freq === 'YEARLY';
  const has = (part) => parts.includes(part);
  const values = (part) => (rule.parts[part] ?? []).map(String);
  const numbers = (part) => values(part).map(Number);
  const known = ['BYMONTHDAY', 'BYDAY', 'BYMONTH', 'BYSETPOS', 'BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'WKST'];
  if (parts.some((part) => !known.includes(part))) return false;
  if (!yearly && has('BYMONTH')) return false;
  const dayParts = ['BYMONTHDAY', 'BYDAY', 'BYYEARDAY', 'BYWEEKNO'].filter(has);
  if (dayParts.length > 1 && dayParts.join() !== 'BYDAY,BYWEEKNO') return false;
  const within = (part, limit) => numbers(part).every((v) => Number.isInteger(v) && v !== 0 && Math.abs(v) <= limit);
  if (has('BYMONTHDAY') && !within('BYMONTHDAY', 28)) return false;
  const ordinals = values('BYDAY').map((day) => Number(day.slice(0, -2)) || 0);
  const ordinalLimit = !yearly || has('BYMONTH') ? 4 : 52;
  if (ordinals.some((n) => Math.abs(n) > ordinalLimit)) return false;
  if (has('BYYEARDAY') && (has('BYMONTH') || !within('BYYEARDAY', 365))) return false;
  if (has('BYWEEKNO') && (!has('BYDAY') || has('BYMONTH') || !within('BYWEEKNO', 52))) return false;
  if (dayParts.length === 0 && new Date(startWall).getUTCDate() > 28) return false;
  if (has('BYSETPOS')) {
    if (dayParts.join() !== 'BYDAY' || ordinals.some((n) => n !== 0)) return false;
    if (!within('BYSETPOS', 4 * values('BYDAY').length)) return false;
  }
  return true;
}

/**
 * Would the rule generate this wall clock as an occurrence? For the rules
 * shiftPlan admits: each BY part present holds its field (BYDAY its
 * weekday); an absent one defaults to DTSTART's, which whole periods later
 * is unchanged.
 */
function generates(rule, wall) {
  const d = new Date(wall);
  const holds = {
    BYDAY: WEEKDAYS[d.getUTCDay()],
    BYMONTH: d.getUTCMonth() + 1,
    BYHOUR: d.getUTCHours(),
    BYMINUTE: d.getUTCMinutes(),
    BYSECOND: d.getUTCSeconds(),
  };
  return Object.entries(holds).every(([part, value]) => {
    const allowed = rule.parts?.[part];
    return !allowed || allowed.map(String).includes(String(value));
  });
}

/** Does the rule's UNTIL end the series before this wall clock? */
function pastUntil({ plan, frame }, wall) {
  const until = plan.rule.until;
  if (!until) return false;
  if (until.isDate || frame.kind === 'date') return utcDay(wall) > wallOfTime(until);
  // UNTIL is UTC for a zoned series, floating for a floating one (RFC 5545)
  const instant = until.zone === ICAL.Timezone.utcTimezone || /Z$/.test(until.toString())
    ? wallOfTime(until) : frame.toInstant(wallOfTime(until));
  return frame.toInstant(wall) > instant;
}

function byStart(a, b) {
  return spanOf(a).start - spanOf(b).start || toInstant(a.recurrenceId) - toInstant(b.recurrenceId);
}

/**
 * Does provably no occurrence of the series touch the range? Decided from
 * its bounds alone, without expanding: no occurrence starts before the
 * earliest of DTSTART, the RDATEs and the overrides' starts, and none ends
 * after the latest of the rule's last start (from UNTIL, or from COUNT where
 * every period of the rule surely holds an occurrence) plus the duration,
 * the RDATEs' ends and the overrides' ends. Or, between those bounds: none
 * of DTSTART, the RDATEs and the overrides comes near the range, and no day
 * of it meets the rule (ruleMissesRange). A THISANDFUTURE override, an
 * unbounded or unreadable rule, a value that cannot be placed: not provable,
 * false. Floating times and dates carry a zone offset of slack, the rule a
 * DST change of it.
 *
 * @param {ReturnType<typeof relateSeries>} series
 * @param {{start: number, end: number}} range - ms
 * @returns {boolean}
 */
export function seriesOutside(series, range) {
  if (!series.frame || series.futures.length > 0) return false;
  const { event, master, zone } = series;
  const at = (time) => orNull(() => toInstant(time, zone));
  const start = at(event.startDate);
  if (start === null) return false;
  const duration = durationOf(event);

  const spans = [];
  for (const value of master.getAllProperties('rdate').flatMap((p) => p.getValues())) {
    const period = value instanceof ICAL.Period;
    const from = at(period ? value.start : value);
    const to = period ? at(value.getEnd()) : from + duration;
    if (from === null || to === null) return false;
    spans.push([from, to]);
  }
  for (const { event: own } of series.overrides) {
    const from = at(own.startDate);
    if (from === null) return false;
    spans.push([from, at(own.endDate ?? own.startDate) ?? from]);
  }

  const slack = ZONE_SLACK_MS + DST_SLACK_MS;
  if (Math.min(start, ...spans.map(([from]) => from)) - slack >= range.end) return true;
  const last = lastRuleStart(series, start);
  if (last !== null && Math.max(last + duration, ...spans.map(([, to]) => to)) + slack <= range.start) return true;
  // the rule's days miss the range, and so do DTSTART, the RDATEs and the
  // overrides: a birthday in March for a week in November
  const near = ([from, to]) => from - slack < range.end && to + slack > range.start;
  return !near([start, start + duration]) && !spans.some(near) && ruleMissesRange(series, range, duration, slack);
}

// Longest range, in days, whose days ruleMissesRange checks one by one
const RULE_DAYS_CHECKED = 400;

/**
 * Does no day of the range (widened by the occurrence length and `slack`)
 * meet the series' rule? Each day is tested against what RFC 5545 makes
 * every occurrence's day hold: BYMONTH, BYMONTHDAY, the weekdays of BYDAY
 * (with an ordinal in a month, the seven days it can fall on), and
 * DTSTART's month, day of month or weekday where the rule takes those from
 * it. A necessary condition only, never sufficient: years, INTERVAL, COUNT,
 * BYSETPOS and the time parts are not looked at, so a day passing it may
 * still hold no occurrence, but a day failing it holds none. BYYEARDAY,
 * BYWEEKNO, several RRULEs, a range of more than RULE_DAYS_CHECKED days or a
 * rule that cannot be read: not decided, false.
 *
 * tsdav-utils works out a fixed-day yearly rule without walking it, but each
 * call into it still costs a call (CALL_COST) and a copy of the series: a
 * calendar of 5 000 birthdays would spend the extra pool on calls that each
 * find nothing (#170). This keeps those calls from being made.
 */
function ruleMissesRange({ master, event, frame }, range, duration, slack) {
  const rules = master.getAllProperties('rrule');
  if (rules.length !== 1) return false;
  const rule = orNull(() => rules[0].getFirstValue());
  if (!rule?.freq) return false;
  const parts = rule.parts ?? {};
  if (parts.BYYEARDAY || parts.BYWEEKNO) return false;
  const startWall = orNull(() => wallOfTime(event.startDate));
  if (startWall === null) return false;
  // a date without an end still takes its whole day
  const length = frame.kind === 'date' ? Math.max(duration, 864e5) : duration;
  // the wall-clock days an occurrence touching the range can start on
  const first = utcDay(range.start - length - slack) - 864e5;
  const last = utcDay(range.end + slack);
  if ((last - first) / 864e5 > RULE_DAYS_CHECKED) return false;
  const takes = dayTest(rule, new Date(startWall));
  if (!takes) return false;
  for (let day = first; day <= last; day += 864e5) {
    if (takes(new Date(day))) return false;
  }
  return true;
}

/**
 * The test a day must pass to hold an occurrence of `rule` (see
 * ruleMissesRange), on UTC Date fields read as the wall clock; null when a
 * value cannot be read.
 */
function dayTest(rule, start) {
  const parts = rule.parts ?? {};
  const numbers = (part) => (parts[part] ?? []).map(Number);
  const months = numbers('BYMONTH');
  const monthDays = numbers('BYMONTHDAY');
  const byDay = (parts.BYDAY ?? []).map((value) => {
    const text = String(value);
    return { weekday: text.slice(-2), ordinal: Number(text.slice(0, -2)) || 0 };
  });
  if ([...months, ...monthDays].some((v) => !Number.isInteger(v))) return null;
  if (byDay.some(({ weekday, ordinal }) => !WEEKDAYS.includes(weekday) || !Number.isInteger(ordinal))) return null;
  const { freq } = rule;
  const yearly = freq === 'YEARLY';
  // an ordinal counts within the month for MONTHLY, and for YEARLY with
  // BYMONTH; within the year otherwise, which is not narrowed here
  const monthOrdinal = freq === 'MONTHLY' || (yearly && months.length > 0);
  // what the rule takes from DTSTART (RFC 5545 3.3.10)
  const startMonth = yearly && !months.length && !monthDays.length && !byDay.length ? start.getUTCMonth() + 1 : null;
  const startDay = (yearly || freq === 'MONTHLY') && !monthDays.length && !byDay.length ? start.getUTCDate() : null;
  const startWeekday = freq === 'WEEKLY' && !byDay.length ? WEEKDAYS[start.getUTCDay()] : null;

  return (d) => {
    const month = d.getUTCMonth() + 1;
    const date = d.getUTCDate();
    const weekday = WEEKDAYS[d.getUTCDay()];
    const length = new Date(Date.UTC(d.getUTCFullYear(), month, 0)).getUTCDate();
    if (months.length && !months.includes(month)) return false;
    if (startMonth !== null && month !== startMonth) return false;
    if (startDay !== null && date !== startDay) return false;
    if (startWeekday !== null && weekday !== startWeekday) return false;
    if (monthDays.length && !monthDays.some((v) => (v > 0 ? v : length + 1 + v) === date)) return false;
    if (byDay.length && !byDay.some(({ weekday: w, ordinal }) => {
      if (w !== weekday) return false;
      if (!ordinal || !monthOrdinal) return true;
      const nth = ordinal > 0 ? Math.ceil(date / 7) : -Math.ceil((length + 1 - date) / 7);
      return nth === ordinal;
    })) return false;
    return true;
  };
}

// ms per period for the rule frequencies, the longest a period can be
const PERIOD_MS = { ...Object.fromEntries(Object.entries(UNIT_SECONDS).map(([f, s]) => [f, s * 1000])), MONTHLY: 31 * 864e5, YEARLY: 366 * 864e5 };
// BY parts that never empty a period of a rule coarser than the part
const FINER = { BYHOUR: ['DAILY', 'WEEKLY'], BYMINUTE: ['HOURLY', 'DAILY', 'WEEKLY'], BYSECOND: ['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY'], BYDAY: ['WEEKLY'], WKST: Object.keys(PERIOD_MS) };

/** The latest start the series' rule can have, as an instant; null when unbounded or unknown */
function lastRuleStart({ master, event, zone }, start) {
  const rules = master.getAllProperties('rrule');
  if (rules.length === 0) return start;
  if (rules.length > 1) return null;
  const rule = orNull(() => rules[0].getFirstValue());
  if (!rule) return null;
  if (rule.until) {
    const until = orNull(() => toInstant(rule.until, zone));
    // a date UNTIL includes its whole day
    return until === null ? null : until + 864e5;
  }
  if (!rule.count || !PERIOD_MS[rule.freq]) return null;
  const parts = Object.keys(rule.parts ?? {});
  const filled = rule.freq === 'MONTHLY' || rule.freq === 'YEARLY'
    ? everyPeriodHasOne(rule, parts, wallOfTime(event.startDate))
    : parts.every((part) => FINER[part]?.includes(rule.freq));
  if (!filled) return null;
  // the COUNT-th occurrence lies within the first COUNT periods
  return start + rule.count * (rule.interval || 1) * PERIOD_MS[rule.freq];
}

function orNull(compute) {
  try {
    return compute();
  } catch {
    return null;
  }
}

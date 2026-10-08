import ICAL from 'ical.js';
import { expandOccurrences, createRecurrenceBudget, resolvePropertyZone, resolveZone } from 'tsdav-utils';
import { toInstant, timezoneFor } from './tools/shared/ical-dates.js';

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
 * is read on the host clock, a date as its UTC day.
 */

/**
 * The work one tool call may spend expanding recurring events, across all of
 * them, in tsdav-utils units: one per rule candidate ical.js tests, which
 * measures at 1-15 microseconds each here, so this is about a second at
 * worst. Created once per call (requestBudget) and passed down; a series it
 * does not cover is reported incomplete, never wrong.
 */
const REQUEST_BUDGET = 150000;

/**
 * What one call into the library costs on top of its candidates, charged to
 * the same budget: it reads the object's VTIMEZONEs anew (expanding their DST
 * rules) on every call, which the library does not count. Bounds how many
 * calls one tool call makes, however many overrides its series hold.
 */
const CALL_COST = 100;

// Overrides whose recurrence ids lie at most this many periods apart are
// checked in one call: walking the periods between (a few units each) costs
// less than another call (CALL_COST).
const CLUSTER_PERIODS = 20;

/** A fresh budget for one tool call */
export function requestBudget() {
  return createRecurrenceBudget(REQUEST_BUDGET);
}

/**
 * Milliseconds a wall-clock time can sit away from the same digits read as
 * UTC: zone offsets run from UTC-12 to UTC+14. For bounds that compare a
 * floating time read in the host's zone with an instant (calendar_query's
 * sort key), and for windows estimated before the library reads them.
 */
export const ZONE_SLACK_MS = 26 * 3600 * 1000;

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
 * (`startAt`/`endAt`) where it did, else as toInstant reads its times.
 *
 * @param {{startDate: ICAL.Time, endDate?: ICAL.Time, startAt?: number, endAt?: number}} occurrence
 * @returns {{start: number, end: number}}
 */
export function spanOf({ startDate, endDate, startAt, endAt }) {
  const start = startAt ?? toInstant(startDate);
  const end = endAt ?? (endDate ? toInstant(endDate) : start);
  return { start, end: Math.max(start, end) };
}

// ---------------------------------------------------------------------------
// Frames: the wall clock a value is written on, and its instants

/**
 * The frame of a date or date-time property: how its wall clock (ms of its
 * digits read as UTC) and instants convert. A TZID is converted by
 * tsdav-utils (the object's VTIMEZONE, else IANA data; RFC 5545 3.3.5 at DST
 * changes); floating times by the host clock. null for a TZID neither knows.
 */
function frameOfProperty(property) {
  const value = property.getFirstValue();
  if (value.isDate || property.type === 'date') return { kind: 'date', toWall: utcDay, toInstant: (w) => w };
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
  return {
    kind: 'floating',
    toWall: (ms) => {
      const d = new Date(ms);
      return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    },
    toInstant: (wall) => {
      const d = new Date(wall);
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
    },
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
const MAX_ZONES = 64;
function zoneOf(property, tzid) {
  let root = property.parent;
  while (root?.parent) root = root.parent;
  const vtimezone = root?.getAllSubcomponents('vtimezone').find((z) => z.getFirstPropertyValue('tzid') === tzid);
  const key = vtimezone ? `${tzid}\n${vtimezone.toString()}` : tzid;
  if (!zones.has(key)) {
    if (zones.size >= MAX_ZONES) zones.clear();
    zones.set(key, vtimezone ? resolveZone(tzid, vtimezone) : resolvePropertyZone(property));
  }
  return zones.get(key);
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
  const series = { event, root, master, frame, overrides: [], byWall: new Map(), futures: [], plan: null };
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
 * @returns {{occurrences: Object[], truncated: boolean}} sorted by start,
 *   then recurrence id; truncated when the budget ran out (or the series
 *   could not be read): some occurrences may then be missing, but none is
 *   wrong — an override that could not be checked is left out, and so is
 *   every occurrence a THISANDFUTURE override that could not be checked
 *   might move.
 */
export function seriesOccurrences(series, range, { filter = null, first = false, budget = requestBudget() } = {}) {
  if (!series.frame) return { occurrences: [], truncated: false };
  const accept = (o) => {
    const { start, end } = spanOf(o);
    return touchesRange(start, end, range) && (!filter || filter(o));
  };
  let truncated = false;

  const { lead, trail } = reach(series);
  const from = series.frame.toWall(range.start - lead) - DST_SLACK_MS;
  const to = series.frame.toWall(range.end + trail) + DST_SLACK_MS;

  const main = expand(series, from, to, series.overrides, budget);
  if (!main) return { occurrences: [], truncated: true };
  truncated ||= !main.complete;
  const { reached } = main;

  // which overrides are occurrences: those in the window from the window,
  // the others one by one
  const valid = new Map();
  for (const o of main.occurrences) {
    if (o.overridden) valid.set(o.wall, o);
  }
  const unchecked = new Set();
  const outside = series.overrides.filter((o) => (o.wall < from || o.wall > to)
    && (series.futures.includes(o) ? o.wall < from : mayTouch(o, range)))
    .sort((a, b) => a.wall - b.wall);
  for (const cluster of clusters(series, outside)) {
    const first = cluster[0].wall;
    const last = cluster[cluster.length - 1].wall;
    const checked = expand(series, first, last, cluster, budget);
    for (const override of cluster) {
      // decided only below where an incomplete expansion stopped
      if (!checked || override.wall >= checked.reached) {
        unchecked.add(override);
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
  return { occurrences: first ? found.slice(0, 1) : found, truncated };
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
function mayTouch({ event }, range) {
  const start = orNull(() => toInstant(event.startDate));
  if (start === null) return false;
  const end = orNull(() => toInstant(event.endDate ?? event.startDate)) ?? start;
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
    const start = orNull(() => toInstant(event.startDate));
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
 * @returns {{occurrences: Object[], complete: boolean, reached: number}|null}
 *   occurrences: {wall, overridden, start, end} (the library's times);
 *   reached: the wall clock up to which the list is whole
 */
function expand(series, from, to, overrides, budget) {
  const { frame, plan } = series;
  // the call's own cost first; nothing left: not called at all
  budget.remaining -= CALL_COST;
  if (budget.remaining <= 0) return { occurrences: [], complete: false, reached: from };
  const startWall = wallOfTime(series.event.startDate);
  let dtstart = startWall;
  let dropStart = false;
  if (plan) {
    const periods = Math.floor((from - startWall) / plan.periodMs);
    if (periods > 0) {
      dtstart = startWall + periods * plan.periodMs;
      // the library counts DTSTART whatever the rule says (RFC 5545 does,
      // for the real one): a moved one counts only if the rule makes it
      dropStart = !generates(plan.rule, dtstart) || pastUntil(series, dtstart);
    }
  }

  // toJSON is ical.js' live jCal: clone it, or the copy's DTSTART would move
  // the series itself
  const clone = (component) => new ICAL.Component(structuredClone(component.toJSON()));
  const copy = new ICAL.Component(['vcalendar', [], []]);
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
      budget,
      from: bound(from),
      until: bound(to + (frame.kind === 'date' ? 86400000 : 1000)),
      limit: Number.MAX_SAFE_INTEGER,
    });
  } catch {
    return null;
  }

  const occurrences = [];
  for (const o of result.occurrences) {
    const wall = wallOfText(o.recurrenceId.value);
    if (dropStart && wall === dtstart) continue;
    if (plan?.lastWall !== undefined && plan.lastWall !== null && wall > plan.lastWall) continue;
    occurrences.push({ wall, overridden: o.overridden, start: o.start, end: o.end });
  }
  const last = occurrences.length ? occurrences[occurrences.length - 1].wall : from;
  return { occurrences, complete: result.complete, reached: result.complete ? Infinity : last };
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
  const end = raw.end ? timeFrom(series, raw.end) : start;
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
  if (value.length === 10) return { time: timeOf(wall, { kind: 'date' }), at: wall };
  if (/Z$/.test(value)) return { time: timeOf(wall, { kind: 'utc' }), at: wall };
  if (tzid) {
    const at = instant ? Date.parse(instant) : wall;
    return { time: timeOf(wall, { kind: 'tzid', tzid }, series.root, at), at };
  }
  const floating = frameOfProperty(series.master.getFirstProperty('dtstart'));
  const at = floating?.kind === 'floating' ? floating.toInstant(wall) : toInstant(new ICAL.Time(fieldsOf(wall)));
  return { time: timeOf(wall, { kind: 'floating' }), at };
}

const fieldsOf = (wall) => {
  const d = new Date(wall);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
};

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
  const unit = UNIT_SECONDS[rule.freq];
  if (!unit) return null;
  const parts = Object.keys(rule.parts ?? {});
  if (parts.some((part) => !PERIODIC_PARTS.has(part))) return null;
  if ((rule.parts.BYDAY ?? []).some((day) => !WEEKDAYS.includes(String(day)))) return null;
  if (parts.some((part) => TIME_PARTS[part] && TIME_PARTS[part] >= unit)) return null;
  const dtend = master.getFirstProperty('dtend');
  if (dtend) {
    const own = frameOfProperty(dtend);
    if (!own || own.kind !== frame.kind || own.tzid !== frame.tzid) return null;
  }

  const period = (rule.interval || 1) * unit;
  if (frame.kind === 'date' && period % 86400 !== 0) return null;
  let lastWall = null;
  if (rule.count) {
    if (parts.some((part) => part !== 'WKST')) return null;
    lastWall = wallOfTime(event.startDate) + (rule.count - 1) * period * 1000;
  }
  return { periodMs: period * 1000, lastWall, rule };
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

function orNull(compute) {
  try {
    return compute();
  } catch {
    return null;
  }
}

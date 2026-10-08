import ICAL from 'ical.js';
import { seriesMaster } from 'tsdav-utils';
import { ValidationError } from './error-handler.js';
import { relateSeries, seriesOccurrences, spanOf, touchesRange } from './occurrences.js';

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

/**
 * A queried time range as ms instants, or null when there is none. Goes
 * through Date so every form the schema accepts — with or without
 * milliseconds, "Z" or a "+02:00" offset — lands on the same instant.
 */
function msRange(timeRange) {
  if (!timeRange?.start || !timeRange?.end) return null;
  const start = new Date(timeRange.start).getTime();
  const end = new Date(timeRange.end).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

/**
 * The event as a reader shows it — the one place that decides, so the event
 * list and calendar_query's SUMMARY/LOCATION filters read the same thing.
 *
 *  - No time range: the series master (readSeries). A search without a range
 *    therefore only searches the series, not its renamed occurrences.
 *  - A time range and a recurring series: the earliest occurrence that
 *    touches the range once its overrides apply (src/occurrences.js — the
 *    same test free/busy uses, so a meeting running into the range is in
 *    it) — the earliest one `matches` accepts, when a search passes it. An
 *    occurrence moved into the range from outside it counts, one moved out
 *    of it does not, and it is listed with its own title, place and date.
 *    A cancelled occurrence is still an occurrence; the display says so.
 *  - A time range and several detached instances without a master: the
 *    first instance touching the range (that `matches` accepts, if given),
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
  const range = msRange(timeRange);

  let vevent = series.master;
  if (range && series.detached.length > 1) {
    const inRange = series.detached.filter((instance) => touches(new ICAL.Event(instance), range));
    vevent = inRange.find((instance) => !matches || matches(instance)) ?? inRange[0] ?? vevent;
  }
  const related = relateSeries(vevent, series.overrides);
  const { event } = related;

  let occurrence = null;
  let outsideRange = false;
  let expansionTruncated = false;
  if (range && event.isRecurring()) {
    const filter = matches ? (o) => matches(o.item.component) : null;
    const result = seriesOccurrences(related, range, { filter, first: true });
    occurrence = result.occurrences[0] ?? null;
    // capped: the occurrence found may not be the earliest, or none was found
    expansionTruncated = result.truncated;
    outsideRange = !occurrence && !result.truncated;
  }

  return {
    vevent, event, occurrence,
    item: occurrence ? occurrence.item : event,
    outsideRange, expansionTruncated,
  };
}

function touches(event, range) {
  if (!event.startDate) return false;
  const { start, end } = spanOf({ startDate: event.startDate, endDate: event.endDate });
  return touchesRange(start, end, range);
}

/**
 * Does an event or occurrence occupy time? TRANSP:TRANSPARENT is the RFC 5545
 * way of saying "this does not block me", and a cancelled one does not
 * either. Values are case-insensitive. Read on the component itself: an
 * override is a full component, so one without STATUS of a cancelled series
 * is not cancelled.
 *
 * @param {ICAL.Component} vevent
 * @returns {boolean}
 */
export function blocksTime(vevent) {
  const value = (name) => String(vevent.getFirstPropertyValue(name) ?? '').toUpperCase();
  return value('transp') !== 'TRANSPARENT' && value('status') !== 'CANCELLED';
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

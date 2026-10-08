import ICAL from 'ical.js';
import { toInstant } from './ical-dates.js';
import { readSeries, seriesOccurrences } from '../../ical-components.js';

/**
 * Client-side free/busy calculation.
 *
 * The native CalDAV free-busy-query REPORT is barely supported in practice —
 * Google and iCloud do not answer it, Radicale never implemented it, Nextcloud
 * and Baikal have open bugs — so this derives the same answer from the events
 * themselves, which every server can serve. The cost is needing read access to
 * the calendar rather than only free/busy access, and more data on the wire.
 */

/**
 * Busy intervals contributed by a single calendar object.
 *
 * Skips anything that does not actually occupy time (see blocksTime) — for a
 * recurring event, judged per occurrence. All-day events count as busy for
 * their whole span.
 */
function busyIntervalsOf(calendarObject, range) {
  const intervals = [];

  let comp;
  try {
    comp = new ICAL.Component(ICAL.parse(calendarObject.data));
  } catch {
    // A single unparseable object must not take the whole answer down
    return intervals;
  }

  const series = readSeries(comp, 'vevent');
  if (!series) return intervals;

  const add = (start, end) => {
    const from = Math.max(toInstant(start), range.start.getTime());
    const to = Math.min(toInstant(end), range.end.getTime());
    if (to > from) intervals.push({ start: from, end: to });
  };

  // Detached instances stored without their master (see readSeries): no
  // series to expand, but each instance occupies its own time.
  if (series.detached.length > 0) {
    for (const instance of series.detached) {
      if (!blocksTime(instance)) continue;
      const event = new ICAL.Event(instance);
      add(event.startDate, event.endDate);
    }
    return intervals;
  }

  const { master } = series;
  const event = new ICAL.Event(master);
  for (const override of series.overrides) {
    event.relateException(override);
  }

  if (!event.isRecurring()) {
    if (blocksTime(master)) add(event.startDate, event.endDate);
    return intervals;
  }

  // Each occurrence as it now stands: an override's own time, and its own
  // STATUS and TRANSP — a cancelled occurrence of a busy series is free, a
  // moved one is busy where it moved to (see seriesOccurrences)
  const window = { start: range.start.getTime() / 1000, end: range.end.getTime() / 1000 };
  const busy = (occurrence) => blocksTime(occurrence.item.component)
    && toInstant(occurrence.startDate) < range.end.getTime()
    && toInstant(occurrence.endDate) > range.start.getTime();
  for (const occurrence of seriesOccurrences(event, window, busy).occurrences) {
    add(occurrence.startDate, occurrence.endDate);
  }

  return intervals;
}

/**
 * Does a VEVENT occupy time? TRANSP:TRANSPARENT is the RFC 5545 way of saying
 * "this does not block me", and a cancelled event does not either.
 */
export function blocksTime(vevent) {
  return vevent.getFirstPropertyValue('transp') !== 'TRANSPARENT' &&
    vevent.getFirstPropertyValue('status') !== 'CANCELLED';
}

/**
 * Merge overlapping and touching intervals into a minimal set.
 */
function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];

  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    // touching counts as overlapping: back-to-back meetings are one busy block,
    // not two with a zero-length gap between them
    if (interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

/**
 * Compute busy and free intervals for a set of calendar objects.
 *
 * @param {Array} calendarObjects - DAV objects with a `data` property
 * @param {{ start: Date, end: Date }} range
 * @returns {{
 *   busy: Array<{start: Date, end: Date}>,
 *   free: Array<{start: Date, end: Date}>,
 *   blocking: Array,
 * }} blocking: the objects that make up the busy time, in input order — not
 *   the ones the server returned for the range but that block none of it
 *   (transparent, cancelled, or only their cancelled occurrences in range)
 */
export function calculateFreeBusy(calendarObjects, range) {
  const perObject = calendarObjects.map(object => busyIntervalsOf(object, range));
  const busy = mergeIntervals(perObject.flat());

  const free = [];
  let cursor = range.start.getTime();

  for (const interval of busy) {
    if (interval.start > cursor) {
      free.push({ start: new Date(cursor), end: new Date(interval.start) });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < range.end.getTime()) {
    free.push({ start: new Date(cursor), end: new Date(range.end) });
  }

  return {
    busy: busy.map(i => ({ start: new Date(i.start), end: new Date(i.end) })),
    free,
    blocking: calendarObjects.filter((_, index) => perObject[index].length > 0),
  };
}

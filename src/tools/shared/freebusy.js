import ICAL from 'ical.js';
import { shareTimezones } from './ical-dates.js';
import { readSeries, blocksTime } from '../../ical-components.js';
import { relateSeries, seriesOccurrences, spanOf, touchesRange } from '../../occurrences.js';

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
 * What a calendar object contributes to free/busy: the occurrences of it that
 * block time in the range — the same occurrences calendar_query lists
 * (src/occurrences.js), less those that do not block (see blocksTime) or
 * last no time at all. All-day events block their whole span.
 *
 * `shown` is the view the event details print (formatEvent's `shown`), built
 * from these occurrences rather than by expanding the series a second time.
 *
 * @param {ICAL.Component} root - the parsed VCALENDAR
 * @param {{start: number, end: number}} range - ms
 * @returns {{occurrences: Object[], truncated: boolean, shown: Object|null}}
 */
export function busyOccurrencesOf(root, range) {
  const none = { occurrences: [], truncated: false, shown: null };
  const series = readSeries(root, 'vevent');
  if (!series) return none;
  const blocks = (occurrence) => {
    const { start, end } = spanOf(occurrence);
    return end > start && blocksTime(occurrence.item.component);
  };
  const own = (events) => events
    .filter((event) => event.startDate)
    .map((event) => ({ recurrenceId: null, startDate: event.startDate, endDate: event.endDate, item: event }))
    .filter((o) => {
      const { start, end } = spanOf(o);
      return touchesRange(start, end, range) && blocks(o);
    });

  // Detached instances stored without their master (see readSeries): no
  // series to expand, but each instance occupies its own time
  if (series.detached.length > 0) {
    const occurrences = own(series.detached.map((instance) => new ICAL.Event(instance)));
    if (occurrences.length === 0) return none;
    const { item } = occurrences[0];
    return { occurrences, truncated: false, shown: view(item.component, item, null, occurrences) };
  }

  const related = relateSeries(series.master, series.overrides);
  const { event } = related;
  if (!event.isRecurring()) {
    const occurrences = own([event]);
    if (occurrences.length === 0) return none;
    return { occurrences, truncated: false, shown: view(series.master, event, null, occurrences) };
  }

  const { occurrences, truncated } = seriesOccurrences(related, range, { filter: blocks });
  return {
    occurrences,
    truncated,
    shown: occurrences.length ? view(series.master, event, occurrences[0], occurrences) : null,
  };
}

function view(vevent, event, occurrence, occurrences) {
  return {
    vevent, event, occurrence,
    item: occurrence ? occurrence.item : event,
    outsideRange: false, expansionTruncated: false,
    occurrences,
  };
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
 *   blocking: Array<{object: Object, shown: Object}>,
 *   incomplete: Array<{object: Object, summary: string}>,
 * }} blocking: each object that makes up busy time, in input order, with the
 *   occurrences of it that do (`shown`, as formatEvent takes it) — not the
 *   objects the server returned for the range that block none of it.
 *   incomplete: series too dense to expand fully (the iteration cap): busy
 *   time from them may be missing, so the free time is not certain.
 */
export function calculateFreeBusy(calendarObjects, range) {
  const window = { start: range.start.getTime(), end: range.end.getTime() };
  const blocking = [];
  const incomplete = [];
  const intervals = [];

  for (const object of calendarObjects) {
    let root;
    try {
      root = shareTimezones(new ICAL.Component(ICAL.parse(object.data)));
    } catch {
      // A single unparseable object must not take the whole answer down
      continue;
    }
    const { occurrences, truncated, shown } = busyOccurrencesOf(root, window);
    if (truncated) {
      const summary = readSeries(root, 'vevent')?.master.getFirstPropertyValue('summary');
      incomplete.push({ object, summary: summary ? String(summary) : '' });
    }
    if (occurrences.length === 0) continue;
    blocking.push({ object, shown });
    for (const occurrence of occurrences) {
      const { start, end } = spanOf(occurrence);
      intervals.push({ start: Math.max(start, window.start), end: Math.min(end, window.end) });
    }
  }

  const busy = mergeIntervals(intervals);
  const free = [];
  let cursor = window.start;

  for (const interval of busy) {
    if (interval.start > cursor) {
      free.push({ start: new Date(cursor), end: new Date(interval.start) });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < window.end) {
    free.push({ start: new Date(cursor), end: new Date(window.end) });
  }

  return {
    busy: busy.map(i => ({ start: new Date(i.start), end: new Date(i.end) })),
    free,
    blocking,
    incomplete,
  };
}

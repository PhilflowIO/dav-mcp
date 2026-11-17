import ICAL from 'ical.js';
import { parseICal, unreadableReason } from '../../ical-parse.js';
import { shareTimezones, toInstant } from './ical-dates.js';
import { logicalLines, parseContentLine } from './content-lines.js';
import { setFloatingZone, objectFloatingZone, serverZone } from '../../calendar-zone.js';
import { readSeries, blocksTime } from '../../ical-components.js';
import { relateSeries, seriesOccurrences, spanOf, touchesRange, requestBudget, budgetPool } from '../../occurrences.js';

/**
 * Client-side free/busy calculation.
 *
 * The native CalDAV free-busy-query REPORT is barely supported in practice —
 * Google and iCloud do not answer it, Radicale never implemented it, Nextcloud
 * and Baikal have open bugs — so this derives the same answer from the
 * calendar objects themselves, which every server can serve: the events, and
 * the VFREEBUSY components a calendar stores (published busy time, RFC 4791
 * 7.10). The cost is needing read access to the calendar rather than only
 * free/busy access, and more data on the wire.
 */

/**
 * The busy types of RFC 5545 3.2.9, strongest first: where periods of
 * several types overlap, the time is reported as the strongest of them.
 * BUSY-UNAVAILABLE ("busy and cannot be scheduled") outranks BUSY, which
 * outranks BUSY-TENTATIVE. Busy time from events is BUSY.
 */
export const BUSY_TYPES = ['BUSY-UNAVAILABLE', 'BUSY', 'BUSY-TENTATIVE'];

/**
 * The busy type a FREEBUSY property stands for, or null for free time.
 * RFC 5545 3.2.9: BUSY when there is no FBTYPE, and an unknown one (an
 * x-name or a newer IANA token) is read as BUSY too.
 */
function busyType(fbtype) {
  const type = fbtype == null ? 'BUSY' : fbtype.toUpperCase();
  if (type === 'FREE') return null;
  return BUSY_TYPES.includes(type) ? type : 'BUSY';
}

/**
 * What the stored VFREEBUSY components of a calendar object contribute: each
 * FREEBUSY period that is not FREE and touches the range, clipped to it, with
 * its busy type.
 *
 * A period is a start and an end or a start and a duration; one property may
 * list several. RFC 5545 3.8.2.6 requires them in UTC. One without a Z is
 * read like an event's time rather than dropped, which would report
 * published busy time as free: with a TZID, in the object's VTIMEZONE of
 * that name, else the IANA zone, else, like a floating time, in the
 * calendar's zone (toInstant, the same lookup as for events).
 *
 * Read from the text, content line by content line (content-lines.js) and one
 * period at a time, rather than from ical.js's parse of the whole object:
 * ical.js refuses the whole object for one malformed period, and this keeps
 * the periods that can be read and counts the rest. Only FREEBUSY properties
 * of a VFREEBUSY directly in the VCALENDAR count. Components have to nest:
 * an END that does not close the open component, or one left open, makes
 * the object's structure unreadable (`broken`), and then none of its
 * periods count. Time and memory are linear in the text; only periods that
 * touch the range are kept.
 *
 * @param {string} text - the calendar object's iCalendar text
 * @param {Object} zone - the zone floating values are read in
 * @param {{start: number, end: number}} range - ms
 * @returns {{periods: Array<{start: number, end: number, type: string}>, unreadable: number, stored: boolean, events: boolean, broken: boolean, rest: string|null}}
 *   stored: whether the object has a VFREEBUSY; events: whether it has a
 *   VEVENT; rest: when it has a VFREEBUSY and nests properly, the text
 *   without it, every other line byte for byte as written, for reading its
 *   other components (a bad period does not cost the events their busy time)
 */
export function storedBusyOf(text, zone, range) {
  const periods = [];
  let unreadable = 0;
  let stored = false;
  let events = false;
  let broken = false;
  // the components the line is in, outermost first
  const stack = [];
  const inStored = () => stack.length === 2 && stack[0] === 'VCALENDAR' && stack[1] === 'VFREEBUSY';
  // where the top-level VFREEBUSY and VTIMEZONE components sit in the text
  const cut = [];
  const vtimezones = [];
  let opened = 0;
  // FREEBUSY properties to read once the whole text is seen: a VTIMEZONE
  // may come after the VFREEBUSY that uses it
  const properties = [];
  for (const { line, start, end } of logicalLines(text)) {
    const property = parseContentLine(line);
    if (!property) {
      // a FREEBUSY line that is not a content line is a period lost
      if (inStored() && /^FREEBUSY[;:]/i.test(line)) unreadable += 1;
      continue;
    }
    const { name, params, value } = property;
    if (name === 'BEGIN') {
      const component = value.trim().toUpperCase();
      stack.push(component);
      if (stack.length === 2 && stack[0] === 'VCALENDAR') {
        if (component === 'VFREEBUSY') stored = true;
        if (component === 'VEVENT') events = true;
        opened = start;
      }
      continue;
    }
    if (name === 'END') {
      const component = value.trim().toUpperCase();
      if (stack.at(-1) !== component) {
        broken = true;
        break;
      }
      stack.pop();
      if (stack.length === 1 && component === 'VFREEBUSY') cut.push([opened, end]);
      if (stack.length === 1 && component === 'VTIMEZONE') vtimezones.push([opened, end]);
      continue;
    }
    if (name !== 'FREEBUSY' || !inStored()) continue;
    const type = busyType(params.get('FBTYPE')?.[0] ?? null);
    if (type) properties.push({ type, tzid: params.get('TZID')?.[0] ?? null, value });
  }
  if (stack.length > 0) broken = true;
  if (broken) return { periods: [], unreadable: 0, stored, events, broken, rest: null };

  // the object's VTIMEZONEs, for ical.js to resolve a TZID by as it does in
  // an event (shareTimezones); without them a TZID is the IANA zone's
  let zones = new ICAL.Component('vcalendar');
  if (vtimezones.length > 0) {
    try {
      zones = new ICAL.Component(parseICal(['BEGIN:VCALENDAR', ...vtimezones.map(([from, to]) => text.slice(from, to).replace(/\r?\n$|\r$/, '')), 'END:VCALENDAR'].join('\r\n')));
    } catch {
      // unreadable definitions: the TZIDs fall back as an event's would
    }
  }
  const holder = new ICAL.Component('vfreebusy');
  shareTimezones(zones).addSubcomponent(holder);

  for (const { type, tzid, value } of properties) {
    const head = tzid == null ? 'FREEBUSY' : `FREEBUSY;TZID="${tzid}"`;
    for (const item of value.split(',')) {
      let start;
      let end;
      try {
        const property = ICAL.Property.fromString(`${head}:${item.trim()}`);
        // its TZID is looked up in the object's VTIMEZONEs (see above)
        property.parent = holder;
        const period = property.getFirstValue();
        start = toInstant(period.start, zone);
        end = period.end
          ? toInstant(period.end, zone)
          : start + period.duration.toSeconds() * 1000;
      } catch {
        unreadable += 1;
        continue;
      }
      // RFC 5545 3.3.9: a period has a positive length
      if (!(end > start)) {
        unreadable += 1;
        continue;
      }
      if (!touchesRange(start, end, range)) continue;
      periods.push({ start: Math.max(start, range.start), end: Math.min(end, range.end), type });
    }
  }

  let rest = null;
  if (stored) {
    rest = '';
    let from = 0;
    for (const [to, next] of cut) {
      rest += text.slice(from, to);
      from = next;
    }
    rest += text.slice(from);
  }
  return { periods, unreadable, stored, events, broken, rest };
}

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
 * @param {Object} [budget] - the tool call's expansion budget (requestBudget)
 * @returns {{occurrences: Object[], truncated: boolean, reason?: string, shown: Object|null}}
 *   reason: why the series could not be read at all, when that is why
 */
export function busyOccurrencesOf(root, range, budget = requestBudget()) {
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

  const { occurrences, truncated, reason } = seriesOccurrences(related, range, { filter: blocks, budget });
  return {
    occurrences,
    truncated,
    reason,
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
 * Busy blocks from busy intervals: overlapping and touching intervals of the
 * same type make one block, and where types overlap the strongest
 * (BUSY_TYPES) holds. With one type this is the minimal set of merged
 * intervals; back-to-back meetings are one busy block, not two with a
 * zero-length gap between them.
 *
 * @param {Array<{start: number, end: number, type: string}>} intervals
 * @returns {Array<{start: number, end: number, type: string}>}
 */
function busyBlocks(intervals) {
  const edges = [];
  for (const { start, end, type } of intervals) {
    const rank = BUSY_TYPES.indexOf(type);
    edges.push({ at: start, rank, step: 1 }, { at: end, rank, step: -1 });
  }
  edges.sort((a, b) => a.at - b.at);

  const open = BUSY_TYPES.map(() => 0);
  const blocks = [];
  for (let i = 0; i < edges.length;) {
    const at = edges[i].at;
    while (i < edges.length && edges[i].at === at) {
      open[edges[i].rank] += edges[i].step;
      i += 1;
    }
    const rank = open.findIndex((count) => count > 0);
    const last = blocks[blocks.length - 1];
    if (last && last.end === null) {
      if (rank === last.rank) continue;
      last.end = at;
    }
    if (rank !== -1) blocks.push({ start: at, end: null, rank });
  }
  return blocks.map(({ start, end, rank }) => ({ start, end, type: BUSY_TYPES[rank] }));
}

/**
 * Compute busy and free intervals for a set of calendar objects.
 *
 * @param {Array} calendarObjects - DAV objects with a `data` property
 * @param {{ start: Date, end: Date }} range
 * @returns {{
 *   busy: Array<{start: Date, end: Date, type?: string}>,
 *   free: Array<{start: Date, end: Date}>,
 *   blocking: Array<{object: Object, shown: Object}>,
 *   published: Array<Object>,
 *   incomplete: Array<{object: Object, summary: string}>,
 * }} busy: with its type (BUSY_TYPES) when that is not plain BUSY.
 *   blocking: each event object that makes up busy time, in input order, with
 *   the occurrences of it that do (`shown`, as formatEvent takes it) — not the
 *   objects the server returned for the range that block none of it.
 *   published: each object whose stored VFREEBUSY makes up busy time.
 *   incomplete: series too dense to expand fully (the iteration cap), and
 *   objects that could not be read at all, and (kind 'stored', with the
 *   count of `periods`) stored free/busy with periods that could not be
 *   read: busy time from them may be missing, so the free time is not
 *   certain.
 */
export function calculateFreeBusy(calendarObjects, range) {
  const window = { start: range.start.getTime(), end: range.end.getTime() };
  // one expansion budget for this answer (one tool call), shared fairly by
  // its objects
  const budget = budgetPool(calendarObjects.length);
  const blocking = [];
  const published = [];
  const incomplete = [];
  const intervals = [];

  for (const object of calendarObjects) {
    const text = typeof object.data === 'string' ? object.data : '';
    const stored = storedBusyOf(text, objectFloatingZone(object) ?? serverZone(), window);
    if (stored.broken && stored.stored) {
      // its periods cannot be told apart: the object is noted, and ical.js
      // decides about its events below, from the text as it is
      incomplete.push({ kind: 'stored', object, reason: 'its components do not nest (an END that closes no open BEGIN, or a BEGIN never closed)' });
    } else if (stored.stored) {
      if (stored.periods.length > 0) published.push(object);
      // one at a time: a spread of a large object's periods overflows the stack
      for (const period of stored.periods) intervals.push(period);
      if (stored.unreadable > 0) {
        incomplete.push({ kind: 'stored', object, periods: stored.unreadable });
      }
      // nothing else in it blocks time: no event to parse
      if (!stored.events) continue;
    }
    let root;
    try {
      // with a VFREEBUSY, the rest of the object: its periods are read above
      const data = stored.rest ?? object.data;
      root = setFloatingZone(shareTimezones(new ICAL.Component(parseICal(data))), objectFloatingZone(object));
    } catch (error) {
      // A single unparseable object must not take the whole answer down,
      // nor its busy time vanish unsaid: the answer is incomplete
      incomplete.push({ object, summary: '', reason: unreadableReason(error, 'iCalendar') });
      continue;
    }
    const share = budget.take();
    const { occurrences, truncated, reason, shown } = busyOccurrencesOf(root, window, share);
    budget.give(share);
    if (truncated) {
      const summary = readSeries(root, 'vevent')?.master.getFirstPropertyValue('summary');
      incomplete.push({ object, summary: summary ? String(summary) : '', reason: reason ?? null });
    }
    if (occurrences.length === 0) continue;
    blocking.push({ object, shown });
    for (const occurrence of occurrences) {
      const { start, end } = spanOf(occurrence);
      intervals.push({ start: Math.max(start, window.start), end: Math.min(end, window.end), type: 'BUSY' });
    }
  }

  const busy = busyBlocks(intervals);
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
    busy: busy.map(i => ({
      start: new Date(i.start),
      end: new Date(i.end),
      ...(i.type !== 'BUSY' && { type: i.type }),
    })),
    free,
    blocking,
    published,
    incomplete,
  };
}

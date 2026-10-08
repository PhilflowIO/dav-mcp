import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, calendarQuerySchema } from '../../validation.js';
import { formatEventList } from '../../formatters.js';
import { buildTimeRangeOptions, limitResults, DEFAULT_RESULT_LIMIT } from '../shared/helpers.js';
import ICAL from 'ical.js';
import { shownEvent } from '../../ical-components.js';
import { ZONE_SLACK_MS, requestBudget } from '../../occurrences.js';
import { instantOf, hasAbsoluteInstant } from '../shared/ical-dates.js';
import { parseObjects, textValues, containsText, dateKey, orNull } from '../shared/query-objects.js';

/**
 * Search and filter calendar events efficiently
 */
export const calendarQuery = {
  name: 'calendar_query',
  annotations: {
    title: 'Search events',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: '⭐ PREFERRED: Search and filter calendar events efficiently. Use instead of list_events to avoid loading thousands of entries. Omit calendar_url to search across ALL calendars automatically. With a time range, a recurring event is listed as its first occurrence in the range (one already running at the range start counts); a cancelled occurrence is listed too, with its Status.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'Optional: Specific calendar URL. Omit to search ALL calendars (recommended for "find events with X" queries). Only provide if user explicitly names a calendar. DO NOT use list_calendars first - that defeats cross-calendar search.',
      },
      time_range_start: {
        type: 'string',
        description: 'Start datetime (ISO 8601, e.g., 2025-10-30T00:00:00Z). If provided, time_range_end is REQUIRED. Calculate dates for "today", "this week", etc. Can be used alone (with end date) as sufficient filter.',
      },
      time_range_end: {
        type: 'string',
        description: 'End datetime (ISO 8601). If provided, time_range_start is REQUIRED. Both dates together form a complete filter. Do not omit if start is provided.',
      },
      summary_filter: {
        type: 'string',
        description: 'Search event titles/summaries containing this text (case-insensitive). Example: "meeting with Elena" or "standup". Can be used alone as sufficient filter.',
      },
      location_filter: {
        type: 'string',
        description: 'Search event locations containing this text. Example: "Berlin", "Office", "Zoom". Can be used alone as sufficient filter.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of events to return (default 20, max 500). You get the earliest by start date, and the response states how many matched in total.',
      },
    },
    required: [],
  },
  handler: async (args) => {
    const validated = validateInput(calendarQuerySchema, args);
    const client = tsdavManager.getCalDavClient();
    const calendars = await client.fetchCalendars();

    // If specific calendar requested, use it
    let calendarsToSearch = calendars;
    if (validated.calendar_url) {
      const calendar = calendars.find(c => c.url === validated.calendar_url);
      if (!calendar) {
        const availableUrls = calendars.map(c => c.url).join('\n- ');
        throw new Error(
          `Calendar not found: ${validated.calendar_url}\n\n` +
          `Available calendar URLs:\n- ${availableUrls}\n\n` +
          `Tip: Omit calendar_url to search across all calendars automatically.`
        );
      }
      calendarsToSearch = [calendar];
    }

    // Build timeRange options
    const timeRangeOptions = buildTimeRangeOptions(validated.time_range_start, validated.time_range_end);

    // Search across all selected calendars
    let allEvents = [];
    for (const calendar of calendarsToSearch) {
      const options = { calendar, ...timeRangeOptions };
      const events = await client.fetchCalendarObjects(options);
      allEvents = allEvents.concat(events);
    }

    // Client-side filtering on parsed values; see query-objects.js
    let parsed = parseObjects(allEvents, 'vevent');
    const { timeRange } = timeRangeOptions;
    const matches = searchOf(validated);
    // one expansion budget for every event of this query (one tool call)
    const budget = requestBudget();

    if (matches) {
      parsed = parsed.filter((p) => isFound(p, matches, timeRange, budget));
    }

    // Determine calendar name for display
    const calendarName = calendarsToSearch.length === 1
      ? calendarsToSearch[0]
      : `All Calendars (${calendarsToSearch.length})`;

    const rangeStart = timeRange ? new Date(timeRange.start).getTime() : null;
    const { items, total } = timeRange
      ? limitResults(
        parsed,
        validated.limit ?? DEFAULT_RESULT_LIMIT,
        (p) => startLowerBound(p, rangeStart),
        (p) => listedStart(shownOf(p, matches, timeRange, budget), rangeStart)
      )
      : limitResults(parsed, validated.limit ?? DEFAULT_RESULT_LIMIT, (p) => dateKey(p, 'dtstart'));

    // the occurrence each listed event is shown as, resolved once for the
    // filter, the sort and the display alike
    const shown = new Map();
    for (const p of items) {
      const listed = shownOf(p, matches, timeRange, budget);
      if (listed) shown.set(p.object, listed);
    }

    return formatEventList(items.map(({ object }) => object), calendarName, timeRange, total, matches, shown, budget);
  },
};

/**
 * The search as one test on a VEVENT: every given text filter must hold on
 * the same component, so one occurrence has to carry both the title and the
 * place. null without a text filter.
 */
function searchOf({ summary_filter: summary, location_filter: location }) {
  if (!summary && !location) return null;
  return (vevent) =>
    (!summary || containsText(textValues(vevent, 'summary'), summary))
    && (!location || containsText(textValues(vevent, 'location'), location));
}

/**
 * Is the event found — does the occurrence it is listed as (shownEvent, with
 * the search) pass the search? Without a range that is the series master;
 * with one, the first occurrence in the range the search accepts, an override
 * judged by its own text. formatEventList lists the same occurrence, so an
 * event always shows the text it was found by.
 *
 * Expanding a series is the expensive part — bounded by the range for
 * daily and weekly rules (see expansionStart), but still the bulk of the
 * work — so it only happens when the object's components disagree: if none
 * passes, no occurrence can; if all pass, every occurrence does, and the
 * server returned the object for one inside the range.
 */
function isFound(parsed, matches, timeRange, budget) {
  if (!parsed.root) return false;
  const verdicts = parsed.root.getAllSubcomponents('vevent').map(matches);
  if (!verdicts.some(Boolean)) return false;
  if (verdicts.every(Boolean)) return true;
  const shown = shownOf(parsed, matches, timeRange, budget);
  return Boolean(shown) && !shown.outsideRange && matches(shown.item.component);
}

/** shownEvent for a parsed object, computed once per query */
function shownOf(parsed, matches, timeRange, budget) {
  if (!('shown' in parsed)) {
    parsed.shown = parsed.root ? orNull(() => shownEvent(parsed.root, timeRange, matches, budget)) : null;
  }
  return parsed.shown;
}

/**
 * With a range, the start of what is listed: the occurrence in the range
 * (an override at its own, possibly moved, start), or for a single event or
 * detached instance its DTSTART. A series with no occurrence to list sorts
 * where its lower bound puts it (see startLowerBound). null sorts last.
 */
function listedStart(shown, rangeStart) {
  if (!shown) return null;
  if (!shown.occurrence && shown.event.isRecurring()) {
    return seriesBound(shown.vevent, rangeStart, longestIn(shown.vevent.parent));
  }
  return startOf(shown.item.component, shown.occurrence?.startDate);
}

/**
 * A cheap key never later than listedStart, so limitResults only has to
 * resolve the occurrences that can still make the cut. A series' occurrence
 * touches the range (src/occurrences.js), so it starts no earlier than the
 * later of the series start and the range start less the longest duration
 * in the object — unless an override moved it earlier, so the overrides' own
 * starts count too (a THISANDFUTURE override's later occurrences start no
 * earlier than it does). Detached instances: the earliest of them.
 */
function startLowerBound(parsed, rangeStart) {
  if (!parsed.root || !parsed.main) return null;
  const all = parsed.root.getAllSubcomponents('vevent');
  const recurring = parsed.main.hasProperty('rrule') || parsed.main.hasProperty('rdate');
  const longest = recurring ? longestIn(parsed.root) : 0;
  const starts = all
    .map((vevent) => (recurring && vevent === parsed.main ? seriesBound(vevent, rangeStart, longest) : startOf(vevent)))
    .filter((start) => start !== null);
  return starts.length ? Math.min(...starts) : null;
}

/**
 * The bound for a series: no occurrence touching the range starts before the
 * range does, less its duration — as an instant. A floating DTSTART (or a
 * TZID without its VTIMEZONE) is keyed by instantOf in the host's zone, so
 * the bound gives it a zone offset of slack. Slack only means a few more
 * candidates are resolved at the boundary.
 */
function seriesBound(master, rangeStart, longest) {
  const start = startOf(master);
  if (start === null) return null;
  const dtstart = master.getFirstProperty('dtstart');
  const absolute = orNull(() => hasAbsoluteInstant(dtstart)) === true;
  return Math.max(start, rangeStart - longest - (absolute ? 0 : ZONE_SLACK_MS));
}

/** The longest duration of any VEVENT in the object, in ms (0 if unreadable) */
function longestIn(root) {
  const durations = (root?.getAllSubcomponents('vevent') ?? [])
    .map((vevent) => orNull(() => new ICAL.Event(vevent, { exceptions: [] }).duration.toSeconds() * 1000))
    .filter(Number.isFinite);
  return Math.max(0, ...durations);
}

function startOf(vevent, time) {
  const dtstart = vevent.getFirstProperty('dtstart');
  if (!dtstart) return null;
  const instant = orNull(() => instantOf(dtstart, time ?? dtstart.getFirstValue()));
  return Number.isFinite(instant) ? instant : null;
}

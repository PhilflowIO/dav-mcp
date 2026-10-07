import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, calendarQuerySchema } from '../../validation.js';
import { formatEventList } from '../../formatters.js';
import { buildTimeRangeOptions, limitResults, DEFAULT_RESULT_LIMIT } from '../shared/helpers.js';
import { shownEvent } from '../../ical-components.js';
import { instantOf } from '../shared/ical-dates.js';
import { parseObjects, textValues, containsText, dateKey, orNull } from '../shared/query-objects.js';

/**
 * Search and filter calendar events efficiently
 */
export const calendarQuery = {
  name: 'calendar_query',
  description: '⭐ PREFERRED: Search and filter calendar events efficiently. Use instead of list_events to avoid loading thousands of entries. Omit calendar_url to search across ALL calendars automatically.',
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

    if (matches) {
      parsed = parsed.filter((p) => isFound(p, matches, timeRange));
    }

    // Determine calendar name for display
    const calendarName = calendarsToSearch.length === 1
      ? calendarsToSearch[0]
      : `All Calendars (${calendarsToSearch.length})`;

    const { items, total } = limitResults(
      parsed,
      validated.limit ?? DEFAULT_RESULT_LIMIT,
      listedStart
    );

    return formatEventList(items.map(({ object }) => object), calendarName, timeRange, total, matches);
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
 * Expanding a series is the expensive part (ical.js takes ~3 ms for a weekly
 * series six years long), so it only happens when the object's components
 * disagree: if none passes, no occurrence can; if all pass, every occurrence
 * does, and the server returned the object for one inside the range.
 */
function isFound(parsed, matches, timeRange) {
  if (!parsed.root) return false;
  const verdicts = parsed.root.getAllSubcomponents('vevent').map(matches);
  if (!verdicts.some(Boolean)) return false;
  if (verdicts.every(Boolean)) return true;
  const shown = shownOf(parsed, matches, timeRange);
  return Boolean(shown) && !shown.outsideRange && matches(shown.item.component);
}

/** shownEvent for a parsed object, computed once per query */
function shownOf(parsed, matches, timeRange) {
  if (!('shown' in parsed)) {
    parsed.shown = parsed.root ? orNull(() => shownEvent(parsed.root, timeRange, matches)) : null;
  }
  return parsed.shown;
}

/**
 * Sort key: the start of what is listed, as an instant (see instantOf);
 * null sorts last.
 *
 * Where the search already resolved the listed occurrence (a series whose
 * override was searched), that occurrence's start. Otherwise the master's
 * DTSTART — for a single event that is what is listed; for a recurring one it
 * is the series start, a lower bound of the listed occurrence. Resolving every
 * series just to sort would expand all of them, not only the 20 listed:
 * ~3.4 s for 500 weekly series six years long.
 */
function listedStart(parsed) {
  if (!('shown' in parsed)) return dateKey(parsed, 'dtstart');
  const { shown } = parsed;
  if (!shown) return null;
  const dtstart = shown.item.component.getFirstProperty('dtstart');
  if (!dtstart) return null;
  const instant = orNull(() => instantOf(dtstart, shown.occurrence?.startDate ?? dtstart.getFirstValue()));
  return Number.isFinite(instant) ? instant : null;
}

import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, calendarQuerySchema } from '../../validation.js';
import { formatEventList } from '../../formatters.js';
import { buildTimeRangeOptions, limitResults, DEFAULT_RESULT_LIMIT } from '../shared/helpers.js';
import { shownEvent } from '../../ical-components.js';
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

    if (validated.summary_filter) {
      parsed = parsed.filter((p) => shownMatches(p, 'summary', validated.summary_filter, timeRange));
    }

    if (validated.location_filter) {
      parsed = parsed.filter((p) => shownMatches(p, 'location', validated.location_filter, timeRange));
    }

    // Determine calendar name for display
    const calendarName = calendarsToSearch.length === 1
      ? calendarsToSearch[0]
      : `All Calendars (${calendarsToSearch.length})`;

    const { items, total } = limitResults(
      parsed,
      validated.limit ?? DEFAULT_RESULT_LIMIT,
      (p) => dateKey(p, 'dtstart')
    );

    return formatEventList(items.map(({ object }) => object), calendarName, timeRangeOptions.timeRange, total);
  },
};

/**
 * Does the event as listed contain the text in its SUMMARY or LOCATION?
 *
 * The filter reads exactly what formatEventList shows (shownEvent): the
 * series master without a range, the first occurrence in the range with its
 * override applied with one. So a listed event always shows the text it was
 * found by, and an override that renames an occurrence matches exactly when
 * that occurrence is the one listed.
 *
 * Expanding a series is the expensive part, and only needed when the
 * object's components disagree: if the master and every override (or every
 * detached instance) all match, or all do not, so does whichever is shown.
 */
function shownMatches(parsed, property, needle, timeRange) {
  if (!parsed.root) return false;
  const verdicts = parsed.root.getAllSubcomponents('vevent')
    .map((vevent) => containsText(textValues(vevent, property), needle));
  if (verdicts.every(Boolean)) return verdicts.length > 0;
  if (!verdicts.some(Boolean)) return false;
  const shown = orNull(() => shownEvent(parsed.root, timeRange));
  return Boolean(shown) && containsText(textValues(shown.item.component, property), needle);
}

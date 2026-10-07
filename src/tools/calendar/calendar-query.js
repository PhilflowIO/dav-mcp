import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, calendarQuerySchema } from '../../validation.js';
import { formatEventList } from '../../formatters.js';
import { buildTimeRangeOptions, limitResults, DEFAULT_RESULT_LIMIT } from '../shared/helpers.js';
import { eventSpan } from '../shared/ical-dates.js';
import { parseObjects, overridesOf, textValues, containsText, dateKey, orNull } from '../shared/query-objects.js';

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
    const inRange = occurrenceFilter(timeRangeOptions.timeRange);

    if (validated.summary_filter) {
      parsed = parsed.filter((p) => eventMatches(p, 'summary', validated.summary_filter, inRange));
    }

    if (validated.location_filter) {
      parsed = parsed.filter((p) => eventMatches(p, 'location', validated.location_filter, inRange));
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
 * Does an event's SUMMARY or LOCATION contain the text?
 *
 * The series' own value (the master's) is what the event is called, so it
 * decides. A recurring event can also carry RECURRENCE-ID overrides that
 * rename or move one occurrence — "Standup (Room B)" in a series called
 * "Standup". Such an override matches too, so that occurrence can be found
 * at all; but only if it falls inside the queried range, because the server
 * returned the series for some occurrence in that range and an override
 * outside it is not what the caller asked about.
 */
function eventMatches(parsed, property, needle, inRange) {
  if (containsText(textValues(parsed.main, property), needle)) return true;
  return overridesOf(parsed, 'vevent').some((override) =>
    inRange(override) && containsText(textValues(override, property), needle));
}

/**
 * Whether an override occurrence overlaps the queried range (RFC 4791 9.9:
 * starts before the range ends and ends after it starts; an instant counts
 * when it lies in the range). Without a range every override counts. An
 * override whose dates cannot be read does not.
 */
function occurrenceFilter(timeRange) {
  if (!timeRange) return () => true;
  const start = new Date(timeRange.start).getTime();
  const end = new Date(timeRange.end).getTime();
  return (override) => {
    const span = orNull(() => eventSpan(override));
    if (!span) return false;
    return span.end > span.start
      ? span.start < end && span.end > start
      : span.start >= start && span.start < end;
  };
}

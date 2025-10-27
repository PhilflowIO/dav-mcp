import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, calendarQuerySchema } from '../../validation.js';
import { formatEventList } from '../../formatters.js';
import { buildTimeRangeOptions } from '../shared/helpers.js';

/**
 * Search and filter calendar events efficiently
 */
export const calendarQuery = {
  name: 'calendar_query',
  description: 'PREFERRED: Search and filter calendar events efficiently by text (summary/title), date range, or location. Use this instead of list_events when user asks "find events with X" or "show me events containing Y" to avoid loading thousands of events. Much more token-efficient than list_events. IMPORTANT: When user asks about "today", "tomorrow", "this week" etc., you MUST calculate the correct date range in ISO 8601 format (e.g., 2025-10-08T00:00:00.000Z for tomorrow). ⚠️ FOR SEARCHES: OMIT calendar_url to search across ALL calendars automatically. DO NOT call list_calendars first and then provide a calendar_url - this limits the search to one calendar and will miss events in other calendars. Only provide calendar_url if user explicitly mentions a specific calendar name.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: '⚠️ USUALLY OMIT THIS for searches! If omitted, searches across ALL available calendars. Only provide if user explicitly specifies a calendar name (e.g., "in my work calendar"). DO NOT use list_calendars and then pick one - that defeats the purpose of cross-calendar search.',
      },
      time_range_start: {
        type: 'string',
        description: 'Optional: Start date in ISO 8601 format (e.g., 2025-10-08T00:00:00.000Z). When user asks "tomorrow", calculate tomorrow\'s date. When user asks "this week", use start of current week.',
      },
      time_range_end: {
        type: 'string',
        description: 'Optional: End date in ISO 8601 format. If omitted but time_range_start is provided, defaults to 1 year from start date.',
      },
      summary_filter: {
        type: 'string',
        description: 'Optional: Filter events by summary/title (case-insensitive substring match). Use this when user asks "find events with X in title" or "show me meeting events"',
      },
      location_filter: {
        type: 'string',
        description: 'Optional: Filter events by location (case-insensitive substring match). Use when user asks "events in room X" or "meetings at location Y"',
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
      // Add calendar info to each event
      events.forEach(event => {
        event._calendarName = calendar.displayName || calendar.url;
      });
      allEvents = allEvents.concat(events);
    }

    let filteredEvents = allEvents;

    if (validated.summary_filter) {
      const summaryLower = validated.summary_filter.toLowerCase();
      filteredEvents = filteredEvents.filter(event => {
        const summary = event.data?.match(/SUMMARY:(.+)/)?.[1] || '';
        return summary.toLowerCase().includes(summaryLower);
      });
    }

    if (validated.location_filter) {
      const locationLower = validated.location_filter.toLowerCase();
      filteredEvents = filteredEvents.filter(event => {
        const location = event.data?.match(/LOCATION:(.+)/)?.[1] || '';
        return location.toLowerCase().includes(locationLower);
      });
    }

    // Determine calendar name for display
    const calendarName = calendarsToSearch.length === 1
      ? (calendarsToSearch[0].displayName || calendarsToSearch[0].url)
      : `All Calendars (${calendarsToSearch.length})`;

    return formatEventList(filteredEvents, calendarName);
  },
};

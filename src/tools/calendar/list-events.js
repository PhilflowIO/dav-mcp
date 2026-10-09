import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, listEventsSchema } from '../../validation.js';
import { formatEventList } from '../../formatters.js';
import { findCalendarOrThrow, buildTimeRangeOptions } from '../shared/helpers.js';
import { floatingZoneFor, withFloatingZone } from '../../calendar-zone.js';

/**
 * List ALL events from a single calendar without filtering
 */
export const listEvents = {
  name: 'list_events',
  annotations: {
    title: 'List events',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'List ALL events from a single calendar without filtering. WARNING: Returns all events which can be many thousands - use calendar_query instead for searching with filters (supports multi-calendar search). With a time range, a recurring event is listed as its first occurrence in the range (one already running at the range start counts); a cancelled occurrence is listed too, with its Status.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'The URL of the calendar to fetch events from. Use list_calendars first to get available URLs.',
      },
      time_range_start: {
        type: 'string',
        description: 'Optional: Start date in ISO 8601 format (e.g., 2025-01-01T00:00:00.000Z)',
      },
      time_range_end: {
        type: 'string',
        description: 'Optional: End date in ISO 8601 format',
      },
    },
    required: ['calendar_url'],
  },
  handler: async (args) => {
    const validated = validateInput(listEventsSchema, args);
    const client = tsdavManager.getCalDavClient();
    const calendars = await client.fetchCalendars();
    const calendar = findCalendarOrThrow(calendars, validated.calendar_url);

    const timeRangeOptions = buildTimeRangeOptions(validated.time_range_start, validated.time_range_end);
    const options = { calendar, ...timeRangeOptions };

    // floating times and dates are read in the calendar's zone
    const events = withFloatingZone(await client.fetchCalendarObjects(options), floatingZoneFor(calendar));

    // buildTimeRangeOptions fills in an end when only a start was given, so use
    // its result rather than the raw arguments
    return formatEventList(events, calendar, timeRangeOptions.timeRange);
  },
};

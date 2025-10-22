import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, listEventsSchema } from '../../validation.js';
import { formatEventList } from '../../formatters.js';
import { findCalendarOrThrow, buildTimeRangeOptions } from '../shared/helpers.js';

/**
 * List ALL events from a single calendar without filtering
 */
export const listEvents = {
  name: 'list_events',
  description: 'List ALL events from a single calendar without filtering. WARNING: Returns all events which can be many thousands - use calendar_query instead for searching with filters (supports multi-calendar search).',
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

    const events = await client.fetchCalendarObjects(options);

    return formatEventList(events, calendar);
  },
};

import { tsdavManager } from '../../tsdav-client.js';
import { findCalendarOrThrow } from '../shared/helpers.js';
import { validateInput, calendarMultiGetSchema } from '../../validation.js';
import { formatEventList, withMissingObjects } from '../../formatters.js';
import { multiGetObjects } from '../shared/multiget.js';
import { fetchFloatingZone, withFloatingZone, withZoneNote } from '../../calendar-zone.js';

/**
 * Batch fetch multiple specific calendar events by their URLs
 */
export const calendarMultiGet = {
  name: 'calendar_multi_get',
  annotations: {
    title: 'Get events by URL',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'Batch fetch multiple specific calendar events by their URLs. Use when you have exact event URLs and want to retrieve their details',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'The URL of the calendar',
      },
      event_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of event URLs to fetch',
      },
    },
    required: ['calendar_url', 'event_urls'],
  },
  handler: async (args) => {
    const validated = validateInput(calendarMultiGetSchema, args);
    const client = tsdavManager.getCalDavClient();
    findCalendarOrThrow(await client.fetchCalendars(), validated.calendar_url);

    const { found, missing } = await multiGetObjects(client, {
      kind: 'calendar',
      collectionUrl: validated.calendar_url,
      objectUrls: validated.event_urls,
    });
    // floating times and dates are read in the calendar's zone
    const zone = await fetchFloatingZone(client, validated.calendar_url);
    withFloatingZone(found, zone);

    return withZoneNote(withMissingObjects(formatEventList(found, { url: validated.calendar_url }), missing), [zone]);
  },
};

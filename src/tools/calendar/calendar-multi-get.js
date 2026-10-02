import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, calendarMultiGetSchema } from '../../validation.js';
import { formatEventList, withMissingObjects } from '../../formatters.js';
import { multiGetObjects } from '../shared/multiget.js';

/**
 * Batch fetch multiple specific calendar events by their URLs
 */
export const calendarMultiGet = {
  name: 'calendar_multi_get',
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

    const { found, missing } = await multiGetObjects(client, {
      kind: 'calendar',
      collectionUrl: validated.calendar_url,
      objectUrls: validated.event_urls,
    });

    return withMissingObjects(formatEventList(found, { url: validated.calendar_url }), missing);
  },
};

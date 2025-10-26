import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateEventSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Update an existing calendar event with raw iCal data
 */
export const updateEventRaw = {
  name: 'update_event_raw',
  description: 'ADVANCED: Update event with raw iCal data. Requires manual iCal formatting - use update_event instead for simple field updates (summary, description). Only use this if you have complete pre-formatted iCal data or need to update advanced iCal properties.',
  inputSchema: {
    type: 'object',
    properties: {
      event_url: {
        type: 'string',
        description: 'The URL of the event to update',
      },
      event_etag: {
        type: 'string',
        description: 'The etag of the event',
      },
      updated_ical_data: {
        type: 'string',
        description: 'The complete updated iCal data',
      },
    },
    required: ['event_url', 'event_etag', 'updated_ical_data'],
  },
  handler: async (args) => {
    const validated = validateInput(updateEventSchema, args);
    const client = tsdavManager.getCalDavClient();

    const response = await client.updateCalendarObject({
      calendarObject: {
        url: validated.event_url,
        data: validated.updated_ical_data,
        etag: validated.event_etag,
      },
    });

    return formatSuccess('Event updated successfully', {
      etag: response.etag,
    });
  },
};

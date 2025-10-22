import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteEventSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Delete a calendar event permanently
 */
export const deleteEvent = {
  name: 'delete_event',
  description: 'Delete a calendar event permanently. Requires event URL and etag',
  inputSchema: {
    type: 'object',
    properties: {
      event_url: {
        type: 'string',
        description: 'The URL of the event to delete',
      },
      event_etag: {
        type: 'string',
        description: 'The etag of the event',
      },
    },
    required: ['event_url', 'event_etag'],
  },
  handler: async (args) => {
    const validated = validateInput(deleteEventSchema, args);
    const client = tsdavManager.getCalDavClient();

    await client.deleteCalendarObject({
      calendarObject: {
        url: validated.event_url,
        etag: validated.event_etag,
      },
    });

    return formatSuccess('Event deleted successfully');
  },
};

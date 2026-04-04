import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteEventSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Delete a calendar event permanently
 */
export const deleteEvent = {
  name: 'delete_event',
  description: 'Permanently delete a calendar event. WARNING: This action cannot be undone — the event is removed from the server immediately. Use only when the user explicitly requests deletion. Obtain the event URL and etag from list_events or calendar_query first. The etag ensures no conflicting changes occurred since the event was last retrieved.',
  inputSchema: {
    type: 'object',
    properties: {
      event_url: {
        type: 'string',
        description: 'Full URL of the event to delete. Obtain from list_events or calendar_query response.',
      },
      event_etag: {
        type: 'string',
        description: 'ETag of the event for conflict detection. Obtain from the same response as the event URL. Ensures no changes were made since retrieval.',
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

import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteCalendarSchema } from '../../validation.js';
import { formatCalendarDeleteSuccess } from '../../formatters.js';
import { assertDeleted } from '../shared/helpers.js';

/**
 * Permanently delete a calendar and all its events
 */
export const deleteCalendar = {
  name: 'delete_calendar',
  description: 'Permanently delete a calendar and all its events. WARNING: This action cannot be undone! Use this when user explicitly asks to "delete calendar" or "remove calendar"',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'The URL of the calendar to delete (get from list_calendars)',
      },
    },
    required: ['calendar_url'],
  },
  handler: async (args) => {
    const validated = validateInput(deleteCalendarSchema, args);
    const client = tsdavManager.getCalDavClient();

    const response = await client.deleteObject({
      url: validated.calendar_url,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
      },
    });
    await assertDeleted(response, `calendar ${validated.calendar_url}`);

    return formatCalendarDeleteSuccess(validated.calendar_url);
  },
};

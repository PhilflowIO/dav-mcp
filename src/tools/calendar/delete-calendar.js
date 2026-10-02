import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteCalendarSchema } from '../../validation.js';
import { formatCalendarDeleteSuccess, formatCalendarAlreadyDeleted } from '../../formatters.js';
import { assertDeleted, inspectCollection } from '../shared/helpers.js';

/**
 * Delete a calendar and all its events
 */
export const deleteCalendar = {
  name: 'delete_calendar',
  description: 'Delete a calendar and all its events. WARNING: on servers without a trash bin this cannot be undone; servers with one (e.g. Nextcloud) keep the calendar in the trash for a while. Use this when user explicitly asks to "delete calendar" or "remove calendar"',
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

    // A calendar that already sits in the server's trash bin (Nextcloud) keeps
    // its URL, and a DELETE on it is answered like any other. Reporting that
    // as a deletion would claim something happened; it is already deleted.
    const target = await inspectCollection(client, validated.calendar_url);
    if (target?.trashedCalendar) {
      return formatCalendarAlreadyDeleted(validated.calendar_url);
    }

    // No headers here: tsdav's client merges its auth headers into ours, and
    // tsdav before the v2.3.5 sync replaced them instead — a body-less DELETE
    // has no use for a Content-Type, and passing one sent it unauthenticated.
    const response = await client.deleteObject({
      url: validated.calendar_url,
    });
    // A 404 after the lookup saw the calendar means it went away in between:
    // it existed and is gone. Without a successful lookup a 404 means there
    // was no calendar to delete.
    await assertDeleted(response, 'calendar', validated.calendar_url, { existedBefore: Boolean(target) });

    return formatCalendarDeleteSuccess(validated.calendar_url);
  },
};

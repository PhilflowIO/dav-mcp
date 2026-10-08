import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateEventSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { assertDavSuccess, etagAfterWrite } from '../shared/helpers.js';

/**
 * Update an existing calendar event with raw iCal data
 */
export const updateEventRaw = {
  name: 'update_event_raw',
  annotations: {
    title: 'Replace event iCalendar data',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'ADVANCED: Update event with raw iCal data. Requires manual iCal formatting - use update_event instead for simple field updates (summary, description). Use this to change a single occurrence of a recurring event: fetch the event with calendar_multi_get, add or edit the VEVENT with that occurrence\'s RECURRENCE-ID, and send the whole object. Also for complete pre-formatted iCal data or advanced iCal properties.',
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
    await assertDavSuccess(response, `update event ${validated.event_url}`);

    return formatSuccess('Event updated successfully', {
      ...etagAfterWrite(response),
    });
  },
};

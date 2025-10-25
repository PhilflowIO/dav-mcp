import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateEventSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { cleanICalData } from '../../utils/ical-fixer.js';

/**
 * Update an existing calendar event
 */
export const updateEvent = {
  name: 'update_event',
  description: '⚠️ WARNING: Requires manual iCal formatting - NOT recommended for LLM/AI use. Use update_event_fields instead for field-based updates. Only use this if you have complete pre-formatted iCal data.',
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

    // Clean the iCal data to fix common LLM generation errors
    const cleanedIcalData = cleanICalData(validated.updated_ical_data);

    const response = await client.updateCalendarObject({
      calendarObject: {
        url: validated.event_url,
        data: cleanedIcalData,
        etag: validated.event_etag,
      },
    });

    return formatSuccess('Event updated successfully', {
      etag: response.etag,
    });
  },
};

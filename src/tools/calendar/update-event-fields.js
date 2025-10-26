import { tsdavManager } from '../../tsdav-client.js';
import { validateInput } from '../../validation.js';
import { formatSuccess, formatError } from '../../formatters.js';
import { z } from 'zod';
import tsdavPkg from 'tsdav';
const { updateEventFields: tsdavUpdateEventFields } = tsdavPkg;

/**
 * Schema for field-based event updates
 * Currently supports MVP fields from tsdav v2.2.0: SUMMARY and DESCRIPTION
 * Note: tsdav uses UPPERCASE field names internally for iCal compatibility
 */
const updateEventFieldsSchema = z.object({
  event_url: z.string().url('Event URL must be a valid URL'),
  event_etag: z.string().min(1, 'Event etag is required'),
  fields: z.object({
    summary: z.string().optional(),
    description: z.string().optional(),
    // Future fields (pending tsdav support):
    // location: z.string().optional(),
    // start_date: z.string().optional(),
    // end_date: z.string().optional(),
  }).optional()
});

/**
 * Wrapper for tsdav's native updateEventFields function
 * Uses the field-based update implementation from tsdav v2.2.0 MVP
 *
 * Current MVP limitations:
 * - Only SUMMARY and DESCRIPTION fields are officially supported
 * - Other iCal fields require using the full update_event tool
 */
export const updateEventFields = {
  name: 'update_event',
  description: 'PREFERRED: Update event fields (summary, description) easily without iCal formatting. Use this for simple event updates. For advanced iCal properties, use update_event_raw instead. Currently supports summary and description fields only.',
  inputSchema: {
    type: 'object',
    properties: {
      event_url: {
        type: 'string',
        description: 'The URL of the event to update'
      },
      event_etag: {
        type: 'string',
        description: 'The etag of the event (required for conflict detection)'
      },
      fields: {
        type: 'object',
        description: 'Fields to update - only include fields you want to change. Currently supported: summary, description',
        properties: {
          summary: {
            type: 'string',
            description: 'Event title/summary - the main heading shown in calendars'
          },
          description: {
            type: 'string',
            description: 'Event description - detailed information about the event'
          }
        }
      }
    },
    required: ['event_url', 'event_etag']
  },
  handler: async (args) => {
    try {
      const validated = validateInput(updateEventFieldsSchema, args);
      const client = tsdavManager.getCalDavClient();

      // Step 1: Fetch the current event from server
      const calendarUrl = validated.event_url.substring(0, validated.event_url.lastIndexOf('/') + 1);
      const currentEvents = await client.fetchCalendarObjects({
        calendar: { url: calendarUrl },
        objectUrls: [validated.event_url]
      });

      if (!currentEvents || currentEvents.length === 0) {
        throw new Error('Event not found');
      }

      const calendarObject = currentEvents[0];

      // Step 2: Transform snake_case field names to UPPERCASE for tsdav
      // tsdav's updateEventFields expects UPPERCASE iCal property names
      const tsdavFields = {};
      if (validated.fields) {
        if (validated.fields.summary !== undefined) {
          tsdavFields.summary = validated.fields.summary;
        }
        if (validated.fields.description !== undefined) {
          tsdavFields.description = validated.fields.description;
        }
      }

      // Step 3: Use tsdav's native updateEventFields function
      const result = tsdavUpdateEventFields(calendarObject, tsdavFields);

      // Step 4: Send the updated event back to server
      const updateResponse = await client.updateCalendarObject({
        calendarObject: {
          url: validated.event_url,
          data: result.data,
          etag: validated.event_etag
        }
      });

      return formatSuccess('Event updated successfully', {
        etag: updateResponse.etag,
        updated_fields: Object.keys(tsdavFields),
        modified: result.modified,
        warnings: result.warnings
      });

    } catch (error) {
      return formatError('update_event_fields', error);
    }
  }
};

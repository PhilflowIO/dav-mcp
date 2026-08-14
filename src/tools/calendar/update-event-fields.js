import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, davFieldMapSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { z } from 'zod';
import { updateFields } from 'tsdav-utils';

/**
 * Schema for field-based event updates
 * Supports all RFC 5545 iCalendar properties via tsdav-utils
 * Field names are validated as bare property names; see davFieldMapSchema
 * Common fields: SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, STATUS
 * Custom properties: Any X-* property
 */
const updateEventFieldsSchema = z.object({
  event_url: z.string().url('Event URL must be a valid URL'),
  event_etag: z.string().min(1, 'Event etag is required'),
  fields: davFieldMapSchema
});

/**
 * Field-agnostic event update tool powered by tsdav-utils
 * Supports any bare RFC 5545 property name; parameters and multi-line
 * values are rejected by the schema
 *
 * Features:
 * - Any standard VEVENT property (SUMMARY, DESCRIPTION, LOCATION, DTSTART, etc.)
 * - Custom X-* properties for extensions
 * - Field-agnostic: no pre-defined field list required
 */
export const updateEventFields = {
  name: 'update_event',
  description: 'PREFERRED: Update event fields without iCal formatting. Supports: SUMMARY (title), DESCRIPTION (details), LOCATION (place), DTSTART (start time), DTEND (end time), STATUS (TENTATIVE/CONFIRMED/CANCELLED), and any RFC 5545 property including custom X-* properties (e.g., X-ZOOM-LINK, X-MEETING-ROOM).',
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
        description: 'Fields to update, keyed by bare UPPERCASE property name (e.g., SUMMARY, LOCATION, DTSTART). Any RFC 5545 property or custom X-* property is supported. Property parameters such as "DTSTART;VALUE=DATE" are not accepted here, and values must not contain line breaks.',
        additionalProperties: {
          type: 'string'
        },
        properties: {
          SUMMARY: {
            type: 'string',
            description: 'Event title/summary'
          },
          DESCRIPTION: {
            type: 'string',
            description: 'Event description/details'
          },
          LOCATION: {
            type: 'string',
            description: 'Physical or virtual meeting location'
          },
          DTSTART: {
            type: 'string',
            description: 'Start datetime (ISO 8601 or iCal format: 20250128T100000Z)'
          },
          DTEND: {
            type: 'string',
            description: 'End datetime (ISO 8601 or iCal format)'
          },
          STATUS: {
            type: 'string',
            description: 'Event status: TENTATIVE, CONFIRMED, or CANCELLED'
          }
        }
      }
    },
    required: ['event_url', 'event_etag']
  },
  handler: async (args) => {
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

    // Step 2: Update fields using tsdav-utils (field-agnostic)
    // Accepts any RFC 5545 property name (UPPERCASE)
    const updatedData = updateFields(calendarObject, validated.fields || {});

    // Step 3: Send the updated event back to server
    const updateResponse = await client.updateCalendarObject({
      calendarObject: {
        url: validated.event_url,
        data: updatedData,
        etag: validated.event_etag
      }
    });

    return formatSuccess('Event updated successfully', {
      etag: updateResponse.etag,
      updated_fields: Object.keys(validated.fields || {}),
      message: `Updated ${Object.keys(validated.fields || {}).length} field(s): ${Object.keys(validated.fields || {}).join(', ')}`
    });
  }
};

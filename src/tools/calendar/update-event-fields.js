import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, davFieldMapSchema, dateOrDateTime, refineDateRange, isDateOnly } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { z } from 'zod';
import { updateFields } from 'tsdav-utils';
import { setEventDates } from '../shared/event-dates.js';

/**
 * Schema for field-based event updates
 * Supports all RFC 5545 iCalendar properties via tsdav-utils
 * Field names are validated as bare property names; see davFieldMapSchema
 * Common fields: SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, STATUS
 * Custom properties: Any X-* property
 *
 * start_date/end_date/all_day sit OUTSIDE the fields map on purpose. An
 * all-day DTSTART needs a VALUE=DATE parameter, and the fields map cannot
 * carry a parameter without appending a duplicate property; see
 * src/tools/shared/event-dates.js.
 */
const updateEventFieldsSchema = z.object({
  event_url: z.string().url('Event URL must be a valid URL'),
  event_etag: z.string().min(1, 'Event etag is required'),
  fields: davFieldMapSchema,
  start_date: dateOrDateTime.optional(),
  end_date: dateOrDateTime.optional(),
  all_day: z.boolean().optional(),
}).superRefine((data, ctx) => {
  const usesDateParams = data.start_date !== undefined ||
    data.end_date !== undefined ||
    data.all_day !== undefined;

  if (!usesDateParams) return;

  // Both ends are required together: the all-day DTEND is exclusive, so moving
  // one end alone is how you get an event that silently ends before it starts.
  for (const key of ['start_date', 'end_date']) {
    if (data[key] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when changing the event dates (start_date, end_date and all_day are set together)`,
      });
    }
  }

  for (const key of ['DTSTART', 'DTEND']) {
    if (data.fields && key in data.fields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', key],
        message: `Set the dates with start_date/end_date/all_day, not with fields.${key} — the two would fight over the same property`,
      });
    }
  }

  refineDateRange(data, ctx, { startKey: 'start_date', endKey: 'end_date' });
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
  description: 'PREFERRED: Update event fields without iCal formatting. Supports: SUMMARY (title), DESCRIPTION (details), LOCATION (place), DTSTART (start time), DTEND (end time), STATUS (TENTATIVE/CONFIRMED/CANCELLED), and any RFC 5545 property including custom X-* properties (e.g., X-ZOOM-LINK, X-MEETING-ROOM). To move an event or convert it between all-day and timed, use the top-level start_date/end_date/all_day parameters instead of fields.',
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
      },
      start_date: {
        type: 'string',
        description: 'New start. A datetime ("2026-05-25T10:00:00Z") makes the event timed; a bare date ("2026-05-25") makes it all-day. Must be given together with end_date.'
      },
      end_date: {
        type: 'string',
        description: 'New end, in the same form as start_date. For an all-day event the end is EXCLUSIVE: a single day on 2026-05-25 is start_date "2026-05-25" and end_date "2026-05-26".'
      },
      all_day: {
        type: 'boolean',
        description: 'Optional. All-day is inferred from the date format, so this is only needed to state the intent explicitly; it must agree with the format of start_date/end_date. This is the supported way to convert an event between all-day and timed.'
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
    let updatedData = updateFields(calendarObject, validated.fields || {});

    // Step 2b: dates go through the component API, not the fields map, because
    // an all-day value needs a VALUE=DATE parameter on the property
    const changedFields = Object.keys(validated.fields || {});
    if (validated.start_date !== undefined) {
      updatedData = setEventDates(updatedData, {
        startDate: validated.start_date,
        endDate: validated.end_date,
        // ?? not ||, so an explicit all_day: false stays reachable
        allDay: validated.all_day ?? isDateOnly(validated.start_date),
      });
      changedFields.push('DTSTART', 'DTEND');
    }

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
      updated_fields: changedFields,
      message: `Updated ${changedFields.length} field(s): ${changedFields.join(', ')}`
    });
  }
};

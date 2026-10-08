import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, davFieldMapSchema, dateOrDateTime, refineDateRange, davUrl } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { assertDavSuccess, etagAfterWrite } from '../shared/helpers.js';
import { z } from 'zod';
import { writeEventFields } from '../shared/ical-dates.js';
import { assertFieldUpdatable, describeSeriesChange } from '../../ical-components.js';
import {
  occurrenceEditSchema, refineOccurrenceEdits, editOccurrences, notChanged, nothingWritten,
} from '../shared/occurrence-edits.js';

/**
 * Schema for field-based event updates
 * Supports all RFC 5545 iCalendar properties via tsdav-utils
 * Field names are validated as bare property names; see davFieldMapSchema
 * Common fields: SUMMARY, DESCRIPTION, LOCATION, STATUS
 * Custom properties: Any X-* property
 *
 * start_date/end_date/all_day sit OUTSIDE the fields map on purpose: start and
 * end move together, and an explicit end has to replace a stored DURATION; see
 * writeEventFields in src/tools/shared/ical-dates.js.
 */
const updateEventFieldsSchema = z.object({
  event_url: davUrl('Event URL must be a valid URL'),
  event_etag: z.string().min(1, 'Event etag is required'),
  fields: davFieldMapSchema,
  start_date: dateOrDateTime.optional(),
  end_date: dateOrDateTime.optional(),
  all_day: z.boolean().optional(),
  ...occurrenceEditSchema,
}).strict().superRefine((data, ctx) => {
  // EXDATE/RDATE are lists: written as a field they replace the whole list
  // (tsdav-utils 0.7.0), so single occurrences go through their own
  // parameters; see src/tools/shared/occurrence-edits.js
  refineOccurrenceEdits(data, ctx, 'update_event');

  // The dates are kept out of the map: moving one end alone is how an event
  // ends up ending before it starts, and writing DTEND on an event stored as
  // DTSTART + DURATION leaves both present, which RFC 5545 3.6.1 forbids.
  // There is a dedicated parameter for every case, so the map route is closed
  // rather than half-supported.
  for (const key of ['DTSTART', 'DTEND', 'DURATION']) {
    if (data.fields && key in data.fields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', key],
        message: `Set the dates with start_date/end_date/all_day, not with fields.${key}`,
      });
    }
  }

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

  refineDateRange(data, ctx, { startKey: 'start_date', endKey: 'end_date', mixedZones: 'refuse' });
});

/**
 * Field-agnostic event update tool powered by tsdav-utils
 * Supports any bare RFC 5545 property name; parameters and multi-line
 * values are rejected by the schema
 *
 * Features:
 * - Any standard VEVENT property except the dates (SUMMARY, LOCATION, ...)
 * - Custom X-* properties for extensions
 * - Field-agnostic: no pre-defined field list required
 */
export const updateEventFields = {
  name: 'update_event',
  annotations: {
    title: 'Update event fields',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'PREFERRED: Update event fields without iCal formatting. Use start_date/end_date/all_day to move an event or convert it between all-day and timed. Use fields for everything else: SUMMARY (title), DESCRIPTION, LOCATION, STATUS (TENTATIVE/CONFIRMED/CANCELLED) and any other RFC 5545 or custom X-* property. Recurring events: fields and dates change the whole series; moving the start moves every occurrence, cancelled and changed ones included, and the reply lists what moved (a move the rule cannot follow is refused, saying what to give instead, e.g. fields.RRULE). To cancel or bring back single occurrences use cancel_occurrences/restore_occurrences; to move or retitle one occurrence, use calendar_multi_get and update_event_raw.',
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
        description: 'Fields to update, keyed by bare UPPERCASE property name (e.g., SUMMARY, LOCATION, STATUS). Any RFC 5545 property or custom X-* property is supported, EXCEPT the dates: use start_date/end_date/all_day for DTSTART, DTEND and DURATION, and cancel_occurrences/restore_occurrences instead of EXDATE (RDATE is not accepted either). Property parameters such as "VALUE=DATE" are not accepted here, and values must not contain line breaks.',
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
          STATUS: {
            type: 'string',
            description: 'Event status: TENTATIVE, CONFIRMED, or CANCELLED'
          }
        }
      },
      start_date: {
        type: 'string',
        description: 'New start. For a recurring event this is the start of the SERIES (its first occurrence, DTSTART), not of the occurrence a listing showed: every occurrence moves by the difference. To shift every occurrence by an hour, give the series start plus one hour; to cancel one occurrence use cancel_occurrences, to move one use calendar_multi_get and update_event_raw. A datetime ("2026-05-25T10:00:00Z", or with an offset) makes the event timed; a bare date ("2026-05-25") makes it all-day. A datetime with a zone is that instant, written in the event\'s own timezone if it has one (so a series in Europe/Berlin stays there and keeps its local time across DST changes). A datetime without a zone keeps the event\'s own timezone if it has one, else it is read in the timezone of the computer running dav-mcp. Must be given together with end_date.'
      },
      end_date: {
        type: 'string',
        description: 'New end of the event (for a recurring event, of its first occurrence), in the same form as start_date (a datetime without a zone is read in the event\'s own timezone, like start_date). For an all-day event the end is EXCLUSIVE: a single day on 2026-05-25 is start_date "2026-05-25" and end_date "2026-05-26".'
      },
      cancel_occurrences: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recurring event: cancel these occurrences, each given exactly as calendar_query, list_events or calendar_multi_get list it ("Occurrence ID"). Occurrences are named by their ORIGINAL start (where the occurrence was before any change) in the series\' own form: the wall-clock time in its zone without Z ("2026-12-24T09:00:00"), with Z for a UTC series ("2026-12-24T09:00:00Z"), or the date for an all-day series ("2026-12-24"). Adds to the exclusions already there; a changed version of the occurrence is removed too. Names refer to the series as it is before this call.'
      },
      restore_occurrences: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recurring event: bring back these cancelled occurrences, each given exactly as calendar_query, list_events or calendar_multi_get list it under "Cancelled occurrences" (named as for cancel_occurrences). Removes only those exclusions. Applied before cancel_occurrences, fields and dates.'
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
    const fields = validated.fields || {};
    const moving = validated.start_date !== undefined;
    const writesFields = moving || Object.keys(fields).length > 0;
    // empty lists are no request; a call that asks for nothing writes nothing
    if (!writesFields && !validated.cancel_occurrences?.length && !validated.restore_occurrences?.length) {
      return notChanged('Event', 'nothing to change: no fields, dates, cancel_occurrences or restore_occurrences were given');
    }
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
    // a field update edits the series master; refuse one that has none
    assertFieldUpdatable(calendarObject, 'vevent');

    // Step 2: Restore, then cancel the occurrences named — as the series is
    // before this call — so a move below takes the new exclusions along.
    const occurrences = editOccurrences(calendarObject.data, {
      cancel: validated.cancel_occurrences,
      restore: validated.restore_occurrences,
    }, 'vevent');

    // Step 3: Write the fields and, when moving the event, its dates in one
    // updateFields call on the series master, so an RRULE UNTIL in fields
    // follows the new DTSTART. A move takes the whole series along —
    // overrides, EXDATE, RDATE, UNTIL — or is refused (explainWriteRefusal);
    // RECURRENCE-ID is refused on the master. An explicit end replaces a
    // stored DURATION.
    if (!writesFields && occurrences.data === calendarObject.data) {
      return notChanged('Event', 'the occurrences were already as asked', occurrences.change);
    }
    let updatedData = occurrences.data;
    if (writesFields) {
      try {
        updatedData = writeEventFields(occurrences.data, fields, moving
          ? { startDate: validated.start_date, endDate: validated.end_date }
          : undefined);
      } catch (error) {
        throw nothingWritten(error, occurrences.change);
      }
    }
    const changedFields = Object.keys(fields);
    if (moving) changedFields.push('DTSTART', 'DTEND');
    // what the fields and dates did to the series, apart from the
    // occurrences cancelled or restored above (reported on their own)
    const series = writesFields ? describeSeriesChange(occurrences.data, updatedData, 'vevent') : null;

    // Step 4: Send the updated event back to server
    const updateResponse = await client.updateCalendarObject({
      calendarObject: {
        url: validated.event_url,
        data: updatedData,
        etag: validated.event_etag
      }
    });
    await assertDavSuccess(updateResponse, `update event ${validated.event_url}`);

    return formatSuccess('Event updated successfully', {
      ...etagAfterWrite(updateResponse),
      updated_fields: changedFields,
      message: changedFields.length
        ? `Updated ${changedFields.length} field(s): ${changedFields.join(', ')}`
        : 'Updated occurrences only; no fields changed',
      ...(occurrences.change && { occurrences: occurrences.change }),
      ...(series && { series }),
    });
  }
};

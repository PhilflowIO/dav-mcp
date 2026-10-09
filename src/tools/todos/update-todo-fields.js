import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, davFieldMapSchema, davUrl, entityTag, etagQuotedByUs } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { assertDavSuccess, etagAfterWrite, objectNotFoundError } from '../shared/helpers.js';
import { z } from 'zod';
import { writeFields, reconcileTodoDates, writesDates } from '../shared/ical-dates.js';
import { fetchFloatingZone } from '../../calendar-zone.js';
import { assertFieldUpdatable, describeSeriesChange } from '../../ical-components.js';
import {
  occurrenceEditSchema, refineOccurrenceEdits, editOccurrences, notChanged, nothingWritten,
} from '../shared/occurrence-edits.js';

/**
 * Schema for field-based todo updates
 * Supports all RFC 5545 VTODO properties via tsdav-utils
 * Common fields: SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, PERCENT-COMPLETE
 * Custom properties: Any X-* property
 */
const updateTodoFieldsSchema = z.object({
  todo_url: davUrl('Todo URL must be a valid URL'),
  todo_etag: entityTag,
  fields: davFieldMapSchema,
  ...occurrenceEditSchema,
}).strict().superRefine((data, ctx) => {
  // EXDATE/RDATE are lists: written as a field they replace the whole list
  // (tsdav-utils 0.7.0), so single occurrences go through their own
  // parameters; see src/tools/shared/occurrence-edits.js
  refineOccurrenceEdits(data, ctx, 'update_todo');

  // RFC 5545 3.6.2: a todo ends either at DUE or after DURATION, never both.
  // Setting one replaces the other (see reconcileTodoDates); setting both in
  // one call has no single meaning.
  if (data.fields && 'DUE' in data.fields && 'DURATION' in data.fields) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fields', 'DURATION'],
      message: 'Set either DUE or DURATION, not both (RFC 5545 3.6.2)',
    });
  }
});

// What DUE and DTSTART accept; tsdav-utils parses exactly these forms
const DATE_FORMS =
  'ISO 8601 with a zone ("2026-10-26T18:00:00Z", "2026-10-26T14:00:00-04:00"; that instant, written in the todo\'s own timezone if it has one), ' +
  'without one (kept in the todo\'s own timezone if it has one; a todo stored without a zone stays without one, ' +
  'and a value with a zone becomes its local time in the calendar\'s time zone; else read in the calendar\'s time zone), ' +
  'or a date ("2026-10-26") for an all-day value';

/**
 * Field-agnostic todo update tool powered by tsdav-utils
 * Supports all RFC 5545 VTODO properties without validation
 *
 * Features:
 * - Any standard VTODO property (SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, etc.)
 * - Custom X-* properties for extensions
 * - Field-agnostic: no pre-defined field list required
 */
export const updateTodoFields = {
  name: 'update_todo',
  annotations: {
    title: 'Update to-do fields',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'PREFERRED: Update todo fields without iCal formatting. Supports: SUMMARY (title), DESCRIPTION (details), STATUS (NEEDS-ACTION/IN-PROCESS/COMPLETED/CANCELLED), PRIORITY (0-9), DUE (due date), PERCENT-COMPLETE (0-100), and any RFC 5545 VTODO or custom X-* property. Recurring todos: fields change the whole series; changing DTSTART moves every occurrence, cancelled and changed ones included, and the reply lists what moved (a move the rule cannot follow is refused, saying what to give instead). To cancel or bring back single occurrences use cancel_occurrences/restore_occurrences; to change one occurrence otherwise, use todo_multi_get and update_todo_raw.',
  inputSchema: {
    type: 'object',
    properties: {
      todo_url: {
        type: 'string',
        description: 'The URL of the todo to update'
      },
      todo_etag: {
        type: 'string',
        description: 'The etag of the todo (required for conflict detection)'
      },
      fields: {
        type: 'object',
        description: 'Fields to update, keyed by bare UPPERCASE property name (e.g., SUMMARY, STATUS, PRIORITY). Any RFC 5545 VTODO property or custom X-* property is supported, except EXDATE and RDATE: use cancel_occurrences/restore_occurrences. Property parameters such as "DUE;VALUE=DATE" are not accepted here, and values must not contain line breaks.',
        additionalProperties: {
          type: 'string'
        },
        properties: {
          SUMMARY: {
            type: 'string',
            description: 'Todo title/summary'
          },
          DESCRIPTION: {
            type: 'string',
            description: 'Todo description/details'
          },
          STATUS: {
            type: 'string',
            description: 'Todo status: NEEDS-ACTION, IN-PROCESS, COMPLETED, or CANCELLED'
          },
          PRIORITY: {
            type: 'string',
            description: 'Priority level: 0 (undefined), 1 (highest) to 9 (lowest)'
          },
          DUE: {
            type: 'string',
            description: `Due date: ${DATE_FORMS}. Must be later than DTSTART and of the same kind (both dates or both with a time). Replaces a DURATION. For a recurring todo this is the due date of its first occurrence.`
          },
          DTSTART: {
            type: 'string',
            description: `Start date: ${DATE_FORMS}. Moving it keeps the stored DUE, so to move a todo give DTSTART and DUE together. For a recurring todo this is the start of the SERIES (its first occurrence), not of an occurrence a listing showed: every occurrence moves by the difference. To cancel one occurrence use cancel_occurrences; to move one, todo_multi_get and update_todo_raw.`
          },
          COMPLETED: {
            type: 'string',
            description: 'When the todo was completed, with a time: "2026-10-26T18:00:00Z" or with an offset'
          },
          'PERCENT-COMPLETE': {
            type: 'string',
            description: 'Completion percentage: 0-100'
          }
        }
      },
      cancel_occurrences: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recurring todo: cancel these occurrences, each given exactly as todo_query, list_todos or todo_multi_get list it ("Occurrence ID"). Occurrences are named by their ORIGINAL start (where the occurrence was before any change) in the series\' own form: the wall-clock time in its zone without Z ("2026-12-24T09:00:00"), with Z for a UTC series ("2026-12-24T09:00:00Z"), or the date for an all-day series ("2026-12-24"). Adds to the exclusions already there; a changed version of the occurrence is removed too. Names refer to the series as it is before this call.'
      },
      restore_occurrences: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recurring todo: bring back these cancelled occurrences, each given exactly as todo_query, list_todos or todo_multi_get list it under "Cancelled occurrences" (named as for cancel_occurrences). Removes only those exclusions. Applied before cancel_occurrences and fields.'
      }
    },
    required: ['todo_url', 'todo_etag']
  },
  handler: async (args) => {
    const validated = validateInput(updateTodoFieldsSchema, args);
    const fields = validated.fields || {};
    const writesFields = Object.keys(fields).length > 0;
    // empty lists are no request; a call that asks for nothing writes nothing
    if (!writesFields && !validated.cancel_occurrences?.length && !validated.restore_occurrences?.length) {
      return notChanged('Todo', 'nothing to change: no fields, cancel_occurrences or restore_occurrences were given');
    }
    const client = tsdavManager.getCalDavClient();

    // Step 1: Fetch the current todo from server
    const calendarUrl = validated.todo_url.substring(0, validated.todo_url.lastIndexOf('/') + 1);
    const currentTodos = await client.fetchTodos({
      calendar: { url: calendarUrl },
      objectUrls: [validated.todo_url]
    });

    if (!currentTodos || currentTodos.length === 0) {
      throw objectNotFoundError('todo_url', validated.todo_url, 'todo', 'todo_query or list_todos');
    }

    const todoObject = currentTodos[0];
    // a field update edits the series master; refuse one that has none
    assertFieldUpdatable(todoObject, 'vtodo');

    // Step 2: Restore, then cancel the occurrences named — as the series is
    // before this call — so a DTSTART move below takes the new exclusions along.
    const occurrences = editOccurrences(todoObject.data, {
      cancel: validated.cancel_occurrences,
      restore: validated.restore_occurrences,
    }, 'vtodo');

    // Step 3: Update fields (field-agnostic; date-typed values such as DUE
    // are encoded by tsdav-utils), then keep DUE/DTSTART/DURATION coherent
    if (!writesFields && occurrences.data === todoObject.data) {
      return notChanged('Todo', 'the occurrences were already as asked', occurrences.change);
    }
    let updatedData = occurrences.data;
    if (writesFields) {
      try {
        updatedData = reconcileTodoDates(
          writeFields(occurrences.data, fields, 'vtodo',
            writesDates(fields) ? await fetchFloatingZone(client, calendarUrl) : null), Object.keys(fields));
      } catch (error) {
        throw nothingWritten(error, occurrences.change);
      }
    }

    // what the fields did to the series, apart from the occurrences
    // cancelled or restored above (reported on their own)
    const series = writesFields ? describeSeriesChange(occurrences.data, updatedData, 'vtodo') : null;

    // Step 4: Send the updated todo back to server
    const updateResponse = await client.updateTodo({
      calendarObject: {
        url: validated.todo_url,
        data: updatedData,
        etag: validated.todo_etag
      }
    });
    await assertDavSuccess(updateResponse, `update todo ${validated.todo_url}`, {
      quotedEtag: etagQuotedByUs(args.todo_etag, validated.todo_etag),
      callerContent: { noun: 'todo', fix: 'Correct the values in fields and send them again.' },
    });

    return formatSuccess('Todo updated successfully', {
      ...etagAfterWrite(updateResponse),
      updated_fields: Object.keys(validated.fields || {}),
      message: writesFields
        ? `Updated ${Object.keys(fields).length} field(s): ${Object.keys(fields).join(', ')}`
        : 'Updated occurrences only; no fields changed',
      ...(occurrences.change && { occurrences: occurrences.change }),
      ...(series && { series }),
    });
  }
};

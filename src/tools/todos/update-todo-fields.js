import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, davFieldMapSchema, davUrl } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { assertDavSuccess, etagAfterWrite } from '../shared/helpers.js';
import { z } from 'zod';
import { writeFields, reconcileTodoDates } from '../shared/ical-dates.js';
import { assertFieldUpdatable, describeSeriesChange } from '../../ical-components.js';

/**
 * Schema for field-based todo updates
 * Supports all RFC 5545 VTODO properties via tsdav-utils
 * Common fields: SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, PERCENT-COMPLETE
 * Custom properties: Any X-* property
 */
const updateTodoFieldsSchema = z.object({
  todo_url: davUrl('Todo URL must be a valid URL'),
  todo_etag: z.string().min(1, 'Todo etag is required'),
  fields: davFieldMapSchema
}).superRefine((data, ctx) => {
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
  'ISO 8601 with a zone ("2026-10-26T18:00:00Z", "2026-10-26T14:00:00-04:00"), ' +
  'without one (kept in the todo\'s own timezone if it has one, else read in the timezone of the computer running dav-mcp), ' +
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
  description: 'PREFERRED: Update todo fields without iCal formatting. Supports: SUMMARY (title), DESCRIPTION (details), STATUS (NEEDS-ACTION/IN-PROCESS/COMPLETED/CANCELLED), PRIORITY (0-9), DUE (due date), PERCENT-COMPLETE (0-100), and any RFC 5545 VTODO property including custom X-* properties. Recurring todos: update_todo edits the whole series. Changing DTSTART moves every occurrence, including moved and cancelled ones (overrides, EXDATE), extra dates (RDATE) and the end of the series (UNTIL); a weekday or day of month the rule only restates follows the new start. If the rule cannot follow, the call is refused and says what to give instead, such as RRULE in fields of the same call. The reply lists what else moved. RECURRENCE-ID cannot be set. To change a single occurrence, fetch the todo with todo_multi_get and send the edited iCalendar with update_todo_raw.',
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
        description: 'Fields to update, keyed by bare UPPERCASE property name (e.g., SUMMARY, STATUS, PRIORITY). Any RFC 5545 VTODO property or custom X-* property is supported. Property parameters such as "DUE;VALUE=DATE" are not accepted here, and values must not contain line breaks.',
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
            description: `Start date: ${DATE_FORMS}. Moving it keeps the stored DUE, so to move a todo give DTSTART and DUE together. For a recurring todo this is the start of the SERIES (its first occurrence), not of an occurrence a listing showed: every occurrence moves by the difference. To change one occurrence, use todo_multi_get and update_todo_raw.`
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
      }
    },
    required: ['todo_url', 'todo_etag']
  },
  handler: async (args) => {
    const validated = validateInput(updateTodoFieldsSchema, args);
    const client = tsdavManager.getCalDavClient();

    // Step 1: Fetch the current todo from server
    const calendarUrl = validated.todo_url.substring(0, validated.todo_url.lastIndexOf('/') + 1);
    const currentTodos = await client.fetchTodos({
      calendar: { url: calendarUrl },
      objectUrls: [validated.todo_url]
    });

    if (!currentTodos || currentTodos.length === 0) {
      throw new Error('Todo not found');
    }

    const todoObject = currentTodos[0];
    // a field update edits the series master; refuse one that has none
    assertFieldUpdatable(todoObject, 'vtodo');

    // Step 2: Update fields (field-agnostic; date-typed values such as DUE
    // are encoded by tsdav-utils), then keep DUE/DTSTART/DURATION coherent
    const updatedData = reconcileTodoDates(
      writeFields(todoObject, validated.fields || {}, 'vtodo'),
      Object.keys(validated.fields || {})
    );

    // Step 3: Send the updated todo back to server
    const updateResponse = await client.updateTodo({
      calendarObject: {
        url: validated.todo_url,
        data: updatedData,
        etag: validated.todo_etag
      }
    });
    await assertDavSuccess(updateResponse, `update todo ${validated.todo_url}`);

    const series = describeSeriesChange(todoObject, updatedData, 'vtodo');
    return formatSuccess('Todo updated successfully', {
      ...etagAfterWrite(updateResponse),
      updated_fields: Object.keys(validated.fields || {}),
      message: `Updated ${Object.keys(validated.fields || {}).length} field(s): ${Object.keys(validated.fields || {}).join(', ')}`,
      ...(series && { series }),
    });
  }
};

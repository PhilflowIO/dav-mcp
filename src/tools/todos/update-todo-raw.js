import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateTodoSchema, etagQuotedByUs } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { assertDavSuccess, etagAfterWrite } from '../shared/helpers.js';

/**
 * Update an existing todo/task with raw VTODO iCal data
 */
export const updateTodoRaw = {
  name: 'update_todo_raw',
  annotations: {
    title: 'Replace to-do iCalendar data',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'ADVANCED: Update todo with raw VTODO iCal data. Requires manual iCal formatting - use update_todo instead for simple field updates (summary, description, status). Use this to move or retitle a single occurrence of a recurring todo (fetch it with todo_multi_get, add or edit the VTODO with that occurrence\'s RECURRENCE-ID, send the whole object) and to add or remove extra dates (RDATE). To cancel or restore occurrences, use update_todo with cancel_occurrences/restore_occurrences. Also for complete pre-formatted iCal data or advanced iCal properties.',
  inputSchema: {
    type: 'object',
    properties: {
      todo_url: {
        type: 'string',
        description: 'The URL of the todo to update',
      },
      todo_etag: {
        type: 'string',
        description: 'The current ETag of the todo (required for conflict detection)',
      },
      updated_ical_data: {
        type: 'string',
        description: 'Complete updated VTODO iCalendar data',
      },
    },
    required: ['todo_url', 'todo_etag', 'updated_ical_data'],
  },
  handler: async (args) => {
    const validated = validateInput(updateTodoSchema, args);
    const client = tsdavManager.getCalDavClient();

    const result = await client.updateTodo({
      calendarObject: {
        url: validated.todo_url,
        data: validated.updated_ical_data,
        etag: validated.todo_etag,
      },
    });
    await assertDavSuccess(result, `update todo ${validated.todo_url}`, {
      quotedEtag: etagQuotedByUs(args.todo_etag, validated.todo_etag),
    });

    return formatSuccess('Todo updated successfully', {
      url: result.url,
      ...etagAfterWrite(result),
    });
  },
};

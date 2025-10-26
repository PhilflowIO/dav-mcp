import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateTodoSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Update an existing todo/task with raw VTODO iCal data
 */
export const updateTodoRaw = {
  name: 'update_todo_raw',
  description: 'ADVANCED: Update todo with raw VTODO iCal data. Requires manual iCal formatting - use update_todo instead for simple field updates (summary, description, status). Only use this if you have complete pre-formatted VTODO data or need to update advanced iCal properties.',
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
      todo: {
        url: validated.todo_url,
        data: validated.updated_ical_data,
        etag: validated.todo_etag,
      },
    });

    return formatSuccess('Todo updated successfully', {
      url: result.url,
      etag: result.etag,
    });
  },
};

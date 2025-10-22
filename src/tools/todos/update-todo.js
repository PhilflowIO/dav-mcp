import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateTodoSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Update an existing todo/task
 */
export const updateTodo = {
  name: 'update_todo',
  description: 'Update an existing todo/task. Requires todo URL, etag, and complete updated iCal data. Use this to modify todo details or mark as completed.',
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

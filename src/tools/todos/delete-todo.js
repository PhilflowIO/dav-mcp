import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteTodoSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Delete a todo/task permanently
 */
export const deleteTodo = {
  name: 'delete_todo',
  description: 'Delete a todo/task permanently from the calendar. Cannot be undone. Requires todo URL and etag.',
  inputSchema: {
    type: 'object',
    properties: {
      todo_url: {
        type: 'string',
        description: 'The URL of the todo to delete',
      },
      todo_etag: {
        type: 'string',
        description: 'The current ETag of the todo',
      },
    },
    required: ['todo_url', 'todo_etag'],
  },
  handler: async (args) => {
    const validated = validateInput(deleteTodoSchema, args);
    const client = tsdavManager.getCalDavClient();

    await client.deleteTodo({
      calendarObject: {
        url: validated.todo_url,
        etag: validated.todo_etag,
      },
    });

    return formatSuccess('Todo deleted successfully');
  },
};

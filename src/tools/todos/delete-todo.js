import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteTodoSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Delete a todo/task permanently
 */
export const deleteTodo = {
  name: 'delete_todo',
  description: 'Permanently delete a todo/task from the calendar. WARNING: This action cannot be undone — the todo is removed from the server immediately. Use only when the user explicitly requests deletion. Obtain the todo URL and etag from list_todos or todo_query first. The etag ensures no conflicting changes occurred since the todo was last retrieved.',
  inputSchema: {
    type: 'object',
    properties: {
      todo_url: {
        type: 'string',
        description: 'Full URL of the todo to delete. Obtain from list_todos or todo_query response.',
      },
      todo_etag: {
        type: 'string',
        description: 'ETag of the todo for conflict detection. Obtain from the same response as the todo URL. Ensures no changes were made since retrieval.',
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

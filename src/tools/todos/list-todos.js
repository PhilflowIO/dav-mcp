import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, listTodosSchema } from '../../validation.js';
import { formatTodoList } from '../../formatters.js';

/**
 * List ALL todos/tasks from a calendar
 */
export const listTodos = {
  name: 'list_todos',
  description: 'List ALL todos/tasks from a calendar. WARNING: Returns all todos without filtering - use todo_query for searches with filters by status, summary, or due date.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'The URL of the calendar containing todos',
      },
    },
    required: ['calendar_url'],
  },
  handler: async (args) => {
    const validated = validateInput(listTodosSchema, args);
    const client = tsdavManager.getCalDavClient();

    const calendar = { url: validated.calendar_url };
    const todos = await client.fetchTodos({ calendar });

    return formatTodoList(todos, validated.calendar_url);
  },
};

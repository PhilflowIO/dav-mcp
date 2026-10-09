import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, listTodosSchema } from '../../validation.js';
import { formatTodoList } from '../../formatters.js';
import { fetchFloatingZone, withFloatingZone, withZoneNote } from '../../calendar-zone.js';

/**
 * List ALL todos/tasks from a calendar
 */
export const listTodos = {
  name: 'list_todos',
  annotations: {
    title: 'List to-dos',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
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
    // floating times and dates are read in the calendar's zone
    const zone = await fetchFloatingZone(client, calendar.url);
    const todos = withFloatingZone(await client.fetchTodos({ calendar }), zone);

    return withZoneNote(formatTodoList(todos, validated.calendar_url), [zone]);
  },
};

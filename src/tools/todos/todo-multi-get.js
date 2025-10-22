import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, todoMultiGetSchema } from '../../validation.js';
import { formatTodoList } from '../../formatters.js';

/**
 * Batch fetch multiple specific todos by their URLs
 */
export const todoMultiGet = {
  name: 'todo_multi_get',
  description: 'Batch fetch multiple specific todos by their URLs. More efficient than fetching one by one when you have exact todo URLs.',
  inputSchema: {
    type: 'object',
    properties: {
      todo_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of todo URLs to fetch',
      },
    },
    required: ['todo_urls'],
  },
  handler: async (args) => {
    const validated = validateInput(todoMultiGetSchema, args);
    const client = tsdavManager.getCalDavClient();

    // Extract calendar URL from first todo URL
    const calendarUrl = validated.todo_urls[0].split('/').slice(0, -1).join('/');

    const todos = await client.todoMultiGet({
      url: calendarUrl,
      props: [{ name: 'getetag', namespace: 'DAV:' }, { name: 'calendar-data', namespace: 'urn:ietf:params:xml:ns:caldav' }],
      objectUrls: validated.todo_urls,
    });

    return formatTodoList(todos, calendarUrl);
  },
};

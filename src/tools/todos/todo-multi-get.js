import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, todoMultiGetSchema } from '../../validation.js';
import { formatTodoList, withMissingObjects } from '../../formatters.js';
import { multiGetObjects } from '../shared/multiget.js';

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

    // No calendar_url parameter: a multiget goes to the collection holding the
    // objects, so send one per parent collection. Todos from several task
    // lists then all come back instead of only those next to the first URL.
    const byCalendar = new Map();
    for (const url of validated.todo_urls) {
      const calendarUrl = new URL('.', url).href;
      if (!byCalendar.has(calendarUrl)) byCalendar.set(calendarUrl, []);
      byCalendar.get(calendarUrl).push(url);
    }

    const todos = [];
    const missing = [];
    for (const [calendarUrl, objectUrls] of byCalendar) {
      const result = await multiGetObjects(client, { kind: 'calendar', collectionUrl: calendarUrl, objectUrls });
      todos.push(...result.found);
      missing.push(...result.missing);
    }

    const calendarName = byCalendar.size === 1
      ? [...byCalendar.keys()][0]
      : `${byCalendar.size} calendars`;
    return withMissingObjects(formatTodoList(todos, calendarName), missing);
  },
};

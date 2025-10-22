import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, todoQuerySchema } from '../../validation.js';
import { formatTodoList } from '../../formatters.js';

/**
 * Search and filter todos efficiently
 */
export const todoQuery = {
  name: 'todo_query',
  description: '⭐ PREFERRED: Search and filter todos efficiently by status, summary text, or due date range. Use this instead of list_todos when user asks "show my tasks", "what\'s due this week", "incomplete tasks". Much more token-efficient than list_todos. If calendar_url is not provided, searches across ALL calendars automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'Optional: The URL of a specific calendar containing todos. If omitted, searches across ALL calendars.',
      },
      summary_filter: {
        type: 'string',
        description: 'Optional: Filter by summary text (partial match, case-insensitive)',
      },
      status_filter: {
        type: 'string',
        enum: ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'],
        description: 'Optional: Filter by specific status',
      },
      time_range_start: {
        type: 'string',
        description: 'Optional: Start of due date range (ISO 8601 format)',
      },
      time_range_end: {
        type: 'string',
        description: 'Optional: End of due date range (ISO 8601 format)',
      },
    },
    required: [],
  },
  handler: async (args) => {
    const validated = validateInput(todoQuerySchema, args);
    const client = tsdavManager.getCalDavClient();
    const calendars = await client.fetchCalendars();

    // If specific calendar requested, use it
    let calendarsToSearch = calendars;
    if (validated.calendar_url) {
      const calendar = calendars.find(c => c.url === validated.calendar_url);
      if (!calendar) {
        const availableUrls = calendars.map(c => c.url).join('\n- ');
        throw new Error(
          `Calendar not found: ${validated.calendar_url}\n\n` +
          `Available calendar URLs:\n- ${availableUrls}\n\n` +
          `Tip: Omit calendar_url to search across all calendars automatically.`
        );
      }
      calendarsToSearch = [calendar];
    }

    // Fetch todos from all selected calendars
    let todos = [];
    for (const calendar of calendarsToSearch) {
      const calendarTodos = await client.fetchTodos({ calendar });
      // Add calendar info to each todo
      calendarTodos.forEach(todo => {
        todo._calendarName = calendar.displayName || calendar.url;
      });
      todos = todos.concat(calendarTodos);
    }

    // Client-side filtering (tsdav doesn't support server-side VTODO filtering yet)
    if (validated.summary_filter) {
      const summaryLower = validated.summary_filter.toLowerCase();
      todos = todos.filter(todo => {
        const summary = todo.data?.match(/SUMMARY:(.+)/)?.[1] || '';
        return summary.toLowerCase().includes(summaryLower);
      });
    }

    if (validated.status_filter) {
      todos = todos.filter(todo => {
        const status = todo.data?.match(/STATUS:(.+)/)?.[1] || 'NEEDS-ACTION';
        return status === validated.status_filter;
      });
    }

    if (validated.time_range_start && validated.time_range_end) {
      const startTime = new Date(validated.time_range_start).getTime();
      const endTime = new Date(validated.time_range_end).getTime();

      todos = todos.filter(todo => {
        const dueMatch = todo.data?.match(/DUE:(\d{8}T\d{6}Z?)/);
        if (!dueMatch) return false;

        const dueStr = dueMatch[1];
        const year = parseInt(dueStr.substr(0, 4));
        const month = parseInt(dueStr.substr(4, 2)) - 1;
        const day = parseInt(dueStr.substr(6, 2));
        const hour = parseInt(dueStr.substr(9, 2));
        const minute = parseInt(dueStr.substr(11, 2));
        const dueTime = new Date(Date.UTC(year, month, day, hour, minute)).getTime();

        return dueTime >= startTime && dueTime <= endTime;
      });
    }

    // Determine calendar name for display
    const calendarName = calendarsToSearch.length === 1
      ? (calendarsToSearch[0].displayName || calendarsToSearch[0].url)
      : `All Calendars (${calendarsToSearch.length})`;

    return formatTodoList(todos, calendarName);
  },
};

import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, todoQuerySchema } from '../../validation.js';
import { formatTodoList, withUnsearched } from '../../formatters.js';
import { limitResults, DEFAULT_RESULT_LIMIT } from '../shared/helpers.js';
import { dueSpan } from '../shared/ical-dates.js';
import { todoStatus } from '../../ical-components.js';
import { parseObjects, unsearchedObjects, textValues, containsText, dateKey, orNull } from '../shared/query-objects.js';
import { floatingZoneFor, withFloatingZone, withZoneNote } from '../../calendar-zone.js';

/**
 * Search and filter todos efficiently
 */
export const todoQuery = {
  name: 'todo_query',
  annotations: {
    title: 'Search to-dos',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: '⭐ PREFERRED: Search and filter todos efficiently. Use instead of list_todos to conserve tokens. Omit calendar_url to search across ALL calendars automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'Optional: Specific calendar URL. Omit to search ALL calendars (recommended).',
      },
      summary_filter: {
        type: 'string',
        description: 'Search todo summaries/titles containing this text (case-insensitive). Example: "write report" or "review PR". Can be used alone as sufficient filter.',
      },
      status_filter: {
        type: 'string',
        enum: ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'],
        description: 'Filter by todo status. Use "NEEDS-ACTION" for pending tasks, "COMPLETED" for done tasks. Can be used alone as sufficient filter.',
      },
      time_range_start: {
        type: 'string',
        description: 'Start datetime for due date filtering (ISO 8601). If provided, time_range_end is REQUIRED. Both dates together form a complete filter.',
      },
      time_range_end: {
        type: 'string',
        description: 'End datetime for due date filtering (ISO 8601). If provided, time_range_start is REQUIRED. Both dates together form a complete filter.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of todos to return (default 20, max 500). You get the earliest by due date, and the response states how many matched in total.',
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
    // each calendar's zone, for a note when one could not be read
    const zones = [];
    for (const calendar of calendarsToSearch) {
      // floating times and dates are read in each calendar's own zone
      const zone = floatingZoneFor(calendar);
      zones.push(zone);
      const calendarTodos = withFloatingZone(await client.fetchTodos({ calendar }), zone);
      todos = todos.concat(calendarTodos);
    }

    // Client-side filtering (tsdav doesn't support server-side VTODO filtering
    // yet), on parsed values; see query-objects.js
    const all = parseObjects(todos, 'vtodo');
    let parsed = all;

    if (validated.summary_filter) {
      parsed = parsed.filter(({ main }) =>
        containsText(textValues(main, 'summary'), validated.summary_filter));
    }

    if (validated.status_filter) {
      // the master's status, read as the todo display reads it
      parsed = parsed.filter(({ main }) => Boolean(main) && todoStatus(main) === validated.status_filter);
    }

    if (validated.time_range_start && validated.time_range_end) {
      const startTime = new Date(validated.time_range_start).getTime();
      const endTime = new Date(validated.time_range_end).getTime();

      // A DUE can be a DATE (an all-day todo, which covers its whole day) or
      // carry a TZID
      parsed = parsed.filter(({ main }) => {
        const due = orNull(() => dueSpan(main));
        return Boolean(due) && due.start <= endTime && due.end >= startTime;
      });
    }

    // Determine calendar name for display
    const calendarName = calendarsToSearch.length === 1
      ? (calendarsToSearch[0].displayName || calendarsToSearch[0].url)
      : `All Calendars (${calendarsToSearch.length})`;

    const { items, total } = limitResults(
      parsed,
      validated.limit ?? DEFAULT_RESULT_LIMIT,
      (p) => dateKey(p, 'due')
    );

    const result = formatTodoList(items.map(({ object }) => object), calendarName, total);
    return withZoneNote(withUnsearched(result, unsearchedObjects(all, parsed), 'todos', 'list_todos'), zones);
  },
};

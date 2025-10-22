import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, createTodoSchema, sanitizeICalString } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { formatICalDate } from '../shared/helpers.js';

/**
 * Create a new todo/task in a calendar
 */
export const createTodo = {
  name: 'create_todo',
  description: 'Create a new todo/task in a calendar. Use this when user wants to add a task, todo item, or reminder with optional due date, priority, and status.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'The URL of the calendar to create the todo in',
      },
      summary: {
        type: 'string',
        description: 'The title/summary of the todo (required)',
      },
      description: {
        type: 'string',
        description: 'Optional detailed description',
      },
      due_date: {
        type: 'string',
        description: 'Optional due date in ISO 8601 format (e.g., 2025-12-31T23:59:59+02:00)',
      },
      priority: {
        type: 'number',
        description: 'Optional priority: 0=none, 1-3=high, 4-6=medium, 7-9=low',
      },
      status: {
        type: 'string',
        enum: ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'],
        description: 'Optional status (default: NEEDS-ACTION)',
      },
      percent_complete: {
        type: 'number',
        description: 'Optional completion percentage (0-100)',
      },
    },
    required: ['calendar_url', 'summary'],
  },
  handler: async (args) => {
    const validated = validateInput(createTodoSchema, args);
    const client = tsdavManager.getCalDavClient();

    // Build VTODO iCalendar string
    const uid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@tsdav-mcp`;
    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    let vtodo = 'BEGIN:VCALENDAR\r\n';
    vtodo += 'VERSION:2.0\r\n';
    vtodo += 'PRODID:-//tsdav-mcp-server//NONSGML v1.2.0//EN\r\n';
    vtodo += 'BEGIN:VTODO\r\n';
    vtodo += `UID:${uid}\r\n`;
    vtodo += `DTSTAMP:${dtstamp}\r\n`;
    vtodo += `SUMMARY:${sanitizeICalString(validated.summary)}\r\n`;

    if (validated.description) {
      vtodo += `DESCRIPTION:${sanitizeICalString(validated.description)}\r\n`;
    }

    if (validated.status) {
      vtodo += `STATUS:${validated.status}\r\n`;
    } else {
      vtodo += 'STATUS:NEEDS-ACTION\r\n';
    }

    if (validated.priority !== undefined) {
      vtodo += `PRIORITY:${validated.priority}\r\n`;
    }

    if (validated.due_date) {
      const dueDate = new Date(validated.due_date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      vtodo += `DUE:${dueDate}\r\n`;
    }

    if (validated.percent_complete !== undefined) {
      vtodo += `PERCENT-COMPLETE:${validated.percent_complete}\r\n`;
    }

    vtodo += 'END:VTODO\r\n';
    vtodo += 'END:VCALENDAR\r\n';

    const result = await client.createTodo({
      calendar: { url: validated.calendar_url },
      filename: `${Date.now()}.ics`,
      iCalString: vtodo,
    });

    return formatSuccess('Todo created successfully', {
      url: result.url,
      etag: result.etag,
      summary: validated.summary,
    });
  },
};

import { tsdavManager } from '../../tsdav-client.js';
import { validateInput } from '../../validation.js';
import { formatSuccess, formatError } from '../../formatters.js';
import { z } from 'zod';
import { updateFields } from 'tsdav-utils';

/**
 * Schema for field-based todo updates
 * Supports all RFC 5545 VTODO properties via tsdav-utils
 * Common fields: SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, PERCENT-COMPLETE
 * Custom properties: Any X-* property
 */
const updateTodoFieldsSchema = z.object({
  todo_url: z.string().url('Todo URL must be a valid URL'),
  todo_etag: z.string().min(1, 'Todo etag is required'),
  fields: z.record(z.string()).optional()
});

/**
 * Field-agnostic todo update tool powered by tsdav-utils
 * Supports all RFC 5545 VTODO properties without validation
 *
 * Features:
 * - Any standard VTODO property (SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, etc.)
 * - Custom X-* properties for extensions
 * - Field-agnostic: no pre-defined field list required
 */
export const updateTodoFields = {
  name: 'update_todo',
  description: 'PREFERRED: Update todo fields without iCal formatting. Supports: SUMMARY (title), DESCRIPTION (details), STATUS (NEEDS-ACTION/IN-PROCESS/COMPLETED/CANCELLED), PRIORITY (0-9), DUE (due date), PERCENT-COMPLETE (0-100), and any RFC 5545 VTODO property including custom X-* properties.',
  inputSchema: {
    type: 'object',
    properties: {
      todo_url: {
        type: 'string',
        description: 'The URL of the todo to update'
      },
      todo_etag: {
        type: 'string',
        description: 'The etag of the todo (required for conflict detection)'
      },
      fields: {
        type: 'object',
        description: 'Fields to update - use UPPERCASE property names (e.g., SUMMARY, STATUS, PRIORITY). Any RFC 5545 VTODO property or custom X-* property is supported.',
        additionalProperties: {
          type: 'string'
        },
        properties: {
          SUMMARY: {
            type: 'string',
            description: 'Todo title/summary'
          },
          DESCRIPTION: {
            type: 'string',
            description: 'Todo description/details'
          },
          STATUS: {
            type: 'string',
            description: 'Todo status: NEEDS-ACTION, IN-PROCESS, COMPLETED, or CANCELLED'
          },
          PRIORITY: {
            type: 'string',
            description: 'Priority level: 0 (undefined), 1 (highest) to 9 (lowest)'
          },
          DUE: {
            type: 'string',
            description: 'Due date (ISO 8601 or iCal format: 20250128T100000Z)'
          },
          'PERCENT-COMPLETE': {
            type: 'string',
            description: 'Completion percentage: 0-100'
          }
        }
      }
    },
    required: ['todo_url', 'todo_etag']
  },
  handler: async (args) => {
    try {
      const validated = validateInput(updateTodoFieldsSchema, args);
      const client = tsdavManager.getCalDavClient();

      // Step 1: Fetch the current todo from server
      const calendarUrl = validated.todo_url.substring(0, validated.todo_url.lastIndexOf('/') + 1);
      const currentTodos = await client.fetchTodos({
        calendar: { url: calendarUrl },
        objectUrls: [validated.todo_url]
      });

      if (!currentTodos || currentTodos.length === 0) {
        throw new Error('Todo not found');
      }

      const todoObject = currentTodos[0];

      // Step 2: Update fields using tsdav-utils (field-agnostic)
      // Accepts any RFC 5545 VTODO property name (UPPERCASE)
      const updatedData = updateFields(todoObject, validated.fields || {});

      // Step 3: Send the updated todo back to server
      const updateResponse = await client.updateTodo({
        calendarObject: {
          url: validated.todo_url,
          data: updatedData,
          etag: validated.todo_etag
        }
      });

      return formatSuccess('Todo updated successfully', {
        etag: updateResponse.etag,
        updated_fields: Object.keys(validated.fields || {}),
        message: `Updated ${Object.keys(validated.fields || {}).length} field(s): ${Object.keys(validated.fields || {}).join(', ')}`
      });

    } catch (error) {
      return formatError('update_todo', error);
    }
  }
};

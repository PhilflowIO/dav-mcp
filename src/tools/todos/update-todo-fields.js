import { tsdavManager } from '../../tsdav-client.js';
import { validateInput } from '../../validation.js';
import { formatSuccess, formatError } from '../../formatters.js';
import { z } from 'zod';
import tsdavPkg from 'tsdav';
const tsdavUpdateTodoFields = tsdavPkg.updateTodoFields;

/**
 * Schema for field-based todo updates
 * Currently supports MVP fields from tsdav v2.2.0: SUMMARY and DESCRIPTION
 * Note: tsdav uses UPPERCASE field names internally for iCal compatibility
 */
const updateTodoFieldsSchema = z.object({
  todo_url: z.string().url('Todo URL must be a valid URL'),
  todo_etag: z.string().min(1, 'Todo etag is required'),
  fields: z.object({
    summary: z.string().optional(),
    description: z.string().optional(),
    // Future fields (pending tsdav support):
    // status: z.enum(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']).optional(),
    // due_date: z.string().optional(),
    // priority: z.number().optional(),
  }).optional()
});

/**
 * Wrapper for tsdav's native updateTodoFields function
 * Uses the field-based update implementation from tsdav v2.2.0 MVP
 *
 * Current MVP limitations:
 * - Only SUMMARY and DESCRIPTION fields are officially supported
 * - Other VTODO fields require using the full update_todo_raw tool
 */
export const updateTodoFields = {
  name: 'update_todo',
  description: 'PREFERRED: Update todo fields (summary, description) easily without iCal formatting. Use this for simple todo updates. For advanced VTODO properties, use update_todo_raw instead. Currently supports summary and description fields only.',
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
        description: 'Fields to update - only include fields you want to change. Currently supported: summary, description',
        properties: {
          summary: {
            type: 'string',
            description: 'Todo title/summary - the main heading shown in task lists'
          },
          description: {
            type: 'string',
            description: 'Todo description - detailed information about the task'
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

      // Step 2: Transform snake_case field names to UPPERCASE for tsdav
      // tsdav's updateTodoFields expects UPPERCASE iCal property names
      const tsdavFields = {};
      if (validated.fields) {
        if (validated.fields.summary !== undefined) {
          tsdavFields.summary = validated.fields.summary;
        }
        if (validated.fields.description !== undefined) {
          tsdavFields.description = validated.fields.description;
        }
      }

      // Step 3: Use tsdav's native updateTodoFields function
      const result = tsdavUpdateTodoFields(todoObject, tsdavFields);

      // Step 4: Send the updated todo back to server
      const updateResponse = await client.updateTodo({
        todo: {
          url: validated.todo_url,
          data: result.data,
          etag: validated.todo_etag
        }
      });

      return formatSuccess('Todo updated successfully', {
        etag: updateResponse.etag,
        updated_fields: Object.keys(tsdavFields),
        modified: result.modified,
        warnings: result.warnings
      });

    } catch (error) {
      return formatError('update_todo', error);
    }
  }
};

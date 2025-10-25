import { tsdavManager } from '../../tsdav-client.js';
import { validateInput } from '../../validation.js';
import { formatSuccess, formatError } from '../../formatters.js';
import { z } from 'zod';
import { updateEventFields as tsdavUpdateEventFields } from 'tsdav';

/**
 * Schema for field-based event updates
 * Maps directly to tsdav's updateEventFields function
 */
const updateEventFieldsSchema = z.object({
  event_url: z.string().url('Event URL must be a valid URL'),
  event_etag: z.string().min(1, 'Event etag is required'),
  fields: z.object({
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    status: z.enum(['TENTATIVE', 'CONFIRMED', 'CANCELLED']).optional(),
    transp: z.enum(['OPAQUE', 'TRANSPARENT']).optional(),
    class: z.enum(['PUBLIC', 'PRIVATE', 'CONFIDENTIAL']).optional(),
    priority: z.number().min(0).max(9).optional(),
    url: z.string().url().optional(),
    categories: z.array(z.string()).optional(),
    color: z.string().optional(),
    image: z.array(z.string()).optional(),
    conference: z.array(z.string()).optional(),
  }).optional()
});

/**
 * Wrapper for tsdav's native updateEventFields function
 * Uses the field-based update implementation from tsdav v2.2.0
 */
export const updateEventFields = {
  name: 'update_event_fields',
  description: 'Update specific fields of an existing calendar event without dealing with iCal format. PREFERRED over update_event for LLM/AI use.',
  inputSchema: {
    type: 'object',
    properties: {
      event_url: {
        type: 'string',
        description: 'The URL of the event to update'
      },
      event_etag: {
        type: 'string',
        description: 'The etag of the event'
      },
      fields: {
        type: 'object',
        description: 'Fields to update (only include fields you want to change)',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          description: { type: 'string', description: 'Event description' },
          location: { type: 'string', description: 'Event location' },
          start_date: { type: 'string', description: 'Start date/time in ISO 8601' },
          end_date: { type: 'string', description: 'End date/time in ISO 8601' },
          status: {
            type: 'string',
            enum: ['TENTATIVE', 'CONFIRMED', 'CANCELLED'],
            description: 'Event status'
          },
          transp: {
            type: 'string',
            enum: ['OPAQUE', 'TRANSPARENT'],
            description: 'Time transparency (busy/free)'
          },
          class: {
            type: 'string',
            enum: ['PUBLIC', 'PRIVATE', 'CONFIDENTIAL'],
            description: 'Event classification'
          },
          priority: {
            type: 'number',
            minimum: 0,
            maximum: 9,
            description: 'Priority (0=undefined, 1=highest, 9=lowest)'
          },
          url: { type: 'string', description: 'Associated URL' },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Category tags'
          },
          color: { type: 'string', description: 'CSS3 color (RFC 7986)' },
          image: {
            type: 'array',
            items: { type: 'string' },
            description: 'Image URLs (RFC 7986)'
          },
          conference: {
            type: 'array',
            items: { type: 'string' },
            description: 'Conference URIs (RFC 7986)'
          }
        }
      }
    },
    required: ['event_url', 'event_etag']
  },
  handler: async (args) => {
    try {
      const validated = validateInput(updateEventFieldsSchema, args);
      const client = tsdavManager.getCalDavClient();

      // Step 1: Fetch the current event from server
      const calendarUrl = validated.event_url.substring(0, validated.event_url.lastIndexOf('/') + 1);
      const currentEvents = await client.fetchCalendarObjects({
        calendar: { url: calendarUrl },
        objectUrls: [validated.event_url]
      });

      if (!currentEvents || currentEvents.length === 0) {
        throw new Error('Event not found');
      }

      const calendarObject = currentEvents[0];

      // Step 2: Use tsdav's native updateEventFields function
      const result = tsdavUpdateEventFields(calendarObject, validated.fields || {});

      // Step 3: Send the updated event back to server
      const updateResponse = await client.updateCalendarObject({
        calendarObject: {
          url: validated.event_url,
          data: result.data,
          etag: validated.event_etag
        }
      });

      return formatSuccess('Event updated successfully via field-based update', {
        etag: updateResponse.etag,
        updated_fields: Object.keys(validated.fields || {}),
        warnings: result.warnings
      });

    } catch (error) {
      return formatError('update_event_fields', error);
    }
  }
};
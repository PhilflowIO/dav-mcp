import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, createEventSchema, sanitizeICalString } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { formatICalDate, generateUID, findCalendarOrThrow } from '../shared/helpers.js';

/**
 * Create a new calendar event
 */
export const createEvent = {
  name: 'create_event',
  description: 'Create a new calendar event with title, date, time, optional description and location',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'The URL of the calendar to create the event in',
      },
      summary: {
        type: 'string',
        description: 'Event title/summary',
      },
      start_date: {
        type: 'string',
        description: 'Start date in ISO 8601 format',
      },
      end_date: {
        type: 'string',
        description: 'End date in ISO 8601 format',
      },
      description: {
        type: 'string',
        description: 'Event description (optional)',
      },
      location: {
        type: 'string',
        description: 'Event location (optional)',
      },
    },
    required: ['calendar_url', 'summary', 'start_date', 'end_date'],
  },
  handler: async (args) => {
    const validated = validateInput(createEventSchema, args);
    const client = tsdavManager.getCalDavClient();
    const calendars = await client.fetchCalendars();
    const calendar = findCalendarOrThrow(calendars, validated.calendar_url);

    const now = new Date();
    const uid = generateUID('event');

    const summary = sanitizeICalString(validated.summary);
    const description = validated.description ? sanitizeICalString(validated.description) : '';
    const location = validated.location ? sanitizeICalString(validated.location) : '';

    const iCalString = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//tsdav-mcp-server//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${formatICalDate(now)}
DTSTART:${formatICalDate(new Date(validated.start_date))}
DTEND:${formatICalDate(new Date(validated.end_date))}
SUMMARY:${summary}${description ? `\nDESCRIPTION:${description}` : ''}${location ? `\nLOCATION:${location}` : ''}
END:VEVENT
END:VCALENDAR`;

    const response = await client.createCalendarObject({
      calendar,
      filename: `${uid}.ics`,
      iCalString,
    });

    return formatSuccess('Event created successfully', {
      url: response.url,
      etag: response.etag,
      summary: validated.summary,
    });
  },
};

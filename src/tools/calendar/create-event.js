import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, createEventSchema, sanitizeICalString, isDateOnly } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { formatICalDate, formatICalDateOnly, generateUID, findCalendarOrThrow } from '../shared/helpers.js';

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
        description: 'Start in ISO 8601 format. A datetime ("2026-05-25T10:00:00Z") makes a timed event; a bare date ("2026-05-25") makes an all-day event.',
      },
      end_date: {
        type: 'string',
        description: 'End, in the same form as start_date. For an all-day event the end is EXCLUSIVE: a single day on 2026-05-25 is start_date "2026-05-25" and end_date "2026-05-26".',
      },
      all_day: {
        type: 'boolean',
        description: 'Optional. All-day is inferred from the date format, so this is only needed to state the intent explicitly; it must agree with the format of start_date/end_date.',
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

    // ?? not ||: an explicit all_day: false has to survive a date-only start,
    // and validation has already rejected the case where the two disagree
    const allDay = validated.all_day ?? isDateOnly(validated.start_date);

    // RFC 5545 3.6.1: an all-day event is a DATE-valued DTSTART/DTEND, and the
    // DTEND is exclusive. Anything else is a DATE-TIME in UTC.
    const dtstart = allDay
      ? `DTSTART;VALUE=DATE:${formatICalDateOnly(validated.start_date)}`
      : `DTSTART:${formatICalDate(new Date(validated.start_date))}`;
    const dtend = allDay
      ? `DTEND;VALUE=DATE:${formatICalDateOnly(validated.end_date)}`
      : `DTEND:${formatICalDate(new Date(validated.end_date))}`;

    // RFC 5545 3.1: content lines are delimited by CRLF, not LF
    const iCalString = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//tsdav-mcp-server//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatICalDate(now)}`,
      dtstart,
      dtend,
      `SUMMARY:${summary}`,
      description ? `DESCRIPTION:${description}` : null,
      location ? `LOCATION:${location}` : null,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');

    const response = await client.createCalendarObject({
      calendar,
      filename: `${uid}.ics`,
      iCalString,
    });

    return formatSuccess('Event created successfully', {
      url: response.url,
      etag: response.etag,
      summary: validated.summary,
      all_day: allDay,
    });
  },
};

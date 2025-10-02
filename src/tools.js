import { tsdavManager } from './tsdav-client.js';
import {
  validateInput,
  sanitizeICalString,
  sanitizeVCardString,
  listEventsSchema,
  createEventSchema,
  updateEventSchema,
  deleteEventSchema,
  calendarQuerySchema,
  makeCalendarSchema,
  freeBusyQuerySchema,
  listContactsSchema,
  createContactSchema,
  updateContactSchema,
  deleteContactSchema,
  addressBookQuerySchema,
} from './validation.js';
import {
  formatEventList,
  formatContactList,
  formatCalendarList,
  formatAddressBookList,
  formatSuccess,
} from './formatters.js';

/**
 * Format iCal date (ISO 8601 to iCal format)
 */
function formatICalDate(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * MCP Tools Definition for tsdav
 */
export const tools = [
  // ================================
  // CALDAV TOOLS
  // ================================
  {
    name: 'list_calendars',
    description: 'List all available calendars from the CalDAV server',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const client = tsdavManager.getCalDavClient();
      const calendars = await client.fetchCalendars();

      return formatCalendarList(calendars);
    },
  },

  {
    name: 'list_events',
    description: 'List all events from a specific calendar',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to fetch events from',
        },
        time_range_start: {
          type: 'string',
          description: 'Optional: Start date in ISO 8601 format (e.g., 2025-01-01T00:00:00.000Z)',
        },
        time_range_end: {
          type: 'string',
          description: 'Optional: End date in ISO 8601 format',
        },
      },
      required: ['calendar_url'],
    },
    handler: async (args) => {
      const validated = validateInput(listEventsSchema, args);
      const client = tsdavManager.getCalDavClient();
      const calendars = await client.fetchCalendars();
      const calendar = calendars.find(c => c.url === validated.calendar_url);

      if (!calendar) {
        throw new Error(`Calendar not found: ${validated.calendar_url}`);
      }

      const options = { calendar };

      if (validated.time_range_start && validated.time_range_end) {
        options.timeRange = {
          start: validated.time_range_start,
          end: validated.time_range_end,
        };
      }

      const events = await client.fetchCalendarObjects(options);

      return formatEventList(events, calendar.displayName);
    },
  },

  {
    name: 'create_event',
    description: 'Create a new calendar event',
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
      const calendar = calendars.find(c => c.url === validated.calendar_url);

      if (!calendar) {
        throw new Error(`Calendar not found: ${validated.calendar_url}`);
      }

      const now = new Date();
      const uid = `event-${Date.now()}@tsdav-mcp`;

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

      return formatSuccess('Event created', { url: response.url, etag: response.etag });
    },
  },

  {
    name: 'update_event',
    description: 'Update an existing calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        event_url: {
          type: 'string',
          description: 'The URL of the event to update',
        },
        event_etag: {
          type: 'string',
          description: 'The etag of the event',
        },
        updated_ical_data: {
          type: 'string',
          description: 'The complete updated iCal data',
        },
      },
      required: ['event_url', 'event_etag', 'updated_ical_data'],
    },
    handler: async (args) => {
      const validated = validateInput(updateEventSchema, args);
      const client = tsdavManager.getCalDavClient();

      const response = await client.updateCalendarObject({
        calendarObject: {
          url: validated.event_url,
          data: validated.updated_ical_data,
          etag: validated.event_etag,
        },
      });

      return formatSuccess('Event updated', { etag: response.etag });
    },
  },

  {
    name: 'delete_event',
    description: 'Delete a calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        event_url: {
          type: 'string',
          description: 'The URL of the event to delete',
        },
        event_etag: {
          type: 'string',
          description: 'The etag of the event',
        },
      },
      required: ['event_url', 'event_etag'],
    },
    handler: async (args) => {
      const validated = validateInput(deleteEventSchema, args);
      const client = tsdavManager.getCalDavClient();

      await client.deleteCalendarObject({
        calendarObject: {
          url: validated.event_url,
          etag: validated.event_etag,
        },
      });

      return formatSuccess('Event deleted', { message: 'Event deleted successfully' });
    },
  },

  {
    name: 'calendar_query',
    description: 'Advanced query for calendar events with filtering by date range, summary, and location',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to query',
        },
        time_range_start: {
          type: 'string',
          description: 'Optional: Start date in ISO 8601 format',
        },
        time_range_end: {
          type: 'string',
          description: 'Optional: End date in ISO 8601 format',
        },
        summary_filter: {
          type: 'string',
          description: 'Optional: Filter events by summary (case-insensitive substring match)',
        },
        location_filter: {
          type: 'string',
          description: 'Optional: Filter events by location (case-insensitive substring match)',
        },
        expand_recurring: {
          type: 'boolean',
          description: 'Optional: Expand recurring events into individual instances (default: false)',
        },
      },
      required: ['calendar_url'],
    },
    handler: async (args) => {
      const validated = validateInput(calendarQuerySchema, args);
      const client = tsdavManager.getCalDavClient();
      const calendars = await client.fetchCalendars();
      const calendar = calendars.find(c => c.url === validated.calendar_url);

      if (!calendar) {
        throw new Error(`Calendar not found: ${validated.calendar_url}`);
      }

      const options = { calendar };

      if (validated.time_range_start && validated.time_range_end) {
        options.timeRange = {
          start: validated.time_range_start,
          end: validated.time_range_end,
        };
      }

      let events = await client.fetchCalendarObjects(options);

      // Apply client-side filters
      if (validated.summary_filter) {
        const filterLower = validated.summary_filter.toLowerCase();
        events = events.filter(event => {
          const summary = event.data.match(/SUMMARY:(.+)/i)?.[1] || '';
          return summary.toLowerCase().includes(filterLower);
        });
      }

      if (validated.location_filter) {
        const filterLower = validated.location_filter.toLowerCase();
        events = events.filter(event => {
          const location = event.data.match(/LOCATION:(.+)/i)?.[1] || '';
          return location.toLowerCase().includes(filterLower);
        });
      }

      return formatEventList(events, calendar.displayName);
    },
  },

  {
    name: 'make_calendar',
    description: 'Create a new calendar on the CalDAV server',
    inputSchema: {
      type: 'object',
      properties: {
        display_name: {
          type: 'string',
          description: 'Display name for the new calendar',
        },
        description: {
          type: 'string',
          description: 'Optional: Description of the calendar',
        },
        color: {
          type: 'string',
          description: 'Optional: Calendar color in hex format (#RRGGBB or #RRGGBBAA)',
        },
        timezone: {
          type: 'string',
          description: 'Optional: Timezone for the calendar (e.g., "Europe/Berlin")',
        },
      },
      required: ['display_name'],
    },
    handler: async (args) => {
      const validated = validateInput(makeCalendarSchema, args);
      const client = tsdavManager.getCalDavClient();

      const calendar = await client.makeCalendar({
        filename: `${Date.now()}.ics`,
        displayName: validated.display_name,
        description: validated.description,
        color: validated.color,
        timezone: validated.timezone,
      });

      return formatSuccess('Calendar created', {
        url: calendar.url,
        displayName: validated.display_name,
      });
    },
  },

  {
    name: 'free_busy_query',
    description: 'Query free/busy time for a calendar without exposing event details',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to query',
        },
        time_range_start: {
          type: 'string',
          description: 'Start date in ISO 8601 format',
        },
        time_range_end: {
          type: 'string',
          description: 'End date in ISO 8601 format',
        },
      },
      required: ['calendar_url', 'time_range_start', 'time_range_end'],
    },
    handler: async (args) => {
      const validated = validateInput(freeBusyQuerySchema, args);
      const client = tsdavManager.getCalDavClient();
      const calendars = await client.fetchCalendars();
      const calendar = calendars.find(c => c.url === validated.calendar_url);

      if (!calendar) {
        throw new Error(`Calendar not found: ${validated.calendar_url}`);
      }

      const freeBusy = await client.freeBusyQuery({
        url: calendar.url,
        timeRange: {
          start: validated.time_range_start,
          end: validated.time_range_end,
        },
      });

      return {
        content: [{
          type: 'text',
          text: `## Free/Busy Query Result\n\n- **Calendar**: ${calendar.displayName}\n- **Time Range**: ${new Date(validated.time_range_start).toLocaleString()} to ${new Date(validated.time_range_end).toLocaleString()}\n\n### Raw Data\n\`\`\`\n${freeBusy}\n\`\`\``,
        }],
      };
    },
  },

  // ================================
  // CARDDAV TOOLS
  // ================================
  {
    name: 'list_addressbooks',
    description: 'List all available address books from the CardDAV server',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const client = tsdavManager.getCardDavClient();
      const addressBooks = await client.fetchAddressBooks();

      return formatAddressBookList(addressBooks);
    },
  },

  {
    name: 'list_contacts',
    description: 'List all contacts (vCards) from a specific address book',
    inputSchema: {
      type: 'object',
      properties: {
        addressbook_url: {
          type: 'string',
          description: 'The URL of the address book to fetch contacts from',
        },
      },
      required: ['addressbook_url'],
    },
    handler: async (args) => {
      const validated = validateInput(listContactsSchema, args);
      const client = tsdavManager.getCardDavClient();
      const addressBooks = await client.fetchAddressBooks();
      const addressBook = addressBooks.find(ab => ab.url === validated.addressbook_url);

      if (!addressBook) {
        throw new Error(`Address book not found: ${validated.addressbook_url}`);
      }

      const vcards = await client.fetchVCards({ addressBook });

      return formatContactList(vcards, addressBook.displayName);
    },
  },

  {
    name: 'create_contact',
    description: 'Create a new contact (vCard)',
    inputSchema: {
      type: 'object',
      properties: {
        addressbook_url: {
          type: 'string',
          description: 'The URL of the address book to create the contact in',
        },
        full_name: {
          type: 'string',
          description: 'Full name of the contact',
        },
        family_name: {
          type: 'string',
          description: 'Family/last name',
        },
        given_name: {
          type: 'string',
          description: 'Given/first name',
        },
        email: {
          type: 'string',
          description: 'Email address (optional)',
        },
        phone: {
          type: 'string',
          description: 'Phone number (optional)',
        },
        organization: {
          type: 'string',
          description: 'Organization/company (optional)',
        },
        note: {
          type: 'string',
          description: 'Additional notes (optional)',
        },
      },
      required: ['addressbook_url', 'full_name'],
    },
    handler: async (args) => {
      const validated = validateInput(createContactSchema, args);
      const client = tsdavManager.getCardDavClient();
      const addressBooks = await client.fetchAddressBooks();
      const addressBook = addressBooks.find(ab => ab.url === validated.addressbook_url);

      if (!addressBook) {
        throw new Error(`Address book not found: ${validated.addressbook_url}`);
      }

      const uid = `contact-${Date.now()}`;
      const fullName = sanitizeVCardString(validated.full_name);
      const familyName = validated.family_name ? sanitizeVCardString(validated.family_name) : '';
      const givenName = validated.given_name ? sanitizeVCardString(validated.given_name) : '';
      const email = validated.email ? sanitizeVCardString(validated.email) : '';
      const phone = validated.phone ? sanitizeVCardString(validated.phone) : '';
      const organization = validated.organization ? sanitizeVCardString(validated.organization) : '';
      const note = validated.note ? sanitizeVCardString(validated.note) : '';

      const vCardString = `BEGIN:VCARD
VERSION:3.0
UID:${uid}
FN:${fullName}${familyName || givenName ? `\nN:${familyName};${givenName};;;` : ''}${email ? `\nEMAIL;TYPE=INTERNET:${email}` : ''}${phone ? `\nTEL;TYPE=CELL:${phone}` : ''}${organization ? `\nORG:${organization}` : ''}${note ? `\nNOTE:${note}` : ''}
REV:${new Date().toISOString()}
END:VCARD`;

      const response = await client.createVCard({
        addressBook,
        filename: `${uid}.vcf`,
        vCardString,
      });

      return formatSuccess('Contact created', { url: response.url, etag: response.etag });
    },
  },

  {
    name: 'update_contact',
    description: 'Update an existing contact (vCard)',
    inputSchema: {
      type: 'object',
      properties: {
        vcard_url: {
          type: 'string',
          description: 'The URL of the vCard to update',
        },
        vcard_etag: {
          type: 'string',
          description: 'The etag of the vCard',
        },
        updated_vcard_data: {
          type: 'string',
          description: 'The complete updated vCard data',
        },
      },
      required: ['vcard_url', 'vcard_etag', 'updated_vcard_data'],
    },
    handler: async (args) => {
      const validated = validateInput(updateContactSchema, args);
      const client = tsdavManager.getCardDavClient();

      const response = await client.updateVCard({
        vCard: {
          url: validated.vcard_url,
          data: validated.updated_vcard_data,
          etag: validated.vcard_etag,
        },
      });

      return formatSuccess('Contact updated', { etag: response.etag });
    },
  },

  {
    name: 'delete_contact',
    description: 'Delete a contact (vCard)',
    inputSchema: {
      type: 'object',
      properties: {
        vcard_url: {
          type: 'string',
          description: 'The URL of the vCard to delete',
        },
        vcard_etag: {
          type: 'string',
          description: 'The etag of the vCard',
        },
      },
      required: ['vcard_url', 'vcard_etag'],
    },
    handler: async (args) => {
      const validated = validateInput(deleteContactSchema, args);
      const client = tsdavManager.getCardDavClient();

      await client.deleteVCard({
        vCard: {
          url: validated.vcard_url,
          etag: validated.vcard_etag,
        },
      });

      return formatSuccess('Contact deleted', { message: 'Contact deleted successfully' });
    },
  },

  {
    name: 'addressbook_query',
    description: 'Advanced query for contacts with filtering by name, email, and organization',
    inputSchema: {
      type: 'object',
      properties: {
        addressbook_url: {
          type: 'string',
          description: 'The URL of the address book to query',
        },
        name_filter: {
          type: 'string',
          description: 'Optional: Filter contacts by name (case-insensitive substring match)',
        },
        email_filter: {
          type: 'string',
          description: 'Optional: Filter contacts by email (case-insensitive substring match)',
        },
        organization_filter: {
          type: 'string',
          description: 'Optional: Filter contacts by organization (case-insensitive substring match)',
        },
      },
      required: ['addressbook_url'],
    },
    handler: async (args) => {
      const validated = validateInput(addressBookQuerySchema, args);
      const client = tsdavManager.getCardDavClient();
      const addressBooks = await client.fetchAddressBooks();
      const addressBook = addressBooks.find(ab => ab.url === validated.addressbook_url);

      if (!addressBook) {
        throw new Error(`Address book not found: ${validated.addressbook_url}`);
      }

      let vcards = await client.fetchVCards({ addressBook });

      // Apply client-side filters
      if (validated.name_filter) {
        const filterLower = validated.name_filter.toLowerCase();
        vcards = vcards.filter(vcard => {
          const fn = vcard.data.match(/FN:(.+)/i)?.[1] || '';
          return fn.toLowerCase().includes(filterLower);
        });
      }

      if (validated.email_filter) {
        const filterLower = validated.email_filter.toLowerCase();
        vcards = vcards.filter(vcard => {
          const email = vcard.data.match(/EMAIL[^:]*:(.+)/i)?.[1] || '';
          return email.toLowerCase().includes(filterLower);
        });
      }

      if (validated.organization_filter) {
        const filterLower = validated.organization_filter.toLowerCase();
        vcards = vcards.filter(vcard => {
          const org = vcard.data.match(/ORG:(.+)/i)?.[1] || '';
          return org.toLowerCase().includes(filterLower);
        });
      }

      return formatContactList(vcards, addressBook.displayName);
    },
  },
];

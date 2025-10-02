import { tsdavManager } from './tsdav-client.js';
import {
  validateInput,
  sanitizeICalString,
  sanitizeVCardString,
  listEventsSchema,
  createEventSchema,
  updateEventSchema,
  deleteEventSchema,
  listContactsSchema,
  createContactSchema,
  updateContactSchema,
  deleteContactSchema,
} from './validation.js';

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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(calendars.map(cal => ({
              displayName: cal.displayName,
              url: cal.url,
              components: cal.components,
              calendarColor: cal.calendarColor,
              description: cal.description,
            })), null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(events.map(event => ({
              url: event.url,
              etag: event.etag,
              data: event.data,
            })), null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, url: response.url, etag: response.etag }, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, etag: response.etag }, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'Event deleted' }, null, 2),
          },
        ],
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(addressBooks.map(ab => ({
              displayName: ab.displayName,
              url: ab.url,
              description: ab.description,
            })), null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(vcards.map(vcard => ({
              url: vcard.url,
              etag: vcard.etag,
              data: vcard.data,
            })), null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, url: response.url, etag: response.etag }, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, etag: response.etag }, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'Contact deleted' }, null, 2),
          },
        ],
      };
    },
  },
];

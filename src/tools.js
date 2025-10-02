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
  calendarMultiGetSchema,
  isCollectionDirtySchema,
  listContactsSchema,
  createContactSchema,
  updateContactSchema,
  deleteContactSchema,
  addressBookQuerySchema,
  addressBookMultiGetSchema,
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
    description: 'List all available calendars from the CalDAV server. Use this to get calendar URLs needed for other operations',
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
    description: 'List ALL events from a calendar without filtering. WARNING: Returns all events which can be many thousands - use calendar_query instead when searching for specific events by text, date, or location to save tokens',
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

      return formatEventList(events, calendar);
    },
  },

  {
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

      return formatSuccess('Event created successfully', {
        url: response.url,
        etag: response.etag,
        summary: validated.summary,
      });
    },
  },

  {
    name: 'update_event',
    description: 'Update an existing calendar event. Requires event URL, etag, and complete updated iCal data',
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

      return formatSuccess('Event updated successfully', {
        etag: response.etag,
      });
    },
  },

  {
    name: 'delete_event',
    description: 'Delete a calendar event permanently. Requires event URL and etag',
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

      return formatSuccess('Event deleted successfully');
    },
  },

  {
    name: 'calendar_query',
    description: 'PREFERRED: Search and filter calendar events efficiently by text (summary/title), date range, or location. Use this instead of list_events when user asks "find events with X" or "show me events containing Y" to avoid loading thousands of events. Much more token-efficient than list_events',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to query',
        },
        time_range_start: {
          type: 'string',
          description: 'Optional: Start date in ISO 8601 format (e.g., 2025-01-01T00:00:00.000Z)',
        },
        time_range_end: {
          type: 'string',
          description: 'Optional: End date in ISO 8601 format',
        },
        summary_filter: {
          type: 'string',
          description: 'Optional: Filter events by summary/title (case-insensitive substring match). Use this when user asks "find events with X in title" or "show me meeting events"',
        },
        location_filter: {
          type: 'string',
          description: 'Optional: Filter events by location (case-insensitive substring match). Use when user asks "events in room X" or "meetings at location Y"',
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

      const events = await client.fetchCalendarObjects(options);

      let filteredEvents = events;

      if (validated.summary_filter) {
        const summaryLower = validated.summary_filter.toLowerCase();
        filteredEvents = filteredEvents.filter(event => {
          const summary = event.data?.match(/SUMMARY:(.+)/)?.[1] || '';
          return summary.toLowerCase().includes(summaryLower);
        });
      }

      if (validated.location_filter) {
        const locationLower = validated.location_filter.toLowerCase();
        filteredEvents = filteredEvents.filter(event => {
          const location = event.data?.match(/LOCATION:(.+)/)?.[1] || '';
          return location.toLowerCase().includes(locationLower);
        });
      }

      return formatEventList(filteredEvents, calendar);
    },
  },

  {
    name: 'make_calendar',
    description: 'Create a new calendar collection on the CalDAV server with optional color, description, and timezone',
    inputSchema: {
      type: 'object',
      properties: {
        display_name: {
          type: 'string',
          description: 'Display name for the new calendar',
        },
        description: {
          type: 'string',
          description: 'Optional: Calendar description',
        },
        color: {
          type: 'string',
          description: 'Optional: Calendar color in hex format (e.g., #FF5733)',
        },
        timezone: {
          type: 'string',
          description: 'Optional: Timezone ID (e.g., Europe/Berlin)',
        },
      },
      required: ['display_name'],
    },
    handler: async (args) => {
      const validated = validateInput(makeCalendarSchema, args);
      const client = tsdavManager.getCalDavClient();

      const calendar = await client.makeCalendar({
        displayName: validated.display_name,
        description: validated.description,
        calendarColor: validated.color,
        timezone: validated.timezone,
      });

      return formatSuccess('Calendar created successfully', {
        displayName: calendar.displayName,
        url: calendar.url,
      });
    },
  },

  {
    name: 'free_busy_query',
    description: 'Query free/busy time without exposing private event details. Privacy-friendly alternative to listing all events',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to query',
        },
        time_range_start: {
          type: 'string',
          description: 'Start date in ISO 8601 format (e.g., 2025-01-01T00:00:00.000Z)',
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

      const freeBusy = await client.freeBusyQuery({
        url: validated.calendar_url,
        timeRange: {
          start: validated.time_range_start,
          end: validated.time_range_end,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: `## Free/Busy Information

**Time Range:** ${validated.time_range_start} to ${validated.time_range_end}

---
<details>
<summary>Raw Data (Click to expand)</summary>

\`\`\`json
${JSON.stringify(freeBusy, null, 2)}
\`\`\`
</details>`,
          },
        ],
      };
    },
  },

  {
    name: 'calendar_multi_get',
    description: 'Batch fetch multiple specific calendar events by their URLs. Use when you have exact event URLs and want to retrieve their details',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar',
        },
        event_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of event URLs to fetch',
        },
      },
      required: ['calendar_url', 'event_urls'],
    },
    handler: async (args) => {
      const validated = validateInput(calendarMultiGetSchema, args);
      const client = tsdavManager.getCalDavClient();

      const events = await client.calendarMultiGet({
        url: validated.calendar_url,
        props: [{ name: 'getetag', namespace: 'DAV:' }, 'calendar-data'],
        objectUrls: validated.event_urls,
      });

      return formatEventList(events, { url: validated.calendar_url });
    },
  },

  {
    name: 'is_collection_dirty',
    description: 'Check if calendar or address book collection has changed since last sync (via ctag comparison). Useful for efficient synchronization without fetching all data',
    inputSchema: {
      type: 'object',
      properties: {
        collection_url: {
          type: 'string',
          description: 'The URL of the calendar or address book collection',
        },
        collection_ctag: {
          type: 'string',
          description: 'The last known ctag value',
        },
      },
      required: ['collection_url', 'collection_ctag'],
    },
    handler: async (args) => {
      const validated = validateInput(isCollectionDirtySchema, args);
      const client = tsdavManager.getCalDavClient();

      const isDirty = await client.isCollectionDirty({
        url: validated.collection_url,
        props: [{ name: 'getctag', namespace: 'http://calendarserver.org/ns/' }],
      });

      return {
        content: [
          {
            type: 'text',
            text: `## Collection Status

**Collection URL:** ${validated.collection_url}
**Last Known CTag:** ${validated.collection_ctag}
**Has Changed:** ${isDirty ? '✅ Yes' : '❌ No'}

${isDirty ? '**Action Needed:** Collection has changed. Perform sync to get latest data.' : '**Status:** Collection is up-to-date. No sync needed.'}

---
<details>
<summary>Raw Data (Click to expand)</summary>

\`\`\`json
${JSON.stringify({ isDirty }, null, 2)}
\`\`\`
</details>`,
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
    description: 'List all available address books from the CardDAV server. Use this to get address book URLs needed for other contact operations',
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
    description: 'List ALL contacts from an address book without filtering. WARNING: Returns all contacts which can be thousands - use addressbook_query instead when searching for specific contacts by name, email, or organization to save tokens',
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

      return formatContactList(vcards, addressBook);
    },
  },

  {
    name: 'create_contact',
    description: 'Create a new contact (vCard) with name, email, phone, organization, and other details',
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

      return formatSuccess('Contact created successfully', {
        url: response.url,
        etag: response.etag,
        fullName: validated.full_name,
      });
    },
  },

  {
    name: 'update_contact',
    description: 'Update an existing contact (vCard). Requires contact URL, etag, and complete updated vCard data',
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

      return formatSuccess('Contact updated successfully', {
        etag: response.etag,
      });
    },
  },

  {
    name: 'delete_contact',
    description: 'Delete a contact (vCard) permanently. Requires contact URL and etag',
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

      return formatSuccess('Contact deleted successfully');
    },
  },

  {
    name: 'addressbook_query',
    description: 'PREFERRED: Search and filter contacts efficiently by name (full/given/family), email, or organization. Use this instead of list_contacts when user asks "find contacts with X" or "show me contacts at Y company" to avoid loading thousands of contacts. Much more token-efficient than list_contacts',
    inputSchema: {
      type: 'object',
      properties: {
        addressbook_url: {
          type: 'string',
          description: 'The URL of the address book to query',
        },
        name_filter: {
          type: 'string',
          description: 'Optional: Filter by name (case-insensitive substring match against FN, given name, or family name). Use when user asks "find contact John" or "show me people named Smith"',
        },
        email_filter: {
          type: 'string',
          description: 'Optional: Filter by email address (case-insensitive substring match). Use when user asks "find contact with email X" or "show me Gmail contacts"',
        },
        organization_filter: {
          type: 'string',
          description: 'Optional: Filter by organization/company (case-insensitive substring match). Use when user asks "find contacts at company X" or "show me people at Google"',
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

      const vcards = await client.fetchVCards({ addressBook });

      let filteredContacts = vcards;

      if (validated.name_filter) {
        const nameLower = validated.name_filter.toLowerCase();
        filteredContacts = filteredContacts.filter(vcard => {
          const fn = vcard.data?.match(/FN:(.+)/)?.[1] || '';
          const n = vcard.data?.match(/N:(.+)/)?.[1] || '';
          return fn.toLowerCase().includes(nameLower) || n.toLowerCase().includes(nameLower);
        });
      }

      if (validated.email_filter) {
        const emailLower = validated.email_filter.toLowerCase();
        filteredContacts = filteredContacts.filter(vcard => {
          const email = vcard.data?.match(/EMAIL[^:]*:(.+)/)?.[1] || '';
          return email.toLowerCase().includes(emailLower);
        });
      }

      if (validated.organization_filter) {
        const orgLower = validated.organization_filter.toLowerCase();
        filteredContacts = filteredContacts.filter(vcard => {
          const org = vcard.data?.match(/ORG:(.+)/)?.[1] || '';
          return org.toLowerCase().includes(orgLower);
        });
      }

      return formatContactList(filteredContacts, addressBook);
    },
  },

  {
    name: 'addressbook_multi_get',
    description: 'Batch fetch multiple specific contacts by their URLs. Use when you have exact contact URLs and want to retrieve their details',
    inputSchema: {
      type: 'object',
      properties: {
        addressbook_url: {
          type: 'string',
          description: 'The URL of the address book',
        },
        contact_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of contact URLs to fetch',
        },
      },
      required: ['addressbook_url', 'contact_urls'],
    },
    handler: async (args) => {
      const validated = validateInput(addressBookMultiGetSchema, args);
      const client = tsdavManager.getCardDavClient();

      const vcards = await client.addressBookMultiGet({
        url: validated.addressbook_url,
        props: [{ name: 'getetag', namespace: 'DAV:' }, { name: 'address-data', namespace: 'urn:ietf:params:xml:ns:carddav' }],
        objectUrls: validated.contact_urls,
      });

      return formatContactList(vcards, { url: validated.addressbook_url });
    },
  },
];

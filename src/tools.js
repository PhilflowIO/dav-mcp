import ICAL from 'ical.js';
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
  updateCalendarSchema,
  deleteCalendarSchema,
  calendarMultiGetSchema,
  listContactsSchema,
  createContactSchema,
  updateContactSchema,
  deleteContactSchema,
  addressBookQuerySchema,
  addressBookMultiGetSchema,
  listTodosSchema,
  createTodoSchema,
  updateTodoSchema,
  deleteTodoSchema,
  todoQuerySchema,
  todoMultiGetSchema,
} from './validation.js';
import {
  formatEventList,
  formatContactList,
  formatCalendarList,
  formatAddressBookList,
  formatTodoList,
  formatSuccess,
  formatCalendarUpdateSuccess,
  formatCalendarDeleteSuccess,
} from './formatters.js';
import {
  getValidatedCalendar,
  getValidatedAddressBook,
  buildTimeRangeOptions,
  searchMultipleCalendars,
  searchMultipleTodoCalendars,
  buildPropPatchXml,
  applyFilters,
  resolveCalendarsToSearch,
  getCalendarDisplayName,
  resolveAddressBooksToSearch,
  getAddressBookDisplayName,
} from './utils/tool-helpers.js';
import { updateEventFields } from './tools/calendar/update-event-fields.js';

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
    description: 'List ALL events from a single calendar without filtering. WARNING: Returns all events which can be many thousands - use calendar_query instead for searching with filters (supports multi-calendar search).',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to fetch events from. Use list_calendars first to get available URLs.',
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

      const calendar = await getValidatedCalendar(client, validated.calendar_url);
      const timeRange = buildTimeRangeOptions(validated.time_range_start, validated.time_range_end);

      const options = { calendar, ...timeRange };
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

      const calendar = await getValidatedCalendar(client, validated.calendar_url);

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

  // Add the new field-based update tool
  updateEventFields,

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
    description: 'PREFERRED: Search and filter calendar events efficiently by text (summary/title), date range, or location. Use this instead of list_events when user asks "find events with X" or "show me events containing Y" to avoid loading thousands of events. Much more token-efficient than list_events. IMPORTANT: When user asks about "today", "tomorrow", "this week" etc., you MUST calculate the correct date range in ISO 8601 format (e.g., 2025-10-08T00:00:00.000Z for tomorrow). If calendar_url is not provided, searches across ALL calendars automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'Optional: The URL of a specific calendar to query. If omitted, searches across ALL available calendars.',
        },
        time_range_start: {
          type: 'string',
          description: 'Optional: Start date in ISO 8601 format (e.g., 2025-10-08T00:00:00.000Z). When user asks "tomorrow", calculate tomorrow\'s date. When user asks "this week", use start of current week.',
        },
        time_range_end: {
          type: 'string',
          description: 'Optional: End date in ISO 8601 format. If omitted but time_range_start is provided, defaults to 1 year from start date.',
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
      required: [],
    },
    handler: async (args) => {
      const validated = validateInput(calendarQuerySchema, args);
      const client = tsdavManager.getCalDavClient();

      const calendarsToSearch = await resolveCalendarsToSearch(client, validated.calendar_url);
      const timeRange = buildTimeRangeOptions(validated.time_range_start, validated.time_range_end);

      const allEvents = await searchMultipleCalendars(client, calendarsToSearch, timeRange);

      const filteredEvents = applyFilters(allEvents, {
        summary_filter: validated.summary_filter,
        location_filter: validated.location_filter,
      }, {
        summary_filter: /SUMMARY:(.+)/,
        location_filter: /LOCATION:(.+)/,
      });

      const calendarName = getCalendarDisplayName(calendarsToSearch);
      return formatEventList(filteredEvents, calendarName);
    },
  },

  {
    name: 'make_calendar',
    description: 'Create a new calendar collection on the CalDAV server with optional color, description, timezone, and component types',
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
        components: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['VEVENT', 'VTODO', 'VJOURNAL']
          },
          description: 'Optional: Supported component types. Default: ["VEVENT", "VTODO"]. Use ["VEVENT"] for events only, ["VTODO"] for tasks only.',
        },
      },
      required: ['display_name'],
    },
    handler: async (args) => {
      const validated = validateInput(makeCalendarSchema, args);
      const client = tsdavManager.getCalDavClient();

      // Get calendar home URL from account (works even without existing calendars!)
      let calendarHome = client.account?.homeUrl;

      // Fallback: Extract from existing calendar if homeUrl not available
      if (!calendarHome) {
        const calendars = await client.fetchCalendars();

        if (!calendars || calendars.length === 0) {
          throw new Error('Cannot create calendar: No calendar home found. Please ensure you have at least one calendar or proper CalDAV permissions.');
        }

        // Extract calendar home from an existing calendar URL
        // Example: https://dav.example.com/calendars/user/calendar-name/ -> https://dav.example.com/calendars/user/
        const existingCalendarUrl = calendars[0].url;
        calendarHome = existingCalendarUrl.substring(0, existingCalendarUrl.lastIndexOf('/', existingCalendarUrl.length - 2) + 1);
      }

      // Generate new calendar URL with sanitized name
      const sanitizedName = validated.display_name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      const newCalendarUrl = `${calendarHome}${sanitizedName}/`;

      // Prepare calendar props
      const calendarProps = {
        displayName: validated.display_name,
        description: validated.description,
        calendarColor: validated.color,
        timezone: validated.timezone,
      };

      // Add supported component set if specified
      // NOTE: Radicale ignores this property (known limitation), but works with Nextcloud/Baikal
      // Format: supportedCalendarComponentSet.comp[{_attributes: {name: 'VEVENT'}}]
      if (validated.components && validated.components.length > 0) {
        calendarProps.supportedCalendarComponentSet = {
          comp: validated.components.map(comp => ({ _attributes: { name: comp } }))
        };
      }

      const calendar = await client.makeCalendar({
        url: newCalendarUrl,
        props: calendarProps
      });

      return formatSuccess('Calendar created successfully', {
        displayName: validated.display_name,
        url: newCalendarUrl,
      });
    },
  },

  {
    name: 'update_calendar',
    description: 'Update an existing calendar\'s properties (display name, description, color, timezone). Use this when user asks to "rename calendar", "change calendar color", or "update calendar properties"',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to update (get from list_calendars)',
        },
        display_name: {
          type: 'string',
          description: 'Optional: New display name for the calendar',
        },
        description: {
          type: 'string',
          description: 'Optional: New description for the calendar',
        },
        color: {
          type: 'string',
          description: 'Optional: New calendar color in hex format (e.g., #FF5733)',
        },
        timezone: {
          type: 'string',
          description: 'Optional: New timezone ID (e.g., Europe/Berlin)',
        },
      },
      required: ['calendar_url'],
    },
    handler: async (args) => {
      const validated = validateInput(updateCalendarSchema, args);
      const client = tsdavManager.getCalDavClient();

      const proppatchXml = buildPropPatchXml({
        display_name: validated.display_name,
        description: validated.description,
        color: validated.color,
        timezone: validated.timezone,
      });

      // ✅ FIX: Use raw fetch with HTTP PROPPATCH method (not updateObject which uses PUT!)
      const response = await fetch(validated.calendar_url, {
        method: 'PROPPATCH',  // ← CRITICAL: PROPPATCH for properties, not PUT!
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          ...client.authHeaders,
        },
        body: proppatchXml,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `PROPPATCH failed with status ${response.status} ${response.statusText}\n` +
          `Response: ${errorText}\n\n` +
          `This may indicate:\n` +
          `- Invalid property value (check timezone format if specified)\n` +
          `- Server does not support calendar property updates\n` +
          `- Permission denied for this calendar`
        );
      }

      // Fetch updated calendar to confirm
      const calendars = await client.fetchCalendars();
      const updatedCalendar = calendars.find(c => c.url === validated.calendar_url);

      if (!updatedCalendar) {
        throw new Error(`Calendar not found after update: ${validated.calendar_url}`);
      }

      // Return formatted success
      return formatCalendarUpdateSuccess(updatedCalendar, {
        display_name: validated.display_name,
        description: validated.description,
        color: validated.color,
        timezone: validated.timezone,
      });
    },
  },

  {
    name: 'delete_calendar',
    description: 'Permanently delete a calendar and all its events. WARNING: This action cannot be undone! Use this when user explicitly asks to "delete calendar" or "remove calendar"',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar to delete (get from list_calendars)',
        },
      },
      required: ['calendar_url'],
    },
    handler: async (args) => {
      const validated = validateInput(deleteCalendarSchema, args);
      const client = tsdavManager.getCalDavClient();

      // Use deleteObject to send DELETE request
      await client.deleteObject({
        url: validated.calendar_url,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
        },
      });

      // Return formatted success with warning
      return formatCalendarDeleteSuccess(validated.calendar_url);
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

      const addressBook = await getValidatedAddressBook(client, validated.addressbook_url);
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

      const addressBook = await getValidatedAddressBook(client, validated.addressbook_url);

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
          description: 'Optional: The URL of a specific address book. If omitted, searches across ALL address books.',
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
      required: [],
    },
    handler: async (args) => {
      const validated = validateInput(addressBookQuerySchema, args);
      const client = tsdavManager.getCardDavClient();

      // Resolve which address books to search (all or specific)
      const addressBooksToSearch = await resolveAddressBooksToSearch(client, validated.addressbook_url);

      // Collect all vcards from all address books
      let allVCards = [];
      for (const addressBook of addressBooksToSearch) {
        const vcards = await client.fetchVCards({ addressBook });
        // Add addressbook context to each vcard for proper display
        vcards.forEach(vcard => {
          vcard.addressBook = addressBook;
        });
        allVCards = allVCards.concat(vcards);
      }

      // Custom filter for name_filter (matches FN or N fields)
      let filteredContacts = allVCards;
      if (validated.name_filter) {
        const nameLower = validated.name_filter.toLowerCase();
        filteredContacts = filteredContacts.filter(vcard => {
          const fn = vcard.data?.match(/FN:(.+)/)?.[1] || '';
          const n = vcard.data?.match(/N:(.+)/)?.[1] || '';
          return fn.toLowerCase().includes(nameLower) || n.toLowerCase().includes(nameLower);
        });
      }

      // Apply remaining filters using helper
      filteredContacts = applyFilters(filteredContacts, {
        email_filter: validated.email_filter,
        organization_filter: validated.organization_filter,
      }, {
        email_filter: /EMAIL[^:]*:(.+)/,
        organization_filter: /ORG:(.+)/,
      });

      // Use the display name helper to show which address books were searched
      const displayName = getAddressBookDisplayName(addressBooksToSearch);
      const addressBookForDisplay = {
        displayName: displayName,
        url: addressBooksToSearch.length === 1 ? addressBooksToSearch[0].url : 'multiple'
      };

      return formatContactList(filteredContacts, addressBookForDisplay);
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

  // ================================
  // VTODO (TASK) TOOLS
  // ================================
  {
    name: 'list_todos',
    description: 'List ALL todos/tasks from a calendar. WARNING: Returns all todos without filtering - use todo_query for searches with filters by status, summary, or due date.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'The URL of the calendar containing todos',
        },
      },
      required: ['calendar_url'],
    },
    handler: async (args) => {
      const validated = validateInput(listTodosSchema, args);
      const client = tsdavManager.getCalDavClient();

      const calendar = { url: validated.calendar_url };
      const todos = await client.fetchTodos({ calendar });

      return formatTodoList(todos, validated.calendar_url);
    },
  },

  {
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
  },

  {
    name: 'update_todo',
    description: 'Update an existing todo/task. Requires todo URL, etag, and complete updated iCal data. Use this to modify todo details or mark as completed.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_url: {
          type: 'string',
          description: 'The URL of the todo to update',
        },
        todo_etag: {
          type: 'string',
          description: 'The current ETag of the todo (required for conflict detection)',
        },
        updated_ical_data: {
          type: 'string',
          description: 'Complete updated VTODO iCalendar data',
        },
      },
      required: ['todo_url', 'todo_etag', 'updated_ical_data'],
    },
    handler: async (args) => {
      const validated = validateInput(updateTodoSchema, args);
      const client = tsdavManager.getCalDavClient();

      const result = await client.updateTodo({
        todo: {
          url: validated.todo_url,
          data: validated.updated_ical_data,
          etag: validated.todo_etag,
        },
      });

      return formatSuccess('Todo updated successfully', {
        url: result.url,
        etag: result.etag,
      });
    },
  },

  {
    name: 'delete_todo',
    description: 'Delete a todo/task permanently from the calendar. Cannot be undone. Requires todo URL and etag.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_url: {
          type: 'string',
          description: 'The URL of the todo to delete',
        },
        todo_etag: {
          type: 'string',
          description: 'The current ETag of the todo',
        },
      },
      required: ['todo_url', 'todo_etag'],
    },
    handler: async (args) => {
      const validated = validateInput(deleteTodoSchema, args);
      const client = tsdavManager.getCalDavClient();

      await client.deleteTodo({
        todo: {
          url: validated.todo_url,
          etag: validated.todo_etag,
        },
      });

      return formatSuccess('Todo deleted successfully');
    },
  },

  {
    name: 'todo_query',
    description: '⭐ PREFERRED: Search and filter todos efficiently by status, summary text, or due date range. Use this instead of list_todos when user asks "show my tasks", "what\'s due this week", "incomplete tasks". Much more token-efficient than list_todos. If calendar_url is not provided, searches across ALL calendars automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'Optional: The URL of a specific calendar containing todos. If omitted, searches across ALL calendars.',
        },
        summary_filter: {
          type: 'string',
          description: 'Optional: Filter by summary text (partial match, case-insensitive)',
        },
        status_filter: {
          type: 'string',
          enum: ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'],
          description: 'Optional: Filter by specific status',
        },
        time_range_start: {
          type: 'string',
          description: 'Optional: Start of due date range (ISO 8601 format)',
        },
        time_range_end: {
          type: 'string',
          description: 'Optional: End of due date range (ISO 8601 format)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      const validated = validateInput(todoQuerySchema, args);
      const client = tsdavManager.getCalDavClient();

      const calendarsToSearch = await resolveCalendarsToSearch(client, validated.calendar_url);
      let todos = await searchMultipleTodoCalendars(client, calendarsToSearch);

      // Apply text filters using helper
      todos = applyFilters(todos, {
        summary_filter: validated.summary_filter,
      }, {
        summary_filter: /SUMMARY:(.+)/,
      });

      // Apply status filter (custom logic)
      if (validated.status_filter) {
        todos = todos.filter(todo => {
          const status = todo.data?.match(/STATUS:(.+)/)?.[1] || 'NEEDS-ACTION';
          return status === validated.status_filter;
        });
      }

      // Apply time range filter (custom date parsing logic)
      if (validated.time_range_start && validated.time_range_end) {
        const startTime = new Date(validated.time_range_start).getTime();
        const endTime = new Date(validated.time_range_end).getTime();

        todos = todos.filter(todo => {
          const dueMatch = todo.data?.match(/DUE:(\d{8}T\d{6}Z?)/);
          if (!dueMatch) return false;

          const dueStr = dueMatch[1];
          const year = parseInt(dueStr.substr(0, 4));
          const month = parseInt(dueStr.substr(4, 2)) - 1;
          const day = parseInt(dueStr.substr(6, 2));
          const hour = parseInt(dueStr.substr(9, 2));
          const minute = parseInt(dueStr.substr(11, 2));
          const dueTime = new Date(Date.UTC(year, month, day, hour, minute)).getTime();

          return dueTime >= startTime && dueTime <= endTime;
        });
      }

      const calendarName = getCalendarDisplayName(calendarsToSearch);
      return formatTodoList(todos, calendarName);
    },
  },

  {
    name: 'todo_multi_get',
    description: 'Batch fetch multiple specific todos by their URLs. More efficient than fetching one by one when you have exact todo URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of todo URLs to fetch',
        },
      },
      required: ['todo_urls'],
    },
    handler: async (args) => {
      const validated = validateInput(todoMultiGetSchema, args);
      const client = tsdavManager.getCalDavClient();

      // Extract calendar URL from first todo URL
      const calendarUrl = validated.todo_urls[0].split('/').slice(0, -1).join('/');

      const todos = await client.todoMultiGet({
        url: calendarUrl,
        props: [{ name: 'getetag', namespace: 'DAV:' }, { name: 'calendar-data', namespace: 'urn:ietf:params:xml:ns:caldav' }],
        objectUrls: validated.todo_urls,
      });

      return formatTodoList(todos, calendarUrl);
    },
  },
];

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
    description: `<usecase>
Lists all available calendars from the CalDAV server.
Use when user asks to see all calendars or needs calendar URLs for other operations.
</usecase>

<instructions>
- Use when user says "show me my calendars" or "list all calendars"
- Returns calendar URLs needed for create_event, calendar_query, etc.
- Essential first step for most calendar operations
- Returns display names, URLs, and descriptions
</instructions>`,
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
    description: `<usecase>
Lists ALL events from a single calendar without any filtering.
Use ONLY when user explicitly asks for "all events" or "every single event".
</usecase>

<instructions>
⚠️ WARNING: This loads ALL events (can be thousands) - very expensive!
✅ PREFERRED: Use calendar_query for filtered searches instead
- Use calendar_query for "find events with X" or "show me meetings"
- Use calendar_query for date ranges like "tomorrow" or "next week"
- Only use list_events for explicit "show me literally everything"
</instructions>`,
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
      const calendars = await client.fetchCalendars();
      const calendar = calendars.find(c => c.url === validated.calendar_url);

      if (!calendar) {
        const availableUrls = calendars.map(c => c.url).join('\n- ');
        throw new Error(
          `Calendar not found: ${validated.calendar_url}\n\n` +
          `Available calendar URLs:\n- ${availableUrls}\n\n` +
          `Please use list_calendars first to get the correct calendar URLs.`
        );
      }

      const options = { calendar };

      // If only start date provided, default end date to 1 year from start
      // ✅ FIX: Convert all time ranges to UTC (Z format) because tsdav/Radicale
      // don't handle timezone-aware queries correctly (e.g., +02:00)
      if (validated.time_range_start && !validated.time_range_end) {
        const startDate = new Date(validated.time_range_start);
        const endDate = new Date(startDate);
        endDate.setFullYear(endDate.getFullYear() + 1);
        options.timeRange = {
          start: startDate.toISOString(),  // Convert to UTC
          end: endDate.toISOString(),
        };
      } else if (validated.time_range_start && validated.time_range_end) {
        options.timeRange = {
          start: new Date(validated.time_range_start).toISOString(),  // Convert to UTC
          end: new Date(validated.time_range_end).toISOString(),      // Convert to UTC
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
    description: `<usecase>
Deletes a calendar event permanently.
Use when user asks to cancel, delete, or remove an event.
</usecase>

<instructions>
- REQUIRES: Get event URL and ETAG from calendar_query first
- Use when user says "cancel my meeting" or "delete event X"
- If you don't have event URL/ETAG, use calendar_query to find the event first
- Much more efficient than using list_events to find the event
- PREFERRED workflow: calendar_query → delete_event
</instructions>`,
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
    description: `<usecase>
Searches for calendar events by text, date range, or location.
Use when user asks to find, search, filter, or SHOW events.
Returns matching events with URLs and ETAGs for further operations.
</usecase>

<instructions>
- Use for "show me my events", "find events", "search events", "list events"
- Omit calendar_url to search ALL calendars automatically
- Use time_range for "tomorrow", "next week" (calculate ISO 8601 dates)
- Use summary_filter for title/keyword searches
- Use location_filter for room/location searches
- Returns events ready for update_event or delete_event
- For specific times like "3pm meeting", use 1-hour windows (15:00-16:00)
- PREFERRED over list_events for any search/filter/show request
</instructions>`,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'Optional: Specific calendar URL from list_calendars. If omitted, searches ALL calendars automatically.',
        },
        time_range_start: {
          type: 'string',
          description: 'Start date/time in ISO 8601 format. For "tomorrow" use 2025-10-08T00:00:00Z. For "3pm meeting" use 2025-10-08T15:00:00+02:00 (1-hour window).',
        },
        time_range_end: {
          type: 'string',
          description: 'End date/time in ISO 8601 format. For "3pm meeting" use 2025-10-08T16:00:00+02:00. If omitted, defaults to 1 year from start.',
        },
        summary_filter: {
          type: 'string',
          description: 'Filter by event title/summary (partial match). Use for "find events with X" or "show me meeting events".',
        },
        location_filter: {
          type: 'string',
          description: 'Filter by event location (partial match). Use for "events in room X" or "meetings at location Y".',
        },
      },
      required: [],
    },
    handler: async (args) => {
      const validated = validateInput(calendarQuerySchema, args);
      const client = tsdavManager.getCalDavClient();
      const calendars = await client.fetchCalendars();

      // If specific calendar requested, use it
      let calendarsToSearch = calendars;
      if (validated.calendar_url) {
        const calendar = calendars.find(c => c.url === validated.calendar_url);
        if (!calendar) {
          const availableUrls = calendars.map(c => c.url).join('\n- ');
          throw new Error(
            `Calendar not found: ${validated.calendar_url}\n\n` +
            `Available calendar URLs:\n- ${availableUrls}\n\n` +
            `Tip: Omit calendar_url to search across all calendars automatically.`
          );
        }
        calendarsToSearch = [calendar];
      }

      // Build timeRange options
      // ✅ FIX: Convert all time ranges to UTC (Z format) because tsdav/Radicale
      // don't handle timezone-aware queries correctly (e.g., +02:00)
      const timeRangeOptions = {};
      if (validated.time_range_start && !validated.time_range_end) {
        const startDate = new Date(validated.time_range_start);
        const endDate = new Date(startDate);
        endDate.setFullYear(endDate.getFullYear() + 1);
        timeRangeOptions.timeRange = {
          start: startDate.toISOString(),  // Convert to UTC
          end: endDate.toISOString(),
        };
      } else if (validated.time_range_start && validated.time_range_end) {
        timeRangeOptions.timeRange = {
          start: new Date(validated.time_range_start).toISOString(),  // Convert to UTC
          end: new Date(validated.time_range_end).toISOString(),      // Convert to UTC
        };
      }

      // Search across all selected calendars
      let allEvents = [];
      for (const calendar of calendarsToSearch) {
        const options = { calendar, ...timeRangeOptions };
        const events = await client.fetchCalendarObjects(options);
        // Add calendar info to each event
        events.forEach(event => {
          event._calendarName = calendar.displayName || calendar.url;
        });
        allEvents = allEvents.concat(events);
      }

      let filteredEvents = allEvents;

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

      // Determine calendar name for display
      const calendarName = calendarsToSearch.length === 1
        ? (calendarsToSearch[0].displayName || calendarsToSearch[0].url)
        : `All Calendars (${calendarsToSearch.length})`;

      return formatEventList(filteredEvents, calendarName);
    },
  },

  {
    name: 'make_calendar',
    description: `<usecase>
Creates a new calendar collection on the CalDAV server.
Use when user asks to create, add, or make a new calendar.
</usecase>

<instructions>
- Use when user says "create a new calendar" or "add calendar for work"
- Get calendar URLs from list_calendars first to avoid duplicates
- Optional: Set color, description, timezone for better organization
- Returns new calendar URL for immediate use
</instructions>`,
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

      // Build WebDAV PROPPATCH XML
      let proppatchXml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      proppatchXml += '<d:propertyupdate xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">\n';
      proppatchXml += '  <d:set>\n';
      proppatchXml += '    <d:prop>\n';

      if (validated.display_name) {
        proppatchXml += `      <d:displayname>${validated.display_name}</d:displayname>\n`;
      }
      if (validated.description) {
        proppatchXml += `      <c:calendar-description>${validated.description}</c:calendar-description>\n`;
      }
      if (validated.color) {
        proppatchXml += `      <x:calendar-color>${validated.color}</x:calendar-color>\n`;
      }
      if (validated.timezone) {
        // Validate timezone format (basic check)
        if (!validated.timezone.includes('/')) {
          throw new Error(`Invalid timezone format: ${validated.timezone}. Expected format: "Europe/Berlin", "America/New_York", etc.`);
        }
        proppatchXml += `      <c:calendar-timezone>${validated.timezone}</c:calendar-timezone>\n`;
      }

      proppatchXml += '    </d:prop>\n';
      proppatchXml += '  </d:set>\n';
      proppatchXml += '</d:propertyupdate>';

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
    description: `<usecase>
Permanently deletes a calendar and ALL its events.
Use ONLY when user explicitly asks to delete or remove a calendar.
</usecase>

<instructions>
⚠️ DANGER: This permanently deletes the calendar and ALL events - cannot be undone!
- Use ONLY when user says "delete calendar X" or "remove calendar Y"
- Get calendar URL from list_calendars first
- Confirm with user before proceeding if not explicitly requested
- Consider backing up important events first
</instructions>`,
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
    description: `<usecase>
Lists ALL contacts from an address book without any filtering.
Use ONLY when user explicitly asks for "all contacts" or "every single contact".
</usecase>

<instructions>
⚠️ WARNING: This loads ALL contacts (can be thousands) - very expensive!
✅ PREFERRED: Use addressbook_query for filtered searches instead
- Use addressbook_query for "find contact John" or "show me people at Google"
- Use addressbook_query for email searches like "find Gmail contacts"
- Only use list_contacts for explicit "show me literally everything"
</instructions>`,
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
    description: `<usecase>
Creates a new contact with name, email, phone, and other details.
Use when user asks to add a new person to contacts.
</usecase>

<instructions>
- Use when user says "create contact for John" or "add new person"
- Get addressbook_url from list_addressbooks first
- Only use if contact doesn't already exist (check with addressbook_query first)
- If contact exists, use update_contact instead
</instructions>`,
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
    description: `<usecase>
Updates an existing contact with new information.
Use when user asks to modify, change, or update contact details.
</usecase>

<instructions>
- REQUIRES: Get contact URL and ETAG from addressbook_query first
- Use when user says "update Sarah's phone" or "change John's email"
- If multiple contacts found, ask user to specify which one
- Must provide complete updated vCard data
</instructions>`,
    inputSchema: {
      type: 'object',
      properties: {
        vcard_url: {
          type: 'string',
          description: 'Contact URL from addressbook_query response (required)',
        },
        vcard_etag: {
          type: 'string',
          description: 'ETag from addressbook_query response (required for conflict detection)',
        },
        updated_vcard_data: {
          type: 'string',
          description: 'Complete updated vCard data with new information',
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
    description: `<usecase>
Searches for contacts by name, email, or organization.
Use when user asks to find, search, filter, or SHOW contacts.
Returns ALL matching contacts with URLs and ETAGs for further operations.
</usecase>

<instructions>
- Use for "show me my contacts", "find contacts", "search contacts", "list contacts"
- Omit addressbook_url to search ALL addressbooks automatically
- Use name_filter for "find contact John" or "show me people named Smith"
- Use email_filter for "find contact with email X" or "show me Gmail contacts"
- Use organization_filter for "find contacts at company X" or "show me people at Google"
- Returns ALL matching contacts (may be multiple) - let user choose which one
- Returns contacts ready for update_contact or delete_contact
- Much more efficient than list_contacts
- PREFERRED over list_contacts for any search/filter/show request
</instructions>`,
    inputSchema: {
      type: 'object',
      properties: {
        addressbook_url: {
          type: 'string',
          description: 'Optional: Specific address book URL from list_addressbooks. If omitted, searches ALL addressbooks automatically.',
        },
        name_filter: {
          type: 'string',
          description: 'Filter by contact name (partial match). Use for "find contact John" or "show me people named Smith".',
        },
        email_filter: {
          type: 'string',
          description: 'Filter by email address (partial match). Use for "find contact with email X" or "show me Gmail contacts".',
        },
        organization_filter: {
          type: 'string',
          description: 'Filter by company/organization (partial match). Use for "find contacts at company X" or "show me people at Google".',
        },
      },
      required: [],
    },
    handler: async (args) => {
      const validated = validateInput(addressBookQuerySchema, args);
      const client = tsdavManager.getCardDavClient();
      const addressBooks = await client.fetchAddressBooks();

      // If specific addressbook requested, use it
      let addressBooksToSearch = addressBooks;
      if (validated.addressbook_url) {
        const addressBook = addressBooks.find(ab => ab.url === validated.addressbook_url);
        if (!addressBook) {
          const availableUrls = addressBooks.map(ab => ab.url).join('\n- ');
          throw new Error(
            `Address book not found: ${validated.addressbook_url}\n\n` +
            `Available address book URLs:\n- ${availableUrls}\n\n` +
            `Tip: Omit addressbook_url to search across all addressbooks automatically.`
          );
        }
        addressBooksToSearch = [addressBook];
      }

      // Fetch contacts from all selected addressbooks
      let allContacts = [];
      for (const addressBook of addressBooksToSearch) {
        const vcards = await client.fetchVCards({ addressBook });
        // Add addressbook info to each contact
        vcards.forEach(contact => {
          contact._addressBookName = addressBook.displayName || addressBook.url;
        });
        allContacts = allContacts.concat(vcards);
      }

      let filteredContacts = allContacts;

      if (validated.name_filter) {
        const nameLower = validated.name_filter.toLowerCase();
        filteredContacts = filteredContacts.filter(vcard => {
          // Extract all name-related fields from vCard
          const fn = vcard.data?.match(/FN:(.+)/)?.[1] || '';
          const n = vcard.data?.match(/N:(.+)/)?.[1] || '';
          
          // Parse structured name (N: field format: "Family;Given;Additional;Prefix;Suffix")
          const nameParts = n.split(';');
          const familyName = nameParts[0] || '';
          const givenName = nameParts[1] || '';
          const additionalName = nameParts[2] || '';
          
          // Create searchable name combinations
          const searchableNames = [
            fn,                    // Full name: "Sarah Johnson"
            familyName,           // Family: "Johnson"
            givenName,            // Given: "Sarah"
            additionalName,       // Additional: ""
            `${givenName} ${familyName}`,  // "Sarah Johnson"
            `${familyName} ${givenName}`,  // "Johnson Sarah"
            n                     // Raw N field: "Johnson;Sarah;;;"
          ].filter(name => name.trim() !== '');
          
          // Check if any name part contains the search term
          return searchableNames.some(name => 
            name.toLowerCase().includes(nameLower)
          );
        });
      }

      if (validated.email_filter) {
        const emailLower = validated.email_filter.toLowerCase();
        filteredContacts = filteredContacts.filter(vcard => {
          // Search in all email fields (EMAIL, EMAIL;TYPE=INTERNET, etc.)
          const emailMatches = vcard.data?.match(/EMAIL[^:]*:(.+)/g) || [];
          return emailMatches.some(emailLine => {
            const email = emailLine.split(':')[1] || '';
            return email.toLowerCase().includes(emailLower);
          });
        });
      }

      if (validated.organization_filter) {
        const orgLower = validated.organization_filter.toLowerCase();
        filteredContacts = filteredContacts.filter(vcard => {
          // Search in ORG field and also in TITLE field (job title often contains company info)
          const org = vcard.data?.match(/ORG:(.+)/)?.[1] || '';
          const title = vcard.data?.match(/TITLE:(.+)/)?.[1] || '';
          return org.toLowerCase().includes(orgLower) || title.toLowerCase().includes(orgLower);
        });
      }

      // Determine addressbook name for display
      const addressBookName = addressBooksToSearch.length === 1
        ? (addressBooksToSearch[0].displayName || addressBooksToSearch[0].url)
        : `All Addressbooks (${addressBooksToSearch.length})`;

      return formatContactList(filteredContacts, addressBookName);
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
    description: `<usecase>
Lists ALL todos/tasks from a calendar without any filtering.
Use ONLY when user explicitly asks for "all todos" or "every single task".
</usecase>

<instructions>
⚠️ WARNING: This loads ALL todos (can be thousands) - very expensive!
✅ PREFERRED: Use todo_query for filtered searches instead
- Use todo_query for "show my tasks", "incomplete tasks", "what's due this week"
- Use todo_query for status filters like "completed tasks" or "pending tasks"
- Only use list_todos for explicit "show me literally everything"
</instructions>`,
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
    description: `<usecase>
Searches for todos/tasks by status, summary text, or due date range.
Use when user asks to find, search, or filter tasks/todos.
Returns matching todos with URLs and ETAGs for further operations.
</usecase>

<instructions>
- Omit calendar_url to search ALL calendars automatically
- Use status_filter for "show my tasks", "incomplete tasks", "completed tasks"
- Use summary_filter for "find tasks with X" or "show me project tasks"
- Use time_range for "what's due this week" or "tasks due tomorrow"
- Returns todos ready for update_todo or delete_todo
- Much more efficient than list_todos
</instructions>`,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: {
          type: 'string',
          description: 'Optional: Specific calendar URL from list_calendars. If omitted, searches ALL calendars automatically.',
        },
        summary_filter: {
          type: 'string',
          description: 'Filter by task summary/title (partial match). Use for "find tasks with X" or "show me project tasks".',
        },
        status_filter: {
          type: 'string',
          enum: ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'],
          description: 'Filter by task status. Use for "show my tasks", "incomplete tasks", "completed tasks".',
        },
        time_range_start: {
          type: 'string',
          description: 'Start of due date range in ISO 8601 format. Use for "what\'s due this week" or "tasks due tomorrow".',
        },
        time_range_end: {
          type: 'string',
          description: 'End of due date range in ISO 8601 format. If omitted, defaults to 1 year from start.',
        },
      },
      required: [],
    },
    handler: async (args) => {
      const validated = validateInput(todoQuerySchema, args);
      const client = tsdavManager.getCalDavClient();
      const calendars = await client.fetchCalendars();

      // If specific calendar requested, use it
      let calendarsToSearch = calendars;
      if (validated.calendar_url) {
        const calendar = calendars.find(c => c.url === validated.calendar_url);
        if (!calendar) {
          const availableUrls = calendars.map(c => c.url).join('\n- ');
          throw new Error(
            `Calendar not found: ${validated.calendar_url}\n\n` +
            `Available calendar URLs:\n- ${availableUrls}\n\n` +
            `Tip: Omit calendar_url to search across all calendars automatically.`
          );
        }
        calendarsToSearch = [calendar];
      }

      // Fetch todos from all selected calendars
      let todos = [];
      for (const calendar of calendarsToSearch) {
        const calendarTodos = await client.fetchTodos({ calendar });
        // Add calendar info to each todo
        calendarTodos.forEach(todo => {
          todo._calendarName = calendar.displayName || calendar.url;
        });
        todos = todos.concat(calendarTodos);
      }

      // Client-side filtering (tsdav doesn't support server-side VTODO filtering yet)
      if (validated.summary_filter) {
        const summaryLower = validated.summary_filter.toLowerCase();
        todos = todos.filter(todo => {
          const summary = todo.data?.match(/SUMMARY:(.+)/)?.[1] || '';
          return summary.toLowerCase().includes(summaryLower);
        });
      }

      if (validated.status_filter) {
        todos = todos.filter(todo => {
          const status = todo.data?.match(/STATUS:(.+)/)?.[1] || 'NEEDS-ACTION';
          return status === validated.status_filter;
        });
      }

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

      // Determine calendar name for display
      const calendarName = calendarsToSearch.length === 1
        ? (calendarsToSearch[0].displayName || calendarsToSearch[0].url)
        : `All Calendars (${calendarsToSearch.length})`;

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

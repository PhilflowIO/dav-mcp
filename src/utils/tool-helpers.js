/**
 * Shared helper functions for tsdav MCP tools
 * This module eliminates code duplication across calendar, contact, and todo operations
 */

/**
 * Escapes special XML characters to prevent injection attacks
 * @param {string} text - Text to escape
 * @returns {string} XML-safe string
 */
function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Validates and retrieves a calendar by URL
 *
 * @param {Object} client - The CalDAV client instance
 * @param {string} calendarUrl - The URL of the calendar to find
 * @returns {Promise<Object>} The validated calendar object
 * @throws {Error} If calendar is not found with helpful error message
 *
 * @example
 * const calendar = await getValidatedCalendar(client, 'https://dav.example.com/cal/user/work/');
 */
export async function getValidatedCalendar(client, calendarUrl) {
  const calendars = await client.fetchCalendars();
  const calendar = calendars.find(c => c.url === calendarUrl);

  if (!calendar) {
    const availableUrls = calendars.map(c => c.url).join('\n- ');
    throw new Error(
      `Calendar not found: ${calendarUrl}\n\n` +
      `Available calendar URLs:\n- ${availableUrls}\n\n` +
      `Please use list_calendars first to get the correct calendar URLs.`
    );
  }

  return calendar;
}

/**
 * Validates and retrieves an address book by URL
 *
 * @param {Object} client - The CardDAV client instance
 * @param {string} addressBookUrl - The URL of the address book to find
 * @returns {Promise<Object>} The validated address book object
 * @throws {Error} If address book is not found with helpful error message
 *
 * @example
 * const addressBook = await getValidatedAddressBook(client, 'https://dav.example.com/card/user/contacts/');
 */
export async function getValidatedAddressBook(client, addressBookUrl) {
  const addressBooks = await client.fetchAddressBooks();
  const addressBook = addressBooks.find(ab => ab.url === addressBookUrl);

  if (!addressBook) {
    const availableUrls = addressBooks.map(ab => ab.url).join('\n- ');
    throw new Error(
      `Address book not found: ${addressBookUrl}\n\n` +
      `Available address book URLs:\n- ${availableUrls}\n\n` +
      `Please use list_addressbooks first to get the correct address book URLs.`
    );
  }

  return addressBook;
}

/**
 * Builds time range options for CalDAV queries
 * If only start date is provided, defaults end date to 1 year from start
 *
 * @param {string|undefined} startDate - Optional start date in ISO 8601 format
 * @param {string|undefined} endDate - Optional end date in ISO 8601 format
 * @returns {Object} Options object with timeRange property (or empty object if no dates)
 *
 * @example
 * // Both dates provided
 * buildTimeRangeOptions('2025-01-01T00:00:00.000Z', '2025-12-31T23:59:59.000Z')
 * // Returns: { timeRange: { start: '2025-01-01...', end: '2025-12-31...' } }
 *
 * // Only start date (end = start + 1 year)
 * buildTimeRangeOptions('2025-01-01T00:00:00.000Z', undefined)
 * // Returns: { timeRange: { start: '2025-01-01...', end: '2026-01-01...' } }
 *
 * // No dates
 * buildTimeRangeOptions(undefined, undefined)
 * // Returns: {}
 */
export function buildTimeRangeOptions(startDate, endDate) {
  // No time range specified
  if (!startDate) {
    return {};
  }

  // Only start date provided - default end to 1 year from start
  if (!endDate) {
    const start = new Date(startDate);
    const end = new Date(start);
    end.setFullYear(end.getFullYear() + 1);

    return {
      timeRange: {
        start: startDate,
        end: end.toISOString(),
      },
    };
  }

  // Both dates provided
  return {
    timeRange: {
      start: startDate,
      end: endDate,
    },
  };
}

/**
 * Searches multiple calendars and aggregates results with calendar name annotations
 *
 * @param {Object} client - The CalDAV client instance
 * @param {Array<Object>} calendars - Array of calendar objects to search
 * @param {Object} fetchOptions - Options to pass to fetchCalendarObjects (e.g., timeRange)
 * @returns {Promise<Array>} All events/todos from all calendars with _calendarName property
 *
 * @example
 * const calendars = [cal1, cal2, cal3];
 * const events = await searchMultipleCalendars(client, calendars, { timeRange: {...} });
 * // Each event has event._calendarName = "Work Calendar" etc.
 */
export async function searchMultipleCalendars(client, calendars, fetchOptions = {}) {
  let allItems = [];

  for (const calendar of calendars) {
    const options = { calendar, ...fetchOptions };
    const items = await client.fetchCalendarObjects(options);

    // Add calendar info to each item for display
    items.forEach(item => {
      item._calendarName = calendar.displayName || calendar.url;
    });

    allItems = allItems.concat(items);
  }

  return allItems;
}

/**
 * Searches multiple calendars for todos and aggregates results
 *
 * @param {Object} client - The CalDAV client instance
 * @param {Array<Object>} calendars - Array of calendar objects to search
 * @returns {Promise<Array>} All todos from all calendars with _calendarName property
 *
 * @example
 * const calendars = [cal1, cal2];
 * const todos = await searchMultipleTodoCalendars(client, calendars);
 */
export async function searchMultipleTodoCalendars(client, calendars) {
  let allTodos = [];

  for (const calendar of calendars) {
    const todos = await client.fetchTodos({ calendar });

    // Add calendar info to each todo
    todos.forEach(todo => {
      todo._calendarName = calendar.displayName || calendar.url;
    });

    allTodos = allTodos.concat(todos);
  }

  return allTodos;
}

/**
 * Builds WebDAV PROPPATCH XML for updating calendar properties
 * Uses proper XML escaping to prevent injection attacks
 *
 * @param {Object} properties - Object with optional display_name, description, color, timezone
 * @returns {string} Complete PROPPATCH XML string
 * @throws {Error} If timezone format is invalid
 *
 * @example
 * const xml = buildPropPatchXml({
 *   display_name: 'My Calendar',
 *   description: 'Work & Projects',
 *   color: '#FF5733',
 *   timezone: 'Europe/Berlin'
 * });
 */
export function buildPropPatchXml(properties) {
  const { display_name, description, color, timezone } = properties;

  // Validate timezone format if provided
  if (timezone && !timezone.includes('/')) {
    throw new Error(
      `Invalid timezone format: ${timezone}. ` +
      `Expected format: "Europe/Berlin", "America/New_York", etc.`
    );
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<d:propertyupdate xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">\n';
  xml += '  <d:set>\n';
  xml += '    <d:prop>\n';

  if (display_name) {
    xml += `      <d:displayname>${escapeXml(display_name)}</d:displayname>\n`;
  }
  if (description) {
    xml += `      <c:calendar-description>${escapeXml(description)}</c:calendar-description>\n`;
  }
  if (color) {
    xml += `      <x:calendar-color>${escapeXml(color)}</x:calendar-color>\n`;
  }
  if (timezone) {
    xml += `      <c:calendar-timezone>${escapeXml(timezone)}</c:calendar-timezone>\n`;
  }

  xml += '    </d:prop>\n';
  xml += '  </d:set>\n';
  xml += '</d:propertyupdate>';

  return xml;
}

/**
 * Generic filter function for events, contacts, or todos
 * Applies multiple filters with case-insensitive substring matching
 *
 * @param {Array<Object>} items - Array of items to filter (events/contacts/todos)
 * @param {Object} filters - Object with filter values
 * @param {Object} extractors - Object mapping filter keys to regex extractors
 * @returns {Array<Object>} Filtered items
 *
 * @example
 * // Filter events by summary and location
 * const filtered = applyFilters(
 *   events,
 *   { summary_filter: 'meeting', location_filter: 'room' },
 *   {
 *     summary_filter: /SUMMARY:(.+)/,
 *     location_filter: /LOCATION:(.+)/
 *   }
 * );
 */
export function applyFilters(items, filters, extractors) {
  let filtered = items;

  for (const [filterKey, filterValue] of Object.entries(filters)) {
    if (!filterValue || !extractors[filterKey]) continue;

    const regex = extractors[filterKey];
    const searchLower = filterValue.toLowerCase();

    filtered = filtered.filter(item => {
      const match = item.data?.match(regex);
      const value = match?.[1] || '';
      return value.toLowerCase().includes(searchLower);
    });
  }

  return filtered;
}

/**
 * Resolves which calendars to search based on optional calendar_url parameter
 * If calendar_url is provided, validates and returns single calendar in array
 * Otherwise returns all calendars
 *
 * @param {Object} client - The CalDAV client instance
 * @param {string|undefined} calendarUrl - Optional specific calendar URL
 * @returns {Promise<Array<Object>>} Array of calendars to search
 * @throws {Error} If specific calendar not found
 *
 * @example
 * // Search specific calendar
 * const calendars = await resolveCalendarsToSearch(client, 'https://...');
 * // Returns: [specificCalendar]
 *
 * // Search all calendars
 * const calendars = await resolveCalendarsToSearch(client, undefined);
 * // Returns: [cal1, cal2, cal3, ...]
 */
export async function resolveCalendarsToSearch(client, calendarUrl) {
  const calendars = await client.fetchCalendars();

  // Search all calendars if no specific URL provided
  if (!calendarUrl) {
    return calendars;
  }

  // Find specific calendar
  const calendar = calendars.find(c => c.url === calendarUrl);

  if (!calendar) {
    const availableUrls = calendars.map(c => c.url).join('\n- ');
    throw new Error(
      `Calendar not found: ${calendarUrl}\n\n` +
      `Available calendar URLs:\n- ${availableUrls}\n\n` +
      `Tip: Omit calendar_url to search across all calendars automatically.`
    );
  }

  return [calendar];
}

/**
 * Generates display name for single or multi-calendar searches
 *
 * @param {Array<Object>} calendars - Array of calendars that were searched
 * @returns {string} Display name for formatter
 *
 * @example
 * getCalendarDisplayName([cal1]) // Returns: "Work Calendar"
 * getCalendarDisplayName([cal1, cal2, cal3]) // Returns: "All Calendars (3)"
 */
export function getCalendarDisplayName(calendars) {
  if (calendars.length === 1) {
    return calendars[0].displayName || calendars[0].url;
  }
  return `All Calendars (${calendars.length})`;
}

/**
 * Shared helper functions for tool implementations
 */

/**
 * Format iCal date (ISO 8601 to iCal format)
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted iCal date string (YYYYMMDDTHHmmssZ)
 */
export function formatICalDate(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Generate unique UID for calendar objects
 * @param {string} prefix - Prefix for the UID (e.g., 'event', 'todo', 'contact')
 * @returns {string} Unique identifier
 */
export function generateUID(prefix = 'object') {
  return `${prefix}-${Date.now()}@tsdav-mcp`;
}

/**
 * Extract calendar home URL from existing calendar URL or account
 * @param {Object} client - CalDAV client instance
 * @returns {Promise<string>} Calendar home URL
 */
export async function getCalendarHome(client) {
  // Try to get from account first
  let calendarHome = client.account?.homeUrl;

  // Fallback: Extract from existing calendar
  if (!calendarHome) {
    const calendars = await client.fetchCalendars();

    if (!calendars || calendars.length === 0) {
      throw new Error('Cannot determine calendar home: No calendar home found and no existing calendars available.');
    }

    // Extract calendar home from an existing calendar URL
    // Example: https://dav.example.com/calendars/user/calendar-name/ -> https://dav.example.com/calendars/user/
    const existingCalendarUrl = calendars[0].url;
    calendarHome = existingCalendarUrl.substring(0, existingCalendarUrl.lastIndexOf('/', existingCalendarUrl.length - 2) + 1);
  }

  return calendarHome;
}

/**
 * Sanitize calendar/event name for URL usage
 * @param {string} name - Display name
 * @returns {string} Sanitized name suitable for URLs
 */
export function sanitizeNameForUrl(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Find calendar by URL and provide helpful error if not found
 * @param {Array} calendars - List of calendars
 * @param {string} calendarUrl - URL to search for
 * @returns {Object} Calendar object
 * @throws {Error} If calendar not found
 */
export function findCalendarOrThrow(calendars, calendarUrl) {
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
 * Find addressbook by URL and provide helpful error if not found
 * @param {Array} addressbooks - List of addressbooks
 * @param {string} addressbookUrl - URL to search for
 * @returns {Object} Addressbook object
 * @throws {Error} If addressbook not found
 */
export function findAddressbookOrThrow(addressbooks, addressbookUrl) {
  const addressbook = addressbooks.find(ab => ab.url === addressbookUrl);

  if (!addressbook) {
    const availableUrls = addressbooks.map(ab => ab.url).join('\n- ');
    throw new Error(
      `Address book not found: ${addressbookUrl}\n\n` +
      `Available address book URLs:\n- ${availableUrls}\n\n` +
      `Please use list_addressbooks first to get the correct URLs.`
    );
  }

  return addressbook;
}

/**
 * Build time range options for queries
 * @param {string} timeRangeStart - Start date (ISO 8601)
 * @param {string} timeRangeEnd - End date (ISO 8601)
 * @returns {Object} Time range options object
 */
export function buildTimeRangeOptions(timeRangeStart, timeRangeEnd) {
  const options = {};

  if (timeRangeStart && !timeRangeEnd) {
    // Default to 1 year from start if only start provided
    const startDate = new Date(timeRangeStart);
    const endDate = new Date(startDate);
    endDate.setFullYear(endDate.getFullYear() + 1);
    options.timeRange = {
      start: timeRangeStart,
      end: endDate.toISOString(),
    };
  } else if (timeRangeStart && timeRangeEnd) {
    options.timeRange = {
      start: timeRangeStart,
      end: timeRangeEnd,
    };
  }

  return options;
}

/**
 * Assert that a DAV delete actually happened.
 *
 * tsdav's deleteObject — and the deleteCalendarObject / deleteVCard /
 * deleteTodo wrappers around it — is a bare fetch, and fetch does not reject on
 * 4xx or 5xx. An unchecked call therefore reports success for a 403 or 405 as
 * happily as for a 204, which is how "the calendar is still there after I
 * deleted it" becomes invisible to the caller.
 *
 * A 404 counts as done: DELETE is idempotent and the object is gone either way.
 *
 * @param {Response|undefined} response - what tsdav handed back
 * @param {string} what - the object being deleted, for the error message
 */
export async function assertDeleted(response, what) {
  // Not every tsdav version returns the raw Response; if we cannot see a
  // status, we have nothing to check and must not invent a failure.
  if (!response || typeof response.status !== 'number') return;

  if (response.ok || response.status === 404) return;

  let detail = '';
  try {
    const body = await response.text();
    if (body) detail = `: ${body.slice(0, 200)}`;
  } catch {
    // body already consumed or not readable — the status is enough
  }

  throw new Error(
    `Failed to delete ${what}: server responded ${response.status} ${response.statusText || ''}`.trim() +
    detail +
    '. The object still exists on the server.'
  );
}

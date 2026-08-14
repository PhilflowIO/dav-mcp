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
 * Format a date-only value as an iCal DATE (RFC 5545 3.3.4)
 *
 * String surgery on purpose: routing the value through Date would give it a
 * time and an offset it does not have, and reading the date back out in the
 * host timezone shifts it by a day for anyone east or west of Greenwich.
 *
 * @param {string} dateOnly - Date in YYYY-MM-DD form
 * @returns {string} Formatted iCal date (YYYYMMDD)
 */
export function formatICalDateOnly(dateOnly) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) {
    throw new Error(`Expected a date in YYYY-MM-DD form, got "${dateOnly}"`);
  }
  return `${match[1]}${match[2]}${match[3]}`;
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

// Query tools return everything the server has in range, which for a wide
// range is thousands of objects — and each one carries its full iCal body into
// the model's context. A cap is the difference between a useful answer and an
// overflowed one.
export const DEFAULT_RESULT_LIMIT = 20;

/**
 * Extract a sortable key from a raw iCal/vCard body.
 *
 * Date properties normalise to digits so that a DATE ("20260525") and a
 * DATE-TIME ("20260525T100000Z") sort against each other correctly, which they
 * do not as raw strings. Text properties sort case-insensitively.
 *
 * A missing property sorts last either way: an object with no date is not
 * "earliest", and an unnamed contact is not first.
 */
function sortKey(data, property, kind) {
  const raw = data?.match(new RegExp(`^${property}[^:]*:(.+)$`, 'm'))?.[1]?.trim() || '';

  if (kind === 'text') {
    return raw ? raw.toLowerCase() : '\uffff';
  }
  const digits = raw.replace(/\D/g, '');
  return digits ? digits.padEnd(14, '0') : '9'.repeat(14);
}

/**
 * Sort by date and cap the result set.
 *
 * Truncating without sorting would hand back an arbitrary subset, which is
 * worse than a smaller one: the caller cannot tell which events they are
 * missing. Returns the total so the formatter can say what was left out —
 * silent truncation reads as "this is everything".
 *
 * @param {Array} items - DAV objects with a `data` property
 * @param {number} limit - maximum number of items to return
 * @param {string} property - property to sort by (DTSTART, DUE, FN, ...)
 * @param {'date'|'text'} kind - how to compare that property
 * @returns {{ items: Array, total: number }}
 */
export function limitResults(items, limit, property, kind = 'date') {
  const total = items.length;

  if (!limit || total <= limit) {
    return { items, total };
  }

  const sorted = [...items].sort(
    (a, b) => sortKey(a.data, property, kind).localeCompare(sortKey(b.data, property, kind))
  );

  return { items: sorted.slice(0, limit), total };
}

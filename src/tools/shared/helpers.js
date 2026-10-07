import { MCP_ERROR_CODES } from '../../error-handler.js';
/**
 * Shared helper functions for tool implementations
 */

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

// tsdav strips the namespace and camelCases element names, and 2.3.5+ keeps a
// "{namespace}" prefix where two namespaces use the same name.
const localNames = (resourcetype) =>
  Object.keys(resourcetype && typeof resourcetype === 'object' ? resourcetype : {})
    .map(key => key.replace(/^\{[^}]*\}/, ''));

function textValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value?._cdata ?? value?._text ?? '';
}

/**
 * What is at a collection URL: a live calendar, a calendar in the trash bin,
 * or something else?
 *
 * Status codes cannot answer that. SabreDAV (Nextcloud, Baikal) says 405
 * "already exists" to a MKCALENDAR both for a live calendar and for one in
 * Nextcloud's trash bin, which list_calendars does not show, and a DELETE on a
 * trashed calendar is answered like one on a live calendar. So we look. Goes
 * through the client so the request is authenticated; no headers are passed,
 * as that would replace the auth headers in tsdav before 2.3.5.
 *
 * @returns {Promise<{activeCalendar: boolean, trashedCalendar: boolean, displayName: string}|null>}
 *   null if nothing is there or the server would not tell us
 */
export async function inspectCollection(client, url) {
  let responses;
  try {
    responses = await client.propfind({
      url,
      depth: '0',
      props: { 'd:resourcetype': {}, 'd:displayname': {} },
    });
  } catch {
    return null;
  }
  const entry = Array.isArray(responses) ? responses[0] : undefined;
  if (!entry || entry.ok === false || entry.status < 200 || entry.status >= 300) return null;

  const types = localNames(entry.props?.resourcetype);
  return {
    // Nextcloud marks a trashed calendar {http://nextcloud.com/ns}deleted-calendar
    // instead of calendar; it only holds the URL until the trash is emptied.
    activeCalendar: types.includes('calendar') && !types.includes('deletedCalendar'),
    trashedCalendar: types.includes('deletedCalendar'),
    displayName: textValue(entry.props?.displayname),
  };
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
 * Pull the human-readable reason out of a DAV error body.
 *
 * SabreDAV (Nextcloud, Baikal) answers with an XML <d:error> whose
 * <s:message> is the only part a person can act on ("The resource you tried
 * to create already exists"). Anything else is passed through, capped, so a
 * plain-text reason from another server is not lost either.
 */
function extractDavMessage(body) {
  if (typeof body !== 'string' || !body) return '';
  const sabre = /<(?:[\w-]+:)?message(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?message>/.exec(body);
  if (sabre) return sabre[1].trim();
  return body.trim().slice(0, 200);
}

/**
 * In a parsed 207 multistatus, find the first propstat whose status is not
 * 2xx. PROPPATCH reports per-property failures only there: the HTTP status is
 * 207 and tsdav marks the entry ok, so without this a refused property change
 * reads as success.
 *
 * tsdav 2.3.5+ hands the per-property results over as `propStats`; older
 * versions only have the parsed body in `raw`.
 */
function failedPropstat(entry) {
  if (Array.isArray(entry.propStats)) {
    const failed = entry.propStats.find(stat =>
      typeof stat?.status === 'number' && (stat.status < 200 || stat.status >= 300));
    return failed ? { status: failed.status, statusText: failed.statusText || '' } : null;
  }

  const responses = entry.raw?.multistatus?.response;
  if (!responses) return null;
  for (const response of [].concat(responses)) {
    for (const propstat of [].concat(response?.propstat ?? [])) {
      const match = /^\S+\s(\d{3})\s?(.*)$/.exec(String(propstat?.status ?? ''));
      if (match && !match[1].startsWith('2')) {
        return { status: Number(match[1]), statusText: match[2] };
      }
    }
  }
  return null;
}

/**
 * Describe why a DAV write failed, or return null if it did not.
 *
 * tsdav never rejects on an HTTP error. Its object writes (createObject,
 * updateObject, deleteObject and every create/update/delete wrapper) hand back
 * the bare fetch Response; its XML requests (makeCalendar, davRequest,
 * propfind) hand back DAVResponse[] with `ok: false` on non-2xx. Both shapes
 * are accepted here so every write path uses the same check.
 *
 * @param {Response|Array|undefined} result - what tsdav handed back
 * @returns {Promise<{status:number, statusText:string, message:string, url?:string, parseError?:string}|null>}
 */
export async function davFailure(result) {
  if (Array.isArray(result)) {
    for (const entry of result) {
      if (!entry) continue;
      // tsdav 2.3.5+ marks a response whose XML it could not parse as failed,
      // even on a 2xx. The status alone would read as a contradiction.
      if (entry.parseError) {
        return {
          status: entry.status,
          statusText: entry.statusText || '',
          message: '',
          url: entry.href,
          parseError: entry.parseError,
        };
      }
      const httpFailed = entry.ok === false ||
        (typeof entry.status === 'number' && (entry.status < 200 || entry.status >= 300));
      if (httpFailed) {
        return {
          status: entry.status,
          statusText: entry.statusText || '',
          message: extractDavMessage(entry.raw),
          url: entry.href,
        };
      }
      const propFailure = failedPropstat(entry);
      if (propFailure) {
        return { ...propFailure, message: '', url: entry.href };
      }
    }
    return null;
  }

  // Not every tsdav version returns the raw Response; if we cannot see a
  // status, we have nothing to check and must not invent a failure.
  if (!result || typeof result.status !== 'number') return null;
  if (result.ok ?? (result.status >= 200 && result.status < 300)) return null;

  let body = '';
  try {
    body = await result.text();
  } catch {
    // body already consumed or not readable — the status is enough
  }
  return {
    status: result.status,
    statusText: result.statusText || '',
    message: extractDavMessage(body),
    url: result.url || undefined,
  };
}

/**
 * Turn a davFailure() result into the error the tools throw, for callers that
 * inspect the failure before deciding to give up (make_calendar's slug retry).
 */
export function davFailureError(failure, prefix, suffix = '') {
  const reason = failure.parseError
    ? `server returned an unreadable response (status ${failure.status})`
    : `server responded ${failure.status} ${failure.statusText}`.trim() +
      (failure.message ? `: ${failure.message}` : '');
  const error = new Error(`${prefix}: ${reason}${suffix}`);
  // The error handler derives the MCP error code from this, not from the
  // message, which contains the URL.
  error.httpStatus = failure.status;
  error.details = {
    status: failure.status,
    statusText: failure.statusText,
    ...(failure.message && { serverMessage: failure.message }),
    ...(failure.url && { url: failure.url }),
    ...(failure.parseError && { parseError: failure.parseError }),
  };
  return error;
}

/**
 * Assert that a DAV write was accepted by the server.
 *
 * Without this a 403, 412 or 507 is reported to the model as "created" or
 * "updated" — the server refused, nothing changed, and the caller cannot
 * tell. Issue #72.
 *
 * @param {Response|Array|undefined} result - what tsdav handed back
 * @param {string} action - what was attempted, e.g. "create event", for the error message
 */
export async function assertDavSuccess(result, action) {
  const failure = await davFailure(result);
  if (failure) throw davFailureError(failure, `Failed to ${action}`);
}

/**
 * The ETag a create or update left behind, as the fields a tool result
 * carries: `{ etag }` if the caller can use it for the next update, otherwise
 * `{ etag_note }` saying why there is none.
 *
 * tsdav hands back the fetch Response of the PUT, and the ETag is a response
 * header — `response.etag` does not exist, so every write tool used to return
 * `etag: undefined` and the caller had nothing to send as If-Match. Issue #76.
 *
 * The value is passed on exactly as the server sent it, quotes included: that
 * is the form the list and query tools return (getetag), and the form the
 * update and delete tools send back as If-Match without touching it.
 *
 * A server may leave the header out — RFC 4791 5.3.4 and RFC 6352 6.3.2.3
 * tell it to when what it stored is not octet-for-octet what was sent. A weak
 * ETag (W/"...", the prefix is case-sensitive) is no better: If-Match compares strongly (RFC 9110 13.1.1),
 * so it can never match. Both cases are said out loud, because a missing
 * field reads as "nothing to do" and the next update would fail with a 412.
 *
 * @param {Response|undefined} response - what tsdav handed back from a write
 * @returns {{etag: string}|{etag_note: string}}
 */
export function etagAfterWrite(response) {
  const header = response?.headers?.get?.('etag');
  const etag = typeof header === 'string' ? header.trim() : '';
  if (!etag) {
    return { etag_note: 'no ETag returned — fetch the object before the next update' };
  }
  if (etag.startsWith('W/')) {
    return { etag_note: `only a weak ETag returned (${etag}), which cannot be used for an update — fetch the object before the next update` };
  }
  return { etag };
}

/**
 * Assert that a DAV delete actually happened.
 *
 * Same check as assertDavSuccess, with two delete-specific rules. A 404 means
 * there was nothing to delete: reporting "deleted successfully" for a URL
 * that never existed (a typo, an object someone else removed) tells the caller
 * something happened when nothing did, so it is a not-found error — unless
 * the caller saw the target right before the DELETE (`existedBefore`), in
 * which case it existed and is gone, which is what was asked for. And any
 * other failure says the object is still there, which is what the caller
 * needs to know.
 *
 * @param {Response|undefined} response - what tsdav handed back
 * @param {string} kind - what is being deleted: "calendar", "event", ...
 * @param {string} url - its URL
 * @param {object} [options]
 * @param {boolean} [options.existedBefore] - the target was seen right before the DELETE
 */
export async function assertDeleted(response, kind, url, { existedBefore = false } = {}) {
  const failure = await davFailure(response);
  if (!failure) return;
  if (failure.status === 404) {
    if (existedBefore) return;
    const error = new Error(`No ${kind} at ${url} — nothing was deleted.`);
    error.code = MCP_ERROR_CODES.NOT_FOUND_ERROR;
    error.httpStatus = 404;
    error.details = { status: 404, statusText: failure.statusText, url };
    throw error;
  }
  // Deletes go out with If-Match, and servers answer 412 both for a changed
  // object and for one that is not there at all. Saying "still exists" for
  // the latter would be as wrong as "deleted" was for a 404.
  const suffix = failure.status === 412
    ? '. Nothing was deleted: the ETag does not match — the object was changed since it was read, or it does not exist (any more).'
    : '. The object still exists on the server.';
  throw davFailureError(failure, `Failed to delete ${kind} ${url}`, suffix);
}

// Query tools return everything the server has in range, which for a wide
// range is thousands of objects — and each one carries its full iCal body into
// the model's context. A cap is the difference between a useful answer and an
// overflowed one.
export const DEFAULT_RESULT_LIMIT = 20;

/**
 * Order two sort keys: numbers (instants) numerically, strings
 * case-insensitively as given. A missing key (null) sorts last either way: an
 * object with no date is not "earliest", and an unnamed contact is not first.
 */
function compareKeys(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b));
}

/**
 * Sort and cap the result set.
 *
 * Truncating without sorting would hand back an arbitrary subset, which is
 * worse than a smaller one: the caller cannot tell which events they are
 * missing. Returns the total so the formatter can say what was left out —
 * silent truncation reads as "this is everything".
 *
 * The key comes from the caller, read off the object it has already parsed
 * (see dateKey and textKey in query-objects.js) — not from the raw text,
 * where the first DTSTART line is often the VTIMEZONE's.
 *
 * When the exact key is expensive (the occurrence of a recurring event a
 * range query lists means expanding the series), pass a cheap `sortKey` that
 * is a lower bound of it plus `exactKey`. Items are visited in lower-bound
 * order and resolved until the next lower bound is past the limit-th exact
 * key found so far — no unvisited item can then make the cut. Ties at that
 * boundary are resolved too, so the returned order is exact. Equal keys keep
 * their input order.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit - maximum number of items to return
 * @param {(item: T) => number|string|null} sortKey - instant or text, or a
 *   lower bound of exactKey when that is given; null sorts last
 * @param {(item: T) => number|string|null} [exactKey]
 * @returns {{ items: T[], total: number }}
 */
export function limitResults(items, limit, sortKey, exactKey = null) {
  const total = items.length;

  if (!limit || total <= limit) {
    return { items, total };
  }

  const byKey = (a, b) => compareKeys(a.key, b.key) || a.index - b.index;
  const keyed = items
    .map((item, index) => ({ item, index, key: sortKey(item) }))
    .sort(byKey);

  if (!exactKey) {
    return { items: keyed.slice(0, limit).map(({ item }) => item), total };
  }

  const resolved = []; // kept sorted by exact key
  for (const entry of keyed) {
    if (resolved.length >= limit && compareKeys(entry.key, resolved[limit - 1].key) > 0) break;
    const exact = { item: entry.item, index: entry.index, key: exactKey(entry.item) };
    let at = resolved.length;
    while (at > 0 && byKey(resolved[at - 1], exact) > 0) at--;
    resolved.splice(at, 0, exact);
  }

  return { items: resolved.slice(0, limit).map(({ item }) => item), total };
}

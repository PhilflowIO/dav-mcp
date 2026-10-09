import { MCP_ERROR_CODES, NotFoundError, ValidationError, CalDAVError } from '../../error-handler.js';
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
      throw new CalDAVError('Cannot determine calendar home: the server reported no calendar home and has no calendars to derive it from.');
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
 * The error for a collection URL from the caller that names none of the
 * collections on the server: the caller's mistake, said as one (#115). An
 * untyped error was classified by the words in its message, which carries
 * the URL, so on a host like caldav.icloud.com a typo read as a CalDAV
 * server failure.
 *
 * @param {object} what
 * @param {string} what.parameter - the tool parameter, e.g. "calendar_url"
 * @param {string} what.url - what the caller sent
 * @param {string} what.noun - "calendars", "address books"
 * @param {string} what.listTool - the tool that lists them
 * @param {Array<{url: string}>} what.collections - the ones there are
 * @param {string} [what.omit] - what leaving the parameter out does, if allowed
 * @returns {NotFoundError}
 */
function unknownCollectionError({ parameter, url, noun, listTool, collections, omit }) {
  const shown = collections.slice(0, MAX_LISTED_COLLECTIONS);
  const more = collections.length - shown.length;
  const available = collections.length
    ? `\n- ${shown.map(c => c.url).join('\n- ')}` +
      (more > 0 ? `\n- and ${more} more (${listTool} lists them all)` : '')
    : ' none';
  return new NotFoundError(
    `${parameter} ${url} is not one of the ${noun} on this server.\n\n` +
    `The ${noun} there:${available}\n\n` +
    `Send one of these URLs as ${parameter} (${listTool} lists them)` +
    `${omit ? `, or omit ${parameter} ${omit}` : ''}.`,
    { parameter, url }
  );
}

// An account can hold hundreds of calendars; the error names enough to spot
// a typo and leaves the rest to the list tool.
const MAX_LISTED_COLLECTIONS = 20;

/**
 * Find the calendar a calendar_url names.
 * @param {Array} calendars - List of calendars
 * @param {string} calendarUrl - URL to search for
 * @param {object} [options]
 * @param {string} [options.omit] - what omitting calendar_url does, for tools where it is optional
 * @returns {Object} Calendar object
 * @throws {NotFoundError} If calendar not found
 */
export function findCalendarOrThrow(calendars, calendarUrl, { omit } = {}) {
  const calendar = calendars.find(c => c.url === calendarUrl);
  if (!calendar) {
    throw unknownCollectionError({
      parameter: 'calendar_url', url: calendarUrl, noun: 'calendars',
      listTool: 'list_calendars', collections: calendars, omit,
    });
  }
  return calendar;
}

/**
 * Find the address book an addressbook_url names.
 * @param {Array} addressbooks - List of addressbooks
 * @param {string} addressbookUrl - URL to search for
 * @param {object} [options]
 * @param {string} [options.omit] - what omitting addressbook_url does, for tools where it is optional
 * @returns {Object} Addressbook object
 * @throws {NotFoundError} If addressbook not found
 */
export function findAddressbookOrThrow(addressbooks, addressbookUrl, { omit } = {}) {
  const addressbook = addressbooks.find(ab => ab.url === addressbookUrl);
  if (!addressbook) {
    throw unknownCollectionError({
      parameter: 'addressbook_url', url: addressbookUrl, noun: 'address books',
      listTool: 'list_addressbooks', collections: addressbooks, omit,
    });
  }
  return addressbook;
}

/**
 * The error for an object URL from the caller with nothing behind it.
 *
 * @param {string} parameter - the tool parameter, e.g. "event_url"
 * @param {string} url - what the caller sent
 * @param {string} noun - "event", "todo", "contact"
 * @param {string} findTools - where the caller gets a current URL
 * @returns {NotFoundError}
 */
export function objectNotFoundError(parameter, url, noun, findTools) {
  return new NotFoundError(
    `No ${noun} at ${parameter} ${url}. Nothing was changed. ` +
    `Get the ${noun}'s current URL and etag from ${findTools}.`,
    { parameter, url }
  );
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
  // The error handler adds where to fix the password to a 401 (#123).
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

// Statuses a server answers when it refuses the body itself: SabreDAV
// (Nextcloud, Baïkal) 415 for iCalendar or vCard it cannot parse or validate,
// Radicale 400, and 422 for content understood but not processable.
const CONTENT_REFUSALS = new Set([400, 415, 422]);

/**
 * A write whose body the caller supplied, refused as invalid: the caller's
 * input, so a validation error that says what to correct (#115). Only for
 * bodies from the caller — a request dav-mcp builds itself (a REPORT, a
 * PROPFIND) refused the same way is dav-mcp's or the server's fault, and
 * calling it invalid input would have the model "correct" what it sent.
 */
function contentRefusedError(failure, { noun, fix }) {
  const reason = failure.message || failure.parseError || '';
  return new ValidationError(
    `The server refused the ${noun} as invalid (${`${failure.status} ${failure.statusText}`.trim()})` +
    `${reason ? `: ${reason.replace(/\.$/, '')}` : ''}. ${fix}`,
    {
      status: failure.status,
      statusText: failure.statusText,
      ...(failure.message && { serverMessage: failure.message }),
      ...(failure.url && { url: failure.url }),
    }
  );
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
 * @param {object} [options]
 * @param {string} [options.quotedEtag] - the If-Match sent, if dav-mcp added its quotes (etagQuotedByUs)
 * @param {{noun: string, fix: string}} [options.callerContent] - the body was the caller's
 *   (raw data, or fields dav-mcp wrote as given): what it is and how to correct it
 */
export async function assertDavSuccess(result, action, { quotedEtag, callerContent } = {}) {
  const failure = await davFailure(result);
  if (!failure) return;
  if (callerContent && CONTENT_REFUSALS.has(failure.status)) {
    throw contentRefusedError(failure, callerContent);
  }
  const hint = failure.status === 412 ? quotedEtagHint(quotedEtag) : '';
  throw davFailureError(failure, `Failed to ${action}`, hint && `. ${hint}`);
}

/**
 * What a 412 adds when the caller passed the etag without quotes and dav-mcp
 * sent it quoted (validation.js entityTag): besides a changed object, the
 * cause can be a server that does not quote its ETags. Nothing when the etag
 * went out as given, so that 412 reads as before.
 */
function quotedEtagHint(quotedEtag) {
  if (!quotedEtag) return '';
  return `The etag was passed without quotes, so it was sent as ${quotedEtag}. ` +
    'Fetch the object and pass its etag exactly as the server returns it; if the server ' +
    'returns it without quotes too, it does not quote its ETags as HTTP requires, and an ' +
    'update or delete checked against one cannot succeed.';
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
 * update and delete tools send as If-Match. Those normalise what they are
 * given (validation.js entityTag): a quoted strong ETag goes out unchanged, a
 * bare one gets its quotes, a weak one is refused.
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
 * @param {string} [options.quotedEtag] - the If-Match sent, if dav-mcp added its quotes (etagQuotedByUs)
 */
export async function assertDeleted(response, kind, url, { existedBefore = false, quotedEtag } = {}) {
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
    ? `. Nothing was deleted: the ETag does not match — the object was changed since it was read, or it does not exist (any more).${quotedEtag ? ` ${quotedEtagHint(quotedEtag)}` : ''}`
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

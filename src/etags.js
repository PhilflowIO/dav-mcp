/**
 * What the tools show of an ETag, and which ones a write can use.
 *
 * The update and delete tools send the etag they are given as If-Match, and
 * If-Match compares strongly (RFC 9110 13.1.1): a weak ETag (`W/"…"`, the
 * prefix is case-sensitive, RFC 9110 8.8.3) can never match, so validation.js
 * refuses one (#124). An `etag` field in a tool result is therefore only ever
 * one a write can send; anything else goes into `etag_note`, saying why there
 * is none, the way etagAfterWrite (tools/shared/helpers.js) does for writes.
 */

// The characters an entity-tag may hold between its quotes (RFC 9110 8.8.3:
// etagc = %x21 / %x23-7E / obs-text): no whitespace, no control characters,
// no double quote.
const ETAGC = '[\\x21\\x23-\\x7E\\x80-\\xFF]';
const QUOTED_ETAG = new RegExp(`^"${ETAGC}*"$`);
const BARE_ETAG = new RegExp(`^${ETAGC}+$`);

// The longest etag a tool takes, quotes included. Servers make ETags from a
// hash or a revision counter: SabreDAV (Baikal, Nextcloud) sends 34
// characters, Google and iCloud well under 100. HTTP servers and proxies cap
// a request header line at about 8 KB (Apache LimitRequestFieldSize 8190,
// nginx large_client_header_buffers 8k), so 1 KiB leaves real ETags a wide
// margin while a value pasted into the wrong parameter (a whole iCalendar
// object, say) is named here instead of coming back as a 400 or 431.
export const MAX_ETAG_LENGTH = 1024;

/**
 * @param {unknown} etag
 * @returns {boolean} the value is a weak entity-tag
 */
export function isWeakEtag(etag) {
  return typeof etag === 'string' && etag.trim().startsWith('W/');
}

/**
 * The one rule for which ETag a write can send as If-Match: the etag
 * parameters apply it (validation.js entityTag), and the list and write tools
 * hand out as `etag` only what passes it, so nothing they show is refused.
 *
 * A quoted strong entity-tag is sent as it is, a bare opaque-tag gets its
 * quotes (#124), surrounding whitespace is dropped. Anything else names why
 * not: missing, weak (never matches, RFC 9110 13.1.1), longer than
 * MAX_ETAG_LENGTH, or malformed (inner whitespace, a stray quote, `w/"…"`,
 * whose lowercase prefix makes it neither weak nor an opaque-tag).
 *
 * @param {unknown} value
 * @returns {{ifMatch: string}|{problem: 'missing'|'weak'|'long'|'malformed'}}
 */
export function readEntityTag(value) {
  const etag = typeof value === 'string' ? value.trim() : '';
  if (!etag) return { problem: 'missing' };
  if (isWeakEtag(etag)) return { problem: 'weak' };
  const quoted = QUOTED_ETAG.test(etag) ? etag : BARE_ETAG.test(etag) ? `"${etag}"` : null;
  if (!quoted) return { problem: 'malformed' };
  if (quoted.length > MAX_ETAG_LENGTH) return { problem: 'long' };
  return { ifMatch: quoted };
}

/**
 * The ETag a list, query or get tool read for an object (its DAV:getetag),
 * as the fields its Raw Data entry carries.
 *
 * Where a weak one comes from decides what the note says. DAV:getetag is the
 * ETag a GET would return (RFC 4918 15.6), and that one must be strong for a
 * calendar or address object (RFC 4791 5.3.4, RFC 6352 6.3.2.3). It travels in
 * the body of the multistatus, so a proxy that compresses responses and with
 * that changes their ETag header (nginx gzip marks it weak, Apache mod_deflate
 * appends "-gzip") does not touch it:
 * Nextcloud behind a gzip-compressing front end lists the same strong value
 * either way (checked live, see #136). A weak getetag is the server's own, a
 * fetch from dav-mcp gets the same one again, and only the server can change
 * that. Refetching is the advice after a write (etagAfterWrite), not here.
 *
 * A missing or malformed getetag ends the same way: the write tools need an
 * etag they can send (readEntityTag).
 *
 * @param {unknown} etag - the getetag as tsdav returned it
 * @returns {{etag: string}|{etag_note: string}}
 */
export function listedEtag(etag) {
  const value = typeof etag === 'string' ? etag.trim() : '';
  const { problem } = readEntityTag(value);
  if (problem === 'missing') {
    return { etag_note: 'the server listed no ETag for this object, so it cannot be updated or deleted with these tools, which need one' };
  }
  if (problem === 'weak') {
    return {
      etag_note: `the server lists only a weak ETag (${value}), which can never match an update's or delete's If-Match, ` +
        'so this object cannot be updated or deleted with these tools. CalDAV and CardDAV servers must give strong ETags ' +
        '(RFC 4791 5.3.4, RFC 6352 6.3.2.3): this is the server\'s to fix, not a compressing proxy\'s',
    };
  }
  if (problem) {
    const what = problem === 'long' ? `longer than ${MAX_ETAG_LENGTH} characters` : value;
    return {
      etag_note: `the server lists an ETag that is not a valid ETag (${what}; RFC 9110 8.8.3), so this object cannot be ` +
        'updated or deleted with these tools: this is the server\'s to fix',
    };
  }
  return { etag: value };
}

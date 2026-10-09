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

/**
 * @param {unknown} etag
 * @returns {boolean} the value is a weak entity-tag
 */
export function isWeakEtag(etag) {
  return typeof etag === 'string' && etag.trim().startsWith('W/');
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
 * A missing getetag ends the same way: the write tools need an etag.
 *
 * @param {unknown} etag - the getetag as tsdav returned it
 * @returns {{etag: string}|{etag_note: string}}
 */
export function listedEtag(etag) {
  const value = typeof etag === 'string' ? etag.trim() : '';
  if (!value) {
    return { etag_note: 'the server listed no ETag for this object, so it cannot be updated or deleted with these tools, which need one' };
  }
  if (isWeakEtag(value)) {
    return {
      etag_note: `the server lists only a weak ETag (${value}), which can never match an update's or delete's If-Match, ` +
        'so this object cannot be updated or deleted with these tools. CalDAV and CardDAV servers must give strong ETags ' +
        '(RFC 4791 5.3.4, RFC 6352 6.3.2.3): this is the server\'s to fix, not a compressing proxy\'s',
    };
  }
  return { etag: value };
}

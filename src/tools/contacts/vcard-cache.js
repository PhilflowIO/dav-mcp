import { DAVNamespaceShort } from 'tsdav';
import { multiGetObjects } from '../shared/multiget.js';

/**
 * vCards of an address book, cached per login and validated by ETag.
 *
 * Some servers make vCard data expensive: OX App Suite (mailbox.org) needs
 * about 0.3 s per vCard in an addressbook-multiget, so listing a 1000-contact
 * address book takes minutes, while a PROPFIND of its hrefs and ETags takes
 * half a second. Every call here lists hrefs + ETags, fetches only new or
 * changed vCards and drops deleted ones, so the result is always current and
 * a repeated call on an unchanged address book costs one PROPFIND.
 *
 * The cache hangs off the client: one client per login (see TsdavClientManager),
 * so two logins never share cached objects, even for the same address book URL.
 * Same idea as #171 proposes for recurring events.
 */
const caches = new WeakMap(); // client -> Map(addressBookUrl -> Map(pathKey -> vcard))

/** Comparable key for an object URL: decoded path without trailing slash. */
function pathKey(url, base) {
  let path;
  try {
    path = new URL(url, base).pathname;
  } catch {
    path = String(url).trim();
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // malformed escape — compare as-is
  }
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Text of a parsed DAV property (string, number or CDATA/text node). */
function davText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const text = value?._cdata ?? value?._text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * List the vCards of an address book with one PROPFIND (Depth 1):
 * absolute URL and ETag per object, the collection and sub-collections skipped.
 */
async function listVCards(client, addressBook) {
  const bookKey = pathKey(addressBook.url, addressBook.url);
  const responses = await client.propfind({
    url: addressBook.url,
    props: {
      [`${DAVNamespaceShort.DAV}:getetag`]: {},
      [`${DAVNamespaceShort.DAV}:resourcetype`]: {},
    },
    depth: '1',
  });
  return (responses ?? [])
    .filter(res => res?.href && res.ok !== false && !res.props?.resourcetype?.collection)
    .filter(res => pathKey(res.href, addressBook.url) !== bookKey)
    .map(res => ({
      url: new URL(res.href, addressBook.url).href,
      etag: davText(res.props?.getetag),
    }));
}

/**
 * All vCards of an address book, as client.fetchVCards returns them
 * ({ url, etag, data }), but fetching only what changed since the last call.
 *
 * @param {import('tsdav').DAVClient} client
 * @param {{url: string}} addressBook
 * @returns {Promise<Array<{url: string, etag?: string, data: string}>>}
 */
export async function fetchVCardsCached(client, addressBook) {
  let listed;
  try {
    listed = await listVCards(client, addressBook);
  } catch {
    // A server that refuses a Depth 1 PROPFIND still gets its contacts, uncached
    return client.fetchVCards({ addressBook });
  }

  // Nothing to validate a cached copy against: no listing, or objects without ETag
  if (listed.length === 0 || listed.some(item => !item.etag)) {
    return client.fetchVCards({ addressBook });
  }

  let books = caches.get(client);
  if (!books) {
    books = new Map();
    caches.set(client, books);
  }
  const cache = books.get(addressBook.url) ?? new Map();

  const stale = listed.filter(item => cache.get(pathKey(item.url, addressBook.url))?.etag !== item.etag);
  if (stale.length > 0) {
    const { found } = await multiGetObjects(client, {
      kind: 'addressbook',
      collectionUrl: addressBook.url,
      objectUrls: stale.map(item => item.url),
    });
    for (const vcard of found) {
      cache.set(pathKey(vcard.url, addressBook.url), vcard);
    }
  }

  // Drop objects that are no longer listed
  const current = new Set(listed.map(item => pathKey(item.url, addressBook.url)));
  for (const key of cache.keys()) {
    if (!current.has(key)) cache.delete(key);
  }
  books.set(addressBook.url, cache);

  // Copies: callers annotate the objects (e.g. _addressbookName)
  return listed
    .map(item => cache.get(pathKey(item.url, addressBook.url)))
    .filter(Boolean)
    .map(vcard => ({ ...vcard }));
}

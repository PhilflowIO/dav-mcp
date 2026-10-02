import { DAVNamespace, DAVNamespaceShort, getDAVAttribute } from 'tsdav';
import { davFailure, davFailureError } from './helpers.js';

/**
 * Batch-fetch DAV objects by URL (RFC 4791 §7.9 calendar-multiget,
 * RFC 6352 §8.7 addressbook-multiget) and report each URL on its own.
 *
 * Not through tsdav's fetchCalendarObjects/fetchVCards({ objectUrls }) or its
 * calendarMultiGet/addressBookMultiGet: from 2.3.5 on all of them throw as soon
 * as one URL in the multistatus is a 404, so a single deleted object would
 * hide every object that does exist. davRequest hands back every multistatus
 * member with its own status in every tsdav version, which is what per-URL
 * reporting needs.
 */

const REPORTS = {
  calendar: {
    report: 'calendar-multiget',
    namespace: DAVNamespaceShort.CALDAV,
    attributes: [DAVNamespace.DAV, DAVNamespace.CALDAV],
    dataProp: `${DAVNamespaceShort.CALDAV}:calendar-data`,
    // tsdav strips the namespace and camelCases element names when parsing
    dataKey: 'calendarData',
  },
  addressbook: {
    report: 'addressbook-multiget',
    namespace: DAVNamespaceShort.CARDDAV,
    attributes: [DAVNamespace.DAV, DAVNamespace.CARDDAV],
    dataProp: `${DAVNamespaceShort.CARDDAV}:address-data`,
    dataKey: 'addressData',
  },
};

/**
 * Text content of a parsed DAV property. tsdav hands over a string, a number
 * (2.3.1 coerces numeric text, e.g. an unquoted ETag) or a CDATA/text node.
 */
function davText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const text = value?._cdata ?? value?._text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * Comparable key for an object URL: the decoded path, without a trailing
 * slash. Servers answer with a path-only href, callers pass absolute URLs, and
 * either side may percent-encode differently.
 */
function urlKey(url, base) {
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

const isSuccess = (status) => typeof status === 'number' && status >= 200 && status < 300;

/**
 * Whether davRequest parsed a multistatus, as opposed to handing back the
 * HTTP response of a REPORT that failed outright (raw is then the body text).
 * tsdav 2.3.1 parses an empty <multistatus/> — what Nextcloud sends when none
 * of the hrefs exist — to a lone 207 member with no raw and no href.
 */
const isMultistatus = (entries) => Array.isArray(entries) && entries.some(entry =>
  entry?.raw?.multistatus ||
  (entry && entry.raw === undefined && !entry.href && entry.status === 207));

/**
 * Fetch objects from one collection with a single multiget REPORT.
 *
 * @param {import('tsdav').DAVClient} client
 * @param {object} params
 * @param {'calendar'|'addressbook'} params.kind - which multiget report to send
 * @param {string} params.collectionUrl - calendar or address book holding the objects
 * @param {string[]} params.objectUrls - absolute URLs of the objects to fetch
 * @returns {Promise<{found: Array<{url:string, etag?:string, data:string}>, missing: Array<{url:string, status?:number, statusText:string}>}>}
 *   found in request order, in the shape the list/query tools return;
 *   missing with the reason the server gave for each URL
 */
export async function multiGetObjects(client, { kind, collectionUrl, objectUrls }) {
  const spec = REPORTS[kind];
  const requested = [...new Set(objectUrls)];

  const entries = await client.davRequest({
    url: collectionUrl,
    init: {
      method: 'REPORT',
      // RFC 4791 §7.9 / RFC 6352 §8.7: no Depth header on a multiget
      namespace: spec.namespace,
      body: {
        [spec.report]: {
          _attributes: getDAVAttribute(spec.attributes),
          [`${DAVNamespaceShort.DAV}:prop`]: {
            [`${DAVNamespaceShort.DAV}:getetag`]: {},
            [spec.dataProp]: {},
          },
          // path only, as tsdav sends it: not every server accepts an absolute URI here
          [`${DAVNamespaceShort.DAV}:href`]: requested.map(url => new URL(url).pathname),
        },
      },
    },
  });

  // Anything but a parsed multistatus means the REPORT itself failed
  // (401, 403, wrong collection URL, unreadable body) — that is not a per-URL
  // answer, so it is an error for the whole call.
  if (!isMultistatus(entries)) {
    const failure = await davFailure(entries);
    if (failure) throw davFailureError(failure, `Failed to fetch objects from ${collectionUrl}`);
    throw new Error(`Failed to fetch objects from ${collectionUrl}: server did not answer with a multistatus`);
  }

  const byKey = new Map();
  for (const entry of entries) {
    // an empty <multistatus/> parses to one member without href
    if (!entry?.href) continue;
    byKey.set(urlKey(entry.href, collectionUrl), entry);
  }

  const found = [];
  const missing = [];
  for (const url of requested) {
    const entry = byKey.get(urlKey(url, collectionUrl));
    if (!entry) {
      // RFC 4791 §7.9 wants a 404 member per unknown href; Nextcloud leaves
      // the href out of the multistatus instead. Either way the collection
      // has no such object.
      missing.push({ url, statusText: 'not returned by the server' });
      continue;
    }
    const data = davText(entry.props?.[spec.dataKey]);
    if (isSuccess(entry.status) && data !== undefined) {
      found.push({ url, etag: davText(entry.props?.getetag), data });
    } else if (isSuccess(entry.status)) {
      missing.push({ url, status: entry.status, statusText: 'server returned no data' });
    } else {
      missing.push({ url, status: entry.status, statusText: entry.statusText || '' });
    }
  }

  return { found, missing };
}

import convert from 'xml-js';
import { MCP_ERROR_CODES } from './error-handler.js';
import { ConfigurationError } from './auth-config.js';

/**
 * Where dav-mcp may send a request, and with it the user's credentials.
 *
 * tsdav attaches the login (Basic password, Digest response or OAuth bearer)
 * to every request a client makes, whatever URL it names. The URLs come from
 * the calling model, and the model can be steered by content it reads — an
 * event description or a contact note written by someone else. So a URL is
 * only accepted inside the account: under the configured server URL, or under
 * a URL the server itself named while logging in (its DAV root, the
 * principal, the calendar and address book homes) or listed as one of the
 * account's collections. "Under" means same origin (scheme, host, port) and
 * a path below that URL, so other paths on a shared host do not get the login.
 * iCloud, for one, keeps an account's calendars on a per-account host
 * (pXX-caldav.icloud.com) that differs from the configured caldav.icloud.com.
 *
 * While the login itself runs, before any tool can use the clients, requests
 * may go anywhere on the origins the login has reached so far: the configured
 * server and wherever it redirects. That is where servers keep their
 * well-known discovery and root URLs.
 *
 * Two places enforce the same policy:
 * - the URL fields of the tool schemas (validation.js), so a foreign URL is
 *   refused with a clear message before a tool does anything; and
 * - the fetch every tsdav client is built with (tsdav-client.js), which also
 *   follows redirects itself and checks every hop, so no request path — a
 *   tool that forgets the schema, a URL derived from another one, a server
 *   redirecting elsewhere — can carry a request out of the account.
 */

export class RequestOriginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestOriginError';
    this.code = MCP_ERROR_CODES.VALIDATION_ERROR;
  }
}

// Bound when this module loads, like tsdav binds its own: tests that replace
// globalThis.fetch around the import of the client manager rely on that.
const platformFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

const DAV_NS = 'DAV:';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
const CARDDAV_NS = 'urn:ietf:params:xml:ns:carddav';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 20;
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

function parseUrl(value) {
  try {
    return new URL(value instanceof URL ? value.href : String(value));
  } catch {
    return null;
  }
}

function resolveUrl(reference, base) {
  try {
    return new URL(reference, base);
  } catch {
    return null;
  }
}

function requestUrlOf(input) {
  if (typeof input === 'string' || input instanceof URL) return parseUrl(input);
  return parseUrl(input?.url);
}

const isHttp = (url) => url.protocol === 'https:' || url.protocol === 'http:';

// The path as a directory: a prefix that only matches whole segments.
const directoryOf = (pathname) => (pathname.endsWith('/') ? pathname : `${pathname}/`);

/**
 * The path as a server may end up seeing it: each segment percent-decoded,
 * split again at a decoded slash or backslash, path parameters (`;...`,
 * which Java servlet stacks strip) ignored when deciding whether a segment
 * is `.` or `..`, and dot-segments resolved. URL parsing already resolves
 * the plain and %2e forms; this covers what a decoding server adds.
 *
 * @returns {string[]|null} the segments, or null if the path climbs above
 *   the root, has a malformed escape, or is encoded twice over a dot, slash
 *   or backslash (`%252e`), which no check can follow through every decoder
 */
function effectiveSegments(pathname) {
  const segments = [];
  for (const raw of pathname.split('/').slice(1)) {
    if (/%25(2e|2f|5c)/i.test(raw)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    for (const part of decoded.split(/[/\\]/)) {
      const name = part.split(';', 1)[0];
      if (name === '.') continue;
      if (name === '..') {
        if (segments.length === 0) return null;
        segments.pop();
        continue;
      }
      segments.push(part);
    }
  }
  return segments;
}

// Whether a list of segments starts with a directory's segments.
function startsWithDirectory(segments, directory) {
  const prefix = directory[directory.length - 1] === '' ? directory.slice(0, -1) : directory;
  return segments.length >= prefix.length && prefix.every((segment, i) => segments[i] === segment);
}

/**
 * Whether a URL lies below a scope, both as written and as a server that
 * decodes the path would see it: `/dav/..;/x` and `/dav/a%2F..%2F..%2Fx`
 * leave `/dav/`, `/dav/abc%2Fdef.ics` (an object whose name has a slash)
 * does not.
 */
function isUnder(url, scope) {
  if (url.origin !== scope.origin) return false;
  if (!url.pathname.startsWith(scope.path) && `${url.pathname}/` !== scope.path) return false;
  const segments = effectiveSegments(url.pathname);
  const directory = effectiveSegments(scope.path);
  return Boolean(segments && directory && startsWithDirectory(segments, directory));
}

const isReplayable = (body) =>
  body == null || typeof body === 'string' || body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body) || body instanceof URLSearchParams ||
  (typeof Blob !== 'undefined' && body instanceof Blob);

/**
 * The request fetch makes for the next hop of a redirect, as the fetch
 * standard does it: a 303 (and a 301 or 302 after POST) turns into a GET
 * without body, every other redirect keeps method and body. The login
 * header is dropped when the hop changes origin.
 */
function nextHopInit(status, init, from, to) {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  let next = { ...init };
  if ((status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((status === 301 || status === 302) && method === 'POST')) {
    for (const name of BODY_HEADERS) headers.delete(name);
    next = { ...next, method: 'GET', body: undefined };
  }
  if (from.origin !== to.origin) headers.delete('authorization');
  return { ...next, headers };
}

/**
 * Collection URLs in a multistatus answer to a Depth 1 PROPFIND on a home:
 * the href of each response whose resourcetype says calendar or address
 * book. Only that structure counts; an href elsewhere — inside a property
 * value, in CDATA, in DAV:owner — is not a collection the server keeps.
 */
function listedCollectionHrefs(xml) {
  let document;
  try {
    document = convert.xml2js(xml, { compact: false, trim: true });
  } catch {
    return [];
  }

  const resolve = (element, inherited) => {
    const namespaces = { ...inherited };
    for (const [name, value] of Object.entries(element.attributes ?? {})) {
      if (name === 'xmlns') namespaces[''] = value;
      else if (name.startsWith('xmlns:')) namespaces[name.slice(6)] = value;
    }
    const [prefix, local] = element.name.includes(':') ? element.name.split(':', 2) : ['', element.name];
    return { namespaces, ns: namespaces[prefix], local };
  };
  const children = (element, namespaces, ns, local) => (element.elements ?? [])
    .filter(child => child.type === 'element')
    .map(child => ({ child, ...resolve(child, namespaces) }))
    .filter(entry => entry.ns === ns && entry.local === local);
  const text = (element) => (element.elements ?? [])
    .filter(node => node.type === 'text' || node.type === 'cdata')
    .map(node => node.text ?? node.cdata)
    .join('')
    .trim();

  const root = (document.elements ?? []).find(node => node.type === 'element');
  if (!root) return [];
  const top = resolve(root, {});
  if (top.ns !== DAV_NS || top.local !== 'multistatus') return [];

  const hrefs = [];
  for (const response of children(root, top.namespaces, DAV_NS, 'response')) {
    const [href] = children(response.child, response.namespaces, DAV_NS, 'href');
    if (!href) continue;
    const isCollection = children(response.child, response.namespaces, DAV_NS, 'propstat').some(propstat => {
      const [status] = children(propstat.child, propstat.namespaces, DAV_NS, 'status');
      if (status && !/\s2\d\d\s/.test(` ${text(status.child)} `)) return false;
      return children(propstat.child, propstat.namespaces, DAV_NS, 'prop').some(prop =>
        children(prop.child, prop.namespaces, DAV_NS, 'resourcetype').some(type =>
          children(type.child, type.namespaces, CALDAV_NS, 'calendar').length > 0 ||
          children(type.child, type.namespaces, CARDDAV_NS, 'addressbook').length > 0));
    });
    if (isCollection) hrefs.push(text(href.child));
  }
  return hrefs;
}

export class RequestOrigins {
  /**
   * @param {object} params
   * @param {string} params.serverUrl - the configured DAV server
   * @param {string} [params.tokenUrl] - the OAuth token endpoint; only the
   *   client's token requests may go there (see tokenFetch)
   */
  constructor({ serverUrl, tokenUrl }) {
    const server = parseUrl(serverUrl);
    if (!server || !isHttp(server)) {
      throw new ConfigurationError(`The configured DAV server URL ${serverUrl} is not an http(s) URL.`);
    }
    if (server.username || server.password) {
      throw new ConfigurationError(
        'The configured DAV server URL contains a user name or password. Remove them from the URL ' +
        'and pass them as CALDAV_USERNAME and CALDAV_PASSWORD.');
    }
    this.secure = server.protocol === 'https:';
    this.scopes = [];
    this.loginOrigins = new Set([server.origin]);
    // origins the server tried to send the login to over plain http
    this.downgradeRedirects = new Set();
    this.#addScope(server);
    this.tokenUrl = tokenUrl ? parseUrl(tokenUrl) : null;
    this.discovering = true;
  }

  #addScope(url) {
    const path = directoryOf(url.pathname);
    if (!this.scopes.some(scope => scope.origin === url.origin && scope.path === path)) {
      this.scopes.push({ origin: url.origin, path });
    }
  }

  // A URL the server named may become part of the account only if it is
  // http(s), carries no credentials and does not downgrade https to http.
  #acceptable(url) {
    return url && isHttp(url) && !url.username && !url.password && effectiveSegments(url.pathname) !== null &&
      !(this.secure && url.protocol === 'http:');
  }

  /**
   * Accept a URL the server named (a discovery redirect, the account's root,
   * principal or home): everything below it becomes reachable. During the
   * login its whole origin is reachable as well, until endDiscovery().
   * @returns {boolean} whether the URL is accepted
   */
  trust(value) {
    const url = parseUrl(value);
    if (!this.#acceptable(url)) return false;
    this.#addScope(url);
    if (this.discovering) this.loginOrigins.add(url.origin);
    return true;
  }

  /** Accept the URLs tsdav found while logging in. */
  trustAccount(account) {
    for (const key of ['rootUrl', 'principalUrl', 'homeUrl']) {
      if (account?.[key]) this.trust(account[key]);
    }
  }

  /** Login is done: from now on only URLs inside the account are reachable. */
  endDiscovery() {
    this.discovering = false;
  }

  /** The URLs below which requests are allowed, for messages and logs. */
  allowedPrefixes() {
    return this.scopes.map(scope => `${scope.origin}${scope.path}`);
  }

  /**
   * Why a request to this URL is refused, or null if it is allowed.
   * @param {string|URL} value
   * @returns {string|null}
   */
  problem(value) {
    const url = parseUrl(value);
    const allowed = this.allowedPrefixes().join(', ');
    if (!url || !isHttp(url)) {
      return `${value} is not an http(s) URL. Use a URL returned by this server (e.g. from list_calendars or list_events).`;
    }
    if (url.username || url.password) {
      return 'URLs with a user name or password in them are refused: the configured login is used for every request. ' +
        'Remove the user:password@ part and use a URL returned by this server.';
    }
    if (this.secure && url.protocol === 'http:') {
      if (this.downgradeRedirects.has(url.origin)) {
        return `the server redirected the login from https to plain http (${url.origin}). dav-mcp does not send ` +
          'the login over plain http once https is configured. Configure the server\'s https URL, or fix the ' +
          'redirect on the server so it stays on https.';
      }
      return `${url.origin} is plain http, but the DAV server is configured over https; ` +
        `requests are only sent over https. Allowed: ${allowed}.`;
    }
    if (effectiveSegments(url.pathname) === null) {
      return `${url.href} has a path that cannot be checked safely (it climbs above the root once decoded, ` +
        'has a malformed escape, or is encoded twice). Use a URL returned by this server.';
    }
    if (this.discovering && this.loginOrigins.has(url.origin)) return null;
    if (this.scopes.some(scope => isUnder(url, scope))) return null;
    return `${url.href} is outside the configured DAV account. dav-mcp only sends requests (and with them ` +
      `the login) to URLs below ${allowed}. Use a URL returned by this server (e.g. from list_calendars, ` +
      'list_addressbooks, list_events or list_contacts).';
  }

  /** @throws {RequestOriginError} if a request to this URL is refused */
  assertAllowed(url) {
    const problem = this.problem(url);
    if (problem) throw new RequestOriginError(`Request refused: ${problem}`);
  }

  /**
   * A fetch that refuses every request this policy does not allow, before it
   * reaches the network, and follows redirects itself so that every hop is
   * checked too. A redirect out of the account is an error, never a response.
   *
   * During the login, a redirect from an allowed URL makes its target
   * allowed: that is how servers point a client from the configured URL to
   * their DAV root.
   *
   * @param {typeof fetch} [baseFetch]
   * @param {object} [options]
   * @param {string} [options.listingOf] - a home URL: the collections a
   *   Depth 1 PROPFIND on it lists become reachable (see listedCollectionHrefs)
   * @returns {typeof fetch}
   */
  fetch(baseFetch = platformFetch, { listingOf } = {}) {
    const guarded = (input, init) => this.#send(baseFetch, input, init ?? {}, (url) => this.problem(url), { listingOf });
    this.#own.add(guarded);
    return guarded;
  }

  /** Whether a fetch already is one of this policy's checked fetches. */
  checks(fetch) {
    return this.#own.has(fetch);
  }

  #own = new WeakSet();

  /**
   * The fetch for the OAuth token endpoint, and nothing else: the client's
   * DAV requests cannot reach the token endpoint, its token requests cannot
   * reach anything but.
   * @param {typeof fetch} [baseFetch]
   * @returns {typeof fetch}
   */
  tokenFetch(baseFetch = platformFetch) {
    const token = this.tokenUrl;
    const check = (url) => {
      if (token && url && url.origin === token.origin && url.pathname === token.pathname) return null;
      return `${url?.href ?? url} is not the configured OAuth token endpoint${token ? ` (${token.href})` : ''}.`;
    };
    return (input, init) => this.#send(baseFetch, input, init ?? {}, check, {});
  }

  async #send(baseFetch, input, init, check, { listingOf }) {
    const first = requestUrlOf(input);
    const refused = check(first ?? input);
    if (refused) throw new RequestOriginError(`Request refused: ${refused}`);

    // The caller follows redirects itself (tsdav's Digest handshake, its
    // service discovery): pass the 3xx back and check the next hop when it
    // comes in as a request of its own.
    if ((init.redirect ?? 'follow') !== 'follow') {
      const response = await baseFetch(input, init);
      if (this.discovering) this.#learnRedirect(response, first);
      if (listingOf) await this.#learnListing(response, first, init, listingOf);
      return response;
    }

    let target = first;
    let targetInput = input;
    let targetInit = { ...init, redirect: 'manual' };
    for (let hops = 0; ; hops += 1) {
      const response = await baseFetch(targetInput, targetInit);
      const location = REDIRECT_STATUSES.includes(response.status) ? response.headers.get('location') : null;
      if (!location || !target) {
        if (listingOf && hops === 0) await this.#learnListing(response, target, targetInit, listingOf);
        return response;
      }
      if (hops === MAX_REDIRECTS) throw new RequestOriginError(`Request refused: ${first.href} redirects more than ${MAX_REDIRECTS} times.`);
      await response.body?.cancel().catch(() => undefined);

      const next = resolveUrl(location, target);
      if (this.discovering) this.#learnHop(target, next);
      const problem = check(next);
      if (problem) {
        throw new RequestOriginError(
          `Request refused: the server redirected ${target.href} to ${next?.href ?? location}, and ${problem} ` +
          'Nothing was sent there, and the request did not take effect.');
      }
      if (!isReplayable(targetInit.body) && response.status !== 303) {
        throw new RequestOriginError(`Request refused: ${target.href} redirects, and the request body cannot be sent again.`);
      }
      targetInit = nextHopInit(response.status, targetInit, target, next);
      target = next;
      targetInput = next.href;
    }
  }

  #learnHop(from, to) {
    if (!to) return;
    if (this.secure && from.protocol === 'https:' && to.protocol === 'http:') {
      this.downgradeRedirects.add(to.origin);
      return;
    }
    this.trust(to);
  }

  #learnRedirect(response, url) {
    const location = REDIRECT_STATUSES.includes(response?.status) ? response.headers?.get?.('location') : null;
    if (!location || !url) return;
    // an unparsable Location is skipped: tsdav cannot follow it either
    this.#learnHop(url, resolveUrl(location, url));
  }

  async #learnListing(response, url, init, listingOf) {
    const home = parseUrl(listingOf);
    if (!home || !url || response.status !== 207) return;
    if ((init.method ?? 'GET').toUpperCase() !== 'PROPFIND') return;
    if (directoryOf(url.pathname) !== directoryOf(home.pathname) || url.origin !== home.origin) return;
    let body;
    try {
      body = await response.clone().text();
    } catch {
      return;
    }
    for (const href of listedCollectionHrefs(body)) {
      const collection = resolveUrl(href, url);
      if (this.#acceptable(collection)) this.#addScope(collection);
    }
  }
}

/**
 * The policy of the clients currently in use. Set by the client manager once
 * a login has completed; until then no URL is accepted.
 */
let active = null;

export function activateRequestOrigins(origins) {
  active = origins;
}

/**
 * Why a URL passed to a tool is refused, or null if it may be requested.
 * @param {string} url
 * @returns {string|null}
 */
export function requestUrlProblem(url) {
  if (!active) {
    return 'dav-mcp is not connected to a DAV server yet, so no URL can be checked against it. ' +
      'Check the server configuration and retry.';
  }
  return active.problem(url);
}

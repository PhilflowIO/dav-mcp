import { MCP_ERROR_CODES } from './error-handler.js';
import { ConfigurationError } from './auth-config.js';

/**
 * Where dav-mcp may send a request, and with it the user's credentials.
 *
 * tsdav attaches the login (Basic password, Digest response or OAuth bearer)
 * to every request a client makes, whatever host the URL names. The URLs come
 * from the calling model, and the model can be steered by content it reads —
 * an event description or a contact note written by someone else. So a URL
 * is only accepted if its origin (scheme, host, port) is one the user
 * configured or one the server itself named while logging in or listing its
 * collections. iCloud, for one, hands out its calendars on a per-account host
 * (pXX-caldav.icloud.com) that differs from the configured caldav.icloud.com.
 *
 * Two places enforce the same policy:
 * - the URL fields of the tool schemas (validation.js), so a foreign URL is
 *   refused with a clear message before a tool does anything; and
 * - the fetch every tsdav client is built with (tsdav-client.js), so no
 *   request path — a tool that forgets the schema, a URL derived from another
 *   one — can reach a foreign origin.
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

function parseUrl(value) {
  try {
    return new URL(value instanceof URL ? value.href : String(value));
  } catch {
    return null;
  }
}

function requestUrlOf(input) {
  if (typeof input === 'string' || input instanceof URL) return parseUrl(input);
  return parseUrl(input?.url);
}

const isHttp = (url) => url.protocol === 'https:' || url.protocol === 'http:';

export class RequestOrigins {
  /**
   * @param {object} params
   * @param {string} params.serverUrl - the configured DAV server
   * @param {string[]} [params.authUrls] - endpoints only the login itself talks
   *   to (the OAuth token endpoint): reachable by the client, never accepted
   *   as a tool argument
   */
  constructor({ serverUrl, authUrls = [] }) {
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
    this.davOrigins = new Set([server.origin]);
    this.authOrigins = new Set();
    for (const url of authUrls) {
      const parsed = parseUrl(url);
      if (parsed && isHttp(parsed)) this.authOrigins.add(parsed.origin);
    }
    this.discovering = true;
  }

  /**
   * Accept the origin of a URL the server named (a redirect, the account's
   * principal or home, a collection it listed). Never one that downgrades a
   * https server to plain http, and never one carrying credentials.
   * @returns {boolean} whether the origin is accepted now
   */
  trust(url) {
    const parsed = parseUrl(url);
    if (!parsed || !isHttp(parsed) || parsed.username || parsed.password) return false;
    if (this.secure && parsed.protocol === 'http:') return false;
    this.davOrigins.add(parsed.origin);
    return true;
  }

  /** Accept the URLs tsdav found while logging in. */
  trustAccount(account) {
    for (const key of ['serverUrl', 'rootUrl', 'principalUrl', 'homeUrl']) {
      if (account?.[key]) this.trust(account[key]);
    }
  }

  /** Login is done: from now on only known origins are reachable. */
  endDiscovery() {
    this.discovering = false;
  }

  allowedOrigins() {
    return [...this.davOrigins];
  }

  /**
   * Why a request to this URL is refused, or null if it is allowed.
   * @param {string|URL} url
   * @param {object} [options]
   * @param {boolean} [options.transport] - checked for the client's own
   *   request, which may also go to the OAuth token endpoint
   * @returns {string|null}
   */
  problem(url, { transport = false } = {}) {
    const parsed = parseUrl(url);
    const allowed = this.allowedOrigins().join(', ');
    if (!parsed || !isHttp(parsed)) {
      return `${url} is not an http(s) URL. Use a URL returned by this server (e.g. from list_calendars or list_events).`;
    }
    if (parsed.username || parsed.password) {
      return 'URLs with a user name or password in them are refused: the configured login is used for every request. ' +
        'Remove the user:password@ part and use a URL returned by this server.';
    }
    if (this.secure && parsed.protocol === 'http:') {
      return `${parsed.origin} is plain http, but the DAV server is configured over https; ` +
        `requests are only sent over https. Allowed origins: ${allowed}.`;
    }
    if (this.davOrigins.has(parsed.origin)) return null;
    if (transport && this.authOrigins.has(parsed.origin)) return null;
    return `${parsed.origin} is not the configured DAV server. dav-mcp only sends requests (and with them ` +
      `the login) to ${allowed}. Use a URL returned by this server (e.g. from list_calendars, ` +
      'list_addressbooks, list_events or list_contacts).';
  }

  /** @throws {RequestOriginError} if a request to this URL is refused */
  assertAllowed(url, options) {
    const problem = this.problem(url, options);
    if (problem) throw new RequestOriginError(`Request refused: ${problem}`);
  }

  /**
   * A fetch that refuses every request this policy does not allow, before it
   * reaches the network. While the login is still discovering the account, a
   * redirect from an allowed origin makes its target allowed as well — that
   * is how servers point a client from the configured URL to their DAV root.
   *
   * With learnCollections, the absolute hrefs in a multistatus answer are
   * accepted too: that is a collection listing, and the server lists a
   * collection where it keeps it.
   *
   * @param {typeof fetch} [baseFetch]
   * @param {object} [options]
   * @param {boolean} [options.learnCollections]
   * @returns {typeof fetch}
   */
  fetch(baseFetch = platformFetch, { learnCollections = false } = {}) {
    return async (input, init) => {
      const url = requestUrlOf(input);
      // checked against the policy as it is right now, not as it was when the
      // request was prepared
      this.assertAllowed(url ?? input, { transport: true });
      const response = await baseFetch(input, init);
      if (this.discovering) this.#learnFromLogin(response, url);
      if (learnCollections && response?.status === 207) await this.#learnFromListing(response);
      return response;
    };
  }

  async #learnFromListing(response) {
    let body;
    try {
      body = await response.clone().text();
    } catch {
      return;
    }
    // Path-only hrefs resolve against the account root, which is known
    // already; only absolute ones can name another origin.
    for (const [, href] of body.matchAll(/<(?:[\w-]+:)?href>\s*(https?:\/\/[^<\s]+)\s*</gi)) {
      this.trust(href);
    }
  }

  #learnFromLogin(response, url) {
    // a redirect fetch followed by itself (no Digest wrapper in between)
    if (response?.redirected && response.url) this.trust(response.url);
    const location = response?.status >= 300 && response.status < 400
      ? response.headers?.get?.('location')
      : null;
    if (!location || !url) return;
    try {
      this.trust(new URL(location, url));
    } catch {
      // unparsable Location: tsdav cannot follow it either
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

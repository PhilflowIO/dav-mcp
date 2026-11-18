/**
 * Settings of the HTTP transport that are checked before it listens.
 *
 * Each of them decides who can reach the server or how it tells clients
 * apart, so a wrong value is a ConfigurationError: the server does not start
 * rather than serve with a setting the operator did not mean.
 */

import net from 'net';
import { ConfigurationError } from './auth-config.js';

export const MIN_BEARER_TOKEN_LENGTH = 32;

// Values the documentation has shown as examples. Anyone can read them, so a
// server that accepts one has no authentication.
const PLACEHOLDER_TOKENS = new Set([
  'your-secure-token-here',
  'your-secret-token',
  'YOUR_BEARER_TOKEN',
]);

const HOW_TO_GENERATE = 'Generate one with `openssl rand -hex 32` and set it as BEARER_TOKEN.';

/**
 * @param {string|undefined} value - BEARER_TOKEN as read from the environment
 * @returns {string} the token
 * @throws {ConfigurationError} when the token is unset, a documented example
 *   value, or shorter than MIN_BEARER_TOKEN_LENGTH characters
 */
export function checkBearerToken(value) {
  if (!value) {
    throw new ConfigurationError(
      `BEARER_TOKEN is not set; the HTTP transport refuses every request without it. ${HOW_TO_GENERATE}`,
    );
  }
  if (PLACEHOLDER_TOKENS.has(value)) {
    throw new ConfigurationError(
      `BEARER_TOKEN is the example value from the documentation, which anyone can read. ${HOW_TO_GENERATE}`,
    );
  }
  if (value.length < MIN_BEARER_TOKEN_LENGTH) {
    throw new ConfigurationError(
      `BEARER_TOKEN has ${value.length} characters; at least ${MIN_BEARER_TOKEN_LENGTH} are required. ${HOW_TO_GENERATE}`,
    );
  }
  return value;
}

/**
 * The address the HTTP transport listens on.
 *
 * Only an IP address or `localhost` is accepted. A host name would be
 * resolved to one of the machine's addresses, which is rarely what the
 * operator meant and hides which interface is exposed; some shells (tcsh)
 * also export HOST as the machine's name, and that must not silently move
 * the listener.
 *
 * @param {string|undefined} value - HOST as read from the environment
 * @returns {string|undefined} the address, or undefined for Node's default:
 *   every interface (`::`, dual-stack, or `0.0.0.0` without IPv6)
 * @throws {ConfigurationError} for anything else
 */
export function parseListenHost(value) {
  if (value === undefined || value === '') return undefined;
  if (value === 'localhost' || net.isIP(value) !== 0) return value;
  throw new ConfigurationError(
    `HOST must be an IP address or localhost, got '${value}'. ` +
    'Use 127.0.0.1 to listen on loopback only, 0.0.0.0 or :: for every interface, ' +
    'or leave HOST unset for every interface.',
  );
}

// Express's names for address ranges (proxy-addr): 127.0.0.1/8 and ::1;
// 169.254.0.0/16 and fe80::/10; 10/8, 172.16/12, 192.168/16 and fc00::/7.
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

const LIST_THE_PROXY =
  'Set TRUST_PROXY to the address or CIDR range of the reverse proxy in front of dav-mcp, comma-separated ' +
  'for several: TRUST_PROXY=172.18.0.2 for a proxy container on a compose network ' +
  '(`docker network inspect <network>` shows its address), TRUST_PROXY=127.0.0.1 for a proxy on the same host.';

const isAddressOrRange = (entry) => {
  if (NAMED_RANGES.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  const family = net.isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
};

/**
 * Which proxies in front of the HTTP transport may say who the client is.
 *
 * Express then takes the client address (req.ip) from X-Forwarded-For,
 * walking back from the socket address over trusted proxies only. Without
 * this setting X-Forwarded-For is ignored and the client is whatever
 * connects to the socket — behind a reverse proxy that is the proxy, for
 * every client.
 *
 * Accepted: a comma-separated list of proxy addresses, CIDR ranges and
 * Express's names loopback, linklocal and uniquelocal. A name or range trusts
 * every peer in it: `uniquelocal` makes every container on a compose network
 * a proxy whose X-Forwarded-For is believed, so list the proxy's own address
 * where it is fixed. Unset, empty or `false` turns it off (the default).
 *
 * Refused, because each lets a client choose its own address with one
 * header — a fresh rate-limit counter per request, or a private address for
 * the raised limit:
 *   - `true`, which trusts every hop;
 *   - a hop count. `1` trusts whatever connects to the socket, and the
 *     server listens on every interface by default, so a client that reaches
 *     the published port directly instead of through the proxy is trusted
 *     as if it were the proxy.
 *
 * @param {string|undefined} value - TRUST_PROXY as read from the environment
 * @returns {false|string[]} the value for app.set('trust proxy', …)
 * @throws {ConfigurationError} for `true`, a hop count and anything not
 *   listed above
 */
export function parseTrustProxy(value) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'false') return false;
  if (trimmed === 'true') {
    throw new ConfigurationError(
      'TRUST_PROXY=true would trust X-Forwarded-For from any client, so every client could choose ' +
      `its own address and rate limit. ${LIST_THE_PROXY}`,
    );
  }
  if (/^\d+$/.test(trimmed)) {
    throw new ConfigurationError(
      `TRUST_PROXY=${trimmed} is a hop count, which trusts whatever connects to dav-mcp: a client that ` +
      'reaches the port directly, not through the proxy, could choose its own address and rate limit. ' +
      LIST_THE_PROXY,
    );
  }

  const entries = trimmed.split(',').map(entry => entry.trim());
  const invalid = entries.filter(entry => !isAddressOrRange(entry));
  if (invalid.length > 0) {
    throw new ConfigurationError(
      `TRUST_PROXY has entries that are not a proxy address, CIDR range or loopback/linklocal/uniquelocal: ` +
      `${invalid.map(entry => `'${entry}'`).join(', ')}. ` +
      LIST_THE_PROXY,
    );
  }
  return entries;
}

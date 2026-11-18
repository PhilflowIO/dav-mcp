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
 * Accepted, as Express's 'trust proxy' takes them:
 *   - a number of hops: the client is that many entries back from the socket
 *     (1 for a single proxy). A count larger than the real number of proxies
 *     lets a client choose its address, so it has to match the deployment.
 *   - a comma-separated list of proxy addresses, CIDR ranges and the names
 *     loopback, linklocal and uniquelocal.
 * Unset, empty, `false` or `0` turns it off (the default).
 *
 * `true` is refused: it trusts every hop, so any client could set its own
 * address with one header, pick a fresh rate-limit counter per request and
 * claim a private address for the raised limit.
 *
 * @param {string|undefined} value - TRUST_PROXY as read from the environment
 * @returns {false|number|string[]} the value for app.set('trust proxy', …)
 * @throws {ConfigurationError} for `true` and for anything not listed above
 */
export function parseTrustProxy(value) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'false' || trimmed === '0') return false;
  if (trimmed === 'true') {
    throw new ConfigurationError(
      'TRUST_PROXY=true would trust X-Forwarded-For from any client, so every client could choose ' +
      'its own address and rate limit. Set the number of proxies in front of dav-mcp (TRUST_PROXY=1) ' +
      'or their addresses (TRUST_PROXY=10.0.0.2 or TRUST_PROXY=172.18.0.0/16).',
    );
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const entries = trimmed.split(',').map(entry => entry.trim());
  const invalid = entries.filter(entry => !isAddressOrRange(entry));
  if (invalid.length > 0) {
    throw new ConfigurationError(
      `TRUST_PROXY has entries that are not a proxy address, CIDR range or loopback/linklocal/uniquelocal: ` +
      `${invalid.map(entry => `'${entry}'`).join(', ')}. ` +
      'Use the number of proxies in front of dav-mcp (TRUST_PROXY=1) or a comma-separated list of their addresses.',
    );
  }
  return entries;
}

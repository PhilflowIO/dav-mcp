/**
 * Settings of the HTTP transport that are checked before it listens.
 *
 * Each of them decides who can reach the server or how it tells clients
 * apart, so a wrong value is a ConfigurationError: the server does not start
 * rather than serve with a setting the operator did not mean.
 */

import express from 'express';
import net from 'net';
import { ConfigurationError } from './auth-config.js';

export const MIN_BEARER_TOKEN_LENGTH = 32;

// Values the documentation has shown as examples. Anyone can read them, so a
// server that accepts one has no authentication. All are shorter than the
// minimum too; they are named so the error says what is wrong with them.
const PLACEHOLDER_TOKENS = new Set([
  'your-secure-token-here',
  'your-secret-token',
  'YOUR_BEARER_TOKEN',
]);

const HOW_TO_GENERATE = 'Generate one with `openssl rand -hex 32` and set it as BEARER_TOKEN.';

/**
 * @param {string|undefined} value - BEARER_TOKEN as read from the environment
 * @returns {string} the token
 * @throws {ConfigurationError} when the token is unset, contains whitespace,
 *   is a documented example value, or is shorter than MIN_BEARER_TOKEN_LENGTH
 *   characters
 */
export function checkBearerToken(value) {
  if (!value) {
    throw new ConfigurationError(
      `BEARER_TOKEN is not set; the HTTP transport refuses every request without it. ${HOW_TO_GENERATE}`,
    );
  }
  // Length alone would pass 32 spaces. Whitespace is also what a wrapped
  // line or a stray quote in an env file adds, and an Authorization header
  // cannot carry it reliably.
  if (/\s/.test(value)) {
    throw new ConfigurationError(
      `BEARER_TOKEN contains whitespace; a token is one unbroken string. ${HOW_TO_GENERATE}`,
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

// The widest raw CIDR range TRUST_PROXY takes. /8 is the largest block a
// proxy network plausibly needs (10.0.0.0/8, 127.0.0.0/8); /32 is the
// smallest IPv6 allocation a provider gets, so anything wider spans networks
// nobody runs proxies across. A wider range trusts so many peers that a
// client reaching the port directly is likely inside it. fc00::/7 is
// available as the name `uniquelocal`, not as a raw range.
export const MIN_IPV4_PREFIX = 8;
export const MIN_IPV6_PREFIX = 32;

// Express matches IPv4 peers against IPv6 ranges in their mapped form
// (::ffff:a.b.c.d), so an IPv6 range that reaches into ::ffff:0:0/96 is an
// IPv4 range of (prefix - 96) bits — ::/32 and ::ffff:0.0.0.0/96 both trust
// every IPv4 client.
const MAPPED_BLOCK = new net.BlockList();
MAPPED_BLOCK.addSubnet('::ffff:0.0.0.0', 96, 'ipv6');

// The IPv4 prefix length a range has for IPv4 peers, or undefined if it
// matches none
const ipv4PrefixOf = (address, family, prefix) => {
  if (family === 4) return prefix;
  if (prefix <= 96) {
    const range = new net.BlockList();
    range.addSubnet(address, prefix, 'ipv6');
    return range.check('::ffff:0.0.0.0', 'ipv6') ? 0 : undefined;
  }
  return MAPPED_BLOCK.check(address, 'ipv6') ? prefix - 96 : undefined;
};

// Why a range is too wide, or undefined if it is not
const tooWide = (entry) => {
  if (NAMED_RANGES.has(entry) || !entry.includes('/')) return undefined;
  const [address, prefixText] = entry.split('/');
  const family = net.isIP(address);
  const prefix = Number(prefixText);
  const ipv4Prefix = ipv4PrefixOf(address, family, prefix);
  if (ipv4Prefix !== undefined && ipv4Prefix < MIN_IPV4_PREFIX) {
    return family === 4
      ? `'${entry}' is wider than /${MIN_IPV4_PREFIX}`
      : `'${entry}' covers IPv4 clients as /${ipv4Prefix}, wider than /${MIN_IPV4_PREFIX}`;
  }
  if (family === 6 && ipv4Prefix === undefined && prefix < MIN_IPV6_PREFIX) {
    return `'${entry}' is wider than /${MIN_IPV6_PREFIX}`;
  }
  return undefined;
};

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
 *   - a range wider than /8 for IPv4 or /32 for IPv6, counting an IPv6 range
 *     that covers IPv4-mapped addresses as the IPv4 range it trusts;
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
  const wide = entries.map(tooWide).filter(Boolean);
  if (wide.length > 0) {
    throw new ConfigurationError(
      `TRUST_PROXY ranges must not be wider than /${MIN_IPV4_PREFIX} for IPv4 or /${MIN_IPV6_PREFIX} for IPv6: ` +
      `${wide.join('; ')}. A range that wide would trust clients that reach dav-mcp directly. ${LIST_THE_PROXY}`,
    );
  }
  // Compile the list the way the server will, with Express's own 'trust
  // proxy' compiler, so a value Express would reject is a configuration error
  // here and not an exception after startup.
  try {
    express().set('trust proxy', entries);
  } catch (error) {
    throw new ConfigurationError(`TRUST_PROXY is not accepted by Express: ${error.message}. ${LIST_THE_PROXY}`);
  }
  return entries;
}

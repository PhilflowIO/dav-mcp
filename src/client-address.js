/**
 * Which client addresses get the raised HTTP rate limit.
 *
 * The raised limit exists for clients that are part of the deployment: a
 * process on the same host, or another container on the same Docker network
 * (n8n next to dav-mcp in one compose file). Those are loopback and the
 * private IPv4 ranges of RFC 1918 — Docker's default bridge and compose
 * networks take theirs from 172.16.0.0/12 and 192.168.0.0/16, swarm overlays
 * and many custom networks from 10.0.0.0/8. None of them is routable on the
 * public internet, so a public client can never present one.
 *
 * The ranges are matched as numbers, not as string prefixes. The check used to
 * be `startsWith('::ffff:172.')`, which is all of 172.0.0.0/8: sixteen million
 * public addresses got the raised limit before the bearer-token check ran.
 * Issue #84.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// A dual-stack listener reports an IPv4 client as an IPv4-mapped IPv6 address
const MAPPED_PREFIX = /^::ffff:/i;

/**
 * @param {string|undefined} ip - client address as Express reports it (req.ip)
 * @returns {boolean} true for loopback and RFC 1918 addresses, in plain IPv4
 *   or IPv4-mapped IPv6 form; false for everything else, including anything
 *   that does not parse
 */
export function isLocalOrPrivateAddress(ip) {
  if (typeof ip !== 'string') return false;
  if (ip === '::1') return true;

  const match = IPV4.exec(ip.replace(MAPPED_PREFIX, ''));
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;

  return a === 127 ||                       // 127.0.0.0/8 loopback
    a === 10 ||                             // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||    // 172.16.0.0/12
    (a === 192 && b === 168);               // 192.168.0.0/16
}

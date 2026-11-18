import { describe, test, expect } from '@jest/globals';
import { getsRaisedRateLimit, isLocalOrPrivateAddress } from '../src/client-address.js';

// The HTTP rate limiter gives these addresses a 100x higher limit, before the
// bearer token is checked. A prefix match on "172." once handed that to all of
// 172.0.0.0/8, most of which is public (#84) — so the edges are spelled out.

const bothForms = (ip) => [ip, `::ffff:${ip}`];

describe('isLocalOrPrivateAddress', () => {
  test.each([
    '127.0.0.1', '127.255.255.254',
    '10.0.0.0', '10.255.255.255',
    '172.16.0.0', '172.17.0.1', '172.31.255.255',
    '192.168.0.0', '192.168.255.255',
  ].flatMap(bothForms))('%s is local or private', (ip) => {
    expect(isLocalOrPrivateAddress(ip)).toBe(true);
  });

  test('IPv6 loopback is local', () => {
    expect(isLocalOrPrivateAddress('::1')).toBe(true);
  });

  // n8n on a compose network with IPv6 enabled connects from a unique local
  // address; an IPv6 peer on the same link may use its link-local one.
  test.each([
    'fc00::', 'fd00::1', 'fd12:3456:789a:1::5', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::1', 'fe80::42:acff:fe11:2', 'febf:ffff::1', 'fe80::1%eth0',
    'FD00::1', 'FE80::1',
  ])('IPv6 %s is private', (ip) => {
    expect(isLocalOrPrivateAddress(ip)).toBe(true);
  });

  test.each([
    // either side of fc00::/7 and fe80::/10
    'fbff:ffff::1', 'fe00::1', 'fe7f:ffff::1', 'fec0::1',
    // public, unspecified, and the IPv4-mapped form of a public address
    '2001:db8::1', '2a00:1450:4001:80b::200e', '::', '::ffff:8.8.8.8',
    // mapped notation that is not dotted IPv4 must not reach the IPv6 rules
    '::ffff:fd00:1',
  ])('IPv6 %s is not', (ip) => {
    expect(isLocalOrPrivateAddress(ip)).toBe(false);
  });

  test.each([
    // either side of 172.16.0.0/12
    '172.15.255.255', '172.32.0.0',
    // public 172.x
    '172.0.0.1', '172.67.1.1', '172.217.16.14', '172.255.255.255',
    // either side of the other ranges
    '9.255.255.255', '11.0.0.0', '126.255.255.255', '128.0.0.1',
    '192.167.255.255', '192.169.0.0', '193.168.0.1',
    '8.8.8.8', '0.0.0.0',
  ].flatMap(bothForms))('%s is not', (ip) => {
    expect(isLocalOrPrivateAddress(ip)).toBe(false);
  });

  test.each([
    ['a public IPv6 address', '2001:db8::1'],
    ['an IPv6 address that merely contains a private-looking group', '2001:db8::172.16.0.1'],
    ['an octet out of range', '172.16.0.256'],
    ['a prefix of an address', '172.16.0'],
    ['trailing text', '10.0.0.1.example.com'],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('%s is not', (_, ip) => {
    expect(isLocalOrPrivateAddress(ip)).toBe(false);
  });
});

describe('getsRaisedRateLimit', () => {
  const request = (ip, headers = {}) => ({ ip, headers });
  const noProxy = () => false;
  // stands in for Express's compiled check of TRUST_PROXY=172.18.0.2
  const proxyAt = (address) => (ip) => ip === address || ip === `::ffff:${address}`;

  test('a private client that connects directly gets it, with or without TRUST_PROXY', () => {
    expect(getsRaisedRateLimit(request('::ffff:172.18.0.5'), false, noProxy)).toBe(true);
    expect(getsRaisedRateLimit(request('::ffff:172.18.0.5'), ['172.18.0.2'], proxyAt('172.18.0.2'))).toBe(true);
  });

  test('a public client does not', () => {
    expect(getsRaisedRateLimit(request('203.0.113.7'), false, noProxy)).toBe(false);
    expect(getsRaisedRateLimit(request('203.0.113.7'), ['172.18.0.2'], proxyAt('172.18.0.2'))).toBe(false);
  });

  // Behind a reverse proxy without TRUST_PROXY, req.ip is the proxy's private
  // address for every client; handing that the raised limit gave it to the
  // whole internet (#177).
  test.each([
    ['X-Forwarded-For', { 'x-forwarded-for': '203.0.113.7' }],
    ['Forwarded', { forwarded: 'for=203.0.113.7' }],
  ])('a forwarded request without TRUST_PROXY does not: its %s address is a proxy\'s', (_, headers) => {
    expect(getsRaisedRateLimit(request('::ffff:172.18.0.2', headers), false, noProxy)).toBe(false);
  });

  test('with TRUST_PROXY the client Express resolved decides', () => {
    const trusted = ['172.18.0.2'];
    // req.ip is what Express took from X-Forwarded-For over the trusted proxy
    expect(getsRaisedRateLimit(request('10.0.0.5', { 'x-forwarded-for': '10.0.0.5' }), trusted, proxyAt('172.18.0.2')))
      .toBe(true);
    expect(getsRaisedRateLimit(request('203.0.113.7', { 'x-forwarded-for': '203.0.113.7' }), trusted, proxyAt('172.18.0.2')))
      .toBe(false);
  });

  // A trusted proxy that sends no X-Forwarded-For, or only Forwarded (which
  // Express does not read), leaves req.ip at the proxy's own private address.
  test.each([
    ['no forwarding header', {}],
    ['only Forwarded', { forwarded: 'for=203.0.113.7' }],
  ])('with TRUST_PROXY, the trusted proxy\'s own address does not get it (%s)', (_, headers) => {
    expect(getsRaisedRateLimit(request('::ffff:172.18.0.2', headers), ['172.18.0.2'], proxyAt('172.18.0.2')))
      .toBe(false);
  });
});

import { describe, test, expect } from '@jest/globals';
import { isLocalOrPrivateAddress } from '../src/client-address.js';

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

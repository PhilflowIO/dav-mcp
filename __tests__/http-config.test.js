import { describe, test, expect } from '@jest/globals';
import {
  checkBearerToken, MIN_BEARER_TOKEN_LENGTH, parseListenHost, parseTrustProxy,
} from '../src/http-config.js';

describe('checkBearerToken', () => {
  test.each([
    ['unset', undefined, /not set/],
    ['empty', '', /not set/],
    ['the .env.example placeholder', 'your-secure-token-here', /example value/],
    ['the README example', 'your-secret-token', /example value/],
    ['the MIGRATION.md example', 'YOUR_BEARER_TOKEN', /example value/],
    ['one character short', 'x'.repeat(MIN_BEARER_TOKEN_LENGTH - 1), /has 31 characters; at least 32/],
    ['32 spaces', ' '.repeat(32), /contains whitespace/],
    ['a token with a space inside', `${'a'.repeat(20)} ${'b'.repeat(20)}`, /contains whitespace/],
    ['a token with a trailing newline', `${'f'.repeat(64)}\n`, /contains whitespace/],
  ])('refuses %s, and says how to generate a token', (_, value, reason) => {
    let error;
    try {
      checkBearerToken(value);
    } catch (e) {
      error = e;
    }
    expect(error?.name).toBe('ConfigurationError');
    expect(error.message).toMatch(reason);
    expect(error.message).toContain('openssl rand -hex 32');
  });

  test('accepts 32 characters, the length of 16 random bytes in hex', () => {
    expect(MIN_BEARER_TOKEN_LENGTH).toBe(32);
    const token = 'x'.repeat(32);
    expect(checkBearerToken(token)).toBe(token);
  });

  test('accepts what `openssl rand -hex 32` prints', () => {
    const token = 'f'.repeat(64);
    expect(checkBearerToken(token)).toBe(token);
  });
});

describe('parseListenHost', () => {
  test.each([undefined, ''])('%p leaves the choice to Node: every interface', (value) => {
    expect(parseListenHost(value)).toBeUndefined();
  });

  test.each(['127.0.0.1', '0.0.0.0', '192.168.1.20', '::1', '::', 'localhost'])('accepts %s', (value) => {
    expect(parseListenHost(value)).toBe(value);
  });

  test.each([
    ['a machine name as tcsh exports it', 'workstation'],
    ['a domain name', 'dav.example.com'],
    ['an address with a port', '127.0.0.1:3000'],
    ['a bracketed IPv6 address', '[::1]'],
  ])('refuses %s', (_, value) => {
    expect(() => parseListenHost(value)).toThrow(/HOST must be an IP address or localhost/);
  });
});

describe('parseTrustProxy', () => {
  test.each([undefined, '', ' ', 'false'])('%p trusts no proxy', (value) => {
    expect(parseTrustProxy(value)).toBe(false);
  });

  // TRUST_PROXY=1 trusts whatever connects to the socket: a client reaching
  // the published port directly would be taken for the proxy (#177 review).
  test.each(['0', '1', '2'])('the hop count %s is refused and the message says to list the proxy', (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/is a hop count.*TRUST_PROXY=172\.18\.0\.2.*docker network inspect/s);
  });

  test.each([
    ['10.0.0.2', ['10.0.0.2']],
    ['172.18.0.0/16', ['172.18.0.0/16']],
    ['loopback', ['loopback']],
    ['loopback, uniquelocal,linklocal', ['loopback', 'uniquelocal', 'linklocal']],
    ['::1, fd00:1::/48, 192.168.1.1/32', ['::1', 'fd00:1::/48', '192.168.1.1/32']],
    ['10.0.0.0/8', ['10.0.0.0/8']],
    ['2001:db8::/32', ['2001:db8::/32']],
    ['::ffff:10.0.0.0/104', ['::ffff:10.0.0.0/104']],
    ['::ffff:172.18.0.2', ['::ffff:172.18.0.2']],
  ])('%s is a list of proxies', (value, list) => {
    expect(parseTrustProxy(value)).toEqual(list);
  });

  // A range that wide trusts clients that reach the port directly, which
  // reopens the hop-count hole by configuration (#177 re-review).
  test.each([
    ['all of IPv4', '0.0.0.0/0', "'0.0.0.0/0' is wider than /8"],
    ['one bit wider than /8', '10.0.0.0/7', "'10.0.0.0/7' is wider than /8"],
    ['all of IPv6', '::/0', "'::/0' covers IPv4 clients as /0"],
    ['all of IPv4 in mapped form', '::ffff:0.0.0.0/96', "'::ffff:0.0.0.0/96' covers IPv4 clients as /0"],
    ['a mapped range wider than /8', '::ffff:10.0.0.0/103', "'::ffff:10.0.0.0/103' covers IPv4 clients as /7"],
    ['an IPv6 /32 that holds the mapped block', '::/32', "'::/32' covers IPv4 clients as /0"],
    ['one bit wider than /32', '2001:db8::/31', "'2001:db8::/31' is wider than /32"],
    ['unique local as a raw range', 'fc00::/7', "'fc00::/7' is wider than /32"],
    ['a wide entry among narrow ones', '172.18.0.2, 0.0.0.0/1', "'0.0.0.0/1' is wider than /8"],
  ])('refuses %s', (_, value, reason) => {
    let error;
    try {
      parseTrustProxy(value);
    } catch (e) {
      error = e;
    }
    expect(error?.name).toBe('ConfigurationError');
    expect(error.message).toContain(reason);
    expect(error.message).toContain('TRUST_PROXY=172.18.0.2');
  });

  test('true is refused: it would let every client choose its address', () => {
    expect(() => parseTrustProxy('true')).toThrow(/any client.*TRUST_PROXY=172\.18\.0\.2/s);
  });

  test.each([
    ['a host name', 'proxy.internal', "'proxy.internal'"],
    ['a prefix too long for IPv4', '10.0.0.0/33', "'10.0.0.0/33'"],
    ['a prefix that is not a number', '10.0.0.0/8a', "'10.0.0.0/8a'"],
    ['an empty entry', '10.0.0.2,', "''"],
    ['a negative hop count', '-1', "'-1'"],
  ])('refuses %s and names the entry', (_, value, named) => {
    let error;
    try {
      parseTrustProxy(value);
    } catch (e) {
      error = e;
    }
    expect(error?.name).toBe('ConfigurationError');
    expect(error.message).toContain(named);
  });
});

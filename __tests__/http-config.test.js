import { describe, test, expect } from '@jest/globals';
import { checkBearerToken, MIN_BEARER_TOKEN_LENGTH, parseListenHost } from '../src/http-config.js';

describe('checkBearerToken', () => {
  test.each([
    ['unset', undefined, /not set/],
    ['empty', '', /not set/],
    ['the .env.example placeholder', 'your-secure-token-here', /example value/],
    ['the README example', 'your-secret-token', /example value/],
    ['the MIGRATION.md example', 'YOUR_BEARER_TOKEN', /example value/],
    ['one character short', 'x'.repeat(MIN_BEARER_TOKEN_LENGTH - 1), /has 31 characters; at least 32/],
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

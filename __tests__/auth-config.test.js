import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// AUTH_METHOD used to be compared case-sensitively against 'OAuth'/'Oauth' in
// each transport, so 'oauth2' (what server.json documented) silently ran Basic,
// and there was no way to ask for Digest (#74). Both transports now read it
// through auth-config.js; the manager hands the method on to tsdav.

const constructed = [];
jest.unstable_mockModule('tsdav', () => ({
  DAVClient: class {
    constructor(options) {
      constructed.push(options);
    }
    async login() {}
  },
}));

const { parseAuthMethod, buildTsdavConfig } = await import('../src/auth-config.js');
const { tsdavManager } = await import('../src/tsdav-client.js');

const PASSWORD_ENV = {
  CALDAV_SERVER_URL: 'https://dav.example.com/',
  CALDAV_USERNAME: 'user',
  CALDAV_PASSWORD: 'pass',
};

const OAUTH_ENV = {
  GOOGLE_USER: 'user@example.com',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};

describe('parseAuthMethod', () => {
  test.each([
    [undefined, 'Basic'],
    ['', 'Basic'],
    ['  ', 'Basic'],
    ['Basic', 'Basic'],
    ['basic', 'Basic'],
    ['Digest', 'Digest'],
    ['digest', 'Digest'],
    [' DIGEST ', 'Digest'],
    ['OAuth', 'OAuth'],
    ['Oauth', 'OAuth'],
    ['oauth2', 'OAuth'],
    ['OAuth2', 'OAuth'],
    // Docker --env-file keeps the quotes of AUTH_METHOD="Basic"
    ['"Basic"', 'Basic'],
    ["'digest'", 'Digest'],
    [' "OAuth2" ', 'OAuth'],
    ['" Basic "', 'Basic'],
    ['""', 'Basic'],
  ])('%p -> %s', (value, expected) => {
    expect(parseAuthMethod(value)).toBe(expected);
  });

  test('rejects an unknown method instead of falling back to Basic', () => {
    expect(() => parseAuthMethod('Bearer')).toThrow("Unsupported AUTH_METHOD 'Bearer'");
    expect(() => parseAuthMethod('digets')).toThrow('Valid values: Basic (default), Digest, OAuth (or OAuth2).');
    expect(() => parseAuthMethod('"Bearer"')).toThrow("Unsupported AUTH_METHOD '\"Bearer\"'");
    // only a matching pair of quotes is removed
    expect(() => parseAuthMethod('"Basic')).toThrow('Unsupported AUTH_METHOD');
  });
});

describe('buildTsdavConfig', () => {
  test('defaults to Basic with the CALDAV_* credentials', () => {
    expect(buildTsdavConfig(PASSWORD_ENV)).toEqual({
      serverUrl: 'https://dav.example.com/',
      authMethod: 'Basic',
      username: 'user',
      password: 'pass',
    });
  });

  test('AUTH_METHOD=digest uses the CALDAV_* credentials with Digest', () => {
    expect(buildTsdavConfig({ ...PASSWORD_ENV, AUTH_METHOD: 'digest' })).toEqual({
      serverUrl: 'https://dav.example.com/',
      authMethod: 'Digest',
      username: 'user',
      password: 'pass',
    });
  });

  test('Digest needs the same credentials as Basic', () => {
    const { CALDAV_PASSWORD, ...withoutPassword } = PASSWORD_ENV;
    expect(() => buildTsdavConfig({ ...withoutPassword, AUTH_METHOD: 'Digest' }))
      .toThrow('Digest Auth requires CALDAV_SERVER_URL, CALDAV_USERNAME, and CALDAV_PASSWORD');
  });

  test('AUTH_METHOD=oauth2 selects OAuth with Google defaults', () => {
    expect(buildTsdavConfig({ ...OAUTH_ENV, AUTH_METHOD: 'oauth2' })).toEqual({
      serverUrl: 'https://apidata.googleusercontent.com/caldav/v2/',
      authMethod: 'OAuth',
      username: 'user@example.com',
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      tokenUrl: 'https://accounts.google.com/o/oauth2/token',
    });
  });

  test('OAuth requires the Google client credentials', () => {
    expect(() => buildTsdavConfig({ AUTH_METHOD: 'OAuth', GOOGLE_USER: 'u' }))
      .toThrow('OAuth2 requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN');
  });
});

describe('tsdavManager.initialize', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  test.each(['Basic', 'Digest'])('creates both clients with authMethod %s', async (method) => {
    await tsdavManager.initialize(buildTsdavConfig({ ...PASSWORD_ENV, AUTH_METHOD: method }));

    expect(constructed).toHaveLength(2);
    for (const options of constructed) {
      expect(options.authMethod).toBe(method);
      expect(options.credentials).toEqual({ username: 'user', password: 'pass' });
    }
    expect(constructed.map((o) => o.defaultAccountType)).toEqual(['caldav', 'carddav']);
  });

  test('passes OAuth to tsdav as Oauth', async () => {
    await tsdavManager.initialize(buildTsdavConfig({ ...OAUTH_ENV, AUTH_METHOD: 'OAuth' }));

    expect(constructed.map((o) => o.authMethod)).toEqual(['Oauth', 'Oauth']);
  });

  test('rejects an unknown authMethod', async () => {
    await expect(tsdavManager.initialize({ ...PASSWORD_ENV, authMethod: 'Bearer' }))
      .rejects.toThrow("Unsupported authMethod 'Bearer'");
    expect(constructed).toHaveLength(0);
  });
});

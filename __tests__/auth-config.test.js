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
  isDAVAuthenticationError: () => false,
  isDAVResponseError: () => false,
}));

const logged = [];
const record = (level) => (fields, message) => logged.push({ level, fields, message });
jest.unstable_mockModule('../src/logger.js', () => ({
  logger: { info: record('info'), debug: record('debug'), warn: record('warn'), error: record('error') },
}));

const { parseAuthMethod, buildTsdavConfig, ConfigurationError } = await import('../src/auth-config.js');
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
    expect(() => parseAuthMethod('Bearer')).toThrow(ConfigurationError);
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
      cardDav: {
        serverUrl: 'https://dav.example.com/',
        username: 'user',
        password: 'pass',
      },
    });
  });

  test('AUTH_METHOD=digest uses the CALDAV_* credentials with Digest', () => {
    expect(buildTsdavConfig({ ...PASSWORD_ENV, AUTH_METHOD: 'digest' })).toEqual({
      serverUrl: 'https://dav.example.com/',
      authMethod: 'Digest',
      username: 'user',
      password: 'pass',
      cardDav: {
        serverUrl: 'https://dav.example.com/',
        username: 'user',
        password: 'pass',
      },
    });
  });

  test('Digest needs the same credentials as Basic', () => {
    const { CALDAV_PASSWORD, ...withoutPassword } = PASSWORD_ENV;
    expect(() => buildTsdavConfig({ ...withoutPassword, AUTH_METHOD: 'Digest' }))
      .toThrow('Digest Auth requires CALDAV_SERVER_URL, CALDAV_USERNAME, and CALDAV_PASSWORD');
  });

  describe('a separate CardDAV endpoint', () => {
    const splitEnv = {
      ...PASSWORD_ENV,
      CARDDAV_SERVER_URL: 'https://card.example.com/',
      CARDDAV_USERNAME: 'contacts',
      CARDDAV_PASSWORD: 'other-pass',
    };

    test('CARDDAV_* overrides all three values for the contacts client', () => {
      expect(buildTsdavConfig(splitEnv)).toEqual({
        serverUrl: 'https://dav.example.com/',
        authMethod: 'Basic',
        username: 'user',
        password: 'pass',
        cardDav: {
          serverUrl: 'https://card.example.com/',
          username: 'contacts',
          password: 'other-pass',
        },
      });
    });

    test('each value falls back to its CALDAV_* counterpart on its own', () => {
      const { serverUrl, username, password } = buildTsdavConfig({
        ...PASSWORD_ENV,
        CARDDAV_SERVER_URL: 'https://card.example.com/',
      }).cardDav;
      expect(serverUrl).toBe('https://card.example.com/');
      expect(username).toBe('user');
      expect(password).toBe('pass');
    });

    test('an empty value counts as unset, so blank user-config fields fall back', () => {
      const { serverUrl, username, password } = buildTsdavConfig({
        ...splitEnv,
        CARDDAV_SERVER_URL: '',
        CARDDAV_PASSWORD: '',
      }).cardDav;
      expect(serverUrl).toBe('https://dav.example.com/');
      expect(username).toBe('contacts');
      expect(password).toBe('pass');
    });

    test('a whitespace-only URL counts as unset, not as an endpoint of its own', () => {
      const { serverUrl } = buildTsdavConfig({ ...PASSWORD_ENV, CARDDAV_SERVER_URL: '   ' }).cardDav;
      expect(serverUrl).toBe('https://dav.example.com/');
    });

    test('OAuth ignores CARDDAV_*: Google has one server', () => {
      const config = buildTsdavConfig({ ...OAUTH_ENV, ...splitEnv, AUTH_METHOD: 'OAuth' });
      expect(config).not.toHaveProperty('cardDav');
    });
  });

  test('AUTH_METHOD=oauth2 selects OAuth with Google defaults', () => {
    expect(buildTsdavConfig({ ...OAUTH_ENV, AUTH_METHOD: 'oauth2' })).toEqual({
      serverUrl: 'https://apidata.googleusercontent.com/caldav/v2/',
      authMethod: 'OAuth',
      username: 'user@example.com',
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      tokenUrl: 'https://oauth2.googleapis.com/token',
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

  test('with a split configuration the contacts client logs onto its own endpoint', async () => {
    await tsdavManager.initialize(buildTsdavConfig({
      ...PASSWORD_ENV,
      AUTH_METHOD: 'Digest',
      CARDDAV_SERVER_URL: 'https://card.example.com/',
      CARDDAV_USERNAME: 'contacts',
      CARDDAV_PASSWORD: 'other-pass',
    }));

    expect(constructed).toHaveLength(2);
    expect(constructed[0]).toMatchObject({
      serverUrl: 'https://dav.example.com/',
      credentials: { username: 'user', password: 'pass' },
      defaultAccountType: 'caldav',
    });
    expect(constructed[1]).toMatchObject({
      serverUrl: 'https://card.example.com/',
      credentials: { username: 'contacts', password: 'other-pass' },
      defaultAccountType: 'carddav',
    });
  });

  test('the logs name the CardDAV endpoint only when it differs', async () => {
    logged.length = 0;
    await tsdavManager.initialize(buildTsdavConfig(PASSWORD_ENV));
    let done = logged.find(entry => entry.message === 'tsdav clients initialized and logged in');
    expect(done.fields).not.toHaveProperty('cardDavServerUrl');
    // one endpoint serving both services is one shared policy
    let restricted = logged.find(entry => entry.message === 'Requests are restricted to these URLs and below');
    expect(restricted.fields.allowedPrefixes).toEqual(['https://dav.example.com/']);

    logged.length = 0;
    await tsdavManager.initialize(buildTsdavConfig({
      ...PASSWORD_ENV,
      CARDDAV_SERVER_URL: 'https://card.example.com/',
    }));
    done = logged.find(entry => entry.message === 'tsdav clients initialized and logged in');
    expect(done.fields.cardDavServerUrl).toBe('https://card.example.com/');
    restricted = logged.find(entry => entry.message === 'Requests are restricted to these URLs and below');
    expect(restricted.fields.allowedPrefixes).toEqual(['https://dav.example.com/', 'https://card.example.com/']);
  });

  test('logs the method as configured, since Basic may end up as Digest on the wire', async () => {
    logged.length = 0;
    await tsdavManager.initialize(buildTsdavConfig(PASSWORD_ENV));

    const done = logged.find(entry => entry.message === 'tsdav clients initialized and logged in');
    expect(done.fields).toMatchObject({ configuredAuthMethod: 'Basic' });
    expect(done.fields.note).toMatch(/Digest is used instead if the server only offers Digest/);
    expect(done.fields).not.toHaveProperty('authMethod');
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

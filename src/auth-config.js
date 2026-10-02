/**
 * Authentication configuration from the environment
 *
 * Both transports (stdio and HTTP) build the tsdav client configuration here,
 * so AUTH_METHOD means the same thing everywhere.
 *
 * AUTH_METHOD (case-insensitive):
 *   - Basic (default): username + password. Also works against servers that
 *     only offer Digest — tsdav switches to Digest when a 401 offers only Digest,
 *     after the first request has carried the password Basic-encoded.
 *   - Digest: username + password, answered only as Digest (RFC 7616); the
 *     password itself never goes over the wire.
 *     Needs WebCrypto (Node.js 20 or newer).
 *   - OAuth (alias OAuth2): Google Calendar and other OAuth2 CalDAV servers.
 */

const AUTH_METHODS = {
  basic: 'Basic',
  digest: 'Digest',
  oauth: 'OAuth',
  oauth2: 'OAuth',
};

const DEFAULT_GOOGLE_SERVER_URL = 'https://apidata.googleusercontent.com/caldav/v2/';
const DEFAULT_GOOGLE_TOKEN_URL = 'https://accounts.google.com/o/oauth2/token';

/**
 * Normalize an AUTH_METHOD value to 'Basic', 'Digest' or 'OAuth'.
 * An unknown value is an error rather than a silent fallback to Basic, so a
 * typo does not send the password with a scheme the user did not ask for.
 *
 * @param {string|undefined} value - Raw AUTH_METHOD value
 * @returns {'Basic'|'Digest'|'OAuth'}
 */
export function parseAuthMethod(value) {
  const key = (value ?? '').trim().toLowerCase();
  if (key === '') {
    return 'Basic';
  }
  const method = AUTH_METHODS[key];
  if (!method) {
    throw new Error(`Unsupported AUTH_METHOD '${value}'. Use Basic (default), Digest or OAuth.`);
  }
  return method;
}

/**
 * Build the configuration for tsdavManager.initialize() from the environment.
 *
 * @param {Object} env - Environment variables (usually process.env)
 * @returns {Object} tsdav client configuration
 */
export function buildTsdavConfig(env) {
  const authMethod = parseAuthMethod(env.AUTH_METHOD);

  if (authMethod === 'OAuth') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
      throw new Error('OAuth2 requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN');
    }
    return {
      serverUrl: env.GOOGLE_SERVER_URL || DEFAULT_GOOGLE_SERVER_URL,
      authMethod,
      username: env.GOOGLE_USER,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      tokenUrl: env.GOOGLE_TOKEN_URL || DEFAULT_GOOGLE_TOKEN_URL,
    };
  }

  if (!env.CALDAV_SERVER_URL || !env.CALDAV_USERNAME || !env.CALDAV_PASSWORD) {
    throw new Error(`${authMethod} Auth requires CALDAV_SERVER_URL, CALDAV_USERNAME, and CALDAV_PASSWORD`);
  }
  return {
    serverUrl: env.CALDAV_SERVER_URL,
    authMethod,
    username: env.CALDAV_USERNAME,
    password: env.CALDAV_PASSWORD,
  };
}

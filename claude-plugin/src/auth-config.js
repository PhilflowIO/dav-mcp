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
 *   - OAuth (alias OAuth2): Google Calendar and other OAuth2 CalDAV servers.
 */

/**
 * The configuration itself is wrong (unknown AUTH_METHOD, missing
 * credentials). Unlike an unreachable server this cannot heal by waiting, so
 * both transports stop at startup instead of retrying on the first tool call.
 */
export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Where the user changes the settings a failed login depends on.
 *
 * dav-mcp only sees environment variables, and the three ways it is started
 * fill them from three different places: the Claude Code plugin from its
 * plugin options, the Claude Desktop extension (MCP bundle) from its
 * extension settings, npx, Docker or a checkout from the MCP client's config,
 * `docker -e` or the checkout's .env file. Nothing tells the server which one
 * started it, so the hint names all of them rather than guess (#123). OAuth
 * is only set up through environment variables; the plugin and the extension
 * offer no OAuth settings.
 *
 * @param {'Basic'|'Digest'|'OAuth'} [authMethod] - the configured method
 * @returns {string} one sentence, to append to an error message
 */
export function settingsHint(authMethod) {
  if (authMethod === 'OAuth') {
    return 'Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_USER and ' +
      'GOOGLE_SERVER_URL in the environment dav-mcp is started with ' +
      '(the MCP client\'s config, docker -e, or .env in a checkout).';
  }
  return 'Check the server URL, username and password where dav-mcp was set up: ' +
    'Claude Code plugin: /plugin → Installed → dav-mcp → Configure options; ' +
    'Claude Desktop extension: Settings → Extensions → dav-mcp: Calendars, Contacts & Tasks; ' +
    'npx, Docker or a checkout: CALDAV_SERVER_URL, CALDAV_USERNAME and CALDAV_PASSWORD ' +
    '(the MCP client\'s config, docker -e, or .env).';
}

/**
 * The authentication method the server was started with, for a hint given
 * after startup; undefined if AUTH_METHOD is not readable (the server would
 * not have started then).
 *
 * @param {Object} [env] - Environment variables
 * @returns {'Basic'|'Digest'|'OAuth'|undefined}
 */
export function configuredAuthMethod(env = process.env) {
  try {
    return parseAuthMethod(env.AUTH_METHOD);
  } catch {
    return undefined;
  }
}

const AUTH_METHODS = {
  basic: 'Basic',
  digest: 'Digest',
  oauth: 'OAuth',
  oauth2: 'OAuth',
};

const DEFAULT_GOOGLE_SERVER_URL = 'https://apidata.googleusercontent.com/caldav/v2/';
const DEFAULT_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Normalize an AUTH_METHOD value to 'Basic', 'Digest' or 'OAuth'.
 *
 * Surrounding whitespace and one pair of quotes are ignored: a Docker
 * --env-file passes `AUTH_METHOD="Basic"` on with the quotes, and that is
 * plainly Basic. An unknown value is an error rather than a silent fallback to
 * Basic, so a typo does not send the password with a scheme the user did not
 * ask for.
 *
 * @param {string|undefined} value - Raw AUTH_METHOD value
 * @returns {'Basic'|'Digest'|'OAuth'}
 */
export function parseAuthMethod(value) {
  const key = String(value ?? '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim()
    .toLowerCase();
  if (key === '') {
    return 'Basic';
  }
  const method = AUTH_METHODS[key];
  if (!method) {
    throw new ConfigurationError(
      `Unsupported AUTH_METHOD '${value}'. Valid values: Basic (default), Digest, OAuth (or OAuth2).`
    );
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
      throw new ConfigurationError('OAuth2 requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN');
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
    throw new ConfigurationError(`${authMethod} Auth requires CALDAV_SERVER_URL, CALDAV_USERNAME, and CALDAV_PASSWORD`);
  }
  return {
    serverUrl: env.CALDAV_SERVER_URL,
    authMethod,
    username: env.CALDAV_USERNAME,
    password: env.CALDAV_PASSWORD,
  };
}

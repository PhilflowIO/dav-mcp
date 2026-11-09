import { DAVClient, isDAVAuthenticationError, isDAVResponseError } from 'tsdav';
import { logger } from './logger.js';
import { CalDAVError, CardDAVError, AuthenticationError, MCP_ERROR_CODES, codeForHttpStatus } from './error-handler.js';
import { ConfigurationError, settingsHint } from './auth-config.js';
import { RequestOrigins, activateRequestOrigins } from './request-origins.js';

const DEFAULT_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * A tsdav client that only reaches URLs inside the account (see
 * request-origins.js). Every request tsdav makes goes through the fetch given
 * here; a fetch passed to a single call is wrapped as well, so passing one
 * does not open a way around the check. OAuth token requests get a fetch of
 * their own that reaches the token endpoint and nothing else.
 */
class OriginCheckedDAVClient extends DAVClient {
  constructor(params, origins, answers) {
    super({ ...params, fetch: answers.watch(origins.fetch()) });
    this.requestOrigins = origins;
    this.answers = answers;
  }

  #checked(params, options) {
    if (!options && (!params?.fetch || this.requestOrigins.checks(params.fetch))) return params;
    return { ...params, fetch: this.requestOrigins.fetch(params?.fetch, options) };
  }

  // tsdav fetches OAuth tokens with the fetch it is handed here; whatever a
  // caller passes, token requests only go to the token endpoint.
  async authenticate(force, fetchOptions) {
    return super.authenticate(force, fetchOptions,
      this.answers.watch(this.requestOrigins.tokenFetch()));
  }

  async invoke(fn, params) {
    return super.invoke(fn, this.#checked(params));
  }

  async davRequest(params) {
    return super.davRequest(this.#checked(params));
  }

  async createAccount(params) {
    return super.createAccount(this.#checked(params));
  }

  // A server may list a collection somewhere other than below its home;
  // tsdav asks each listed collection for its reports while still listing,
  // so the collections in the home listing have to be known before the
  // listing call returns.
  //
  // projectedProps keeps each calendar's calendar-timezone as the server sent
  // it: tsdav up to 2.4 drops it from `timezone` when it arrives as CDATA, and
  // src/calendar-zone.js reads this raw value for every tool alike.
  async fetchCalendars(params) {
    const projected = { ...params, projectedProps: { calendarTimezone: true, ...params?.projectedProps } };
    return super.fetchCalendars(this.#checked(projected, { listingOf: this.account?.homeUrl }));
  }

  async fetchAddressBooks(params) {
    return super.fetchAddressBooks(this.#checked(params, { listingOf: this.account?.homeUrl }));
  }
}

/**
 * Whether a login got any answer at all, to tell a server that cannot be
 * reached from one that answered but not as a DAV server. Whether the
 * credentials were refused is not read here: tsdav tries several URLs and the
 * last answer need not be the refusal (Baïkal answers 401 on /dav.php/, then
 * 405 on the server root); the error tsdav throws says so itself.
 */
class LoginAnswers {
  constructor() {
    this.answered = false;
  }

  /**
   * @param {Function} fetchFn - the fetch to watch
   * @returns {Function} a fetch that notes that an answer came
   */
  watch(fetchFn) {
    return async (input, init) => {
      const response = await fetchFn(input, init);
      this.answered = true;
      return response;
    };
  }
}

/**
 * A failed client login, wrapped with the service that failed: initialize()
 * reports its endpoint and reads its own login answers. With a separate
 * CardDAV URL the two services have different endpoints, and whether "the
 * server answered at all" is a per-endpoint fact.
 */
class LoginFailure {
  /**
   * @param {Error} cause - what the login threw
   * @param {string} label - 'CalDAV client' or 'CardDAV client'
   * @param {string} serverUrl - the endpoint this client logged onto
   * @param {LoginAnswers} answers - this client's own login answers
   */
  constructor(cause, label, serverUrl, answers) {
    this.cause = cause;
    this.label = label;
    this.serverUrl = serverUrl;
    this.answers = answers;
  }
}

/**
 * The code of a login answered with an error status other than 401. During
 * login dav-mcp only asks the configured URL for its DAV account, so a 405
 * (no PROPFIND there), a 404 or another 4xx means the server URL does not
 * lead to a DAV server: dav-mcp's configuration, not a malformed request
 * (405 is INVALID_REQUEST for a tool call). 401 (refused), 403, 408, 429 and
 * 5xx keep their meaning.
 */
function loginStatusCode(status) {
  if (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)) {
    return MCP_ERROR_CODES.CONFIGURATION_ERROR;
  }
  return codeForHttpStatus(status);
}

/**
 * The error a failed login is reported as. Every one of them is fixed where
 * dav-mcp's settings are kept, so each names that place (#123); the code says
 * which kind of failure it was, instead of leaving it to the message.
 *
 * @param {Error} cause - what tsdav threw
 * @param {object} config - the configuration the login used, tokenUrl resolved
 * @param {LoginAnswers} answers - whether the server answered at all
 * @param {string} [label] - which client failed ('CalDAV client' or
 *   'CardDAV client'); given when the two log onto different endpoints, so a
 *   CardDAV failure is not read as a calendar one
 * @returns {Error}
 */
function loginError(cause, config, answers, label) {
  const hint = settingsHint(config.authMethod);
  const refused = isDAVAuthenticationError(cause);
  // An error status tsdav reports (@philflow/tsdav 2.5.0): its message alone
  // ("cannot find principalUrl", "no access token") does not say which.
  const status = isDAVResponseError(cause) && Number.isInteger(cause.status) ? cause.status : undefined;
  // A refused DAV login already says "returned 401"; tsdav's other messages
  // ("cannot find principalUrl", "no access token") name no status.
  const answeredBy = status === undefined ? ''
    : cause.url === config.tokenUrl ? ` (the token endpoint answered ${status})`
      : refused ? '' : ` (the server answered ${status})`;
  const code = Number.isInteger(cause.code) ? cause.code
    : status !== undefined ? loginStatusCode(status)
      : answers.answered ? MCP_ERROR_CODES.CONFIGURATION_ERROR
        : MCP_ERROR_CODES.NETWORK_ERROR;
  const notDav = !refused && code === MCP_ERROR_CODES.CONFIGURATION_ERROR
    ? `The server URL does not lead to a CalDAV/CardDAV server. ` : '';
  const message = `Login to ${config.serverUrl} failed${label ? ` (${label})` : ''}: ` +
    `${String(cause.message).replace(/\.$/, '')}${answeredBy}. ${notDav}${hint}`;

  if (refused) {
    return new AuthenticationError(message, {
      serverUrl: config.serverUrl,
      ...(label && { service: label }),
      status,
      url: cause.url,
    });
  }
  const error = new Error(message, { cause });
  // A typed error (a redirect off the server, say) keeps its code; a status
  // says what kind of failure it was (403 forbidden, 429 rate limited, ...).
  error.code = code;
  error.details = {
    serverUrl: config.serverUrl,
    ...(label && { service: label }),
    ...(status !== undefined && { status, url: cause.url }),
  };
  return error;
}

/**
 * Singleton CalDAV/CardDAV Client Manager
 *
 * Supports Basic, Digest and OAuth2 authentication:
 * - Basic Auth: Standard CalDAV servers (Radicale, Baikal, Nextcloud). tsdav
 *   switches to Digest by itself when a server's 401 offers only Digest.
 * - Digest Auth: Servers that only accept Digest (RFC 7616); the password is
 *   never sent, not even once.
 * - OAuth2: Google Calendar and other OAuth2-enabled CalDAV servers
 */
class TsdavClientManager {
  constructor() {
    this.calDavClient = null;
    this.cardDavClient = null;
    this.config = null;
    this.authMethod = null;
  }

  /**
   * Initialize clients with configuration
   *
   * @param {Object} config - Client configuration
   * @param {string} config.serverUrl - CalDAV/CardDAV server URL
   * @param {string} config.authMethod - 'Basic', 'Digest' or 'OAuth' (note: tsdav uses 'Oauth')
   *
   * For Basic and Digest Auth:
   * @param {string} config.username - Username
   * @param {string} config.password - Password
   * @param {Object} [config.cardDav] - a separate CardDAV endpoint (CARDDAV_*,
   *   e.g. Fastmail serves calendars and contacts on two hosts); each field
   *   falls back to its CalDAV counterpart
   * @param {string} config.cardDav.serverUrl - CardDAV server URL
   * @param {string} config.cardDav.username - CardDAV username
   * @param {string} config.cardDav.password - CardDAV password
   *
   * For OAuth2:
   * @param {string} config.username - User email (for OAuth2)
   * @param {string} config.clientId - OAuth2 client ID
   * @param {string} config.clientSecret - OAuth2 client secret
   * @param {string} config.refreshToken - OAuth2 refresh token
   * @param {string} config.tokenUrl - OAuth2 token endpoint (default: Google's)
   */
  async initialize(config) {
    this.config = config;
    this.authMethod = config.authMethod || 'Basic';
    const answers = new LoginAnswers();
    const useOAuth = this.authMethod === 'OAuth' || this.authMethod === 'Oauth';
    const tokenUrl = useOAuth ? (config.tokenUrl || DEFAULT_OAUTH_TOKEN_URL) : undefined;
    // Set when CARDDAV_SERVER_URL points the contacts client elsewhere; logs
    // and login errors then tell the two endpoints apart.
    const cardDavServerUrl = config.cardDav?.serverUrl;
    const splitServer = Boolean(cardDavServerUrl) && cardDavServerUrl !== config.serverUrl;

    try {

      if (!useOAuth && this.authMethod !== 'Basic' && this.authMethod !== 'Digest') {
        throw new ConfigurationError(`Unsupported authMethod '${this.authMethod}'. Use Basic, Digest or OAuth.`);
      }

      // A fresh policy per login: the clients built here may reach the
      // configured server (or both of them), what a login redirects to and
      // the account it describes; their token requests only the OAuth token
      // endpoint (see request-origins.js).
      const origins = new RequestOrigins({ serverUrl: config.serverUrl, cardDavServerUrl, tokenUrl });

      let clients;
      if (useOAuth) {
        logger.info({ serverUrl: config.serverUrl }, 'Initializing tsdav clients with OAuth2');
        clients = await this._initializeOAuth({ ...config, tokenUrl }, origins, answers);
      } else {
        logger.info({
          serverUrl: config.serverUrl,
          ...(splitServer && { cardDavServerUrl }),
        }, `Initializing tsdav clients, ${this.authMethod} Auth configured`);
        clients = await this._initializePasswordAuth(config, this.authMethod, origins);
      }

      // The account each server described (root, principal, calendar and
      // address book home) is where its collections live, e.g. on a
      // per-account host.
      origins.trustAccount(clients.calDavClient.account);
      origins.trustAccount(clients.cardDavClient.account);
      origins.endDiscovery();

      // Tools only see clients that have finished logging in; until then the
      // previous clients and their policy stay in place.
      activateRequestOrigins(origins);
      this.calDavClient = clients.calDavClient;
      this.cardDavClient = clients.cardDavClient;
      logger.info({ allowedPrefixes: origins.allowedPrefixes() }, 'Requests are restricted to these URLs and below');

      // "configured", not "used": under Basic tsdav switches to Digest when
      // the server offers nothing else, and does not expose which scheme it
      // ended up with. Logging authMethod: Basic there read as a wrong fact.
      logger.info({
        serverUrl: config.serverUrl,
        ...(splitServer && { cardDavServerUrl }),
        configuredAuthMethod: this.authMethod,
        ...(this.authMethod === 'Basic' && { note: 'Digest is used instead if the server only offers Digest' }),
      }, 'tsdav clients initialized and logged in');
    } catch (cause) {
      let error;
      if (cause instanceof LoginFailure) {
        // Without its own endpoint the two logins are told apart by the URL
        // alone, as before; the label only names a split configuration's
        // failing half.
        error = loginError(cause.cause, { ...config, serverUrl: cause.serverUrl, tokenUrl }, cause.answers,
          splitServer ? cause.label : undefined);
      } else if (cause.name === 'ConfigurationError') {
        error = cause;
      } else {
        error = loginError(cause, { ...config, tokenUrl }, answers);
      }
      logger.error({
        error: error.message,
        serverUrl: config.serverUrl,
        ...(splitServer && { cardDavServerUrl }),
        configuredAuthMethod: this.authMethod
      }, 'Failed to initialize tsdav clients');
      throw error;
    }
  }

  /**
   * Initialize clients with username/password authentication. Each client has
   * its own endpoint and credentials: config.cardDav overrides the CalDAV
   * values for the contacts client, and each client records its own login
   * answers, so a failure is reported against the settings it used.
   *
   * @private
   * @param {Object} config - Client configuration, cardDav resolved
   * @param {'Basic'|'Digest'} authMethod - tsdav auth method
   * @param {RequestOrigins} origins - where the clients may send requests
   * @returns {Promise<{calDavClient: DAVClient, cardDavClient: DAVClient}>} logged-in clients
   */
  async _initializePasswordAuth(config, authMethod, origins) {
    // Validate required fields
    if (!config.username || !config.password) {
      throw new ConfigurationError(`${authMethod} Auth requires username and password`);
    }
    const card = config.cardDav ||
      { serverUrl: config.serverUrl, username: config.username, password: config.password };

    // CalDAV Client
    const calAnswers = new LoginAnswers();
    const calDavClient = new OriginCheckedDAVClient({
      serverUrl: config.serverUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
      authMethod,
      defaultAccountType: 'caldav',
    }, origins, calAnswers);

    // CardDAV Client
    const cardAnswers = new LoginAnswers();
    const cardDavClient = new OriginCheckedDAVClient({
      serverUrl: card.serverUrl,
      credentials: {
        username: card.username,
        password: card.password,
      },
      authMethod,
      defaultAccountType: 'carddav',
    }, origins, cardAnswers);

    // Login to both clients. Either failure fails initialization; the error
    // carries the service, its endpoint and its own answers so initialize()
    // reports the settings that failed.
    try {
      await calDavClient.login();
      logger.debug({ accountType: 'caldav' }, `CalDAV client logged in (${authMethod} Auth configured)`);
    } catch (cause) {
      throw new LoginFailure(cause, 'CalDAV client', config.serverUrl, calAnswers);
    }

    try {
      await cardDavClient.login();
      logger.debug({ accountType: 'carddav' }, `CardDAV client logged in (${authMethod} Auth configured)`);
    } catch (cause) {
      throw new LoginFailure(cause, 'CardDAV client', card.serverUrl, cardAnswers);
    }

    return { calDavClient, cardDavClient };
  }

  /**
   * Initialize clients with OAuth2 Authentication
   * @private
   * @param {Object} config - Client configuration, tokenUrl resolved
   * @param {RequestOrigins} origins - where the clients may send requests
   * @param {LoginAnswers} answers - records what the server answers
   * @returns {Promise<{calDavClient: DAVClient, cardDavClient: DAVClient}>} logged-in clients
   */
  async _initializeOAuth(config, origins, answers) {
    // Validate required OAuth fields
    if (!config.username) {
      throw new ConfigurationError('OAuth requires GOOGLE_USER (the account\'s email address)');
    }
    if (!config.clientId || !config.clientSecret || !config.refreshToken) {
      throw new ConfigurationError('OAuth requires clientId, clientSecret, and refreshToken');
    }

    const tokenUrl = config.tokenUrl;

    const oauthCredentials = {
      tokenUrl,
      username: config.username,
      refreshToken: config.refreshToken,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };

    logger.debug({
      username: config.username,
      tokenUrl,
      serverUrl: config.serverUrl
    }, 'Configuring OAuth2 credentials');

    // CalDAV Client with OAuth
    const calDavClient = new OriginCheckedDAVClient({
      serverUrl: config.serverUrl,
      credentials: oauthCredentials,
      authMethod: 'Oauth', // Note: tsdav expects 'Oauth' with capital O
      defaultAccountType: 'caldav',
    }, origins, answers);

    // CardDAV Client with OAuth
    // Note: Google Calendar doesn't support CardDAV, but we initialize it anyway
    // for compatibility with other OAuth2 CalDAV/CardDAV servers
    const cardDavClient = new OriginCheckedDAVClient({
      serverUrl: config.serverUrl,
      credentials: oauthCredentials,
      authMethod: 'Oauth',
      defaultAccountType: 'carddav',
    }, origins, answers);

    // Login to CalDAV client
    await calDavClient.login();
    logger.debug({ accountType: 'caldav' }, 'CalDAV client logged in (OAuth2)');

    // Try to login to CardDAV client, but don't fail if it doesn't work
    // (Google Calendar doesn't support CardDAV)
    try {
      await cardDavClient.login();
      logger.debug({ accountType: 'carddav' }, 'CardDAV client logged in (OAuth2)');
    } catch (error) {
      logger.warn({
        error: error.message
      }, 'CardDAV login failed (expected for Google Calendar)');
      // Don't throw - CardDAV is optional for OAuth2 providers like Google
    }

    return { calDavClient, cardDavClient };
  }

  /**
   * Get CalDAV client
   */
  getCalDavClient() {
    if (!this.calDavClient) {
      const error = new CalDAVError('CalDAV client not initialized. Call initialize() first.');
      logger.error('CalDAV client not initialized');
      throw error;
    }
    return this.calDavClient;
  }

  /**
   * Get CardDAV client
   */
  getCardDavClient() {
    if (!this.cardDavClient) {
      const error = new CardDAVError('CardDAV client not initialized. Call initialize() first.');
      logger.error('CardDAV client not initialized');
      throw error;
    }
    return this.cardDavClient;
  }
}

// Export singleton instance
export const tsdavManager = new TsdavClientManager();

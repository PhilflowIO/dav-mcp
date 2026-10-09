import { DAVClient } from 'tsdav';
import { logger } from './logger.js';
import { CalDAVError, CardDAVError, AuthenticationError, MCP_ERROR_CODES } from './error-handler.js';
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
      this.answers.watch(this.requestOrigins.tokenFetch(), { tokenEndpoint: true }));
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
  async fetchCalendars(params) {
    return super.fetchCalendars(this.#checked(params, { listingOf: this.account?.homeUrl }));
  }

  async fetchAddressBooks(params) {
    return super.fetchAddressBooks(this.#checked(params, { listingOf: this.account?.homeUrl }));
  }
}

/**
 * The last answer a login got, so a failed login can be told apart by what
 * happened on the wire rather than by tsdav's wording: the server refused
 * the credentials (401, or a token endpoint refusing the OAuth grant), the
 * server could not be reached at all, or it answered but not as a DAV server.
 */
class LoginAnswers {
  constructor() {
    this.last = null;
  }

  /**
   * @param {Function} fetchFn - the fetch to watch
   * @param {object} [options]
   * @param {boolean} [options.tokenEndpoint] - it reaches the OAuth token endpoint
   * @returns {Function} a fetch that records each answer, or that none came
   */
  watch(fetchFn, { tokenEndpoint = false } = {}) {
    return async (input, init) => {
      try {
        const response = await fetchFn(input, init);
        this.last = { status: response.status, statusText: response.statusText || '', tokenEndpoint };
        return response;
      } catch (error) {
        this.last = { unreachable: true };
        throw error;
      }
    };
  }

  /** The credentials were refused (RFC 9110 15.5.2; RFC 6749 5.2 for OAuth). */
  get refused() {
    const { status, tokenEndpoint } = this.last ?? {};
    return status === 401 || (tokenEndpoint === true && status >= 400 && status < 500);
  }

  get unreachable() {
    return this.last?.unreachable === true;
  }
}

/**
 * The error a failed login is reported as. Every one of them is fixed where
 * dav-mcp's settings are kept, so each names that place (#123); the code says
 * which kind of failure it was, instead of leaving it to the message
 * heuristics of the error handler.
 *
 * @param {Error} cause - what tsdav threw
 * @param {object} config - the configuration the login used
 * @param {LoginAnswers} answers - what the server answered
 * @returns {Error}
 */
function loginError(cause, config, answers) {
  const hint = settingsHint(config.authMethod);
  const { status, statusText, tokenEndpoint } = answers.last ?? {};
  // tsdav only says the token endpoint gave no access token; the status says why
  const tokenAnswer = answers.refused && tokenEndpoint
    ? ` (the token endpoint answered ${`${status} ${statusText}`.trim()})`
    : '';
  const message = `Login to ${config.serverUrl} failed: ${String(cause.message).replace(/\.$/, '')}${tokenAnswer}. ${hint}`;

  if (answers.refused) {
    return new AuthenticationError(message, { serverUrl: config.serverUrl, status });
  }
  const error = new Error(message, { cause });
  // A typed error (a redirect off the server, say) keeps its code.
  error.code = Number.isInteger(cause.code) ? cause.code
    : answers.unreachable ? MCP_ERROR_CODES.NETWORK_ERROR
      : MCP_ERROR_CODES.CALDAV_ERROR;
  error.details = { serverUrl: config.serverUrl };
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

    try {
      // Determine authentication method
      const useOAuth = this.authMethod === 'OAuth' || this.authMethod === 'Oauth';

      if (!useOAuth && this.authMethod !== 'Basic' && this.authMethod !== 'Digest') {
        throw new ConfigurationError(`Unsupported authMethod '${this.authMethod}'. Use Basic, Digest or OAuth.`);
      }

      // A fresh policy per login: the clients built here may reach the
      // configured server, what it redirects the login to and the account it
      // describes; their token requests only the OAuth token endpoint
      // (see request-origins.js).
      const tokenUrl = useOAuth ? (config.tokenUrl || DEFAULT_OAUTH_TOKEN_URL) : undefined;
      const origins = new RequestOrigins({ serverUrl: config.serverUrl, tokenUrl });

      let clients;
      if (useOAuth) {
        logger.info({ serverUrl: config.serverUrl }, 'Initializing tsdav clients with OAuth2');
        clients = await this._initializeOAuth({ ...config, tokenUrl }, origins, answers);
      } else {
        logger.info({ serverUrl: config.serverUrl }, `Initializing tsdav clients, ${this.authMethod} Auth configured`);
        clients = await this._initializePasswordAuth(config, this.authMethod, origins, answers);
      }

      // The account the server described (root, principal, calendar and
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
        configuredAuthMethod: this.authMethod,
        ...(this.authMethod === 'Basic' && { note: 'Digest is used instead if the server only offers Digest' }),
      }, 'tsdav clients initialized and logged in');
    } catch (cause) {
      const error = cause.name === 'ConfigurationError' ? cause : loginError(cause, config, answers);
      logger.error({
        error: error.message,
        serverUrl: config.serverUrl,
        configuredAuthMethod: this.authMethod
      }, 'Failed to initialize tsdav clients');
      throw error;
    }
  }

  /**
   * Initialize clients with username/password authentication
   * @private
   * @param {Object} config - Client configuration
   * @param {'Basic'|'Digest'} authMethod - tsdav auth method
   * @param {RequestOrigins} origins - where the clients may send requests
   * @param {LoginAnswers} answers - records what the server answers
   * @returns {Promise<{calDavClient: DAVClient, cardDavClient: DAVClient}>} logged-in clients
   */
  async _initializePasswordAuth(config, authMethod, origins, answers) {
    // Validate required fields
    if (!config.username || !config.password) {
      throw new ConfigurationError(`${authMethod} Auth requires username and password`);
    }

    // CalDAV Client
    const calDavClient = new OriginCheckedDAVClient({
      serverUrl: config.serverUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
      authMethod,
      defaultAccountType: 'caldav',
    }, origins, answers);

    // CardDAV Client
    const cardDavClient = new OriginCheckedDAVClient({
      serverUrl: config.serverUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
      authMethod,
      defaultAccountType: 'carddav',
    }, origins, answers);

    // Login to both clients
    await calDavClient.login();
    logger.debug({ accountType: 'caldav' }, `CalDAV client logged in (${authMethod} Auth configured)`);

    await cardDavClient.login();
    logger.debug({ accountType: 'carddav' }, `CardDAV client logged in (${authMethod} Auth configured)`);

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

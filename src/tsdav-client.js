import { DAVClient, isDigestUnsupportedError } from 'tsdav';
import { logger } from './logger.js';
import { CalDAVError, CardDAVError } from './error-handler.js';
import { ConfigurationError } from './auth-config.js';
import { RequestOrigins, activateRequestOrigins } from './request-origins.js';

const DEFAULT_OAUTH_TOKEN_URL = 'https://accounts.google.com/o/oauth2/token';

/**
 * A tsdav client that only reaches the origins of its RequestOrigins (see
 * request-origins.js). Every request tsdav makes goes through the fetch given
 * here; a fetch passed to a single call is wrapped as well, so passing one
 * does not open a way around the check.
 */
class OriginCheckedDAVClient extends DAVClient {
  constructor(params, origins) {
    super({ ...params, fetch: origins.fetch() });
    this.requestOrigins = origins;
  }

  #checked(params, options) {
    if (!params?.fetch && !options) return params;
    return { ...params, fetch: this.requestOrigins.fetch(params?.fetch, options) };
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

  // A server may list a collection on an origin other than its root; tsdav
  // asks that collection for its reports while still listing, so the origins
  // in the listing have to be known before the listing call returns.
  async fetchCalendars(params) {
    return super.fetchCalendars(this.#checked(params, { learnCollections: true }));
  }

  async fetchAddressBooks(params) {
    return super.fetchAddressBooks(this.#checked(params, { learnCollections: true }));
  }
}

/**
 * Singleton CalDAV/CardDAV Client Manager
 *
 * Supports Basic, Digest and OAuth2 authentication:
 * - Basic Auth: Standard CalDAV servers (Radicale, Baikal, Nextcloud). tsdav
 *   switches to Digest by itself when a server's 401 offers only Digest.
 * - Digest Auth: Servers that only accept Digest (RFC 7616); the password is
 *   never sent, not even once. Needs WebCrypto (Node.js 20 or newer).
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

    try {
      // Determine authentication method
      const useOAuth = this.authMethod === 'OAuth' || this.authMethod === 'Oauth';

      if (!useOAuth && this.authMethod !== 'Basic' && this.authMethod !== 'Digest') {
        throw new Error(`Unsupported authMethod '${this.authMethod}'. Use Basic, Digest or OAuth.`);
      }

      // A fresh policy per login: the clients built here may reach the
      // configured server, whatever it redirects the login to, and the OAuth
      // token endpoint — nothing else (see request-origins.js).
      const tokenUrl = useOAuth ? (config.tokenUrl || DEFAULT_OAUTH_TOKEN_URL) : undefined;
      const origins = new RequestOrigins({ serverUrl: config.serverUrl, authUrls: tokenUrl ? [tokenUrl] : [] });

      let clients;
      if (useOAuth) {
        logger.info({ serverUrl: config.serverUrl }, 'Initializing tsdav clients with OAuth2');
        clients = await this._initializeOAuth({ ...config, tokenUrl }, origins);
      } else {
        logger.info({ serverUrl: config.serverUrl }, `Initializing tsdav clients, ${this.authMethod} Auth configured`);
        clients = await this._initializePasswordAuth(config, this.authMethod, origins);
      }

      // The account the server described (principal, calendar and address
      // book home) is where its collections live, e.g. on a per-user host.
      origins.trustAccount(clients.calDavClient.account);
      origins.trustAccount(clients.cardDavClient.account);
      origins.endDiscovery();

      // Tools only see clients that have finished logging in; until then the
      // previous clients and their policy stay in place.
      activateRequestOrigins(origins);
      this.calDavClient = clients.calDavClient;
      this.cardDavClient = clients.cardDavClient;
      logger.info({ allowedOrigins: origins.allowedOrigins() }, 'Requests are restricted to these origins');

      // "configured", not "used": under Basic tsdav switches to Digest when
      // the server offers nothing else, and does not expose which scheme it
      // ended up with. Logging authMethod: Basic there read as a wrong fact.
      logger.info({
        serverUrl: config.serverUrl,
        configuredAuthMethod: this.authMethod,
        ...(this.authMethod === 'Basic' && { note: 'Digest is used instead if the server only offers Digest' }),
      }, 'tsdav clients initialized and logged in');
    } catch (cause) {
      // The server wants Digest and this runtime cannot compute it (no
      // WebCrypto, i.e. Node.js 18). Waiting does not help, so this is a
      // configuration error — and it says what to do, not just what is missing.
      const error = isDigestUnsupportedError(cause)
        ? new ConfigurationError(
          `${config.serverUrl} only accepts Digest authentication, which dav-mcp supports on Node.js 20 or newer ` +
          `(this is Node.js ${process.versions.node}). Upgrade Node.js, or enable Basic authentication on the server. ` +
          `Cause: ${cause.message}`)
        : cause;
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
   * @returns {Promise<{calDavClient: DAVClient, cardDavClient: DAVClient}>} logged-in clients
   */
  async _initializePasswordAuth(config, authMethod, origins) {
    // Validate required fields
    if (!config.username || !config.password) {
      throw new Error(`${authMethod} Auth requires username and password`);
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
    }, origins);

    // CardDAV Client
    const cardDavClient = new OriginCheckedDAVClient({
      serverUrl: config.serverUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
      authMethod,
      defaultAccountType: 'carddav',
    }, origins);

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
   * @returns {Promise<{calDavClient: DAVClient, cardDavClient: DAVClient}>} logged-in clients
   */
  async _initializeOAuth(config, origins) {
    // Validate required OAuth fields
    if (!config.username) {
      throw new Error('OAuth requires username (user email)');
    }
    if (!config.clientId || !config.clientSecret || !config.refreshToken) {
      throw new Error('OAuth requires clientId, clientSecret, and refreshToken');
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
    }, origins);

    // CardDAV Client with OAuth
    // Note: Google Calendar doesn't support CardDAV, but we initialize it anyway
    // for compatibility with other OAuth2 CalDAV/CardDAV servers
    const cardDavClient = new OriginCheckedDAVClient({
      serverUrl: config.serverUrl,
      credentials: oauthCredentials,
      authMethod: 'Oauth',
      defaultAccountType: 'carddav',
    }, origins);

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

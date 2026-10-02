import { DAVClient, isDigestUnsupportedError } from 'tsdav';
import { logger } from './logger.js';
import { CalDAVError, CardDAVError } from './error-handler.js';
import { ConfigurationError } from './auth-config.js';

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

      if (useOAuth) {
        logger.info({ serverUrl: config.serverUrl }, 'Initializing tsdav clients with OAuth2');
        await this._initializeOAuth(config);
      } else if (this.authMethod === 'Basic' || this.authMethod === 'Digest') {
        logger.info({ serverUrl: config.serverUrl }, `Initializing tsdav clients with ${this.authMethod} Auth`);
        await this._initializePasswordAuth(config, this.authMethod);
      } else {
        throw new Error(`Unsupported authMethod '${this.authMethod}'. Use Basic, Digest or OAuth.`);
      }

      logger.info({
        serverUrl: config.serverUrl,
        authMethod: this.authMethod
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
        authMethod: this.authMethod
      }, 'Failed to initialize tsdav clients');
      throw error;
    }
  }

  /**
   * Initialize clients with username/password authentication
   * @private
   * @param {Object} config - Client configuration
   * @param {'Basic'|'Digest'} authMethod - tsdav auth method
   */
  async _initializePasswordAuth(config, authMethod) {
    // Validate required fields
    if (!config.username || !config.password) {
      throw new Error(`${authMethod} Auth requires username and password`);
    }

    // CalDAV Client
    this.calDavClient = new DAVClient({
      serverUrl: config.serverUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
      authMethod,
      defaultAccountType: 'caldav',
    });

    // CardDAV Client
    this.cardDavClient = new DAVClient({
      serverUrl: config.serverUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
      authMethod,
      defaultAccountType: 'carddav',
    });

    // Login to both clients
    await this.calDavClient.login();
    logger.debug({ accountType: 'caldav' }, `CalDAV client logged in (${authMethod} Auth)`);

    await this.cardDavClient.login();
    logger.debug({ accountType: 'carddav' }, `CardDAV client logged in (${authMethod} Auth)`);
  }

  /**
   * Initialize clients with OAuth2 Authentication
   * @private
   */
  async _initializeOAuth(config) {
    // Validate required OAuth fields
    if (!config.username) {
      throw new Error('OAuth requires username (user email)');
    }
    if (!config.clientId || !config.clientSecret || !config.refreshToken) {
      throw new Error('OAuth requires clientId, clientSecret, and refreshToken');
    }

    // Default to Google's token endpoint if not specified
    const tokenUrl = config.tokenUrl || 'https://accounts.google.com/o/oauth2/token';

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
    this.calDavClient = new DAVClient({
      serverUrl: config.serverUrl,
      credentials: oauthCredentials,
      authMethod: 'Oauth', // Note: tsdav expects 'Oauth' with capital O
      defaultAccountType: 'caldav',
    });

    // CardDAV Client with OAuth
    // Note: Google Calendar doesn't support CardDAV, but we initialize it anyway
    // for compatibility with other OAuth2 CalDAV/CardDAV servers
    this.cardDavClient = new DAVClient({
      serverUrl: config.serverUrl,
      credentials: oauthCredentials,
      authMethod: 'Oauth',
      defaultAccountType: 'carddav',
    });

    // Login to CalDAV client
    await this.calDavClient.login();
    logger.debug({ accountType: 'caldav' }, 'CalDAV client logged in (OAuth2)');

    // Try to login to CardDAV client, but don't fail if it doesn't work
    // (Google Calendar doesn't support CardDAV)
    try {
      await this.cardDavClient.login();
      logger.debug({ accountType: 'carddav' }, 'CardDAV client logged in (OAuth2)');
    } catch (error) {
      logger.warn({
        error: error.message
      }, 'CardDAV login failed (expected for Google Calendar)');
      // Don't throw - CardDAV is optional for OAuth2 providers like Google
    }
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

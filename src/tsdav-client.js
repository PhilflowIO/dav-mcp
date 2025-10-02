import { DAVClient } from 'tsdav';
import { logger } from './logger.js';
import { CalDAVError, CardDAVError } from './error-handler.js';

/**
 * Singleton CalDAV/CardDAV Client Manager
 */
class TsdavClientManager {
  constructor() {
    this.calDavClient = null;
    this.cardDavClient = null;
    this.config = null;
  }

  /**
   * Initialize clients with configuration
   */
  async initialize(config) {
    this.config = config;

    try {
      // CalDAV Client
      this.calDavClient = new DAVClient({
        serverUrl: config.serverUrl,
        credentials: {
          username: config.username,
          password: config.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });

      // CardDAV Client
      this.cardDavClient = new DAVClient({
        serverUrl: config.serverUrl,
        credentials: {
          username: config.username,
          password: config.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'carddav',
      });

      // Login to both clients
      await this.calDavClient.login();
      logger.debug({ accountType: 'caldav' }, 'CalDAV client logged in');

      await this.cardDavClient.login();
      logger.debug({ accountType: 'carddav' }, 'CardDAV client logged in');

      logger.info({ serverUrl: config.serverUrl }, 'tsdav clients initialized and logged in');
    } catch (error) {
      logger.error({ error: error.message, serverUrl: config.serverUrl }, 'Failed to initialize tsdav clients');
      throw error;
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

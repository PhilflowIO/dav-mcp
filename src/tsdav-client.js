import { DAVClient, isDAVAuthenticationError, isDAVResponseError } from 'tsdav';
import { logger } from './logger.js';
import { CalDAVError, CardDAVError, AuthenticationError, MCP_ERROR_CODES, codeForHttpStatus } from './error-handler.js';
import { ConfigurationError, settingsHint, withoutUserinfo } from './auth-config.js';
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

// Statuses that say the server had a fault or turned a request away for
// now, not that it lacks something: forbidden, timeout, rate limit, 5xx.
// 401 is not among them: a Digest login starts with one, and a refused
// login is one tsdav reports itself (see LoginAnswers).
const FAULT_STATUSES = new Set([403, 408, 429]);
const isFaultStatus = status => FAULT_STATUSES.has(status) || status >= 500;

/**
 * What the requests of one login got: whether any answer came, to tell a
 * server that cannot be reached from one that answered but not as a DAV
 * server, and the first fault on the way, if any (a request that threw, or a
 * status isFaultStatus counts).
 *
 * tsdav's error alone does not say whether there was a fault: it tries
 * several URLs and keeps only the last answer (a 429 on the configured
 * /dav/ comes back as the 405 of the server root it tries next), and a
 * request that throws after discovery has been answered reads like a server
 * without that half. Whether the credentials were refused is left to tsdav's
 * error, which says so itself (Baïkal answers 401 on /dav.php/, then 405 on
 * the server root).
 */
class LoginAnswers {
  constructor() {
    this.answered = false;
    this.fault = null;
    this.recording = true;
  }

  /**
   * @param {Function} fetchFn - the fetch to watch
   * @returns {Function} a fetch that notes what each login request got
   */
  watch(fetchFn) {
    return async (input, init) => {
      let response;
      try {
        response = await fetchFn(input, init);
      } catch (error) {
        if (this.recording) this.fault ??= { error };
        throw error;
      }
      if (this.recording) {
        this.answered = true;
        if (isFaultStatus(response.status)) {
          this.fault ??= { status: response.status, url: String(input?.url ?? input) };
        }
      }
      return response;
    };
  }

  /** The login is over: the requests of tool calls are not recorded. */
  done() {
    this.recording = false;
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
 * What a failed login says about itself: whether the credentials were
 * refused, the error status tsdav reports (@philflow/tsdav 2.5.0; its message
 * alone, "cannot find principalUrl" or "no access token", does not say
 * which), whether that status came from the OAuth token endpoint, and the
 * code the failure is reported with.
 *
 * @param {Error} cause - what tsdav threw
 * @param {object} config - the configuration the login used, tokenUrl resolved
 * @param {LoginAnswers} answers - whether the server answered at all
 */
function loginFailure(cause, config, answers) {
  const refused = isDAVAuthenticationError(cause);
  const status = isDAVResponseError(cause) && Number.isInteger(cause.status) ? cause.status : undefined;
  const atTokenEndpoint = Boolean(config.tokenUrl) && cause.url === config.tokenUrl;
  // A refused DAV login already says "returned 401"; tsdav's other messages
  // ("cannot find principalUrl", "no access token") name no status.
  const { fault } = answers;
  // The fault on the way, unless it is what the cause already reports.
  const earlierFault = fault && !refused
    && !(fault.error && (fault.error === cause || fault.error.message === cause.message))
    && !(fault.status !== undefined && fault.status === status && fault.url === cause.url)
    ? fault : null;
  const answeredBy = status === undefined ? ''
    : atTokenEndpoint ? ` (the token endpoint answered ${status})`
      : refused ? '' : ` (the server answered ${status})`;
  const reported = `${String(cause.message).replace(/\.$/, '')}${answeredBy}`;
  // The fault comes first: it is what failed, tsdav's last answer only what
  // the login ran into after it.
  const reason = !earlierFault ? reported
    : earlierFault.error
      ? `a request failed with a network error: ${String(earlierFault.error.message).replace(/\.$/, '')} (the login then reported: ${reported})`
      : `${earlierFault.url} answered ${earlierFault.status} (the login then reported: ${reported})`;
  const code = Number.isInteger(cause.code) ? cause.code
    : fault?.error ? MCP_ERROR_CODES.NETWORK_ERROR
      : fault ? loginStatusCode(fault.status)
        : status !== undefined ? loginStatusCode(status)
          : answers.answered ? MCP_ERROR_CODES.CONFIGURATION_ERROR
            : MCP_ERROR_CODES.NETWORK_ERROR;
  return { refused, status, atTokenEndpoint, reason, code };
}

/**
 * Whether a failed login of one half (CalDAV or CardDAV) means the server
 * does not serve that half: it answered, but not with that account type's
 * home (no home set, 404, 405). iCloud answers a CardDAV discovery on
 * caldav.icloud.com with an empty addressbook-home-set, all-inkl with a 404
 * (#152), and no request of that login met a fault (LoginAnswers). A
 * refused login, an unreachable server, a server fault, a rate
 * limit or a token endpoint error says nothing about which halves the server
 * serves and may be gone on the next try, so it fails the login as a whole.
 */
function isUnservedHalf(failure) {
  return !failure.refused && !failure.atTokenEndpoint && failure.code === MCP_ERROR_CODES.CONFIGURATION_ERROR;
}

/**
 * When a half's failed login leaves the half out instead of failing the
 * login, per account type:
 * - 'unserved': only when the server does not serve that half
 *   (isUnservedHalf); any other failure fails the login.
 * - 'never': every failure fails the login.
 * - 'always': every failure leaves the half out.
 */
const PASSWORD_HALVES_OPTIONAL = { caldav: 'unserved', carddav: 'unserved' };
// With any CARDDAV_* set (config.cardDav), the user has said where each half
// is: a half that fails there is a misconfiguration, and leaving it out
// would hide it behind tools that answer "not available". Both halves are
// required then.
const CONFIGURED_HALVES_OPTIONAL = { caldav: 'never', carddav: 'never' };
// OAuth is configured for one Google CalDAV server (GOOGLE_SERVER_URL), and
// Google serves no CardDAV there, so dav-mcp has always logged in under
// OAuth without that half, whatever its login failed with; a CardDAV error
// of a kind not seen before must not stop Google users from starting. The
// CalDAV half is what an OAuth setup is for: any failure fails the login.
const OAUTH_HALVES_OPTIONAL = { caldav: 'never', carddav: 'always' };

// Errors loginError() built, so initialize() does not build one around them.
const loginErrors = new WeakSet();

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
  const { refused, status, reason, code } = loginFailure(cause, config, answers);
  const notDav = !refused && code === MCP_ERROR_CODES.CONFIGURATION_ERROR
    ? `The server URL does not lead to a CalDAV/CardDAV server. ` : '';
  const message = `Login to ${config.serverUrl} failed${label ? ` (${label})` : ''}: ${reason}. ${notDav}${hint}`;

  let error;
  if (refused) {
    error = new AuthenticationError(message, {
      serverUrl: config.serverUrl,
      ...(label && { service: label }),
      status,
      url: cause.url,
    });
  } else {
    error = new Error(message, { cause });
    // A typed error (a redirect off the server, say) keeps its code; a status
    // says what kind of failure it was (403 forbidden, 429 rate limited, ...).
    error.code = code;
    error.details = {
      serverUrl: config.serverUrl,
      ...(label && { service: label }),
      ...(status !== undefined && { status, url: cause.url }),
    };
  }
  loginErrors.add(error);
  return error;
}

/**
 * The origin of a configured URL, or undefined if it is not one (the policy
 * reports that with its variable).
 * @param {string} value
 * @returns {string|undefined}
 */
function originOf(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return undefined;
  }
}

// Per half: the account type tsdav knows it by, its name, its error class
// and the tools that need it.
const HALVES = {
  caldav: { name: 'CalDAV', ErrorClass: CalDAVError, tools: 'calendar and task tools' },
  carddav: { name: 'CardDAV', ErrorClass: CardDAVError, tools: 'contact tools' },
};

/**
 * Why a half is not available, for every tool call that needs it: the server
 * logged in for the other half but does not serve this one.
 */
function unservedHalf(accountType, cause, config, answers) {
  const { name, tools } = HALVES[accountType];
  const { status, reason } = loginFailure(cause, config, answers);
  return {
    message: `The configured server ${config.serverUrl} does not serve ${name}, so the ${tools} are not available. ` +
      `Its ${name} login failed: ${reason}. ` +
      // OAuth has one server and ignores CARDDAV_*.
      (config.authMethod === 'OAuth'
        ? `If your provider serves ${name} at another URL, run a second dav-mcp with that URL. `
        : accountType === 'carddav'
        ? 'If your provider serves CardDAV at another URL, set CARDDAV_SERVER_URL to it ' +
          '(and CARDDAV_USERNAME and CARDDAV_PASSWORD if its login differs). '
        : 'If your provider serves CalDAV at another URL, set CALDAV_SERVER_URL to it and ' +
          `CARDDAV_SERVER_URL to ${config.serverUrl}. `) +
      settingsHint(config.authMethod),
    details: { serverUrl: config.serverUrl, accountType, ...(status !== undefined && { status, url: cause.url }) },
  };
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
    // Per account type, why the server logged in without it (see
    // unservedHalf); empty when both halves logged in.
    this.unserved = {};
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
    const useOAuth = this.authMethod === 'OAuth' || this.authMethod === 'Oauth';
    const tokenUrl = useOAuth ? (config.tokenUrl || DEFAULT_OAUTH_TOKEN_URL) : undefined;
    const loginConfig = { ...config, authMethod: this.authMethod, tokenUrl };
    // Set when any CARDDAV_* is: login errors then name the failing half, even
    // when only its credentials differ, and logs tell the two endpoints apart
    // when the URLs do. OAuth has one Google server and ignores them.
    const cardDav = useOAuth ? undefined : config.cardDav;
    const cardDavServerUrl = cardDav?.serverUrl;
    const splitServer = Boolean(cardDavServerUrl) && cardDavServerUrl !== config.serverUrl;
    const splitConfig = Boolean(cardDav);

    try {

      if (!useOAuth && this.authMethod !== 'Basic' && this.authMethod !== 'Digest') {
        throw new ConfigurationError(`Unsupported authMethod '${this.authMethod}'. Use Basic, Digest or OAuth.`);
      }

      // A fresh policy per login: the clients built here may reach their
      // configured server, what a login redirects to and the account it
      // describes; their token requests only the OAuth token endpoint (see
      // request-origins.js). With any CARDDAV_* set each client keeps its own
      // policy, even on the same URL: a policy learns every host its login
      // was redirected to, so a shared one would hand the CardDAV login to a
      // host only the calendar login was sent to. Each policy also refuses
      // the other half's configured host, so a redirect cannot carry one
      // login to the other endpoint. Without CARDDAV_* one login serves both
      // halves, and they share one policy, as before. The names make
      // configuration errors point at the setting that caused them.
      const calHost = splitServer ? originOf(config.serverUrl) : undefined;
      const cardHost = splitServer ? originOf(cardDavServerUrl) : undefined;
      const separateHosts = Boolean(calHost && cardHost && calHost !== cardHost);
      const calOrigins = new RequestOrigins({
        serverUrl: config.serverUrl,
        tokenUrl,
        ...(useOAuth
          ? { serverUrlName: 'GOOGLE_SERVER_URL', serverCredentials: 'GOOGLE_USER' }
          : splitConfig ? { serverUrlName: 'CALDAV_SERVER_URL' } : {}),
        ...(splitServer && { serves: 'calendars and tasks' }),
        ...(separateHosts && { forbidden: { origin: cardHost, name: 'CARDDAV_SERVER_URL', own: 'CALDAV_SERVER_URL' } }),
      });
      const cardOrigins = splitConfig
        ? new RequestOrigins({
          serverUrl: cardDav.serverUrl,
          serverUrlName: splitServer ? 'CARDDAV_SERVER_URL' : 'CALDAV_SERVER_URL',
          serverCredentials: 'CARDDAV_USERNAME and CARDDAV_PASSWORD',
          ...(splitServer && { serves: 'contacts' }),
          ...(separateHosts && { forbidden: { origin: calHost, name: 'CALDAV_SERVER_URL', own: 'CARDDAV_SERVER_URL' } }),
        })
        : calOrigins;
      const origins = { caldav: calOrigins, carddav: cardOrigins };

      let clients;
      if (useOAuth) {
        logger.info({ serverUrl: config.serverUrl }, 'Initializing tsdav clients with OAuth2');
        clients = await this._initializeOAuth(loginConfig, origins);
      } else {
        logger.info({
          serverUrl: config.serverUrl,
          ...(splitServer && { cardDavServerUrl }),
        }, `Initializing tsdav clients, ${this.authMethod} Auth configured`);
        clients = await this._initializePasswordAuth({ ...loginConfig, cardDav, splitConfig }, origins);
      }

      // The account each server described (root, principal, calendar and
      // address book home) is where its collections live, e.g. on a
      // per-account host.
      calOrigins.trustAccount(clients.calDavClient?.account);
      cardOrigins.trustAccount(clients.cardDavClient?.account);
      calOrigins.endDiscovery();
      cardOrigins.endDiscovery();

      // Tools only see clients that have finished logging in; until then the
      // previous clients and their policy stay in place. The tool schemas
      // accept a URL inside the account of any client that logged in, and
      // only those: a policy whose client is left out (a half the server
      // does not serve) has no account, so no tool may be handed a URL for
      // it. Each client's own policy still keeps its requests on its own
      // endpoint.
      const policies = [...new Set([
        clients.calDavClient && calOrigins,
        clients.cardDavClient && cardOrigins,
      ].filter(Boolean))];
      activateRequestOrigins(policies.length === 1 ? policies[0] : policies);
      this.calDavClient = clients.calDavClient;
      this.cardDavClient = clients.cardDavClient;
      this.unserved = clients.unserved;
      logger.info({ allowedPrefixes: [...new Set(policies.flatMap(policy => policy.allowedPrefixes()))] },
        'Requests are restricted to these URLs and below');

      // "configured", not "used": under Basic tsdav switches to Digest when
      // the server offers nothing else, and does not expose which scheme it
      // ended up with. Logging authMethod: Basic there read as a wrong fact.
      logger.info({
        serverUrl: config.serverUrl,
        ...(splitServer && { cardDavServerUrl }),
        configuredAuthMethod: this.authMethod,
        availableAccountTypes: this.availableAccountTypes(),
        ...(this.authMethod === 'Basic' && { note: 'Digest is used instead if the server only offers Digest' }),
      }, 'tsdav clients initialized and logged in');
    } catch (cause) {
      const error = cause.name === 'ConfigurationError' || loginErrors.has(cause)
        ? cause : loginError(cause, loginConfig, new LoginAnswers());
      logger.error({
        error: error.message,
        // a URL refused for carrying a password is still in the config here
        serverUrl: withoutUserinfo(config.serverUrl),
        ...(splitServer && { cardDavServerUrl: withoutUserinfo(cardDavServerUrl) }),
        configuredAuthMethod: this.authMethod
      }, 'Failed to initialize tsdav clients');
      throw error;
    }
  }

  /**
   * Initialize clients with username/password authentication. Each client has
   * its own endpoint, credentials, origin policy and login answers: each
   * field of config.cardDav overrides its CalDAV counterpart for the contacts
   * client, so a failure is reported against the settings it used.
   *
   * @private
   * @param {Object} config - Client configuration, authMethod 'Basic' or 'Digest'
   * @param {{caldav: RequestOrigins, carddav: RequestOrigins}} origins - per
   *   account type, where its client may send requests
   * @returns {Promise<{calDavClient: DAVClient|null, cardDavClient: DAVClient|null, unserved: object}>}
   *   see _loginHalves
   */
  async _initializePasswordAuth(config, origins) {
    const { authMethod } = config;
    // Validate required fields
    if (!config.username || !config.password) {
      throw new ConfigurationError(`${authMethod} Auth requires username and password`);
    }

    const card = {
      serverUrl: config.cardDav?.serverUrl || config.serverUrl,
      username: config.cardDav?.username || config.username,
      password: config.cardDav?.password || config.password,
    };
    // The label only names a split configuration's failing half; without its
    // own endpoint the two logins are told apart by the URL alone, as before.
    const halves = {
      caldav: {
        serverUrl: config.serverUrl,
        credentials: { username: config.username, password: config.password },
        origins: origins.caldav,
        ...(config.splitConfig && { label: 'CalDAV client' }),
      },
      carddav: {
        serverUrl: card.serverUrl,
        credentials: { username: card.username, password: card.password },
        origins: origins.carddav,
        ...(config.splitConfig && { label: 'CardDAV client' }),
      },
    };
    return this._loginHalves(config, halves, authMethod, `${authMethod} Auth configured`,
      config.cardDav ? CONFIGURED_HALVES_OPTIONAL : PASSWORD_HALVES_OPTIONAL);
  }

  /**
   * Builds and logs in one client per account type. A server may serve only
   * one of them at the configured URL (iCloud keeps calendars on
   * caldav.icloud.com and contacts on contacts.icloud.com, each with the
   * other's home set empty; all-inkl answers 404 for the half it keeps
   * elsewhere, #152), so a half the server does not serve (isUnservedHalf)
   * comes back null, with the reason in `unserved` for the tools that need
   * it. Any other failure fails the login as before, so stdio retries it on
   * the next tool call instead of running without the half for good. When
   * neither half is served, the CalDAV error is thrown. Which failures leave
   * a half out is set per auth method (`optional`): OAuth keeps its own, and
   * a configured CardDAV endpoint (any CARDDAV_*) makes both halves required.
   * @private
   * @param {Object} config - Client configuration, tokenUrl resolved
   * @param {Object} halves - per account type, the endpoint (serverUrl), the
   *   credentials for tsdav, the origin policy its client is held to and, in
   *   a split setup, the label errors carry
   * @param {string} authMethod - tsdav's auth method ('Basic', 'Digest', 'Oauth')
   * @param {string} how - how the clients authenticate, for the log
   * @param {{caldav: string, carddav: string}} optional - per account type,
   *   which failures leave the half out (see PASSWORD_HALVES_OPTIONAL)
   * @returns {Promise<{calDavClient: DAVClient|null, cardDavClient: DAVClient|null, unserved: object}>}
   */
  async _loginHalves(config, halves, authMethod, how, optional) {
    const clients = { calDavClient: null, cardDavClient: null, unserved: {} };
    const unservedErrors = [];
    for (const [accountType, key] of [['caldav', 'calDavClient'], ['carddav', 'cardDavClient']]) {
      // Each half has its own record of answers: one half having been
      // answered says nothing about whether the other reached the server.
      const answers = new LoginAnswers();
      const half = halves[accountType];
      // A failure is reported against the endpoint this half logged onto.
      const halfConfig = { ...config, serverUrl: half.serverUrl };
      const client = new OriginCheckedDAVClient({
        serverUrl: half.serverUrl,
        credentials: half.credentials,
        authMethod,
        defaultAccountType: accountType,
      }, half.origins, answers);
      try {
        await client.login();
        clients[key] = client;
        logger.debug({ accountType }, `${HALVES[accountType].name} client logged in (${how})`);
      } catch (cause) {
        const error = loginError(cause, halfConfig, answers, half.label);
        const leaveOut = optional[accountType] === 'always'
          || (optional[accountType] === 'unserved' && isUnservedHalf(loginFailure(cause, halfConfig, answers)));
        if (!leaveOut) throw error;
        unservedErrors.push(error);
        clients.unserved[accountType] = unservedHalf(accountType, cause, halfConfig, answers);
        logger.warn({ accountType, error: error.message },
          `The server does not serve ${HALVES[accountType].name}; the ${HALVES[accountType].tools} are not available`);
      } finally {
        answers.done();
      }
    }
    if (!clients.calDavClient && !clients.cardDavClient) throw unservedErrors[0];
    return clients;
  }

  /**
   * Initialize clients with OAuth2 Authentication
   * @private
   * @param {Object} config - Client configuration, tokenUrl resolved
   * @param {{caldav: RequestOrigins, carddav: RequestOrigins}} origins - per
   *   account type, where its client may send requests (one shared policy)
   * @returns {Promise<{calDavClient: DAVClient|null, cardDavClient: DAVClient|null, unserved: object}>}
   *   see _loginHalves; Google serves no CardDAV at its CalDAV URL, so there
   *   the CardDAV half is null
   */
  async _initializeOAuth(config, origins) {
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

    // Note: tsdav expects 'Oauth' with capital O
    const halves = {
      caldav: { serverUrl: config.serverUrl, credentials: oauthCredentials, origins: origins.caldav },
      carddav: { serverUrl: config.serverUrl, credentials: oauthCredentials, origins: origins.carddav },
    };
    return this._loginHalves(config, halves, 'Oauth', 'OAuth2', OAUTH_HALVES_OPTIONAL);
  }

  /**
   * The account types the server logged in for, e.g. ['caldav'] for a
   * server that serves no CardDAV at the configured URL.
   * @returns {string[]}
   */
  availableAccountTypes() {
    return [
      this.calDavClient ? 'caldav' : null,
      this.cardDavClient ? 'carddav' : null,
    ].filter(Boolean);
  }

  /**
   * The error for a tool that needs a half there is no client for: the
   * server does not serve it, or no login has succeeded yet.
   * @private
   */
  _missingHalf(accountType) {
    const { name, ErrorClass } = HALVES[accountType];
    const unserved = this.unserved[accountType];
    if (unserved) return new ErrorClass(unserved.message, unserved.details);
    logger.error(`${name} client not initialized`);
    return new ErrorClass(`${name} client not initialized. Call initialize() first.`);
  }

  /**
   * Get CalDAV client
   */
  getCalDavClient() {
    if (!this.calDavClient) throw this._missingHalf('caldav');
    return this.calDavClient;
  }

  /**
   * Get CardDAV client
   */
  getCardDavClient() {
    if (!this.cardDavClient) throw this._missingHalf('carddav');
    return this.cardDavClient;
  }
}

// Export singleton instance
export const tsdavManager = new TsdavClientManager();

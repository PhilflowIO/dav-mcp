import { isDAVAuthenticationError, isDAVResponseError } from 'tsdav';
import { settingsHint, configuredAuthMethod } from './auth-config.js';

/**
 * MCP Standard Error Codes
 * Following JSON-RPC 2.0 error code specification
 */
export const MCP_ERROR_CODES = {
  // JSON-RPC standard errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Custom application errors (range -32000 to -32099)
  CALDAV_ERROR: -32000,
  CARDDAV_ERROR: -32001,
  VALIDATION_ERROR: -32002,
  AUTH_ERROR: -32003,
  NETWORK_ERROR: -32004,
  TIMEOUT_ERROR: -32005,
  NOT_FOUND_ERROR: -32006,
  CONFLICT_ERROR: -32007,
  // dav-mcp's own settings are wrong: an unknown AUTH_METHOD, missing
  // credentials, or a server URL that does not lead to a DAV server.
  CONFIGURATION_ERROR: -32008,
};

/**
 * Error type to code mapping
 */
const ERROR_TYPE_MAP = {
  'ValidationError': MCP_ERROR_CODES.VALIDATION_ERROR,
  'AuthenticationError': MCP_ERROR_CODES.AUTH_ERROR,
  'NetworkError': MCP_ERROR_CODES.NETWORK_ERROR,
  'TimeoutError': MCP_ERROR_CODES.TIMEOUT_ERROR,
  'NotFoundError': MCP_ERROR_CODES.NOT_FOUND_ERROR,
  'ConflictError': MCP_ERROR_CODES.CONFLICT_ERROR,
  'ConfigurationError': MCP_ERROR_CODES.CONFIGURATION_ERROR,
};

/**
 * Map the HTTP status a DAV server answered with to an MCP error code.
 * Statuses without a more specific meaning are internal errors, as before.
 */
export function codeForHttpStatus(status) {
  switch (status) {
    case 401:
    case 403:
      return MCP_ERROR_CODES.AUTH_ERROR;
    case 404:
    case 410:
      return MCP_ERROR_CODES.NOT_FOUND_ERROR;
    // The request is fine but the state of the resource is in the way:
    // 409 a missing parent or UID clash, 412 a stale ETag, 423 a lock.
    case 409:
    case 412:
    case 423:
      return MCP_ERROR_CODES.CONFLICT_ERROR;
    // The server does not take this kind of request at this URL — for
    // instance a server without MKCALENDAR. SabreDAV also says 405 when the
    // URL of a new calendar is taken, but only make_calendar can tell the two
    // apart, and it sets the conflict code itself once it has confirmed one.
    // Not METHOD_NOT_FOUND: to an MCP client that means the tool is missing.
    case 405:
      return MCP_ERROR_CODES.INVALID_REQUEST;
    case 408:
    case 504:
      return MCP_ERROR_CODES.TIMEOUT_ERROR;
    // The server, or a proxy in front of it, cannot take the request right
    // now; the same request can succeed later.
    case 429:
    case 502:
    case 503:
      return MCP_ERROR_CODES.NETWORK_ERROR;
    // 507 (quota exceeded) and everything else: the server failed and a
    // retry will not change that.
    default:
      return MCP_ERROR_CODES.INTERNAL_ERROR;
  }
}

// What a fetch that never got an answer carries in its cause (Node.js and
// undici): no route, no name, refused, reset, timed out.
const NETWORK_CAUSES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

// The network code sits on the error or somewhere down its cause chain
// (undici: TypeError('fetch failed') with the socket error as cause; dav-mcp
// wraps such a failure in turn).
function networkCause(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (typeof current.code === 'string' && NETWORK_CAUSES.has(current.code)) return current.code;
  }
  return null;
}

/**
 * The MCP code of an error, and a hint where the user fixes it.
 *
 * Only what an error is, never what its message says: the message usually
 * carries a URL, and a calendar on caldav.icloud.com or one called
 * "author-notes" read as a CalDAV or auth error (#115). In order:
 * - an explicit numeric code (dav-mcp's typed errors set one);
 * - dav-mcp's error classes by name;
 * - errors tsdav throws for an error status (@philflow/tsdav 2.5.0): a
 *   refused login (DAVAuthenticationError, also mid-session, e.g. an OAuth
 *   refresh token that expired) and any other status (DAVResponseError);
 * - a DAV request dav-mcp checked itself (httpStatus);
 * - a fetch that never got an answer (its cause's network code);
 * - anything else is a fault of dav-mcp or a library: internal. A plain
 *   JavaScript TypeError is one of those, never the caller's input, since
 *   tool parameters are validated before a handler runs.
 *
 * @returns {{code: number, hint?: string}}
 */
function classify(error) {
  if (typeof error.code === 'number') {
    return { code: error.code };
  }
  if (error.name && ERROR_TYPE_MAP[error.name]) {
    return { code: ERROR_TYPE_MAP[error.name] };
  }
  if (isDAVAuthenticationError(error)) {
    return { code: MCP_ERROR_CODES.AUTH_ERROR, hint: settingsHint(configuredAuthMethod()) };
  }
  if (isDAVResponseError(error) && Number.isInteger(error.status)) {
    return { code: codeForHttpStatus(error.status) };
  }
  if (Number.isInteger(error.httpStatus)) {
    // A 401 once logged in: the password was changed or revoked since (#123).
    return {
      code: codeForHttpStatus(error.httpStatus),
      ...(error.httpStatus === 401 && { hint: settingsHint(configuredAuthMethod()) }),
    };
  }
  const cause = networkCause(error);
  if (cause) {
    return {
      code: MCP_ERROR_CODES.NETWORK_ERROR,
      hint: `The DAV server could not be reached (${cause}). ${settingsHint(configuredAuthMethod())}`,
    };
  }
  return { code: MCP_ERROR_CODES.INTERNAL_ERROR };
}

/**
 * Format error into MCP-compliant structure
 */
export function formatMCPError(error, includeStack = false) {
  const { code, hint } = classify(error);
  const message = error.message || 'An error occurred';

  const errorResponse = {
    code,
    message: hint ? `${message.replace(/\.?$/, '.')} ${hint}` : message,
    data: {
      type: error.name || 'Error',
      ...(error.details && { details: error.details }),
      ...(includeStack && error.stack && { stack: error.stack }),
    },
  };

  return errorResponse;
}

/**
 * Create MCP tool error response
 */
export function createToolErrorResponse(error, includeStack = false) {
  const mcpError = formatMCPError(error, includeStack);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(mcpError, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Create HTTP error response
 */
export function createHTTPErrorResponse(error, statusCode = null) {
  const mcpError = formatMCPError(error, process.env.NODE_ENV === 'development');

  // Map MCP error codes to HTTP status codes
  const defaultStatusCode = statusCode || mapMCPCodeToHTTPStatus(mcpError.code);

  return {
    statusCode: defaultStatusCode,
    body: {
      error: mcpError.message,
      code: mcpError.code,
      ...mcpError.data,
    },
  };
}

/**
 * Map MCP error codes to HTTP status codes
 */
function mapMCPCodeToHTTPStatus(code) {
  switch (code) {
    case MCP_ERROR_CODES.PARSE_ERROR:
    case MCP_ERROR_CODES.INVALID_REQUEST:
    case MCP_ERROR_CODES.INVALID_PARAMS:
    case MCP_ERROR_CODES.VALIDATION_ERROR:
      return 400; // Bad Request

    case MCP_ERROR_CODES.METHOD_NOT_FOUND:
    case MCP_ERROR_CODES.NOT_FOUND_ERROR:
      return 404; // Not Found

    case MCP_ERROR_CODES.AUTH_ERROR:
      return 401; // Unauthorized

    case MCP_ERROR_CODES.CONFLICT_ERROR:
      return 409; // Conflict

    case MCP_ERROR_CODES.TIMEOUT_ERROR:
      return 408; // Request Timeout

    case MCP_ERROR_CODES.NETWORK_ERROR:
      return 502; // Bad Gateway

    case MCP_ERROR_CODES.CALDAV_ERROR:
    case MCP_ERROR_CODES.CARDDAV_ERROR:
    case MCP_ERROR_CODES.INTERNAL_ERROR:
    default:
      return 500; // Internal Server Error
  }
}

/**
 * Custom error classes
 */
export class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.code = MCP_ERROR_CODES.VALIDATION_ERROR;
    this.details = details;
  }
}

export class AuthenticationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = MCP_ERROR_CODES.AUTH_ERROR;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'NotFoundError';
    this.code = MCP_ERROR_CODES.NOT_FOUND_ERROR;
    this.details = details;
  }
}

export class CalDAVError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'CalDAVError';
    this.code = MCP_ERROR_CODES.CALDAV_ERROR;
    this.details = details;
  }
}

export class CardDAVError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'CardDAVError';
    this.code = MCP_ERROR_CODES.CARDDAV_ERROR;
    this.details = details;
  }
}

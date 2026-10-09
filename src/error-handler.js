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
};

/**
 * Map the HTTP status a DAV server answered with to an MCP error code.
 * Statuses without a more specific meaning are internal errors, as before.
 */
function codeForHttpStatus(status) {
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

/**
 * Get error code based on error type or message
 */
function getErrorCode(error) {
  // Check if error has explicit code
  if (error.code && typeof error.code === 'number') {
    return error.code;
  }

  // Map by error type
  if (error.name && ERROR_TYPE_MAP[error.name]) {
    return ERROR_TYPE_MAP[error.name];
  }

  // A rejected DAV request carries the server's status. Its message also
  // carries the URL, so the substring guesses below would read a calendar
  // called "author-notes" as an auth error, or one with "404" in its name as
  // not found.
  if (Number.isInteger(error.httpStatus)) {
    return codeForHttpStatus(error.httpStatus);
  }

  // Nothing is read from the message: it usually carries a URL, and a
  // calendar on caldav.icloud.com or one called "author-notes" read as a
  // CalDAV or auth error (#115). An error without a code, type or status is
  // a fault of dav-mcp or a library. A JavaScript TypeError is one of those
  // too (fetch rejects with one): tool parameters are validated before a
  // handler runs, so it is never the caller's input.
  // Default to internal error
  return MCP_ERROR_CODES.INTERNAL_ERROR;
}

/**
 * Format error into MCP-compliant structure
 */
export function formatMCPError(error, includeStack = false) {
  const code = getErrorCode(error);

  const errorResponse = {
    code,
    message: error.message || 'An error occurred',
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

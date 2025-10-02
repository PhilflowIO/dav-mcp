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
  'TypeError': MCP_ERROR_CODES.INVALID_PARAMS,
  'ValidationError': MCP_ERROR_CODES.VALIDATION_ERROR,
  'AuthenticationError': MCP_ERROR_CODES.AUTH_ERROR,
  'NetworkError': MCP_ERROR_CODES.NETWORK_ERROR,
  'TimeoutError': MCP_ERROR_CODES.TIMEOUT_ERROR,
  'NotFoundError': MCP_ERROR_CODES.NOT_FOUND_ERROR,
  'ConflictError': MCP_ERROR_CODES.CONFLICT_ERROR,
};

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

  // Check error message for CalDAV/CardDAV specific errors
  const message = error.message?.toLowerCase() || '';
  if (message.includes('caldav')) {
    return MCP_ERROR_CODES.CALDAV_ERROR;
  }
  if (message.includes('carddav')) {
    return MCP_ERROR_CODES.CARDDAV_ERROR;
  }
  if (message.includes('auth') || message.includes('unauthorized') || message.includes('forbidden')) {
    return MCP_ERROR_CODES.AUTH_ERROR;
  }
  if (message.includes('not found') || message.includes('404')) {
    return MCP_ERROR_CODES.NOT_FOUND_ERROR;
  }
  if (message.includes('timeout')) {
    return MCP_ERROR_CODES.TIMEOUT_ERROR;
  }
  if (message.includes('network') || message.includes('connection')) {
    return MCP_ERROR_CODES.NETWORK_ERROR;
  }
  if (message.includes('validation') || message.includes('invalid')) {
    return MCP_ERROR_CODES.VALIDATION_ERROR;
  }

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

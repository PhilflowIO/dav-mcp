import { describe, test, expect } from '@jest/globals';
import {
  MCP_ERROR_CODES,
  formatMCPError,
  createToolErrorResponse,
  createHTTPErrorResponse,
  ValidationError,
  AuthenticationError,
  CalDAVError,
  CardDAVError
} from '../src/error-handler.js';
import { assertDavSuccess } from '../src/tools/shared/helpers.js';

describe('Error Handler Module', () => {
  describe('MCP_ERROR_CODES', () => {
    test('should have standard JSON-RPC error codes', () => {
      expect(MCP_ERROR_CODES.PARSE_ERROR).toBe(-32700);
      expect(MCP_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
      expect(MCP_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
      expect(MCP_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
      expect(MCP_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
    });

    test('should have custom application error codes', () => {
      expect(MCP_ERROR_CODES.CALDAV_ERROR).toBe(-32000);
      expect(MCP_ERROR_CODES.CARDDAV_ERROR).toBe(-32001);
      expect(MCP_ERROR_CODES.VALIDATION_ERROR).toBe(-32002);
      expect(MCP_ERROR_CODES.AUTH_ERROR).toBe(-32003);
    });
  });

  describe('Custom Error Classes', () => {
    test('ValidationError should have correct properties', () => {
      const error = new ValidationError('Test validation error', { field: 'test' });
      expect(error.name).toBe('ValidationError');
      expect(error.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
      expect(error.message).toBe('Test validation error');
      expect(error.details).toEqual({ field: 'test' });
    });

    test('AuthenticationError should have correct properties', () => {
      const error = new AuthenticationError('Unauthorized');
      expect(error.name).toBe('AuthenticationError');
      expect(error.code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
    });

    test('CalDAVError should have correct properties', () => {
      const error = new CalDAVError('CalDAV connection failed');
      expect(error.name).toBe('CalDAVError');
      expect(error.code).toBe(MCP_ERROR_CODES.CALDAV_ERROR);
    });

    test('CardDAVError should have correct properties', () => {
      const error = new CardDAVError('CardDAV connection failed');
      expect(error.name).toBe('CardDAVError');
      expect(error.code).toBe(MCP_ERROR_CODES.CARDDAV_ERROR);
    });
  });

  describe('formatMCPError', () => {
    test('should format error with explicit code', () => {
      const error = new Error('Test error');
      error.code = MCP_ERROR_CODES.INVALID_REQUEST;

      const formatted = formatMCPError(error);

      expect(formatted.code).toBe(MCP_ERROR_CODES.INVALID_REQUEST);
      expect(formatted.message).toBe('Test error');
      expect(formatted.data.type).toBe('Error');
    });

    test('should include stack trace when requested', () => {
      const error = new Error('Test error');

      const formatted = formatMCPError(error, true);

      expect(formatted.data.stack).toBeDefined();
      expect(typeof formatted.data.stack).toBe('string');
    });

    test('should not include stack trace by default', () => {
      const error = new Error('Test error');

      const formatted = formatMCPError(error, false);

      expect(formatted.data.stack).toBeUndefined();
    });

    // An error that carries no code, type or HTTP status is a fault of
    // dav-mcp or a library, never guessed from its wording (#115): the
    // message usually holds a URL, and on caldav.icloud.com or a calendar
    // called "author-notes" the guess was a CalDAV or auth error.
    test.each([
      ['caldav connection failed'],
      ['Calendar not found: https://caldav.example.com/calendars/u/x/'],
      ['request to https://dav.example.com/author-notes/ returned 404'],
      ['invalid time value'],
      ['connection timeout'],
    ])('an untyped error is internal, whatever it says: %s', (message) => {
      expect(formatMCPError(new Error(message)).code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
    });

    test('a JavaScript TypeError is internal, not invalid params', () => {
      // fetch rejects with TypeError('fetch failed'); a bug throws one too.
      // Tool parameters are validated before a handler runs.
      expect(formatMCPError(new TypeError('fetch failed')).code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
    });
  });

  describe('createToolErrorResponse', () => {
    test('should create MCP-compliant error response', () => {
      const error = new ValidationError('Invalid input');

      const response = createToolErrorResponse(error);

      expect(response.isError).toBe(true);
      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe('text');

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
      expect(parsed.message).toBe('Invalid input');
    });
  });

  describe('createHTTPErrorResponse', () => {
    test('should map validation error to 400', () => {
      const error = new ValidationError('Invalid input');

      const response = createHTTPErrorResponse(error);

      expect(response.statusCode).toBe(400);
      expect(response.body.error).toBe('Invalid input');
      expect(response.body.code).toBe(MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    test('should map auth error to 401', () => {
      const error = new AuthenticationError('Unauthorized');

      const response = createHTTPErrorResponse(error);

      expect(response.statusCode).toBe(401);
    });

    test('should map method not found to 404', () => {
      const error = new Error('Tool not found');
      error.code = MCP_ERROR_CODES.METHOD_NOT_FOUND;

      const response = createHTTPErrorResponse(error);

      expect(response.statusCode).toBe(404);
    });

    test('should use custom status code if provided', () => {
      const error = new Error('Custom error');

      const response = createHTTPErrorResponse(error, 418);

      expect(response.statusCode).toBe(418);
    });
  });

  describe('DAV failures', () => {
    // The message of a rejected DAV request contains the URL, so a slug can
    // contain any of the words the message heuristics look for.
    const rejected = (status, statusText, url) =>
      assertDavSuccess([{ ok: false, status, statusText, raw: '', href: url }], `create calendar ${url}`)
        .catch(e => e);

    test('a URL containing "author" is not an auth error', async () => {
      const error = await rejected(500, 'Internal Server Error', 'https://dav.example.com/calendars/u/author-notes/');
      expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
    });

    test.each([
      // a bare 405 is "not supported here"; a confirmed collision is make_calendar's call
      [405, 'Method Not Allowed', 'INVALID_REQUEST'],
      [409, 'Conflict', 'CONFLICT_ERROR'],
      [412, 'Precondition Failed', 'CONFLICT_ERROR'],
      [423, 'Locked', 'CONFLICT_ERROR'],
      [429, 'Too Many Requests', 'NETWORK_ERROR'],
      [502, 'Bad Gateway', 'NETWORK_ERROR'],
      [503, 'Service Unavailable', 'NETWORK_ERROR'],
      [504, 'Gateway Timeout', 'TIMEOUT_ERROR'],
      [507, 'Insufficient Storage', 'INTERNAL_ERROR'],
    ])('%i %s maps to %s', async (status, statusText, code) => {
      const error = await rejected(status, statusText, 'https://dav.example.com/calendars/u/work/');
      expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES[code]);
    });

    test('a URL containing "404" is not a not-found error', async () => {
      const error = await rejected(412, 'Precondition Failed', 'https://dav.example.com/calendars/u/room-404/');
      expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.CONFLICT_ERROR);
    });

    test('the status decides, whatever the URL says', async () => {
      const forbidden = await rejected(403, 'Forbidden', 'https://dav.example.com/calendars/u/404-timeout/');
      expect(formatMCPError(forbidden).code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
      const missing = await rejected(404, 'Not Found', 'https://dav.example.com/calendars/u/author/');
      expect(formatMCPError(missing).code).toBe(MCP_ERROR_CODES.NOT_FOUND_ERROR);
    });
  });
});

// Errors tsdav throws carry their status in a typed error (@philflow/tsdav
// 2.5.0), not in a numeric code; they are classified by tsdav's guards and
// that status, never by the message (review of #134).
const tsdav = await import('tsdav');

describe('errors tsdav throws', () => {
  const SETTINGS = 'Configure options';

  test('a refused login mid-session (OAuth refresh: invalid_grant 400) is an auth error with the settings hint', () => {
    const error = new tsdav.DAVAuthenticationError(
      'OAuth authentication failed: token endpoint returned no access token',
      { status: 400, url: 'https://oauth2.googleapis.com/token' },
    );
    const formatted = formatMCPError(error);
    expect(formatted.code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
    expect(formatted.message).toContain('OAuth authentication failed');
  });

  test.each([
    ['Calendar discovery failed: 401 Unauthorized', 401, 'AUTH_ERROR'],
    ['Collection query failed: 401 Unauthorized. Raw response: ...', 401, 'AUTH_ERROR'],
  ])('%s → %s with the settings hint', (message, status, code) => {
    const error = new tsdav.DAVAuthenticationError(message, { status, url: 'https://dav.example.com/calendars/u/' });
    const formatted = formatMCPError(error);
    expect(formatted.code).toBe(MCP_ERROR_CODES[code]);
    expect(formatted.message).toContain(message);
    expect(formatted.message).toContain(SETTINGS);
  });

  test.each([
    [403, 'AUTH_ERROR'],
    [404, 'NOT_FOUND_ERROR'],
    [409, 'CONFLICT_ERROR'],
    [429, 'NETWORK_ERROR'],
    [500, 'INTERNAL_ERROR'],
  ])('a DAVResponseError with status %i is %s, without the password hint', (status, code) => {
    const error = new tsdav.DAVResponseError(`fetchCalendars: ${status} x`, { status, url: 'https://dav.example.com/' });
    const formatted = formatMCPError(error);
    expect(formatted.code).toBe(MCP_ERROR_CODES[code]);
    expect(formatted.message).not.toContain(SETTINGS);
  });

  test('a copy from another bundle is recognised by its code', () => {
    const copy = Object.assign(new Error('Collection query failed: 401'), {
      code: 'TSDAV_AUTHENTICATION_FAILED', status: 401, url: 'u',
    });
    expect(formatMCPError(copy).code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
  });

  test('a write refused with 401 by dav-mcp\'s own check gets the hint once', () => {
    const error = Object.assign(new Error('Failed to update event x: server responded 401 Unauthorized'), { httpStatus: 401 });
    const message = formatMCPError(error).message;
    expect(message.split(SETTINGS)).toHaveLength(2);
  });
});

describe('a server that cannot be reached', () => {
  const failed = (code) => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`connect ${code}`), { code }),
  });

  test.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])(
    'fetch failed (%s) is a network error naming the server URL setting', (code) => {
      const formatted = formatMCPError(failed(code));
      expect(formatted.code).toBe(MCP_ERROR_CODES.NETWORK_ERROR);
      expect(formatted.message).toContain(code);
      expect(formatted.message).toContain('server URL');
    });

  test('a TypeError without a network cause stays internal', () => {
    expect(formatMCPError(new TypeError("Cannot read properties of undefined (reading 'x')")).code)
      .toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });
});

test('a ConfigurationError has its own code, not an internal error', async () => {
  const { ConfigurationError } = await import('../src/auth-config.js');
  expect(MCP_ERROR_CODES.CONFIGURATION_ERROR).toBe(-32008);
  expect(formatMCPError(new ConfigurationError('Unsupported AUTH_METHOD')).code).toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
});

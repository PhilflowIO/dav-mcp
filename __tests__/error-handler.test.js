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

    test('should detect error type from message', () => {
      const error = new Error('caldav connection failed');

      const formatted = formatMCPError(error);

      expect(formatted.code).toBe(MCP_ERROR_CODES.CALDAV_ERROR);
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
});

import { describe, test, expect } from '@jest/globals';
import { logger, createContextLogger, createRequestLogger, createSessionLogger } from '../src/logger.js';

describe('Logger Module', () => {
  test('logger should be defined', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  test('createContextLogger should create child logger with context', () => {
    const childLogger = createContextLogger({ module: 'test' });
    expect(childLogger).toBeDefined();
    expect(typeof childLogger.info).toBe('function');
  });

  test('createRequestLogger should create child logger with requestId', () => {
    const requestLogger = createRequestLogger('req-123');
    expect(requestLogger).toBeDefined();
    expect(typeof requestLogger.info).toBe('function');
  });

  test('createRequestLogger should accept additional context', () => {
    const requestLogger = createRequestLogger('req-123', { userId: 'user-456' });
    expect(requestLogger).toBeDefined();
  });

  test('createSessionLogger should create child logger with sessionId', () => {
    const sessionLogger = createSessionLogger('session-789');
    expect(sessionLogger).toBeDefined();
    expect(typeof sessionLogger.info).toBe('function');
  });

  test('createSessionLogger should accept additional context', () => {
    const sessionLogger = createSessionLogger('session-789', { ip: '127.0.0.1' });
    expect(sessionLogger).toBeDefined();
  });
});

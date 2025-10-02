import pino from 'pino';

/**
 * Create and configure Pino logger
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    }
  } : undefined,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create child logger with context
 */
export function createContextLogger(context) {
  return logger.child(context);
}

/**
 * Create logger with request ID for tracing
 */
export function createRequestLogger(requestId, additionalContext = {}) {
  return logger.child({
    requestId,
    ...additionalContext,
  });
}

/**
 * Create logger with session ID for tracing
 */
export function createSessionLogger(sessionId, additionalContext = {}) {
  return logger.child({
    sessionId,
    ...additionalContext,
  });
}

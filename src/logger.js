/**
 * Simple JSON logger with millisecond precision
 * Outputs structured JSON logs to stdout
 */

class JSONLogger {
  constructor(context = {}, level = 'info') {
    this.context = context;
    this.level = level;
    this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
    this.minLevel = this.levels[process.env.LOG_LEVEL?.toLowerCase() || 'info'] || 2;
  }

  /**
   * Format timestamp with milliseconds (HH:MM:ss.mmm)
   */
  formatTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${milliseconds}`;
  }

  /**
   * Log a message at the specified level
   */
  log(level, objOrMsg, msg) {
    // Check if level should be logged
    if (this.levels[level] > this.minLevel) {
      return;
    }

    const timestamp = this.formatTimestamp();
    let logData = {
      time: timestamp,
      level: level.toUpperCase(),
      ...this.context,
    };

    // Handle both log(level, obj, msg) and log(level, msg) patterns
    if (typeof objOrMsg === 'string') {
      logData.msg = objOrMsg;
    } else if (typeof objOrMsg === 'object' && objOrMsg !== null) {
      logData = { ...logData, ...objOrMsg };
      if (msg) {
        logData.msg = msg;
      }
    }

    // Pretty-print in development, single-line JSON in production
    if (process.env.NODE_ENV !== 'production') {
      // Development: colored output with readable format
      const colorMap = {
        error: '\x1b[31m', // Red
        warn: '\x1b[33m',  // Yellow
        info: '\x1b[32m',  // Green
        debug: '\x1b[36m', // Cyan
      };
      const reset = '\x1b[0m';
      const color = colorMap[level] || '';

      const { time, level: lvl, msg: message, ...rest } = logData;
      const extraFields = Object.keys(rest).length > 0
        ? ' ' + JSON.stringify(rest)
        : '';

      console.log(`[${time}] ${color}${lvl}${reset}: ${message || ''}${extraFields}`);
    } else {
      // Production: single-line JSON
      console.log(JSON.stringify(logData));
    }
  }

  info(objOrMsg, msg) {
    this.log('info', objOrMsg, msg);
  }

  warn(objOrMsg, msg) {
    this.log('warn', objOrMsg, msg);
  }

  error(objOrMsg, msg) {
    this.log('error', objOrMsg, msg);
  }

  debug(objOrMsg, msg) {
    this.log('debug', objOrMsg, msg);
  }

  /**
   * Create child logger with additional context
   */
  child(additionalContext) {
    return new JSONLogger(
      { ...this.context, ...additionalContext },
      this.level
    );
  }
}

/**
 * Main logger instance
 */
export const logger = new JSONLogger();

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

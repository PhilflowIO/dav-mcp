/**
 * Robust Test Validator
 *
 * Production-ready validator for MCP tool call parameters with intelligent
 * type detection, flexible matching, and comprehensive error handling.
 *
 * Features:
 * - Null/undefined handling with smart defaults
 * - Flexible date/time validation with timezone support
 * - Server-agnostic URL validation
 * - Automatic field type detection
 * - Partial string matching for filters
 * - Detailed logging for debugging
 *
 * @module robust-validator
 */

const fs = require('fs');
const path = require('path');

/**
 * Logger for validation operations
 */
class ValidationLogger {
  constructor(verbose = false) {
    this.verbose = verbose;
    this.logs = [];
  }

  log(level, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...data
    };
    this.logs.push(entry);

    if (this.verbose || level === 'error') {
      console.log(`[${level.toUpperCase()}] ${message}`, data);
    }
  }

  info(message, data) {
    this.log('info', message, data);
  }

  warn(message, data) {
    this.log('warn', message, data);
  }

  error(message, data) {
    this.log('error', message, data);
  }

  debug(message, data) {
    this.log('debug', message, data);
  }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
  }
}

/**
 * Date/Time Validator
 * Handles flexible date validation with timezone support
 */
class DateValidator {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Parse relative date strings like "tomorrow", "next week"
   */
  parseRelativeDate(dateStr) {
    const now = new Date();
    const lower = dateStr.toLowerCase().trim();

    // Today
    if (lower === 'today') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    // Tomorrow
    if (lower === 'tomorrow') {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
    }

    // Yesterday
    if (lower === 'yesterday') {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
    }

    // Next week
    if (lower === 'next week') {
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + 7);
      return new Date(nextWeek.getFullYear(), nextWeek.getMonth(), nextWeek.getDate());
    }

    // Last week
    if (lower === 'last week') {
      const lastWeek = new Date(now);
      lastWeek.setDate(lastWeek.getDate() - 7);
      return new Date(lastWeek.getFullYear(), lastWeek.getMonth(), lastWeek.getDate());
    }

    return null;
  }

  /**
   * Parse date string to Date object
   */
  parseDate(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;

    // Try relative date first
    const relativeDate = this.parseRelativeDate(dateStr);
    if (relativeDate) return relativeDate;

    // Try ISO string
    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date;
      }
    } catch (e) {
      this.logger.debug('Failed to parse date as ISO string', { dateStr, error: e.message });
    }

    // Try common formats
    const formats = [
      // YYYY-MM-DD
      /^(\d{4})-(\d{2})-(\d{2})$/,
      // DD.MM.YYYY
      /^(\d{2})\.(\d{2})\.(\d{4})$/,
      // MM/DD/YYYY
      /^(\d{2})\/(\d{2})\/(\d{4})$/
    ];

    for (const format of formats) {
      const match = dateStr.match(format);
      if (match) {
        try {
          let year, month, day;
          if (format.source.startsWith('^(\\d{4})')) {
            // YYYY-MM-DD
            [, year, month, day] = match;
          } else if (format.source.includes('\\.')) {
            // DD.MM.YYYY
            [, day, month, year] = match;
          } else {
            // MM/DD/YYYY
            [, month, day, year] = match;
          }
          const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
          if (!isNaN(date.getTime())) {
            return date;
          }
        } catch (e) {
          this.logger.debug('Failed to parse date with format', { dateStr, format: format.source, error: e.message });
        }
      }
    }

    return null;
  }

  /**
   * Compare dates ignoring time component
   */
  compareDateOnly(date1, date2) {
    const d1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
    const d2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());
    return d1.getTime() === d2.getTime();
  }

  /**
   * Compare dates with flexible timezone handling
   */
  compareDates(actual, expected, fieldName) {
    const actualDate = this.parseDate(actual);
    const expectedDate = this.parseDate(expected);

    if (!actualDate && !expectedDate) {
      this.logger.debug('Both dates are null/invalid', { fieldName, actual, expected });
      return true;
    }

    if (!actualDate || !expectedDate) {
      this.logger.warn('One date is null/invalid', {
        fieldName,
        actual,
        expected,
        actualParsed: actualDate,
        expectedParsed: expectedDate
      });
      return false;
    }

    // For date-only fields (dtstart, dtend without time), compare date only
    // Check if either actual OR expected is date-only (without time)
    const actualIsDateOnly = !actual.includes('T') && !actual.includes(':');
    const expectedIsDateOnly = !expected.includes('T') && !expected.includes(':');
    const isDateOnly = actualIsDateOnly || expectedIsDateOnly;

    if (isDateOnly) {
      const result = this.compareDateOnly(actualDate, expectedDate);
      this.logger.debug('Date-only comparison', {
        fieldName,
        actual,
        expected,
        actualIsDateOnly,
        expectedIsDateOnly,
        result
      });
      return result;
    }

    // For datetime fields, allow 1-hour difference (timezone tolerance)
    const diffMs = Math.abs(actualDate.getTime() - expectedDate.getTime());
    const diffHours = diffMs / (1000 * 60 * 60);
    const result = diffHours <= 1;

    this.logger.debug('DateTime comparison', {
      fieldName,
      actual,
      expected,
      diffHours,
      result
    });

    return result;
  }

  /**
   * Validate date field
   */
  validate(actual, expected, fieldName) {
    // Handle null/undefined
    if (actual === null || actual === undefined) {
      if (expected === null || expected === undefined) {
        return true;
      }
      this.logger.warn('Actual date is null but expected is not', { fieldName, expected });
      return false;
    }

    return this.compareDates(actual, expected, fieldName);
  }
}

/**
 * URL Validator
 * Handles server-agnostic URL validation for CalDAV/CardDAV
 */
class URLValidator {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Extract path from URL
   */
  extractPath(url) {
    if (!url) return null;

    try {
      const urlObj = new URL(url);
      return urlObj.pathname;
    } catch (e) {
      // If not a full URL, assume it's already a path
      if (url.startsWith('/')) {
        return url;
      }
      this.logger.debug('Failed to parse URL, treating as path', { url });
      return url;
    }
  }

  /**
   * Check if path is a valid CalDAV/CardDAV path
   */
  isValidPath(path) {
    if (!path) return false;

    // CalDAV patterns
    const calDavPatterns = [
      /\/calendars\//,
      /\/calendar\//,
      /\/cal\//,
      /\.ics$/
    ];

    // CardDAV patterns
    const cardDavPatterns = [
      /\/addressbooks\//,
      /\/addressbook\//,
      /\/contacts\//,
      /\.vcf$/
    ];

    const allPatterns = [...calDavPatterns, ...cardDavPatterns];

    for (const pattern of allPatterns) {
      if (pattern.test(path)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Compare URL paths
   */
  comparePaths(actual, expected) {
    const actualPath = this.extractPath(actual);
    const expectedPath = this.extractPath(expected);

    if (!actualPath && !expectedPath) {
      return true;
    }

    if (!actualPath || !expectedPath) {
      return false;
    }

    // Normalize paths (remove trailing slashes, etc.)
    const normalizePath = (p) => p.replace(/\/+$/, '').replace(/\/+/g, '/');

    const normalizedActual = normalizePath(actualPath);
    const normalizedExpected = normalizePath(expectedPath);

    return normalizedActual === normalizedExpected;
  }

  /**
   * Validate URL field
   */
  validate(actual, expected, fieldName) {
    // Handle null/undefined
    if (actual === null || actual === undefined) {
      if (expected === null || expected === undefined) {
        return true;
      }
      this.logger.warn('Actual URL is null but expected is not', { fieldName, expected });
      return false;
    }

    // Compare paths only (server-agnostic)
    const pathsMatch = this.comparePaths(actual, expected);

    if (!pathsMatch) {
      this.logger.warn('URL paths do not match', {
        fieldName,
        actual,
        expected,
        actualPath: this.extractPath(actual),
        expectedPath: this.extractPath(expected)
      });
      return false;
    }

    // Validate that it's a CalDAV/CardDAV URL
    const actualPath = this.extractPath(actual);
    const isValid = this.isValidPath(actualPath);

    if (!isValid) {
      this.logger.warn('URL path does not look like CalDAV/CardDAV', {
        fieldName,
        actual,
        actualPath
      });
    }

    this.logger.debug('URL validation passed', { fieldName, actual, expected });
    return true;
  }
}

/**
 * String Validator
 * Handles partial matching for filters and descriptions
 */
class StringValidator {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Check if field should use partial matching
   */
  isPartialMatchField(fieldName) {
    const partialMatchPatterns = [
      /_filter$/,
      /^summary$/,
      /^description$/,
      /^note$/,
      /^search/,
      /query$/
    ];

    return partialMatchPatterns.some(pattern => pattern.test(fieldName));
  }

  /**
   * Validate string field
   */
  validate(actual, expected, fieldName) {
    // Handle null/undefined
    if (actual === null || actual === undefined) {
      if (expected === null || expected === undefined) {
        return true;
      }
      this.logger.warn('Actual string is null but expected is not', { fieldName, expected });
      return false;
    }

    // Normalize strings
    const normalizeString = (s) => {
      if (typeof s !== 'string') return String(s);
      return s.trim();
    };

    const actualNorm = normalizeString(actual);
    const expectedNorm = normalizeString(expected);

    // Partial match for filter fields
    if (this.isPartialMatchField(fieldName)) {
      const result = actualNorm.toLowerCase().includes(expectedNorm.toLowerCase());
      this.logger.debug('Partial string match', {
        fieldName,
        actual: actualNorm,
        expected: expectedNorm,
        result
      });
      return result;
    }

    // Exact match
    const result = actualNorm === expectedNorm;
    if (!result) {
      this.logger.warn('String exact match failed', {
        fieldName,
        actual: actualNorm,
        expected: expectedNorm
      });
    }
    return result;
  }
}

/**
 * Field Type Detector
 * Automatically detects field types based on naming patterns
 */
class FieldTypeDetector {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Detect field type
   * @returns {'date'|'url'|'string'|'exact'}
   */
  detectType(fieldName, value) {
    // Date fields
    const datePatterns = [
      /^dtstart$/i,
      /^dtend$/i,
      /^due$/i,
      /^completed$/i,
      /^created$/i,
      /^last_modified$/i,
      /^time_range_start$/i,
      /^time_range_end$/i,
      /_date$/i,
      /_time$/i
    ];

    for (const pattern of datePatterns) {
      if (pattern.test(fieldName)) {
        this.logger.debug('Detected date field', { fieldName });
        return 'date';
      }
    }

    // URL fields
    const urlPatterns = [
      /^calendar_url$/i,
      /^addressbook_url$/i,
      /^url$/i,
      /_url$/i,
      /_uri$/i,
      /^href$/i
    ];

    for (const pattern of urlPatterns) {
      if (pattern.test(fieldName)) {
        this.logger.debug('Detected URL field', { fieldName });
        return 'url';
      }
    }

    // String fields (filters, descriptions)
    if (typeof value === 'string') {
      this.logger.debug('Detected string field', { fieldName });
      return 'string';
    }

    // Default to exact match
    this.logger.debug('Using exact match for field', { fieldName, valueType: typeof value });
    return 'exact';
  }
}

/**
 * Main Robust Validator
 */
class RobustValidator {
  constructor(options = {}) {
    this.logger = new ValidationLogger(options.verbose || false);
    this.dateValidator = new DateValidator(this.logger);
    this.urlValidator = new URLValidator(this.logger);
    this.stringValidator = new StringValidator(this.logger);
    this.fieldDetector = new FieldTypeDetector(this.logger);
    this.strictMode = options.strictMode || false;
  }

  /**
   * Validate individual field
   */
  validateField(actual, expected, fieldName) {
    this.logger.debug('Validating field', { fieldName, actual, expected });

    // Detect field type
    const fieldType = this.fieldDetector.detectType(fieldName, expected);

    // Route to appropriate validator
    switch (fieldType) {
      case 'date':
        return this.dateValidator.validate(actual, expected, fieldName);

      case 'url':
        return this.urlValidator.validate(actual, expected, fieldName);

      case 'string':
        return this.stringValidator.validate(actual, expected, fieldName);

      case 'exact':
      default:
        // Exact match with type coercion
        if (actual === expected) return true;

        // Try string comparison
        if (String(actual) === String(expected)) {
          this.logger.debug('Exact match after string coercion', { fieldName, actual, expected });
          return true;
        }

        this.logger.warn('Exact match failed', { fieldName, actual, expected });
        return false;
    }
  }

  /**
   * Validate parameters object
   */
  validateParameters(actualParams, expectedParams) {
    this.logger.info('Starting parameter validation', {
      actualParams,
      expectedParams
    });

    // Handle null/undefined actualParams
    if (actualParams === null || actualParams === undefined) {
      // If expected is also empty/null, that's OK
      if (!expectedParams || Object.keys(expectedParams).length === 0) {
        this.logger.info('Both actual and expected params are empty/null - valid');
        return { valid: true, errors: [] };
      }

      // If expected has values, that's an error
      this.logger.error('Actual params are null/undefined but expected params exist', {
        expectedParams
      });
      return {
        valid: false,
        errors: ['Actual parameters are null/undefined but expected parameters exist']
      };
    }

    // If expectedParams is null/undefined, nothing to validate
    if (!expectedParams || Object.keys(expectedParams).length === 0) {
      this.logger.info('No expected params to validate');
      return { valid: true, errors: [] };
    }

    const errors = [];

    // Validate each expected field
    for (const [fieldName, expectedValue] of Object.entries(expectedParams)) {
      const actualValue = actualParams[fieldName];

      // Handle missing field
      if (actualValue === undefined) {
        // In strict mode, missing fields are errors
        if (this.strictMode) {
          const error = `Missing required field: ${fieldName}`;
          this.logger.error(error);
          errors.push(error);
          continue;
        }

        // In non-strict mode, missing fields are warnings
        this.logger.warn('Field missing in actual params', { fieldName, expectedValue });
        continue;
      }

      // Validate field
      const isValid = this.validateField(actualValue, expectedValue, fieldName);

      if (!isValid) {
        const error = `Field validation failed: ${fieldName} (expected: ${JSON.stringify(expectedValue)}, actual: ${JSON.stringify(actualValue)})`;
        this.logger.error(error);
        errors.push(error);
      }
    }

    const valid = errors.length === 0;
    this.logger.info('Validation complete', { valid, errorCount: errors.length });

    return { valid, errors };
  }

  /**
   * Get validation logs
   */
  getLogs() {
    return this.logger.getLogs();
  }

  /**
   * Clear logs
   */
  clearLogs() {
    this.logger.clear();
  }

  /**
   * Save logs to file
   */
  saveLogs(filePath) {
    const logs = this.getLogs();
    fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), 'utf8');
    this.logger.info('Logs saved to file', { filePath, logCount: logs.length });
  }
}

/**
 * Factory function for creating validator instances
 */
function createValidator(options = {}) {
  return new RobustValidator(options);
}

/**
 * Quick validation function for simple use cases
 */
function validate(actualParams, expectedParams, options = {}) {
  const validator = createValidator(options);
  return validator.validateParameters(actualParams, expectedParams);
}

// Export everything
module.exports = {
  RobustValidator,
  ValidationLogger,
  DateValidator,
  URLValidator,
  StringValidator,
  FieldTypeDetector,
  createValidator,
  validate
};

// CLI usage
if (require.main === module) {
  console.log('Robust Validator - Usage Examples\n');

  // Example 1: Simple validation
  console.log('Example 1: Simple validation');
  const result1 = validate(
    { calendar_url: 'http://server1.com/calendars/user/cal', summary: 'Meeting' },
    { calendar_url: 'http://server2.com/calendars/user/cal', summary: 'Meet' }
  );
  console.log('Result:', result1);
  console.log();

  // Example 2: Date validation
  console.log('Example 2: Date validation');
  const result2 = validate(
    { dtstart: '2025-01-15T10:00:00Z', dtend: 'tomorrow' },
    { dtstart: '2025-01-15', dtend: new Date(Date.now() + 86400000).toISOString() }
  );
  console.log('Result:', result2);
  console.log();

  // Example 3: Null handling
  console.log('Example 3: Null handling');
  const result3 = validate(null, {});
  console.log('Result:', result3);
  console.log();

  // Example 4: With logging
  console.log('Example 4: With verbose logging');
  const validator = createValidator({ verbose: true });
  const result4 = validator.validateParameters(
    { summary_filter: 'important meeting' },
    { summary_filter: 'meeting' }
  );
  console.log('Result:', result4);
  console.log('\nLogs saved to: ./validation-logs.json');
  validator.saveLogs('./validation-logs.json');
}

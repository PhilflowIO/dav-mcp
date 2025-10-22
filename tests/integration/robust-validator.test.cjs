/**
 * Tests for Robust Validator
 *
 * Comprehensive test suite covering all validation scenarios
 */

const {
  RobustValidator,
  DateValidator,
  URLValidator,
  StringValidator,
  FieldTypeDetector,
  ValidationLogger,
  createValidator,
  validate
} = require('./robust-validator.cjs');

/**
 * Test helper for assertions
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

/**
 * Test Suite Runner
 */
class TestSuite {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.results = {
      passed: 0,
      failed: 0,
      errors: []
    };
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running Test Suite: ${this.name}`);
    console.log('='.repeat(60));

    for (const test of this.tests) {
      try {
        await test.fn();
        this.results.passed++;
        console.log(`✓ ${test.name}`);
      } catch (error) {
        this.results.failed++;
        this.results.errors.push({ test: test.name, error: error.message });
        console.log(`✗ ${test.name}`);
        console.log(`  Error: ${error.message}`);
      }
    }

    console.log(`\n${'-'.repeat(60)}`);
    console.log(`Results: ${this.results.passed} passed, ${this.results.failed} failed`);
    console.log('-'.repeat(60) + '\n');

    return this.results;
  }
}

// ============================================================================
// Date Validator Tests
// ============================================================================

async function testDateValidator() {
  const suite = new TestSuite('DateValidator');
  const logger = new ValidationLogger(false);
  const validator = new DateValidator(logger);

  suite.test('should parse relative date "tomorrow"', () => {
    const date = validator.parseRelativeDate('tomorrow');
    assert(date !== null, 'Should parse tomorrow');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assertEqual(date.getDate(), tomorrow.getDate(), 'Should be tomorrow');
  });

  suite.test('should parse relative date "today"', () => {
    const date = validator.parseRelativeDate('today');
    assert(date !== null, 'Should parse today');
    const today = new Date();
    assertEqual(date.getDate(), today.getDate(), 'Should be today');
  });

  suite.test('should parse ISO date string', () => {
    const date = validator.parseDate('2025-01-15T10:00:00Z');
    assert(date !== null, 'Should parse ISO date');
    assertEqual(date.getFullYear(), 2025, 'Year should be 2025');
    assertEqual(date.getMonth(), 0, 'Month should be January');
    assertEqual(date.getDate(), 15, 'Day should be 15');
  });

  suite.test('should parse YYYY-MM-DD format', () => {
    const date = validator.parseDate('2025-01-15');
    assert(date !== null, 'Should parse YYYY-MM-DD');
    assertEqual(date.getFullYear(), 2025, 'Year should be 2025');
  });

  suite.test('should compare dates ignoring time', () => {
    const date1 = new Date('2025-01-15T10:00:00Z');
    const date2 = new Date('2025-01-15T18:00:00Z');
    const result = validator.compareDateOnly(date1, date2);
    assert(result === true, 'Should match on date only');
  });

  suite.test('should accept dates within 1-hour timezone tolerance', () => {
    const date1 = '2025-01-15T10:00:00Z';
    const date2 = '2025-01-15T10:30:00Z';
    const result = validator.compareDates(date1, date2, 'dtstart');
    assert(result === true, 'Should accept 30-minute difference');
  });

  suite.test('should handle null dates gracefully', () => {
    const result = validator.validate(null, null, 'dtstart');
    assert(result === true, 'Null dates should match');
  });

  suite.test('should reject mismatched null dates', () => {
    const result = validator.validate(null, '2025-01-15', 'dtstart');
    assert(result === false, 'Should reject null vs non-null');
  });

  return await suite.run();
}

// ============================================================================
// URL Validator Tests
// ============================================================================

async function testURLValidator() {
  const suite = new TestSuite('URLValidator');
  const logger = new ValidationLogger(false);
  const validator = new URLValidator(logger);

  suite.test('should extract path from full URL', () => {
    const path = validator.extractPath('http://server.com/calendars/user/cal');
    assertEqual(path, '/calendars/user/cal', 'Should extract path');
  });

  suite.test('should handle path-only string', () => {
    const path = validator.extractPath('/calendars/user/cal');
    assertEqual(path, '/calendars/user/cal', 'Should return path as-is');
  });

  suite.test('should validate CalDAV path', () => {
    const result = validator.isValidPath('/calendars/user/cal');
    assert(result === true, 'Should recognize CalDAV path');
  });

  suite.test('should validate CardDAV path', () => {
    const result = validator.isValidPath('/addressbooks/user/contacts');
    assert(result === true, 'Should recognize CardDAV path');
  });

  suite.test('should reject invalid path', () => {
    const result = validator.isValidPath('/some/random/path');
    assert(result === false, 'Should reject non-CalDAV/CardDAV path');
  });

  suite.test('should compare paths from different servers', () => {
    const url1 = 'http://server1.com/calendars/user/cal';
    const url2 = 'http://server2.com/calendars/user/cal';
    const result = validator.comparePaths(url1, url2);
    assert(result === true, 'Should match paths from different servers');
  });

  suite.test('should normalize paths with trailing slashes', () => {
    const url1 = 'http://server.com/calendars/user/cal/';
    const url2 = 'http://server.com/calendars/user/cal';
    const result = validator.comparePaths(url1, url2);
    assert(result === true, 'Should normalize trailing slashes');
  });

  suite.test('should handle null URLs gracefully', () => {
    const result = validator.validate(null, null, 'calendar_url');
    assert(result === true, 'Null URLs should match');
  });

  return await suite.run();
}

// ============================================================================
// String Validator Tests
// ============================================================================

async function testStringValidator() {
  const suite = new TestSuite('StringValidator');
  const logger = new ValidationLogger(false);
  const validator = new StringValidator(logger);

  suite.test('should detect partial match fields', () => {
    assert(validator.isPartialMatchField('summary_filter'), 'Should detect _filter suffix');
    assert(validator.isPartialMatchField('summary'), 'Should detect summary');
    assert(validator.isPartialMatchField('description'), 'Should detect description');
    assert(validator.isPartialMatchField('search_query'), 'Should detect search prefix');
  });

  suite.test('should perform partial match for filter fields', () => {
    const result = validator.validate('important meeting today', 'meeting', 'summary_filter');
    assert(result === true, 'Should match substring');
  });

  suite.test('should be case-insensitive for partial match', () => {
    const result = validator.validate('IMPORTANT MEETING', 'meeting', 'summary_filter');
    assert(result === true, 'Should be case-insensitive');
  });

  suite.test('should perform exact match for non-filter fields', () => {
    const result = validator.validate('exact value', 'exact value', 'regular_field');
    assert(result === true, 'Should match exactly');
  });

  suite.test('should reject non-matching exact strings', () => {
    const result = validator.validate('value1', 'value2', 'regular_field');
    assert(result === false, 'Should reject non-matching strings');
  });

  suite.test('should trim whitespace', () => {
    const result = validator.validate('  value  ', 'value', 'regular_field');
    assert(result === true, 'Should trim whitespace');
  });

  suite.test('should handle null strings gracefully', () => {
    const result = validator.validate(null, null, 'summary');
    assert(result === true, 'Null strings should match');
  });

  return await suite.run();
}

// ============================================================================
// Field Type Detector Tests
// ============================================================================

async function testFieldTypeDetector() {
  const suite = new TestSuite('FieldTypeDetector');
  const logger = new ValidationLogger(false);
  const detector = new FieldTypeDetector(logger);

  suite.test('should detect date fields', () => {
    assertEqual(detector.detectType('dtstart', '2025-01-15'), 'date', 'Should detect dtstart');
    assertEqual(detector.detectType('dtend', '2025-01-15'), 'date', 'Should detect dtend');
    assertEqual(detector.detectType('time_range_start', '2025-01-15'), 'date', 'Should detect time_range_start');
  });

  suite.test('should detect URL fields', () => {
    assertEqual(detector.detectType('calendar_url', 'http://...'), 'url', 'Should detect calendar_url');
    assertEqual(detector.detectType('addressbook_url', 'http://...'), 'url', 'Should detect addressbook_url');
    assertEqual(detector.detectType('url', 'http://...'), 'url', 'Should detect url');
  });

  suite.test('should detect string fields', () => {
    assertEqual(detector.detectType('summary', 'text'), 'string', 'Should detect string');
    assertEqual(detector.detectType('description', 'text'), 'string', 'Should detect string');
  });

  suite.test('should default to exact match', () => {
    assertEqual(detector.detectType('unknown_field', 123), 'exact', 'Should default to exact');
  });

  return await suite.run();
}

// ============================================================================
// Robust Validator Integration Tests
// ============================================================================

async function testRobustValidator() {
  const suite = new TestSuite('RobustValidator Integration');

  suite.test('should validate complete parameter set', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      {
        calendar_url: 'http://server1.com/calendars/user/cal',
        dtstart: '2025-01-15T10:00:00Z',
        summary: 'Team Meeting'
      },
      {
        calendar_url: 'http://server2.com/calendars/user/cal',
        dtstart: '2025-01-15',
        summary: 'Team Meeting'
      }
    );
    assert(result.valid === true, 'Should validate all fields');
  });

  suite.test('should handle null actualParams with empty expectedParams', () => {
    const result = validate(null, {});
    assert(result.valid === true, 'Should accept null with empty expected');
  });

  suite.test('should reject null actualParams with non-empty expectedParams', () => {
    const result = validate(null, { calendar_url: 'http://...' });
    assert(result.valid === false, 'Should reject null with non-empty expected');
  });

  suite.test('should handle undefined actualParams', () => {
    const result = validate(undefined, {});
    assert(result.valid === true, 'Should accept undefined with empty expected');
  });

  suite.test('should validate with flexible date matching', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      { dtstart: 'tomorrow' },
      { dtstart: new Date(Date.now() + 86400000).toISOString().split('T')[0] }
    );
    assert(result.valid === true, 'Should accept relative dates');
  });

  suite.test('should validate with server-agnostic URLs', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      { calendar_url: 'http://local.test/calendars/user/work' },
      { calendar_url: 'https://prod.com/calendars/user/work' }
    );
    assert(result.valid === true, 'Should ignore server differences');
  });

  suite.test('should validate partial string matches', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      { summary_filter: 'important client meeting with team' },
      { summary_filter: 'meeting' }
    );
    assert(result.valid === true, 'Should match partial strings');
  });

  suite.test('should collect validation errors', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      { calendar_url: 'http://server.com/wrong/path' },
      { calendar_url: 'http://server.com/calendars/user/cal' }
    );
    assert(result.valid === false, 'Should fail validation');
    assert(result.errors.length > 0, 'Should collect errors');
  });

  suite.test('should respect strict mode', () => {
    const validator = createValidator({ strictMode: true });
    const result = validator.validateParameters(
      { calendar_url: 'http://server.com/calendars/user/cal' },
      { calendar_url: 'http://server.com/calendars/user/cal', summary: 'required' }
    );
    assert(result.valid === false, 'Should fail in strict mode for missing field');
  });

  suite.test('should allow missing fields in non-strict mode', () => {
    const validator = createValidator({ strictMode: false });
    const result = validator.validateParameters(
      { calendar_url: 'http://server.com/calendars/user/cal' },
      { calendar_url: 'http://server.com/calendars/user/cal', summary: 'optional' }
    );
    assert(result.valid === true, 'Should pass in non-strict mode for missing field');
  });

  suite.test('should log validation details', () => {
    const validator = createValidator({ verbose: false });
    validator.validateParameters(
      { calendar_url: 'http://server.com/calendars/user/cal' },
      { calendar_url: 'http://server.com/calendars/user/cal' }
    );
    const logs = validator.getLogs();
    assert(logs.length > 0, 'Should collect logs');
  });

  return await suite.run();
}

// ============================================================================
// Real-World Scenarios
// ============================================================================

async function testRealWorldScenarios() {
  const suite = new TestSuite('Real-World Scenarios');

  suite.test('Scenario: Create calendar event with tomorrow', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      {
        calendar_url: 'http://localhost:8080/calendars/testuser/work',
        summary: 'Client Presentation',
        dtstart: 'tomorrow',
        dtend: 'tomorrow'
      },
      {
        calendar_url: '/calendars/testuser/work',
        summary: 'Client',
        dtstart: new Date(Date.now() + 86400000).toISOString().split('T')[0]
      }
    );
    assert(result.valid === true, 'Should validate event creation');
  });

  suite.test('Scenario: Search events with filter', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      {
        calendar_url: 'http://prod.server.com/calendars/user/personal',
        summary_filter: 'important team standup meeting'
      },
      {
        calendar_url: 'http://test.server.com/calendars/user/personal',
        summary_filter: 'meeting'
      }
    );
    assert(result.valid === true, 'Should validate search filter');
  });

  suite.test('Scenario: Null parameters on optional endpoint', () => {
    const validator = createValidator();
    const result = validator.validateParameters(null, {});
    assert(result.valid === true, 'Should accept null params when nothing expected');
  });

  suite.test('Scenario: Missing optional parameters', () => {
    const validator = createValidator({ strictMode: false });
    const result = validator.validateParameters(
      {
        calendar_url: 'http://server.com/calendars/user/cal',
        summary: 'Meeting'
      },
      {
        calendar_url: '/calendars/user/cal',
        summary: 'Meeting',
        description: 'Optional description',
        location: 'Optional location'
      }
    );
    assert(result.valid === true, 'Should pass with missing optional fields');
  });

  suite.test('Scenario: Cross-timezone event comparison', () => {
    const validator = createValidator();
    const result = validator.validateParameters(
      {
        dtstart: '2025-01-15T10:00:00+01:00',
        dtend: '2025-01-15T11:00:00+01:00'
      },
      {
        dtstart: '2025-01-15T09:00:00Z',
        dtend: '2025-01-15T10:00:00Z'
      }
    );
    assert(result.valid === true, 'Should handle timezone differences');
  });

  return await suite.run();
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log('\n' + '='.repeat(60));
  console.log('ROBUST VALIDATOR - COMPREHENSIVE TEST SUITE');
  console.log('='.repeat(60));

  const results = [];

  results.push(await testDateValidator());
  results.push(await testURLValidator());
  results.push(await testStringValidator());
  results.push(await testFieldTypeDetector());
  results.push(await testRobustValidator());
  results.push(await testRealWorldScenarios());

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('OVERALL SUMMARY');
  console.log('='.repeat(60));

  const total = {
    passed: results.reduce((sum, r) => sum + r.passed, 0),
    failed: results.reduce((sum, r) => sum + r.failed, 0)
  };

  console.log(`Total: ${total.passed + total.failed} tests`);
  console.log(`Passed: ${total.passed}`);
  console.log(`Failed: ${total.failed}`);

  if (total.failed > 0) {
    console.log('\nFailed Tests:');
    results.forEach((result, idx) => {
      if (result.errors.length > 0) {
        result.errors.forEach(error => {
          console.log(`  - ${error.test}: ${error.error}`);
        });
      }
    });
  }

  console.log('='.repeat(60) + '\n');

  return total.failed === 0;
}

// Run tests if executed directly
if (require.main === module) {
  runAllTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Test runner error:', error);
      process.exit(1);
    });
}

module.exports = {
  runAllTests,
  testDateValidator,
  testURLValidator,
  testStringValidator,
  testFieldTypeDetector,
  testRobustValidator,
  testRealWorldScenarios
};

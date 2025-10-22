#!/usr/bin/env node

/**
 * Robust Validator - Practical Examples
 *
 * This file demonstrates real-world usage of the robust validator
 * in various testing scenarios.
 */

const { createValidator, validate } = require('./robust-validator.cjs');

console.log('='.repeat(70));
console.log('ROBUST VALIDATOR - PRACTICAL EXAMPLES');
console.log('='.repeat(70) + '\n');

// ============================================================================
// Example 1: Simple Event Validation
// ============================================================================

console.log('Example 1: Simple Event Validation');
console.log('-'.repeat(70));

const example1Result = validate(
  {
    calendar_url: 'http://localhost:8080/calendars/testuser/work',
    summary: 'Team Standup',
    dtstart: '2025-01-15T09:00:00Z',
    dtend: '2025-01-15T09:30:00Z'
  },
  {
    calendar_url: '/calendars/testuser/work', // Server-agnostic
    summary: 'Team Standup',
    dtstart: '2025-01-15', // Date-only comparison
    dtend: '2025-01-15'
  }
);

console.log('Valid:', example1Result.valid);
console.log('Errors:', example1Result.errors);
console.log();

// ============================================================================
// Example 2: Relative Dates
// ============================================================================

console.log('Example 2: Relative Dates');
console.log('-'.repeat(70));

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const tomorrowStr = tomorrow.toISOString().split('T')[0];

const example2Result = validate(
  {
    calendar_url: '/calendars/user/personal',
    summary: 'Doctor Appointment',
    dtstart: 'tomorrow' // Relative date
  },
  {
    calendar_url: '/calendars/user/personal',
    summary: 'Doctor',
    dtstart: tomorrowStr
  }
);

console.log('Valid:', example2Result.valid);
console.log('Errors:', example2Result.errors);
console.log();

// ============================================================================
// Example 3: Partial String Matching (Filters)
// ============================================================================

console.log('Example 3: Partial String Matching (Filters)');
console.log('-'.repeat(70));

const example3Result = validate(
  {
    calendar_url: '/calendars/user/work',
    summary_filter: 'Important quarterly business review meeting with stakeholders'
  },
  {
    calendar_url: '/calendars/user/work',
    summary_filter: 'business review' // Partial match
  }
);

console.log('Valid:', example3Result.valid);
console.log('Errors:', example3Result.errors);
console.log();

// ============================================================================
// Example 4: Null/Undefined Handling
// ============================================================================

console.log('Example 4: Null/Undefined Handling');
console.log('-'.repeat(70));

// Case 1: null with empty expected
const example4a = validate(null, {});
console.log('null params with empty expected - Valid:', example4a.valid);

// Case 2: null with non-empty expected
const example4b = validate(null, { calendar_url: '/calendars/user/cal' });
console.log('null params with non-empty expected - Valid:', example4b.valid);

// Case 3: Missing optional fields
const validator = createValidator({ strictMode: false });
const example4c = validator.validateParameters(
  { calendar_url: '/calendars/user/cal' },
  { calendar_url: '/calendars/user/cal', summary: 'Optional' }
);
console.log('Missing optional fields (non-strict) - Valid:', example4c.valid);
console.log();

// ============================================================================
// Example 5: Cross-Timezone Comparison
// ============================================================================

console.log('Example 5: Cross-Timezone Comparison');
console.log('-'.repeat(70));

const example5Result = validate(
  {
    dtstart: '2025-01-15T10:00:00+01:00', // 10:00 CET
    dtend: '2025-01-15T11:00:00+01:00'
  },
  {
    dtstart: '2025-01-15T09:00:00Z', // 09:00 UTC (same time)
    dtend: '2025-01-15T10:00:00Z'
  }
);

console.log('Valid:', example5Result.valid);
console.log('Errors:', example5Result.errors);
console.log();

// ============================================================================
// Example 6: Strict Mode
// ============================================================================

console.log('Example 6: Strict Mode vs Non-Strict Mode');
console.log('-'.repeat(70));

const testParams = {
  calendar_url: '/calendars/user/cal',
  summary: 'Meeting'
  // location is missing
};

const expectedParams = {
  calendar_url: '/calendars/user/cal',
  summary: 'Meeting',
  location: 'Conference Room'
};

// Non-strict mode (default)
const nonStrictValidator = createValidator({ strictMode: false });
const nonStrictResult = nonStrictValidator.validateParameters(testParams, expectedParams);
console.log('Non-Strict Mode - Valid:', nonStrictResult.valid);

// Strict mode
const strictValidator = createValidator({ strictMode: true });
const strictResult = strictValidator.validateParameters(testParams, expectedParams);
console.log('Strict Mode - Valid:', strictResult.valid);
console.log('Strict Mode - Errors:', strictResult.errors);
console.log();

// ============================================================================
// Example 7: Verbose Logging for Debugging
// ============================================================================

console.log('Example 7: Verbose Logging for Debugging');
console.log('-'.repeat(70));

const debugValidator = createValidator({ verbose: true });
console.log('\n--- Verbose Output Start ---');
const example7Result = debugValidator.validateParameters(
  {
    calendar_url: 'http://test-server.com/calendars/user/cal',
    dtstart: 'tomorrow',
    summary_filter: 'important meeting'
  },
  {
    calendar_url: 'http://prod-server.com/calendars/user/cal',
    dtstart: tomorrowStr,
    summary_filter: 'meeting'
  }
);
console.log('--- Verbose Output End ---\n');
console.log('Valid:', example7Result.valid);

// Save logs to file
debugValidator.saveLogs('/tmp/robust-validator-debug.json');
console.log('Debug logs saved to: /tmp/robust-validator-debug.json');
console.log();

// ============================================================================
// Example 8: Complex Real-World Scenario
// ============================================================================

console.log('Example 8: Complex Real-World Scenario');
console.log('-'.repeat(70));

const realWorldValidator = createValidator({ strictMode: false, verbose: false });

const actualToolCall = {
  calendar_url: 'http://192.168.1.100:8080/remote.php/dav/calendars/john/work/',
  summary: 'Q1 Planning Meeting - Sales & Engineering Teams',
  description: 'Quarterly planning session for Q1 2025',
  location: 'Conference Room A',
  dtstart: '2025-01-20T14:00:00+01:00',
  dtend: '2025-01-20T16:00:00+01:00',
  attendees: ['john@company.com', 'jane@company.com']
};

const expectedToolCall = {
  calendar_url: '/remote.php/dav/calendars/john/work', // Path only
  summary_filter: 'Planning Meeting', // Partial match
  dtstart: '2025-01-20', // Date only
  location: 'Conference Room A'
  // description and attendees are optional
};

const realWorldResult = realWorldValidator.validateParameters(actualToolCall, expectedToolCall);

console.log('Valid:', realWorldResult.valid);
console.log('Errors:', realWorldResult.errors);

if (realWorldResult.valid) {
  console.log('\n✓ All validation checks passed!');
  console.log('  - URL path matches (server-agnostic)');
  console.log('  - Summary contains filter text (partial match)');
  console.log('  - Date matches (date-only comparison)');
  console.log('  - Location matches exactly');
  console.log('  - Optional fields ignored (non-strict mode)');
}
console.log();

// ============================================================================
// Example 9: Error Collection and Reporting
// ============================================================================

console.log('Example 9: Error Collection and Reporting');
console.log('-'.repeat(70));

const errorValidator = createValidator({ verbose: false });

const invalidParams = {
  calendar_url: 'http://server.com/wrong/path',
  dtstart: '2025-01-15T10:00:00Z',
  summary: 'Wrong Meeting'
};

const expectedValidParams = {
  calendar_url: 'http://server.com/calendars/user/cal',
  dtstart: '2025-01-20', // Different date
  summary: 'Correct Meeting'
};

const errorResult = errorValidator.validateParameters(invalidParams, expectedValidParams);

console.log('Valid:', errorResult.valid);
console.log('Number of errors:', errorResult.errors.length);
console.log('\nDetailed errors:');
errorResult.errors.forEach((error, idx) => {
  console.log(`  ${idx + 1}. ${error}`);
});
console.log();

// ============================================================================
// Summary
// ============================================================================

console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`
The Robust Validator provides:

1. ✓ Flexible date validation (relative dates, timezone tolerance)
2. ✓ Server-agnostic URL validation (path-only comparison)
3. ✓ Smart string matching (partial for filters, exact for others)
4. ✓ Null/undefined handling with graceful fallbacks
5. ✓ Automatic field type detection
6. ✓ Strict and non-strict modes
7. ✓ Comprehensive logging and debugging
8. ✓ Production-ready error reporting

Use Cases:
- Integration testing of MCP tools
- API response validation
- Configuration validation
- Test data comparison

For more information, see ROBUST-VALIDATOR-README.md
`);
console.log('='.repeat(70));

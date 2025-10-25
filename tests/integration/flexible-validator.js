/**
 * Flexible parameter validation for MCP test runner
 * Handles variations in LLM-generated parameters
 */

/**
 * Flexible validation that handles common LLM variations
 */
export function flexibleValidateParameters(expected, actual) {
  // If no expected params, any params are acceptable
  if (!expected || Object.keys(expected).length === 0) {
    return true;
  }

  // If no actual params provided but expected exists
  if (!actual && expected) {
    return false;
  }

  // Check each expected parameter
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];

    // Handle different validation scenarios
    if (expectedValue === null || expectedValue === undefined) {
      // Expected to be absent or undefined
      if (actualValue !== null && actualValue !== undefined && actualValue !== '') {
        return false;
      }
    } else if (expectedValue === '') {
      // Empty string - should be handled by our preprocessing
      // Accept undefined as valid (since preprocessing converts '' to undefined)
      if (actualValue !== undefined && actualValue !== '' && actualValue !== null) {
        return false;
      }
    } else if (expectedValue === 'unknown' || expectedValue === 'default' ||
               expectedValue === 'null' || expectedValue === 'undefined' ||
               expectedValue === 'none' || expectedValue === 'N/A' || expectedValue === 'n/a') {
      // LLM placeholders - should be converted to undefined by preprocessing
      if (actualValue !== undefined && actualValue !== null) {
        return false;
      }
    } else if (typeof expectedValue === 'string' && typeof actualValue === 'string') {
      // String comparison - handle variations

      // For filter fields, allow partial matches
      if (key.includes('filter') || key.includes('Filter')) {
        const expectedLower = expectedValue.toLowerCase();
        const actualLower = actualValue.toLowerCase();

        // Check if actual contains expected or vice versa
        if (!actualLower.includes(expectedLower) && !expectedLower.includes(actualLower)) {
          return false;
        }
      } else if (key.includes('url') || key.includes('Url')) {
        // URL comparison - handle trailing slashes and protocol variations
        const normalizeUrl = (url) => {
          if (!url) return '';
          return url.replace(/\/$/, '').toLowerCase();
        };

        if (normalizeUrl(expectedValue) !== normalizeUrl(actualValue)) {
          // Check if it's a placeholder that should have been converted
          const placeholders = ['unknown', 'default', 'null', 'undefined', 'none', 'n/a'];
          if (placeholders.includes(expectedValue.toLowerCase())) {
            // Should have been converted to undefined
            return actualValue === undefined || actualValue === null;
          }
          return false;
        }
      } else if (key.includes('date') || key.includes('Date') ||
                 key.includes('time') || key.includes('Time')) {
        // Date/time comparison - handle timezone variations
        try {
          const expectedDate = new Date(expectedValue);
          const actualDate = new Date(actualValue);

          // Allow up to 24 hours difference (for timezone issues)
          const diffMs = Math.abs(expectedDate - actualDate);
          const diffHours = diffMs / (1000 * 60 * 60);

          if (diffHours > 24) {
            return false;
          }
        } catch {
          // If not parseable as dates, do string comparison
          if (expectedValue !== actualValue) {
            return false;
          }
        }
      } else {
        // Exact match for other strings
        if (expectedValue !== actualValue) {
          return false;
        }
      }
    } else if (Array.isArray(expectedValue)) {
      // Array comparison
      if (!Array.isArray(actualValue)) {
        return false;
      }

      // Check if all expected items are present
      for (const item of expectedValue) {
        if (!actualValue.includes(item)) {
          return false;
        }
      }
    } else if (typeof expectedValue === 'object' && expectedValue !== null) {
      // Nested object - recursive validation
      if (!flexibleValidateParameters(expectedValue, actualValue)) {
        return false;
      }
    } else {
      // Primitive values - exact match
      if (expectedValue !== actualValue) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Export for backward compatibility
 */
export default {
  flexibleValidateParameters
};
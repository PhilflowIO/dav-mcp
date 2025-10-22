/**
 * Universal n8n Response Handler
 * Handles various response formats from n8n webhooks
 * Addresses Issue #12: Parameter extraction from different n8n formats
 */

export class N8nResponseHandler {
  /**
   * Extract parameters from various n8n response formats
   * Tries multiple strategies to find the actual parameters
   *
   * @param {Object} response - The response from n8n webhook
   * @param {Object} mcpLogs - MCP logs as fallback source
   * @returns {Object|null} Extracted parameters or null
   */
  static extractParameters(response, mcpLogs = null) {
    // Strategy 1: Direct parameters field (expected format)
    if (response?.parameters && Object.keys(response.parameters).length > 0) {
      console.debug('✓ Found parameters in standard location');
      return response.parameters;
    }

    // Strategy 2: Check body.parameters (n8n JSON response)
    if (response?.body?.parameters) {
      console.debug('✓ Found parameters in body.parameters');
      return response.body.parameters;
    }

    // Strategy 3: Check data field (n8n workflow data)
    if (response?.data?.parameters) {
      console.debug('✓ Found parameters in data.parameters');
      return response.data.parameters;
    }

    // Strategy 4: Check first item in array response
    if (Array.isArray(response) && response[0]?.parameters) {
      console.debug('✓ Found parameters in array[0].parameters');
      return response[0].parameters;
    }

    // Strategy 5: Check json field (n8n webhook response)
    if (response?.json?.parameters) {
      console.debug('✓ Found parameters in json.parameters');
      return response.json.parameters;
    }

    // Strategy 6: Check output field (n8n node output)
    if (response?.output?.parameters) {
      console.debug('✓ Found parameters in output.parameters');
      return response.output.parameters;
    }

    // Strategy 7: Extract from MCP logs as fallback
    if (mcpLogs) {
      const extracted = this.extractFromMcpLogs(mcpLogs);
      if (extracted) {
        console.debug('✓ Extracted parameters from MCP logs');
        return extracted;
      }
    }

    // Strategy 8: Check if the entire response is the parameters object
    if (response && typeof response === 'object' && !response.tool && !response.method) {
      // Check if it looks like parameters (has expected fields)
      const possibleParams = this.looksLikeParameters(response);
      if (possibleParams) {
        console.debug('✓ Response itself appears to be parameters');
        return response;
      }
    }

    // Strategy 9: Deep search for parameters-like objects
    const deepFound = this.deepSearchParameters(response);
    if (deepFound) {
      console.debug('✓ Found parameters through deep search');
      return deepFound;
    }

    console.debug('✗ No parameters found in any known location');
    return null;
  }

  /**
   * Extract parameters from MCP logs
   * Parses the logs to find the actual parameters sent
   *
   * @param {Array|string} mcpLogs - MCP log entries
   * @returns {Object|null} Extracted parameters
   */
  static extractFromMcpLogs(mcpLogs) {
    if (!mcpLogs) return null;

    const logsStr = Array.isArray(mcpLogs) ? mcpLogs.join('\n') : String(mcpLogs);

    // Look for parameter patterns in logs
    const patterns = [
      /params:\s*({[^}]+})/,
      /arguments:\s*({[^}]+})/,
      /parameters:\s*({[^}]+})/,
      /"params":\s*({[^}]+})/
    ];

    for (const pattern of patterns) {
      const match = logsStr.match(pattern);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (e) {
          // Continue to next pattern
        }
      }
    }

    return null;
  }

  /**
   * Check if an object looks like parameters
   * Uses heuristics to identify parameter-like objects
   *
   * @param {Object} obj - Object to check
   * @returns {boolean} True if likely parameters
   */
  static looksLikeParameters(obj) {
    if (!obj || typeof obj !== 'object') return false;

    // Common parameter field names
    const parameterFields = [
      'calendarUrl', 'addressBookUrl', 'calendar_url', 'addressbook_url',
      'summary', 'description', 'location', 'startDate', 'endDate',
      'start_date', 'end_date', 'display_name', 'email', 'phone',
      'summary_filter', 'description_filter', 'status_filter',
      'priority', 'status', 'color', 'timezone', 'uid', 'etag'
    ];

    // Check if object has at least one parameter-like field
    const hasParamField = Object.keys(obj).some(key =>
      parameterFields.some(field =>
        key.toLowerCase().includes(field.toLowerCase())
      )
    );

    // Check if it doesn't have system fields (indicating it's not parameters)
    const hasSystemField = Object.keys(obj).some(key =>
      ['tool', 'method', 'status', 'error', 'response', 'headers'].includes(key)
    );

    return hasParamField && !hasSystemField;
  }

  /**
   * Deep search for parameter objects in nested structures
   *
   * @param {any} obj - Object to search
   * @param {number} maxDepth - Maximum recursion depth
   * @returns {Object|null} Found parameters or null
   */
  static deepSearchParameters(obj, maxDepth = 5) {
    if (maxDepth <= 0 || !obj) return null;

    if (typeof obj === 'object') {
      // Check current level
      if (obj.parameters) return obj.parameters;
      if (this.looksLikeParameters(obj)) return obj;

      // Search nested objects
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
          const found = this.deepSearchParameters(obj[key], maxDepth - 1);
          if (found) return found;
        }
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = this.deepSearchParameters(item, maxDepth - 1);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Transform n8n response to standard MCP format
   *
   * @param {Object} n8nResponse - Response from n8n
   * @param {Object} mcpLogs - Optional MCP logs
   * @returns {Object} Standardized response
   */
  static transformResponse(n8nResponse, mcpLogs = null) {
    const parameters = this.extractParameters(n8nResponse, mcpLogs);

    // Extract tool name from various locations
    const tool = n8nResponse?.tool ||
                 n8nResponse?.method ||
                 n8nResponse?.json?.tool ||
                 n8nResponse?.data?.tool ||
                 (Array.isArray(n8nResponse) && n8nResponse[0]?.tool) ||
                 'unknown';

    return {
      tool,
      parameters: parameters || {},
      originalResponse: n8nResponse,
      extractionMethod: parameters ? 'success' : 'failed'
    };
  }

  /**
   * Validate extracted parameters against expected schema
   *
   * @param {Object} parameters - Extracted parameters
   * @param {Object} expectedSchema - Expected parameter schema
   * @returns {Object} Validation result
   */
  static validateParameters(parameters, expectedSchema) {
    if (!parameters || !expectedSchema) {
      return { valid: false, errors: ['Missing parameters or schema'] };
    }

    const errors = [];
    const warnings = [];

    // Check required fields
    if (expectedSchema.required) {
      for (const field of expectedSchema.required) {
        if (!(field in parameters)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check field types
    if (expectedSchema.properties) {
      for (const [field, schema] of Object.entries(expectedSchema.properties)) {
        if (field in parameters) {
          const value = parameters[field];
          const expectedType = schema.type;

          if (expectedType && !this.matchesType(value, expectedType)) {
            warnings.push(`Field ${field} type mismatch: expected ${expectedType}`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Check if value matches expected type
   *
   * @param {any} value - Value to check
   * @param {string} type - Expected type
   * @returns {boolean} True if matches
   */
  static matchesType(value, type) {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' || !isNaN(Number(value));
      case 'boolean':
        return typeof value === 'boolean' || value === 'true' || value === 'false';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && !Array.isArray(value);
      default:
        return true;
    }
  }
}

// Export for use in tests
export default N8nResponseHandler;
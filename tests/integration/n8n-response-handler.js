/**
 * N8n Response Handler for MCP test runner
 * Parses and normalizes responses from n8n webhook
 */

export class N8nResponseHandler {
  /**
   * Parse the n8n webhook response to extract tool and parameters
   */
  static parseResponse(response) {
    if (!response) {
      return {
        tool_selected: null,
        parameters: null,
        answer: null,
        error: 'Empty response'
      };
    }

    // Handle different response formats from n8n
    let result = {
      tool_selected: null,
      parameters: null,
      answer: null,
      error: null
    };

    try {
      // If response is a string, try to parse it
      let data = typeof response === 'string' ? JSON.parse(response) : response;

      // Check for direct tool response
      if (data.tool || data.tool_name || data.tool_selected) {
        result.tool_selected = data.tool || data.tool_name || data.tool_selected;
      }

      // Check for parameters in various locations
      if (data.parameters || data.args || data.arguments) {
        result.parameters = data.parameters || data.args || data.arguments;
      }

      // Check for answer/response
      if (data.answer || data.response || data.result || data.message) {
        result.answer = data.answer || data.response || data.result || data.message;
      }

      // Check for nested structure (n8n might wrap the response)
      if (data.output) {
        if (typeof data.output === 'string') {
          try {
            const output = JSON.parse(data.output);
            result.tool_selected = output.tool || result.tool_selected;
            result.parameters = output.parameters || result.parameters;
            result.answer = output.answer || result.answer;
          } catch {
            // If output is not JSON, use as answer
            result.answer = data.output;
          }
        } else if (typeof data.output === 'object') {
          result.tool_selected = data.output.tool || result.tool_selected;
          result.parameters = data.output.parameters || result.parameters;
          result.answer = data.output.answer || result.answer;
        }
      }

      // Check for error
      if (data.error) {
        result.error = data.error;
      }

    } catch (error) {
      result.error = `Failed to parse response: ${error.message}`;
    }

    return result;
  }

  /**
   * Normalize parameter names (handle variations from different LLMs)
   */
  static normalizeParameters(params) {
    if (!params) return null;

    const normalized = {};

    for (const [key, value] of Object.entries(params)) {
      // Normalize key names (handle camelCase, snake_case, etc.)
      let normalizedKey = key;

      // Common variations
      const mappings = {
        'addressbook_url': ['addressbookUrl', 'addressbook_url', 'addressBookUrl', 'url'],
        'calendar_url': ['calendarUrl', 'calendar_url', 'calendarURL', 'url'],
        'name_filter': ['nameFilter', 'name_filter', 'name', 'filter'],
        'email_filter': ['emailFilter', 'email_filter', 'email'],
        'organization_filter': ['organizationFilter', 'organization_filter', 'org_filter', 'company'],
        'summary_filter': ['summaryFilter', 'summary_filter', 'summary', 'title'],
        'status_filter': ['statusFilter', 'status_filter', 'status'],
        'time_range_start': ['timeRangeStart', 'time_range_start', 'start_date', 'startDate', 'from'],
        'time_range_end': ['timeRangeEnd', 'time_range_end', 'end_date', 'endDate', 'to']
      };

      // Find the canonical key
      for (const [canonical, variations] of Object.entries(mappings)) {
        if (variations.includes(key) || key === canonical) {
          normalizedKey = canonical;
          break;
        }
      }

      normalized[normalizedKey] = value;
    }

    return normalized;
  }

  /**
   * Transform response to standardized format
   */
  static transformResponse(response, mcpToolCalls = null) {
    // Parse the response
    const parsed = N8nResponseHandler.parseResponse(response);

    // Normalize parameters if present
    if (parsed.parameters) {
      parsed.parameters = N8nResponseHandler.normalizeParameters(parsed.parameters);
    }

    // Try to extract tool name if not already set
    if (!parsed.tool_selected && response) {
      parsed.tool_selected = N8nResponseHandler.extractToolName(response);
    }

    // If we have MCP tool calls, use the first one's tool and args
    if (mcpToolCalls && mcpToolCalls.length > 0 && !parsed.tool_selected) {
      parsed.tool_selected = mcpToolCalls[0].tool;
      if (!parsed.parameters && mcpToolCalls[0].args) {
        parsed.parameters = N8nResponseHandler.normalizeParameters(mcpToolCalls[0].args);
      }
    }

    // Return a format compatible with the test runner expectations
    return {
      tool: parsed.tool_selected,
      parameters: parsed.parameters,
      answer: parsed.answer,
      error: parsed.error
    };
  }

  /**
   * Extract tool name from various response formats
   */
  static extractToolName(response) {
    if (!response) return null;

    // Direct tool name
    if (response.tool_selected || response.tool || response.tool_name) {
      return response.tool_selected || response.tool || response.tool_name;
    }

    // Check in output
    if (response.output) {
      if (typeof response.output === 'object' && response.output.tool) {
        return response.output.tool;
      }
    }

    // Try to extract from answer text
    if (response.answer || response.message) {
      const text = response.answer || response.message;

      // Look for patterns like "Using addressbook_query tool"
      const toolMatch = text.match(/using\s+(\w+)\s+tool/i);
      if (toolMatch) {
        return toolMatch[1];
      }

      // Look for tool names in the text
      const tools = [
        'addressbook_query', 'calendar_query', 'todo_query',
        'list_addressbooks', 'list_calendars', 'list_events',
        'create_event', 'update_event', 'delete_event',
        'create_contact', 'update_contact', 'delete_contact',
        'create_todo', 'update_todo', 'delete_todo'
      ];

      for (const tool of tools) {
        if (text.includes(tool)) {
          return tool;
        }
      }
    }

    return null;
  }
}

export default N8nResponseHandler;
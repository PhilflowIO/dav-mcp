import fs from 'fs';
import path from 'path';

/**
 * Tool Call Logger - Logs all MCP tool calls to JSON Lines format
 * Enables real-time monitoring of LLM tool selection behavior
 */

class ToolCallLogger {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.outputMode = options.outputMode || 'file'; // 'file' | 'console' | 'both'
    this.logFile = options.logFile || '/tmp/mcp-tool-calls.jsonl';

    if (this.enabled && this.outputMode.includes('file')) {
      this.ensureLogFileExists();
    }
  }

  ensureLogFileExists() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  log(entry) {
    if (!this.enabled) return;

    const line = JSON.stringify(entry) + '\n';

    if (this.outputMode === 'console' || this.outputMode === 'both') {
      console.log(line.trim());
    }

    if (this.outputMode === 'file' || this.outputMode === 'both') {
      try {
        fs.appendFileSync(this.logFile, line);
      } catch (error) {
        console.error('Failed to write to tool call log:', error.message);
      }
    }
  }

  logToolCallStart(toolName, args, metadata = {}) {
    this.log({
      type: 'tool_call_start',
      timestamp: new Date().toISOString(),
      tool: toolName,
      args: args,
      ...metadata
    });
  }

  logToolCallSuccess(toolName, args, result, metadata = {}) {
    // Summarize result to avoid huge logs
    const resultSummary = this.summarizeResult(result);

    this.log({
      type: 'tool_call_success',
      timestamp: new Date().toISOString(),
      tool: toolName,
      args: args,
      result_summary: resultSummary,
      duration_ms: metadata.duration,
      ...metadata
    });
  }

  logToolCallError(toolName, args, error, metadata = {}) {
    this.log({
      type: 'tool_call_error',
      timestamp: new Date().toISOString(),
      tool: toolName,
      args: args,
      error: {
        message: error.message,
        code: error.code,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      duration_ms: metadata.duration,
      ...metadata
    });
  }

  summarizeResult(result) {
    if (!result) return null;

    // Handle MCP result format
    if (result.content && Array.isArray(result.content)) {
      return {
        type: 'mcp_result',
        content_count: result.content.length,
        content_types: result.content.map(c => c.type),
        has_text: result.content.some(c => c.type === 'text'),
        text_length: result.content
          .filter(c => c.type === 'text')
          .reduce((sum, c) => sum + (c.text?.length || 0), 0)
      };
    }

    // Handle plain objects/strings
    if (typeof result === 'string') {
      return { type: 'string', length: result.length };
    }

    if (typeof result === 'object') {
      return {
        type: 'object',
        keys: Object.keys(result).slice(0, 5),
        key_count: Object.keys(result).length
      };
    }

    return { type: typeof result };
  }

  clearLog() {
    if (this.enabled && fs.existsSync(this.logFile)) {
      fs.unlinkSync(this.logFile);
    }
  }
}

// Singleton instance
let instance = null;

export function initializeToolCallLogger(options = {}) {
  const enabled = process.env.LOG_TOOL_CALLS !== 'false';
  const outputMode = process.env.TOOL_CALL_LOG_MODE || 'file';
  const logFile = process.env.TOOL_CALL_LOG_FILE || '/tmp/mcp-tool-calls.jsonl';

  instance = new ToolCallLogger({
    enabled,
    outputMode,
    logFile,
    ...options
  });

  return instance;
}

export function getToolCallLogger() {
  if (!instance) {
    instance = initializeToolCallLogger();
  }
  return instance;
}

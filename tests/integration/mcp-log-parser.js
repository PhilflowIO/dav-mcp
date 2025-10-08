#!/usr/bin/env node

/**
 * MCP Server Log Parser
 *
 * Parses MCP server logs to extract tool usage information
 * Used by test suite to track which tools are called and with what parameters
 */

import fs from 'fs';
import path from 'path';

export class MCPLogParser {
  constructor(logFilePath = '/tmp/mcp-server.log') {
    this.logFilePath = logFilePath;
  }

  /**
   * Parse log file and extract all tool calls
   * @returns {Array} Array of tool call objects
   */
  parseLog() {
    if (!fs.existsSync(this.logFilePath)) {
      throw new Error(`Log file not found: ${this.logFilePath}`);
    }

    const logContent = fs.readFileSync(this.logFilePath, 'utf-8');
    const lines = logContent.split('\n');

    const toolCalls = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Look for "tools/call request received" entries
      if (line.includes('tools/call request received')) {
        const toolCall = this.parseToolCall(lines, i);
        if (toolCall) {
          toolCalls.push(toolCall);
        }
      }

      i++;
    }

    return toolCalls;
  }

  /**
   * Parse a single tool call from log lines
   */
  parseToolCall(lines, startIndex) {
    const requestLine = lines[startIndex];

    // Extract timestamp
    const timestampMatch = requestLine.match(/\[(\d{2}:\d{2}:\d{2})\]/);
    const timestamp = timestampMatch ? timestampMatch[1] : null;

    // Extract requestId
    const requestIdMatch = lines[startIndex + 1]?.match(/requestId.*: "([^"]+)"/);
    const requestId = requestIdMatch ? requestIdMatch[1] : null;

    // Extract sessionId
    const sessionIdMatch = lines[startIndex + 2]?.match(/sessionId.*: "([^"]+)"/);
    const sessionId = sessionIdMatch ? sessionIdMatch[1] : null;

    // Extract tool name
    const toolMatch = lines[startIndex + 3]?.match(/tool.*: "([^"]+)"/);
    const tool = toolMatch ? toolMatch[1] : null;

    // Extract args (can span multiple lines)
    let args = {};
    const argsStartIndex = startIndex + 4;

    if (lines[argsStartIndex]?.includes('args')) {
      // Check if args is empty object
      if (lines[argsStartIndex].includes('{}')) {
        args = {};
      } else {
        // Parse multi-line args
        args = this.parseArgs(lines, argsStartIndex);
      }
    }

    // Find success/failure
    let success = null;
    let executionTime = null;

    // Look ahead for "Tool executed successfully" or error
    for (let j = startIndex; j < Math.min(startIndex + 20, lines.length); j++) {
      if (lines[j].includes('Tool executed successfully') &&
          lines[j + 2]?.includes(`requestId.*: "${requestId}"`)) {
        success = true;

        // Calculate execution time if we have timestamps
        const successTimestamp = lines[j].match(/\[(\d{2}:\d{2}:\d{2})\]/)?.[1];
        if (timestamp && successTimestamp) {
          executionTime = this.calculateTimeDiff(timestamp, successTimestamp);
        }
        break;
      } else if (lines[j].includes('ERROR') && lines[j].includes(requestId)) {
        success = false;
        break;
      }
    }

    return {
      timestamp,
      requestId,
      sessionId,
      tool,
      args,
      success,
      executionTime
    };
  }

  /**
   * Parse args from multi-line log output
   */
  parseArgs(lines, startIndex) {
    const args = {};
    let i = startIndex + 1; // Skip "args: {" line

    while (i < lines.length && !lines[i].includes('}')) {
      const line = lines[i].trim();

      // Match pattern: "key": "value" or "key": value
      const match = line.match(/"([^"]+)":\s*"?([^",}]+)"?/);
      if (match) {
        const [, key, value] = match;
        // Try to parse as JSON value
        try {
          args[key] = JSON.parse(value);
        } catch {
          args[key] = value.replace(/"/g, '');
        }
      }

      i++;

      // Safety break
      if (i - startIndex > 20) break;
    }

    return args;
  }

  /**
   * Calculate time difference in milliseconds
   */
  calculateTimeDiff(startTime, endTime) {
    const [startH, startM, startS] = startTime.split(':').map(Number);
    const [endH, endM, endS] = endTime.split(':').map(Number);

    const startMs = (startH * 3600 + startM * 60 + startS) * 1000;
    const endMs = (endH * 3600 + endM * 60 + endS) * 1000;

    return endMs - startMs;
  }

  /**
   * Group tool calls by session
   */
  groupBySession(toolCalls) {
    const sessions = {};

    for (const call of toolCalls) {
      if (!sessions[call.sessionId]) {
        sessions[call.sessionId] = [];
      }
      sessions[call.sessionId].push(call);
    }

    return sessions;
  }

  /**
   * Get the most recent session's tool calls
   */
  getLatestSession(toolCalls) {
    const sessions = this.groupBySession(toolCalls);
    const sessionIds = Object.keys(sessions);

    if (sessionIds.length === 0) return [];

    // Get the session with the latest timestamp
    const latestSessionId = sessionIds.reduce((latest, current) => {
      const latestTime = sessions[latest][0].timestamp;
      const currentTime = sessions[current][0].timestamp;
      return currentTime > latestTime ? current : latest;
    });

    return sessions[latestSessionId];
  }

  /**
   * Get tool calls since a specific timestamp
   */
  getToolCallsSince(timestamp) {
    const allCalls = this.parseLog();
    return allCalls.filter(call => call.timestamp >= timestamp);
  }

  /**
   * Get statistics from tool calls
   */
  getStatistics(toolCalls) {
    const stats = {
      totalCalls: toolCalls.length,
      uniqueTools: new Set(toolCalls.map(c => c.tool)).size,
      successRate: toolCalls.filter(c => c.success).length / toolCalls.length,
      toolUsage: {},
      avgExecutionTime: 0
    };

    // Count tool usage
    for (const call of toolCalls) {
      if (!stats.toolUsage[call.tool]) {
        stats.toolUsage[call.tool] = 0;
      }
      stats.toolUsage[call.tool]++;
    }

    // Calculate average execution time
    const timings = toolCalls.filter(c => c.executionTime !== null).map(c => c.executionTime);
    if (timings.length > 0) {
      stats.avgExecutionTime = timings.reduce((a, b) => a + b, 0) / timings.length;
    }

    return stats;
  }

  /**
   * Clear log file (useful for starting fresh test runs)
   */
  clearLog() {
    if (fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, '');
    }
  }

  /**
   * Get a summary of the latest session
   */
  getLatestSessionSummary() {
    const allCalls = this.parseLog();
    const latestSession = this.getLatestSession(allCalls);

    if (latestSession.length === 0) {
      return null;
    }

    return {
      sessionId: latestSession[0].sessionId,
      toolCalls: latestSession,
      statistics: this.getStatistics(latestSession),
      toolChain: latestSession.map(c => ({
        tool: c.tool,
        args: c.args,
        success: c.success,
        executionTime: c.executionTime
      }))
    };
  }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const parser = new MCPLogParser();

  const command = process.argv[2] || 'latest';

  if (command === 'latest') {
    const summary = parser.getLatestSessionSummary();
    if (summary) {
      console.log('\n=== Latest Session Summary ===');
      console.log(`Session ID: ${summary.sessionId}`);
      console.log(`\nTool Chain (${summary.toolCalls.length} calls):`);
      summary.toolChain.forEach((call, i) => {
        console.log(`  ${i + 1}. ${call.tool}`);
        if (Object.keys(call.args).length > 0) {
          console.log(`     Args: ${JSON.stringify(call.args)}`);
        }
        console.log(`     Success: ${call.success ? '✅' : '❌'} | Time: ${call.executionTime}ms`);
      });

      console.log(`\nStatistics:`);
      console.log(`  Total Calls: ${summary.statistics.totalCalls}`);
      console.log(`  Unique Tools: ${summary.statistics.uniqueTools}`);
      console.log(`  Success Rate: ${(summary.statistics.successRate * 100).toFixed(1)}%`);
      console.log(`  Avg Execution Time: ${summary.statistics.avgExecutionTime.toFixed(0)}ms`);

      console.log(`\nTool Usage:`);
      for (const [tool, count] of Object.entries(summary.statistics.toolUsage)) {
        console.log(`  ${tool}: ${count} calls`);
      }
    } else {
      console.log('No sessions found in log');
    }
  } else if (command === 'clear') {
    parser.clearLog();
    console.log('Log cleared');
  } else if (command === 'all') {
    const allCalls = parser.parseLog();
    console.log(JSON.stringify(allCalls, null, 2));
  } else {
    console.log('Usage: node mcp-log-parser.js [latest|clear|all]');
  }
}

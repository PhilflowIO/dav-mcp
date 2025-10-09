#!/usr/bin/env node

/**
 * Integration Example: Using metrics.js with mcp-log-parser.js
 *
 * This demonstrates how to combine the log parser with metrics calculation
 * to analyze actual test runs.
 */

import { MCPLogParser } from '../integration/mcp-log-parser.js';
import {
  calculateCallEfficiency,
  calculateTimeEfficiency,
  calculateRouteConsistency,
  checkFirstCallCorrect,
  detectAntiPatterns,
  aggregateRunMetrics
} from './metrics.js';

// ============================================================================
// Example Test Case Definition
// ============================================================================

const testCase = {
  id: "workflow-001",
  name: "Find and delete event by name",
  user_query: "Delete my meeting with Sarah",
  optimal_route: {
    tools: ["calendar_query", "delete_event"],
    call_count: 2,
    estimated_time_ms: 1000
  }
};

// ============================================================================
// Simulate 5 Test Runs (in real usage, these come from actual test execution)
// ============================================================================

const simulatedRuns = [
  // Run 1: Perfect execution
  {
    toolCalls: [
      { tool: "calendar_query", args: { summary: "Sarah" }, executionTime: 600 },
      { tool: "delete_event", args: { event_url: "..." }, executionTime: 400 }
    ],
    executionTime: 1000
  },
  // Run 2: Perfect execution
  {
    toolCalls: [
      { tool: "calendar_query", args: { summary: "Sarah" }, executionTime: 650 },
      { tool: "delete_event", args: { event_url: "..." }, executionTime: 350 }
    ],
    executionTime: 1000
  },
  // Run 3: Sub-optimal (used list_events instead of calendar_query)
  {
    toolCalls: [
      { tool: "list_events", args: {}, executionTime: 2300 },
      { tool: "delete_event", args: { event_url: "..." }, executionTime: 500 }
    ],
    executionTime: 2800
  },
  // Run 4: Perfect execution
  {
    toolCalls: [
      { tool: "calendar_query", args: { summary: "Sarah" }, executionTime: 580 },
      { tool: "delete_event", args: { event_url: "..." }, executionTime: 420 }
    ],
    executionTime: 1000
  },
  // Run 5: Perfect execution
  {
    toolCalls: [
      { tool: "calendar_query", args: { summary: "Sarah" }, executionTime: 620 },
      { tool: "delete_event", args: { event_url: "..." }, executionTime: 380 }
    ],
    executionTime: 1000
  }
];

// ============================================================================
// Analyze Individual Runs
// ============================================================================

console.log('\n=== Analyzing Individual Runs ===\n');

simulatedRuns.forEach((run, index) => {
  console.log(`Run ${index + 1}:`);

  // Call efficiency
  const callEff = calculateCallEfficiency(
    run.toolCalls.length,
    testCase.optimal_route.call_count
  );
  console.log(`  Call Efficiency: ${(callEff.efficiency * 100).toFixed(0)}% - ${callEff.interpretation}`);

  // Time efficiency
  const timeEff = calculateTimeEfficiency(
    run.executionTime,
    testCase.optimal_route.estimated_time_ms
  );
  console.log(`  Time Efficiency: ${(timeEff.efficiency * 100).toFixed(0)}% - ${timeEff.interpretation}`);

  // First call correctness
  const firstCall = checkFirstCallCorrect(
    run.toolCalls,
    testCase.optimal_route.tools
  );
  console.log(`  First Call: ${firstCall.first_call_correct ? '✅' : '❌'} ${firstCall.actual_first} (${firstCall.severity})`);

  // Anti-patterns
  const patterns = detectAntiPatterns(run.toolCalls);
  if (patterns.length > 0) {
    console.log(`  Anti-Patterns: ${patterns.map(p => p.name).join(', ')}`);
  } else {
    console.log(`  Anti-Patterns: None detected`);
  }

  console.log('');
});

// ============================================================================
// Aggregate Analysis (5x Rule)
// ============================================================================

console.log('\n=== Aggregate Analysis (5 Runs) ===\n');

const aggregate = aggregateRunMetrics(simulatedRuns, testCase);

console.log(`Overall Quality: ${aggregate.overall_quality}`);
console.log('');

console.log('Metrics:');
console.log(`  Average Call Efficiency: ${(aggregate.avg_call_efficiency * 100).toFixed(0)}%`);
console.log(`  Average Time Efficiency: ${(aggregate.avg_time_efficiency * 100).toFixed(0)}%`);
console.log(`  Route Consistency: ${(aggregate.route_consistency * 100).toFixed(0)}% (${aggregate.route_consistency >= 0.8 ? '✅ PASS' : '❌ FAIL'})`);
console.log(`  First Call Correct Rate: ${(aggregate.first_call_correct_rate * 100).toFixed(0)}% (${aggregate.first_call_correct_count}/${aggregate.total_runs})`);
console.log('');

console.log('Route Distribution:');
for (const [route, count] of Object.entries(aggregate.route_distribution)) {
  const isOptimal = route === testCase.optimal_route.tools.join(' → ');
  console.log(`  ${route}: ${count}/${aggregate.total_runs} ${isOptimal ? '✅ (optimal)' : '❌ (sub-optimal)'}`);
}
console.log('');

if (aggregate.pattern_frequency.length > 0) {
  console.log('Detected Anti-Patterns:');
  aggregate.pattern_frequency.forEach(pattern => {
    console.log(`  ${pattern.name}: ${pattern.count}/${aggregate.total_runs} runs (${(pattern.frequency * 100).toFixed(0)}%)`);
  });
  console.log('');
}

// ============================================================================
// Recommendations
// ============================================================================

console.log('=== Recommendations ===\n');

if (aggregate.route_consistency < 0.8) {
  console.log('⚠️ Route consistency is below 80%');
  console.log('   → Add clearer workflow examples to tool descriptions');
  console.log('   → Example: "BEFORE DELETING: Use calendar_query to find event first"');
  console.log('');
}

if (aggregate.first_call_correct_rate < 0.8) {
  console.log('⚠️ First call correct rate is below 80%');
  console.log('   → Tool description is unclear from the start');
  console.log('   → Add WHEN to use guidance at the beginning of description');
  console.log('');
}

if (aggregate.detected_patterns.LIST_ALL_BEFORE_DELETE) {
  console.log('⚠️ LIST_ALL_BEFORE_DELETE pattern detected');
  console.log('   → Add to delete_event description:');
  console.log('   → "⚠️ WARNING: Use calendar_query (fast) instead of list_events (slow)"');
  console.log('');
}

if (aggregate.detected_patterns.MULTIPLE_SAME_QUERY) {
  console.log('🚨 CRITICAL: MULTIPLE_SAME_QUERY pattern detected');
  console.log('   → Tool implementation bug - should search all containers in one call');
  console.log('   → Priority: URGENT');
  console.log('');
}

if (aggregate.route_consistency >= 0.8 && aggregate.first_call_correct_rate >= 0.8) {
  console.log('✅ Tool descriptions are working well!');
  console.log('   No major improvements needed.');
  console.log('');
}

// ============================================================================
// Real MCP Log Parser Integration
// ============================================================================

console.log('\n=== How to Use with Real MCP Logs ===\n');

console.log('In mcp-test-runner.js:');
console.log('');
console.log('```javascript');
console.log('import { MCPLogParser } from "./mcp-log-parser.js";');
console.log('import { aggregateRunMetrics } from "../optimization/metrics.js";');
console.log('');
console.log('// After running 5x test');
console.log('const parser = new MCPLogParser();');
console.log('const allCalls = parser.parseLog();');
console.log('const sessionCalls = parser.getLatestSession(allCalls);');
console.log('');
console.log('// Calculate total execution time');
console.log('const executionTime = sessionCalls.reduce((sum, call) =>');
console.log('  sum + (call.executionTime || 0), 0');
console.log(');');
console.log('');
console.log('const run = {');
console.log('  toolCalls: sessionCalls,');
console.log('  executionTime: executionTime');
console.log('};');
console.log('');
console.log('// After collecting 5 runs');
console.log('const aggregate = aggregateRunMetrics(runs, testCase);');
console.log('console.log(aggregate);');
console.log('```');
console.log('');

console.log('=== Example Complete ===\n');

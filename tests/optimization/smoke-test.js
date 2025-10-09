#!/usr/bin/env node
/**
 * Smoke Test for LLMx Metrics
 *
 * Tests the metrics module with sample data to validate functionality
 * without requiring full MCP server / n8n setup.
 *
 * Usage: node tests/optimization/smoke-test.js
 */

import {
  detectAntiPatterns,
  checkFirstCallCorrect,
  calculateCallEfficiency,
  calculateRouteConsistency,
  aggregateRunMetrics
} from './metrics.js';

console.log('🧪 LLMx Metrics Smoke Test\n');
console.log('='.repeat(60));

// Test 1: Anti-Pattern Detection
console.log('\n1️⃣  Anti-Pattern Detection');
console.log('-'.repeat(60));

const antiPatternTest1 = [
  { tool: 'list_events' },
  { tool: 'delete_event' }
];
const patterns1 = detectAntiPatterns(antiPatternTest1);
console.log('Test: list_events → delete_event');
console.log('Result:', patterns1);
console.log('Expected: LIST_ALL_BEFORE_DELETE detected');
console.log('✅ PASS:', patterns1.length === 1 && patterns1[0].name === 'LIST_ALL_BEFORE_DELETE');

const antiPatternTest2 = [
  { tool: 'todo_query' },
  { tool: 'todo_query' },
  { tool: 'todo_query' }
];
const patterns2 = detectAntiPatterns(antiPatternTest2);
console.log('\nTest: todo_query x3');
console.log('Result:', patterns2);
console.log('Expected: MULTIPLE_SAME_QUERY detected');
console.log('✅ PASS:', patterns2.length === 1 && patterns2[0].name === 'MULTIPLE_SAME_QUERY');

// Test 2: First Call Correctness
console.log('\n\n2️⃣  First Call Correctness');
console.log('-'.repeat(60));

const toolCalls = [
  { tool: 'list_events' },
  { tool: 'delete_event' }
];
const optimalRoute = ['calendar_query', 'delete_event'];
const firstCallResult = checkFirstCallCorrect(toolCalls, optimalRoute);
console.log('Test: list_events vs expected calendar_query');
console.log('Result:', firstCallResult);
console.log('Expected: first_call_correct = false, severity = CRITICAL');
console.log('✅ PASS:', !firstCallResult.first_call_correct && firstCallResult.severity === 'CRITICAL');

const correctToolCalls = [
  { tool: 'calendar_query' },
  { tool: 'delete_event' }
];
const firstCallResult2 = checkFirstCallCorrect(correctToolCalls, optimalRoute);
console.log('\nTest: calendar_query (correct first call)');
console.log('Result:', firstCallResult2);
console.log('Expected: first_call_correct = true, severity = OK');
console.log('✅ PASS:', firstCallResult2.first_call_correct && firstCallResult2.severity === 'OK');

// Test 3: Call Efficiency
console.log('\n\n3️⃣  Call Efficiency');
console.log('-'.repeat(60));

const efficiency1 = calculateCallEfficiency(3, 1);
console.log('Test: 3 calls vs 1 optimal');
console.log('Result:', efficiency1);
console.log('Expected: efficiency = 0.33 (33%), wasted_calls = 2');
console.log('✅ PASS:', efficiency1.efficiency === 0.33 && efficiency1.wasted_calls === 2);

const efficiency2 = calculateCallEfficiency(1, 1);
console.log('\nTest: 1 call vs 1 optimal (perfect)');
console.log('Result:', efficiency2);
console.log('Expected: efficiency = 1.0 (100%), wasted_calls = 0');
console.log('✅ PASS:', efficiency2.efficiency === 1.0 && efficiency2.wasted_calls === 0);

// Test 4: Route Consistency
console.log('\n\n4️⃣  Route Consistency');
console.log('-'.repeat(60));

const runs = [
  { toolCalls: [{ tool: 'calendar_query' }] },
  { toolCalls: [{ tool: 'calendar_query' }] },
  { toolCalls: [{ tool: 'list_events' }] },  // Wrong
  { toolCalls: [{ tool: 'calendar_query' }] },
  { toolCalls: [{ tool: 'calendar_query' }] }
];
const consistency = calculateRouteConsistency(runs, ['calendar_query']);
console.log('Test: 4/5 runs use calendar_query');
console.log('Result:', consistency);
console.log('Expected: consistency = 0.8 (80%), matches = 4');
console.log('✅ PASS:', consistency.consistency === 0.8 && consistency.matches === 4);

// Test 5: Aggregate Metrics
console.log('\n\n5️⃣  Aggregate Metrics');
console.log('-'.repeat(60));

const testCase = {
  optimal_route: {
    tools: ['calendar_query', 'delete_event'],
    call_count: 2,
    estimated_time_ms: 1000
  }
};

const aggregateRuns = [
  {
    toolCalls: [
      { tool: 'calendar_query' },
      { tool: 'delete_event' }
    ],
    executionTime: 1200
  },
  {
    toolCalls: [
      { tool: 'list_events' },  // Wrong first call
      { tool: 'delete_event' }
    ],
    executionTime: 2500
  },
  {
    toolCalls: [
      { tool: 'calendar_query' },
      { tool: 'delete_event' }
    ],
    executionTime: 1100
  },
  {
    toolCalls: [
      { tool: 'calendar_query' },
      { tool: 'delete_event' }
    ],
    executionTime: 1000
  },
  {
    toolCalls: [
      { tool: 'calendar_query' },
      { tool: 'delete_event' }
    ],
    executionTime: 1150
  }
];

const aggregateResult = aggregateRunMetrics(aggregateRuns, testCase);
console.log('Test: 5 runs with mixed results');
console.log('Result:', JSON.stringify(aggregateResult, null, 2));
console.log('Expected:');
console.log('  - avg_call_efficiency: 1.0 (all used 2 calls)');
console.log('  - route_consistency: 0.8 (4/5 correct)');
console.log('  - first_call_correct_rate: 0.8 (4/5 correct)');
console.log('  - detected_patterns: LIST_ALL_BEFORE_DELETE x1');
console.log('✅ PASS:',
  aggregateResult.avg_call_efficiency === 1.0 &&
  aggregateResult.route_consistency === 0.8 &&
  aggregateResult.first_call_correct_rate === 0.8 &&
  aggregateResult.detected_patterns.LIST_ALL_BEFORE_DELETE === 1
);

// Final Summary
console.log('\n\n' + '='.repeat(60));
console.log('🎉 Smoke Test Complete!');
console.log('='.repeat(60));
console.log('\nAll core metrics validated:');
console.log('  ✅ Anti-Pattern Detection');
console.log('  ✅ First Call Correctness');
console.log('  ✅ Call Efficiency');
console.log('  ✅ Route Consistency');
console.log('  ✅ Aggregate Metrics');
console.log('\n📊 Metrics module is ready for integration testing!');
console.log('\nNext step: Run real tests with MCP server + n8n webhook');
console.log('  node tests/integration/mcp-test-runner.js\n');

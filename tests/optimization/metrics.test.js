/**
 * Test file demonstrating metrics usage with real examples
 */

import {
  calculateCallEfficiency,
  calculateTimeEfficiency,
  calculateRouteConsistency,
  checkFirstCallCorrect,
  detectAntiPatterns,
  aggregateRunMetrics
} from './metrics.js';

// ============================================================================
// Example 1: Call Efficiency
// ============================================================================
console.log('\n=== Example 1: Call Efficiency ===\n');

// LLM made 3 calls, should have made 2
const callEff1 = calculateCallEfficiency(3, 2);
console.log('Scenario: LLM made 3 calls, optimal is 2');
console.log('Result:', JSON.stringify(callEff1, null, 2));
// Output:
// {
//   efficiency: 0.67,
//   wasted_calls: 1,
//   interpretation: "Moderate waste (33%) - 1 extra call(s)"
// }

// Perfect case
const callEff2 = calculateCallEfficiency(2, 2);
console.log('\nScenario: LLM made 2 calls, optimal is 2');
console.log('Result:', JSON.stringify(callEff2, null, 2));

// ============================================================================
// Example 2: Time Efficiency
// ============================================================================
console.log('\n=== Example 2: Time Efficiency ===\n');

// Took 3000ms, should have taken 1000ms
const timeEff1 = calculateTimeEfficiency(3000, 1000);
console.log('Scenario: Took 3000ms, optimal is 1000ms');
console.log('Result:', JSON.stringify(timeEff1, null, 2));
// Output:
// {
//   efficiency: 0.33,
//   wasted_time_ms: 2000,
//   interpretation: "67% slower than optimal - wasted 2000ms"
// }

// ============================================================================
// Example 3: Route Consistency (5x Rule)
// ============================================================================
console.log('\n=== Example 3: Route Consistency (5x Rule) ===\n');

const runs = [
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ]
  },
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ]
  },
  {
    toolCalls: [
      { tool: "list_events" },
      { tool: "delete_event" }
    ]
  },
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ]
  },
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ]
  }
];

const routeConsistency = calculateRouteConsistency(runs, ["calendar_query", "delete_event"]);
console.log('Scenario: 5 test runs, 4 used optimal route, 1 used wrong route');
console.log('Result:', JSON.stringify(routeConsistency, null, 2));
// Output:
// {
//   consistency: 0.8,
//   matches: 4,
//   total: 5,
//   route_distribution: {
//     "calendar_query → delete_event": 4,
//     "list_events → delete_event": 1
//   },
//   interpretation: "Excellent consistency (80%) - 4/5 runs optimal"
// }

// ============================================================================
// Example 4: First Call Correctness
// ============================================================================
console.log('\n=== Example 4: First Call Correctness ===\n');

// Wrong first call
const firstCall1 = checkFirstCallCorrect(
  [{ tool: "list_events" }, { tool: "delete_event" }],
  ["calendar_query", "delete_event"]
);
console.log('Scenario: First call was list_events, should be calendar_query');
console.log('Result:', JSON.stringify(firstCall1, null, 2));
// Output:
// {
//   first_call_correct: false,
//   actual_first: "list_events",
//   expected_first: "calendar_query",
//   severity: "CRITICAL",
//   interpretation: "Wrong first call: used list_events, should use calendar_query"
// }

// Correct first call
const firstCall2 = checkFirstCallCorrect(
  [{ tool: "calendar_query" }, { tool: "delete_event" }],
  ["calendar_query", "delete_event"]
);
console.log('\nScenario: First call was correct');
console.log('Result:', JSON.stringify(firstCall2, null, 2));

// ============================================================================
// Example 5: Anti-Pattern Detection
// ============================================================================
console.log('\n=== Example 5: Anti-Pattern Detection ===\n');

// LIST_ALL_BEFORE_DELETE pattern
const patterns1 = detectAntiPatterns([
  { tool: "list_events" },
  { tool: "delete_event" }
]);
console.log('Scenario: Used list_events before delete_event');
console.log('Result:', JSON.stringify(patterns1, null, 2));
// Output:
// [
//   {
//     name: "LIST_ALL_BEFORE_DELETE",
//     severity: "HIGH",
//     fix: "Use calendar_query instead of list_events",
//     tool_sequence: ["list_events", "delete_event"]
//   }
// ]

// MULTIPLE_SAME_QUERY pattern
const patterns2 = detectAntiPatterns([
  { tool: "todo_query" },
  { tool: "todo_query" },
  { tool: "todo_query" }
]);
console.log('\nScenario: Made 3 todo_query calls (should be 1)');
console.log('Result:', JSON.stringify(patterns2, null, 2));

// ============================================================================
// Example 6: Aggregate Metrics (Full Test Case)
// ============================================================================
console.log('\n=== Example 6: Aggregate Metrics (5 Runs) ===\n');

const testCase = {
  optimal_route: {
    tools: ["calendar_query", "delete_event"],
    call_count: 2,
    estimated_time_ms: 1000
  }
};

const fullRuns = [
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ],
    executionTime: 1050
  },
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ],
    executionTime: 980
  },
  {
    toolCalls: [
      { tool: "list_events" },
      { tool: "delete_event" }
    ],
    executionTime: 2800
  },
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ],
    executionTime: 1020
  },
  {
    toolCalls: [
      { tool: "calendar_query" },
      { tool: "delete_event" }
    ],
    executionTime: 1000
  }
];

const aggregate = aggregateRunMetrics(fullRuns, testCase);
console.log('Scenario: 5 runs, 4 optimal, 1 suboptimal');
console.log('Result:', JSON.stringify(aggregate, null, 2));
// Output shows:
// - avg_call_efficiency: 1.0 (all runs used 2 calls)
// - avg_time_efficiency: ~0.78 (one run was slow)
// - route_consistency: 0.8 (4/5 used optimal route)
// - first_call_correct_rate: 0.8 (4/5 started correctly)
// - detected_patterns: { LIST_ALL_BEFORE_DELETE: 1 }
// - overall_quality: "EXCELLENT - Tool descriptions are clear and effective"

console.log('\n=== All Examples Complete ===\n');

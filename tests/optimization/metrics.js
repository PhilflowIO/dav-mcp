/**
 * LLMx Metrics - Simple, Pragmatic Metrics for Testing LLM Tool Selection Quality
 *
 * This is NOT based on complex research formulas.
 * These are SIMPLE, USEFUL metrics that directly help improve MCP tool descriptions.
 *
 * @module metrics
 */

/**
 * Calculate Call Efficiency
 *
 * Measures: Did LLM use optimal number of MCP calls?
 *
 * @param {number} actualCalls - Number of calls LLM made
 * @param {number} optimalCallCount - Expected optimal number of calls
 * @returns {Object} Efficiency metrics
 *
 * @example
 * // LLM made 3 calls, should have made 2
 * calculateCallEfficiency(3, 2)
 * // Returns: { efficiency: 0.67, wasted_calls: 1, interpretation: "33% waste - 1 extra call" }
 */
export function calculateCallEfficiency(actualCalls, optimalCallCount) {
  if (!actualCalls || !optimalCallCount) {
    return { efficiency: 0, wasted_calls: actualCalls || 0, interpretation: "Invalid input" };
  }

  const efficiency = Math.min(1.0, optimalCallCount / actualCalls);
  const wastedCalls = Math.max(0, actualCalls - optimalCallCount);
  const wastePercent = ((1 - efficiency) * 100).toFixed(0);

  let interpretation;
  if (efficiency >= 1.0) {
    interpretation = "Perfect - optimal call count";
  } else if (efficiency >= 0.8) {
    interpretation = `Minor waste (${wastePercent}%) - ${wastedCalls} extra call(s)`;
  } else if (efficiency >= 0.5) {
    interpretation = `Moderate waste (${wastePercent}%) - ${wastedCalls} extra call(s)`;
  } else {
    interpretation = `High waste (${wastePercent}%) - ${wastedCalls} extra call(s)`;
  }

  return {
    efficiency: parseFloat(efficiency.toFixed(2)),
    wasted_calls: wastedCalls,
    interpretation
  };
}

/**
 * Calculate Time Efficiency
 *
 * Measures: How much faster could it have been?
 *
 * @param {number} actualTimeMs - Actual execution time in milliseconds
 * @param {number} optimalTimeMs - Expected optimal time in milliseconds
 * @returns {Object} Time efficiency metrics
 *
 * @example
 * // Took 3000ms, should have taken 1000ms
 * calculateTimeEfficiency(3000, 1000)
 * // Returns: { efficiency: 0.33, wasted_time_ms: 2000, interpretation: "67% slower than optimal" }
 */
export function calculateTimeEfficiency(actualTimeMs, optimalTimeMs) {
  if (!actualTimeMs || !optimalTimeMs) {
    return { efficiency: 0, wasted_time_ms: actualTimeMs || 0, interpretation: "Invalid input" };
  }

  const efficiency = Math.min(1.0, optimalTimeMs / actualTimeMs);
  const wastedTime = Math.max(0, actualTimeMs - optimalTimeMs);
  const wastePercent = ((1 - efficiency) * 100).toFixed(0);

  let interpretation;
  if (efficiency >= 1.0) {
    interpretation = "Perfect - optimal speed";
  } else if (efficiency >= 0.8) {
    interpretation = `Slightly slower (${wastePercent}%) - wasted ${wastedTime}ms`;
  } else if (efficiency >= 0.5) {
    interpretation = `${wastePercent}% slower than optimal - wasted ${wastedTime}ms`;
  } else {
    interpretation = `${wastePercent}% slower than optimal - wasted ${wastedTime}ms`;
  }

  return {
    efficiency: parseFloat(efficiency.toFixed(2)),
    wasted_time_ms: wastedTime,
    interpretation
  };
}

/**
 * Calculate Route Consistency (5x Rule)
 *
 * Measures: How consistently does LLM choose optimal route?
 *
 * @param {Array<Object>} runs - Array of test runs with tool call sequences
 * @param {Array<string>} optimalRoute - Expected optimal tool sequence
 * @returns {Object} Consistency metrics
 *
 * @example
 * // 4 out of 5 runs used optimal route
 * const runs = [
 *   { toolCalls: [{ tool: "calendar_query" }, { tool: "delete_event" }] },
 *   { toolCalls: [{ tool: "calendar_query" }, { tool: "delete_event" }] },
 *   { toolCalls: [{ tool: "list_events" }, { tool: "delete_event" }] },
 *   { toolCalls: [{ tool: "calendar_query" }, { tool: "delete_event" }] },
 *   { toolCalls: [{ tool: "calendar_query" }, { tool: "delete_event" }] }
 * ];
 * calculateRouteConsistency(runs, ["calendar_query", "delete_event"])
 * // Returns: { consistency: 0.8, matches: 4, total: 5, route_distribution: {...} }
 */
export function calculateRouteConsistency(runs, optimalRoute) {
  if (!runs || runs.length === 0) {
    return { consistency: 0, matches: 0, total: 0, route_distribution: {}, interpretation: "No runs" };
  }

  if (!optimalRoute || optimalRoute.length === 0) {
    return { consistency: 0, matches: 0, total: runs.length, route_distribution: {}, interpretation: "No optimal route defined" };
  }

  const routeDistribution = {};
  let matches = 0;

  for (const run of runs) {
    const actualRoute = (run.toolCalls || []).map(call => call.tool);
    const routeKey = actualRoute.join(" → ");

    routeDistribution[routeKey] = (routeDistribution[routeKey] || 0) + 1;

    // Check if routes match
    if (actualRoute.length === optimalRoute.length &&
        actualRoute.every((tool, i) => tool === optimalRoute[i])) {
      matches++;
    }
  }

  const consistency = matches / runs.length;
  const consistencyPercent = (consistency * 100).toFixed(0);

  let interpretation;
  if (consistency >= 0.8) {
    interpretation = `Excellent consistency (${consistencyPercent}%) - ${matches}/${runs.length} runs optimal`;
  } else if (consistency >= 0.6) {
    interpretation = `Good consistency (${consistencyPercent}%) - ${matches}/${runs.length} runs optimal`;
  } else if (consistency >= 0.4) {
    interpretation = `Poor consistency (${consistencyPercent}%) - ${matches}/${runs.length} runs optimal`;
  } else {
    interpretation = `Very poor consistency (${consistencyPercent}%) - ${matches}/${runs.length} runs optimal`;
  }

  return {
    consistency: parseFloat(consistency.toFixed(2)),
    matches,
    total: runs.length,
    route_distribution: routeDistribution,
    interpretation
  };
}

/**
 * Check if First Call is Correct
 *
 * Measures: Was the FIRST tool call correct?
 * Why important: If first call is wrong, entire workflow is inefficient
 *
 * @param {Array<Object>} toolCalls - Array of tool calls from LLM
 * @param {Array<string>} optimalRoute - Expected optimal tool sequence
 * @returns {Object} First call correctness
 *
 * @example
 * // First call was wrong
 * checkFirstCallCorrect(
 *   [{ tool: "list_events" }, { tool: "delete_event" }],
 *   ["calendar_query", "delete_event"]
 * )
 * // Returns: {
 * //   first_call_correct: false,
 * //   actual_first: "list_events",
 * //   expected_first: "calendar_query",
 * //   severity: "CRITICAL"
 * // }
 */
export function checkFirstCallCorrect(toolCalls, optimalRoute) {
  if (!toolCalls || toolCalls.length === 0) {
    return {
      first_call_correct: false,
      actual_first: null,
      expected_first: optimalRoute?.[0] || null,
      severity: "CRITICAL",
      interpretation: "No tool calls made"
    };
  }

  if (!optimalRoute || optimalRoute.length === 0) {
    return {
      first_call_correct: null,
      actual_first: toolCalls[0].tool,
      expected_first: null,
      severity: "UNKNOWN",
      interpretation: "No optimal route defined"
    };
  }

  const actualFirst = toolCalls[0].tool;
  const expectedFirst = optimalRoute[0];
  const correct = actualFirst === expectedFirst;

  return {
    first_call_correct: correct,
    actual_first: actualFirst,
    expected_first: expectedFirst,
    severity: correct ? "OK" : "CRITICAL",
    interpretation: correct
      ? "First tool call was correct"
      : `Wrong first call: used ${actualFirst}, should use ${expectedFirst}`
  };
}

/**
 * Detect Anti-Patterns
 *
 * Detect known bad patterns in tool call sequences
 *
 * @param {Array<Object>} toolCalls - Array of tool calls
 * @returns {Array<Object>} Detected anti-patterns
 *
 * @example
 * detectAntiPatterns([
 *   { tool: "list_events" },
 *   { tool: "delete_event" }
 * ])
 * // Returns: [{
 * //   name: "LIST_ALL_BEFORE_DELETE",
 * //   severity: "HIGH",
 * //   fix: "Use calendar_query instead of list_events"
 * // }]
 */
export function detectAntiPatterns(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  const toolSequence = toolCalls.map(call => call.tool);
  const detected = [];

  // Pattern definitions
  const patterns = [
    {
      name: "LIST_ALL_BEFORE_DELETE",
      match: (sequence) => {
        return (sequence.includes("list_events") && sequence.includes("delete_event")) ||
               (sequence.includes("list_contacts") && sequence.includes("delete_contact")) ||
               (sequence.includes("list_todos") && sequence.includes("delete_todo"));
      },
      severity: "HIGH",
      fix: "Use query tool (calendar_query/addressbook_query/todo_query) instead of list tool"
    },
    {
      name: "LIST_ALL_BEFORE_UPDATE",
      match: (sequence) => {
        return (sequence.includes("list_events") && sequence.includes("update_event")) ||
               (sequence.includes("list_contacts") && sequence.includes("update_contact")) ||
               (sequence.includes("list_todos") && sequence.includes("update_todo"));
      },
      severity: "HIGH",
      fix: "Use query tool to find specific item instead of listing all"
    },
    {
      name: "MULTIPLE_SAME_QUERY",
      match: (sequence) => {
        const queryCounts = {};
        sequence.forEach(tool => {
          if (tool.includes("_query")) {
            queryCounts[tool] = (queryCounts[tool] || 0) + 1;
          }
        });
        return Object.values(queryCounts).some(count => count > 2);
      },
      severity: "CRITICAL",
      fix: "Tool should search all containers in one call (likely implementation bug)"
    },
    {
      name: "REDUNDANT_LIST_BEFORE_QUERY",
      match: (sequence) => {
        return (sequence.includes("list_calendars") && sequence.includes("calendar_query")) ||
               (sequence.includes("list_addressbooks") && sequence.includes("addressbook_query"));
      },
      severity: "MEDIUM",
      fix: "Query tools already search all containers - no need to list first"
    }
  ];

  // Check each pattern
  for (const pattern of patterns) {
    if (pattern.match(toolSequence)) {
      detected.push({
        name: pattern.name,
        severity: pattern.severity,
        fix: pattern.fix,
        tool_sequence: toolSequence
      });
    }
  }

  return detected;
}

/**
 * Aggregate Metrics Across Multiple Runs
 *
 * Calculate aggregate metrics across 5 test runs
 *
 * @param {Array<Object>} runs - Array of test runs
 * @param {Object} testCase - Test case definition with optimal_route
 * @returns {Object} Aggregated metrics
 *
 * @example
 * const runs = [
 *   { toolCalls: [...], executionTime: 1500 },
 *   { toolCalls: [...], executionTime: 1600 },
 *   // ... 3 more runs
 * ];
 * const testCase = {
 *   optimal_route: {
 *     tools: ["calendar_query", "delete_event"],
 *     call_count: 2,
 *     estimated_time_ms: 1000
 *   }
 * };
 * aggregateRunMetrics(runs, testCase)
 */
export function aggregateRunMetrics(runs, testCase) {
  if (!runs || runs.length === 0) {
    return {
      error: "No runs provided",
      avg_call_efficiency: 0,
      avg_time_efficiency: 0,
      route_consistency: 0,
      first_call_correct_rate: 0,
      detected_patterns: {}
    };
  }

  const optimalRoute = testCase?.optimal_route?.tools || [];
  const optimalCallCount = testCase?.optimal_route?.call_count || optimalRoute.length;
  const optimalTimeMs = testCase?.optimal_route?.estimated_time_ms || 0;

  let totalCallEfficiency = 0;
  let totalTimeEfficiency = 0;
  let firstCallCorrectCount = 0;
  const allPatterns = {};

  // Process each run
  for (const run of runs) {
    const toolCalls = run.toolCalls || [];
    const executionTime = run.executionTime || 0;

    // Call efficiency
    const callEff = calculateCallEfficiency(toolCalls.length, optimalCallCount);
    totalCallEfficiency += callEff.efficiency;

    // Time efficiency (only if we have optimal time defined)
    if (optimalTimeMs > 0 && executionTime > 0) {
      const timeEff = calculateTimeEfficiency(executionTime, optimalTimeMs);
      totalTimeEfficiency += timeEff.efficiency;
    }

    // First call correctness
    const firstCall = checkFirstCallCorrect(toolCalls, optimalRoute);
    if (firstCall.first_call_correct) {
      firstCallCorrectCount++;
    }

    // Anti-patterns
    const patterns = detectAntiPatterns(toolCalls);
    for (const pattern of patterns) {
      allPatterns[pattern.name] = (allPatterns[pattern.name] || 0) + 1;
    }
  }

  // Calculate averages
  const avgCallEfficiency = totalCallEfficiency / runs.length;
  const avgTimeEfficiency = optimalTimeMs > 0 ? totalTimeEfficiency / runs.length : null;
  const routeConsistency = calculateRouteConsistency(runs, optimalRoute);
  const firstCallCorrectRate = firstCallCorrectCount / runs.length;

  // Overall interpretation
  let overallQuality;
  if (avgCallEfficiency >= 0.8 && routeConsistency.consistency >= 0.8 && firstCallCorrectRate >= 0.8) {
    overallQuality = "EXCELLENT - Tool descriptions are clear and effective";
  } else if (avgCallEfficiency >= 0.6 && routeConsistency.consistency >= 0.6) {
    overallQuality = "GOOD - Minor improvements needed";
  } else if (avgCallEfficiency >= 0.4 || routeConsistency.consistency >= 0.4) {
    overallQuality = "NEEDS IMPROVEMENT - Tool descriptions unclear";
  } else {
    overallQuality = "POOR - Major redesign needed";
  }

  return {
    avg_call_efficiency: parseFloat(avgCallEfficiency.toFixed(2)),
    avg_time_efficiency: avgTimeEfficiency ? parseFloat(avgTimeEfficiency.toFixed(2)) : null,
    route_consistency: routeConsistency.consistency,
    route_distribution: routeConsistency.route_distribution,
    first_call_correct_rate: parseFloat(firstCallCorrectRate.toFixed(2)),
    first_call_correct_count: firstCallCorrectCount,
    detected_patterns: allPatterns,
    pattern_frequency: Object.entries(allPatterns).map(([name, count]) => ({
      name,
      count,
      frequency: parseFloat((count / runs.length).toFixed(2))
    })),
    total_runs: runs.length,
    overall_quality: overallQuality
  };
}

/**
 * Calculate Summary Statistics for a Set of Runs
 *
 * Helper to get min/max/avg for numeric metrics
 *
 * @param {Array<number>} values - Array of numeric values
 * @returns {Object} Statistics
 */
function calculateStats(values) {
  if (!values || values.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }

  const validValues = values.filter(v => v != null && !isNaN(v));
  if (validValues.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }

  const min = Math.min(...validValues);
  const max = Math.max(...validValues);
  const avg = validValues.reduce((a, b) => a + b, 0) / validValues.length;

  return {
    min: parseFloat(min.toFixed(2)),
    max: parseFloat(max.toFixed(2)),
    avg: parseFloat(avg.toFixed(2))
  };
}

/**
 * Export all metrics functions
 */
export default {
  calculateCallEfficiency,
  calculateTimeEfficiency,
  calculateRouteConsistency,
  checkFirstCallCorrect,
  detectAntiPatterns,
  aggregateRunMetrics,
  calculateStats
};

/**
 * FEP Calculator - First Error Position Metric
 *
 * Measures WHERE the first error occurs in a tool call sequence.
 * FEP=1 means error at first step (critical - indicates unclear tool description).
 * FEP>2 means errors happen later (less critical - minor parameter issues).
 *
 * Based on MCP-Radar framework: https://arxiv.org/html/2505.16700v1
 * Adapted for tool design quality evaluation (not model comparison).
 */

export class FEPCalculator {
  /**
   * Calculate First Error Position metric
   *
   * @param {Array} toolCalls - Actual tool calls from MCP log
   *   Format: [{ tool: "list_events", args: {...}, timestamp: "10:15:23.123", executionTime: 1500 }, ...]
   * @param {Array} optimalRoute - Expected optimal tool sequence
   *   Format: ["calendar_query", "delete_event"]
   * @returns {Object} FEP metric result
   *   {
   *     fep: number (1-N, or null if no error),
   *     severity: string ("CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE"),
   *     explanation: string,
   *     total_steps: number
   *   }
   */
  calculate(toolCalls, optimalRoute) {
    // Handle empty inputs
    if (!toolCalls || toolCalls.length === 0) {
      return {
        fep: null,
        severity: "NONE",
        explanation: "No tool calls detected",
        total_steps: 0
      };
    }

    if (!optimalRoute || optimalRoute.length === 0) {
      return {
        fep: null,
        severity: "NONE",
        explanation: "No optimal route provided - cannot calculate FEP",
        total_steps: toolCalls.length
      };
    }

    // Extract tool names from tool calls
    const actualToolNames = toolCalls.map(call => call.tool);
    const totalSteps = Math.max(actualToolNames.length, optimalRoute.length);

    // Find first error position
    let fep = null;
    let firstErrorTool = null;
    let expectedTool = null;

    for (let i = 0; i < optimalRoute.length; i++) {
      const expected = optimalRoute[i];
      const actual = actualToolNames[i];

      // Error: Missing step (actual route shorter than optimal)
      if (!actual) {
        fep = i + 1; // FEP is 1-indexed
        firstErrorTool = null;
        expectedTool = expected;
        break;
      }

      // Error: Wrong tool at this position
      if (actual !== expected) {
        fep = i + 1; // FEP is 1-indexed
        firstErrorTool = actual;
        expectedTool = expected;
        break;
      }
    }

    // No errors detected - perfect route
    if (fep === null) {
      return {
        fep: null,
        severity: "NONE",
        explanation: "No errors detected - optimal route followed",
        total_steps: totalSteps
      };
    }

    // Calculate severity based on FEP position
    let severity;
    if (fep === 1) {
      severity = "CRITICAL"; // Error at first step = fundamental design issue
    } else if (fep === 2) {
      severity = "HIGH"; // Error at second step = workflow guidance issue
    } else if (fep === 3) {
      severity = "MEDIUM"; // Error at third step = less critical
    } else {
      severity = "LOW"; // Error at 4+ step = minor detail
    }

    // Generate explanation
    let explanation;
    if (firstErrorTool) {
      explanation = `First error at step ${fep}: Used "${firstErrorTool}" instead of "${expectedTool}"`;
    } else {
      explanation = `First error at step ${fep}: Missing expected tool "${expectedTool}"`;
    }

    return {
      fep,
      severity,
      explanation,
      total_steps: totalSteps,
      expected_tool: expectedTool,
      actual_tool: firstErrorTool
    };
  }

  /**
   * Calculate average FEP across multiple runs
   *
   * @param {Array} runs - Array of run results with mcp_radar_metrics.fep
   * @returns {Object} Aggregate FEP metrics
   *   {
   *     avg_fep: number (average FEP, null if no errors),
   *     fep_distribution: Object ({ "1": 3, "2": 1, "null": 1 }),
   *     most_common_fep: number,
   *     most_severe_fep: number (lowest FEP = most severe),
   *     consistency_score: number (0-1, how consistent the FEP is)
   *   }
   */
  aggregateRuns(runs) {
    if (!runs || runs.length === 0) {
      return {
        avg_fep: null,
        fep_distribution: {},
        most_common_fep: null,
        most_severe_fep: null,
        consistency_score: 0
      };
    }

    // Extract FEP values from runs
    const fepValues = runs
      .map(run => run.mcp_radar_metrics?.fep?.fep)
      .filter(fep => fep !== undefined);

    if (fepValues.length === 0) {
      return {
        avg_fep: null,
        fep_distribution: { "null": runs.length },
        most_common_fep: null,
        most_severe_fep: null,
        consistency_score: 1.0 // All perfect = consistent
      };
    }

    // Calculate distribution
    const distribution = {};
    for (const fep of fepValues) {
      const key = fep === null ? "null" : String(fep);
      distribution[key] = (distribution[key] || 0) + 1;
    }

    // Add null count if some runs had no errors
    const nullCount = runs.length - fepValues.length;
    if (nullCount > 0) {
      distribution["null"] = nullCount;
    }

    // Calculate average (excluding null)
    const numericFeps = fepValues.filter(fep => fep !== null);
    const avgFep = numericFeps.length > 0
      ? numericFeps.reduce((sum, fep) => sum + fep, 0) / numericFeps.length
      : null;

    // Find most common FEP
    let mostCommonFep = null;
    let maxCount = 0;
    for (const [fep, count] of Object.entries(distribution)) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonFep = fep === "null" ? null : parseInt(fep);
      }
    }

    // Find most severe FEP (lowest number = earliest error)
    const mostSevereFep = numericFeps.length > 0
      ? Math.min(...numericFeps)
      : null;

    // Calculate consistency score
    // High consistency = same FEP across runs
    const consistencyScore = maxCount / runs.length;

    return {
      avg_fep: avgFep,
      fep_distribution: distribution,
      most_common_fep: mostCommonFep,
      most_severe_fep: mostSevereFep,
      consistency_score: consistencyScore
    };
  }
}

/**
 * DTSR Calculator - Dynamic Tool Selection Rate
 *
 * Measures per-step accuracy in multi-step workflows.
 * DTSR = (correct_steps / total_steps)
 * High DTSR (>0.8) = good workflow guidance
 * Low DTSR (<0.5) = poor workflow guidance
 *
 * Based on MCP-Radar framework: https://arxiv.org/html/2505.16700v1
 * Adapted for tool design quality evaluation.
 */

export class DTSRCalculator {
  /**
   * Calculate Dynamic Tool Selection Rate
   *
   * @param {Array} toolCalls - Actual tool calls from MCP log
   *   Format: [{ tool: "list_events", args: {...}, timestamp: "10:15:23.123", executionTime: 1500 }, ...]
   * @param {Array} optimalRoute - Expected optimal tool sequence
   *   Format: ["calendar_query", "delete_event"]
   * @returns {Object} DTSR metric result
   *   {
   *     score: number (0-1),
   *     per_step_analysis: Array of step results,
   *     correct_calls: number,
   *     total_calls: number,
   *     interpretation: string
   *   }
   */
  calculate(toolCalls, optimalRoute) {
    // Handle empty inputs
    if (!toolCalls || toolCalls.length === 0) {
      return {
        score: 0,
        per_step_analysis: [],
        correct_calls: 0,
        total_calls: 0,
        interpretation: "No tool calls detected"
      };
    }

    if (!optimalRoute || optimalRoute.length === 0) {
      return {
        score: 1.0, // No expectations = no errors
        per_step_analysis: [],
        correct_calls: toolCalls.length,
        total_calls: toolCalls.length,
        interpretation: "No optimal route provided - cannot calculate DTSR"
      };
    }

    // Extract tool names from tool calls
    const actualToolNames = toolCalls.map(call => call.tool);

    // Analyze each step
    const perStepAnalysis = [];
    let correctCalls = 0;

    // Compare each step up to the length of optimal route
    for (let i = 0; i < optimalRoute.length; i++) {
      const expected = optimalRoute[i];
      const actual = actualToolNames[i] || null;
      const correct = actual === expected;

      if (correct) correctCalls++;

      perStepAnalysis.push({
        step: i + 1,
        expected: expected,
        actual: actual,
        correct: correct
      });
    }

    // Calculate DTSR score
    const score = optimalRoute.length > 0
      ? correctCalls / optimalRoute.length
      : 0;

    // Generate interpretation
    let interpretation;
    if (score >= 0.8) {
      interpretation = "Excellent workflow guidance - most steps correct";
    } else if (score >= 0.5) {
      interpretation = "Moderate workflow guidance - needs improvement";
    } else {
      interpretation = "Poor workflow guidance - major issues detected";
    }

    return {
      score,
      per_step_analysis: perStepAnalysis,
      correct_calls: correctCalls,
      total_calls: optimalRoute.length,
      interpretation
    };
  }

  /**
   * Calculate average DTSR across multiple runs
   *
   * @param {Array} runs - Array of run results with mcp_radar_metrics.dtsr
   * @returns {Object} Aggregate DTSR metrics
   *   {
   *     avg_dtsr: number (0-1),
   *     dtsr_distribution: Object ({ "1.0": 3, "0.5": 2 }),
   *     min_dtsr: number,
   *     max_dtsr: number,
   *     variance: number,
   *     consistency_score: number (0-1)
   *   }
   */
  aggregateRuns(runs) {
    if (!runs || runs.length === 0) {
      return {
        avg_dtsr: 0,
        dtsr_distribution: {},
        min_dtsr: 0,
        max_dtsr: 0,
        variance: 0,
        consistency_score: 0
      };
    }

    // Extract DTSR scores from runs
    const dtsrScores = runs
      .map(run => run.mcp_radar_metrics?.dtsr?.score)
      .filter(score => score !== undefined && score !== null);

    if (dtsrScores.length === 0) {
      return {
        avg_dtsr: 0,
        dtsr_distribution: {},
        min_dtsr: 0,
        max_dtsr: 0,
        variance: 0,
        consistency_score: 0
      };
    }

    // Calculate average
    const avgDtsr = dtsrScores.reduce((sum, score) => sum + score, 0) / dtsrScores.length;

    // Calculate distribution (rounded to 1 decimal place)
    const distribution = {};
    for (const score of dtsrScores) {
      const rounded = score.toFixed(1);
      distribution[rounded] = (distribution[rounded] || 0) + 1;
    }

    // Calculate min/max
    const minDtsr = Math.min(...dtsrScores);
    const maxDtsr = Math.max(...dtsrScores);

    // Calculate variance
    const variance = dtsrScores.length > 1
      ? dtsrScores.reduce((sum, score) => sum + Math.pow(score - avgDtsr, 2), 0) / dtsrScores.length
      : 0;

    // Calculate consistency score
    // High consistency = low variance, all scores close to average
    const consistencyScore = dtsrScores.length > 1
      ? 1 - Math.min(variance * 2, 1) // Scale variance to 0-1
      : 1.0;

    return {
      avg_dtsr: avgDtsr,
      dtsr_distribution: distribution,
      min_dtsr: minDtsr,
      max_dtsr: maxDtsr,
      variance: variance,
      consistency_score: consistencyScore
    };
  }

  /**
   * Analyze DTSR trends across different complexity levels
   *
   * @param {Array} testResults - Array of test results with complexity field
   * @returns {Object} DTSR by complexity level
   */
  analyzeByComplexity(testResults) {
    const complexityLevels = {};

    for (const result of testResults) {
      const complexity = result.test_case?.complexity || 1;
      const dtsr = result.summary?.avg_dtsr;

      if (dtsr === undefined || dtsr === null) continue;

      if (!complexityLevels[complexity]) {
        complexityLevels[complexity] = {
          count: 0,
          total_dtsr: 0,
          avg_dtsr: 0
        };
      }

      complexityLevels[complexity].count++;
      complexityLevels[complexity].total_dtsr += dtsr;
    }

    // Calculate averages
    for (const level of Object.values(complexityLevels)) {
      level.avg_dtsr = level.count > 0 ? level.total_dtsr / level.count : 0;
    }

    return complexityLevels;
  }
}

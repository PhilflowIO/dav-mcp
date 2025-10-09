/**
 * MCP-Radar Scorer
 *
 * Calculates overall MCP-Radar score from 5 dimensions:
 * 1. Result Accuracy (RA)
 * 2. Dynamic Tool Selection Rate (DTSR)
 * 3. First Error Position (FEP)
 * 4. Resource Efficiency (call count)
 * 5. Time Efficiency (execution time)
 *
 * Based on MCP-Radar framework: https://arxiv.org/html/2505.16700v1
 * Adapted for tool design quality evaluation.
 */

export class MCPRadarScorer {
  /**
   * Calculate overall MCP-Radar score
   *
   * @param {Object} metrics - Individual dimension metrics
   *   {
   *     result_accuracy: number (0-1),
   *     dtsr: number (0-1),
   *     fep: number (1-N, or null if no error),
   *     resource_efficiency: number (0-1),
   *     time_efficiency: number (0-1)
   *   }
   * @returns {Object} MCP-Radar score result
   *   {
   *     radar_score_avg: number (0-1),
   *     dimension_scores: Object,
   *     interpretation: string
   *   }
   */
  calculate(metrics) {
    // Normalize FEP to 0-1 score
    // FEP=null (no error) = 1.0
    // FEP=1 (error at first step) = 0.0
    // FEP=5 (error at 5th step) = 0.8
    const fepScore = this.normalizeFEP(metrics.fep, metrics.total_steps || 5);

    const dimensionScores = {
      result_accuracy: metrics.result_accuracy || 0,
      dtsr: metrics.dtsr || 0,
      fep: fepScore,
      resource_efficiency: metrics.resource_efficiency || 0,
      time_efficiency: metrics.time_efficiency || 0
    };

    // Calculate average radar score
    const scores = Object.values(dimensionScores);
    const radarScoreAvg = scores.reduce((sum, score) => sum + score, 0) / scores.length;

    // Generate interpretation
    let interpretation;
    if (radarScoreAvg >= 0.8) {
      interpretation = "Excellent - Tool design is highly optimized";
    } else if (radarScoreAvg >= 0.6) {
      interpretation = "Good - Minor improvements needed";
    } else if (radarScoreAvg >= 0.4) {
      interpretation = "Fair - Significant improvements needed";
    } else {
      interpretation = "Poor - Major tool design issues detected";
    }

    return {
      radar_score_avg: radarScoreAvg,
      dimension_scores: dimensionScores,
      interpretation
    };
  }

  /**
   * Normalize FEP to 0-1 score
   *
   * @param {number|null} fep - First Error Position (1-N, or null if no error)
   * @param {number} totalSteps - Total steps in workflow
   * @returns {number} Normalized score (0-1)
   */
  normalizeFEP(fep, totalSteps) {
    if (fep === null || fep === undefined) {
      return 1.0; // No error = perfect score
    }

    // FEP=1 (error at first step) is worst = 0.0
    // FEP=totalSteps (error at last step) is better
    // Linear interpolation
    return (fep - 1) / Math.max(totalSteps - 1, 1);
  }

  /**
   * Aggregate MCP-Radar metrics across multiple runs (5x rule)
   *
   * @param {Array} runs - Array of run results with mcp_radar_metrics
   * @param {Object} testCase - Test case definition with optimal_route
   * @returns {Object} Aggregated MCP-Radar metrics
   */
  aggregateRuns(runs, testCase) {
    if (!runs || runs.length === 0) {
      return {
        avg_fep: null,
        avg_dtsr: 0,
        avg_radar_score: 0,
        fep_distribution: {},
        dtsr_distribution: {},
        consistency_issues: false,
        interpretation: "No runs to analyze"
      };
    }

    // Extract metrics from runs
    const fepValues = runs
      .map(run => run.mcp_radar_metrics?.fep?.fep)
      .filter(fep => fep !== undefined);

    const dtsrValues = runs
      .map(run => run.mcp_radar_metrics?.dtsr?.score)
      .filter(score => score !== undefined && score !== null);

    // Calculate FEP distribution
    const fepDistribution = {};
    for (const fep of fepValues) {
      const key = fep === null ? "null" : String(fep);
      fepDistribution[key] = (fepDistribution[key] || 0) + 1;
    }

    // Calculate DTSR distribution
    const dtsrDistribution = {};
    for (const dtsr of dtsrValues) {
      const rounded = dtsr.toFixed(1);
      dtsrDistribution[rounded] = (dtsrDistribution[rounded] || 0) + 1;
    }

    // Calculate averages
    const numericFeps = fepValues.filter(fep => fep !== null);
    const avgFep = numericFeps.length > 0
      ? numericFeps.reduce((sum, fep) => sum + fep, 0) / numericFeps.length
      : null;

    const avgDtsr = dtsrValues.length > 0
      ? dtsrValues.reduce((sum, score) => sum + score, 0) / dtsrValues.length
      : 0;

    // Calculate average radar score per run
    const radarScores = runs.map(run => {
      // Extract metrics from run
      const dtsr = run.mcp_radar_metrics?.dtsr?.score || 0;
      const fep = run.mcp_radar_metrics?.fep?.fep;
      const totalSteps = run.mcp_tool_calls?.length || 1;

      // Calculate resource efficiency
      const optimalCalls = testCase.optimal_route?.tools?.length || 1;
      const actualCalls = run.mcp_tool_calls?.length || 1;
      const resourceEfficiency = Math.min(optimalCalls / actualCalls, 1);

      // Calculate time efficiency
      const optimalTime = testCase.optimal_route?.estimated_time_ms || 1000;
      const actualTime = run.total_mcp_execution_time_ms || 1000;
      const timeEfficiency = Math.min(optimalTime / actualTime, 1);

      // Result accuracy (from validation)
      const resultAccuracy = run.validation?.all_passed ? 1.0 : 0.0;

      // Calculate radar score for this run
      const radarResult = this.calculate({
        result_accuracy: resultAccuracy,
        dtsr: dtsr,
        fep: fep,
        total_steps: totalSteps,
        resource_efficiency: resourceEfficiency,
        time_efficiency: timeEfficiency
      });

      return radarResult.radar_score_avg;
    });

    const avgRadarScore = radarScores.reduce((sum, score) => sum + score, 0) / radarScores.length;

    // Detect consistency issues
    // High variance in FEP or DTSR = inconsistent behavior
    const fepVariance = this.calculateVariance(numericFeps);
    const dtsrVariance = this.calculateVariance(dtsrValues);

    const consistencyIssues = fepVariance > 1.0 || dtsrVariance > 0.1;

    // Generate interpretation
    let interpretation;
    if (avgFep === null) {
      interpretation = "Perfect - No errors detected across all runs";
    } else if (avgFep <= 1.5) {
      interpretation = "Critical - Errors consistently occur at first step (tool description unclear)";
    } else if (avgFep <= 2.5) {
      interpretation = "High Priority - Errors occur early in workflow (workflow guidance needs improvement)";
    } else {
      interpretation = "Medium Priority - Errors occur late in workflow (minor parameter issues)";
    }

    return {
      avg_fep: avgFep,
      avg_dtsr: avgDtsr,
      avg_radar_score: avgRadarScore,
      fep_distribution: fepDistribution,
      dtsr_distribution: dtsrDistribution,
      fep_variance: fepVariance,
      dtsr_variance: dtsrVariance,
      consistency_issues: consistencyIssues,
      interpretation: interpretation
    };
  }

  /**
   * Calculate variance of an array
   */
  calculateVariance(values) {
    if (!values || values.length === 0) return 0;
    if (values.length === 1) return 0;

    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;

    return variance;
  }

  /**
   * Analyze domain-specific performance
   *
   * @param {Array} testResults - Array of test results with domain field
   * @returns {Object} Performance by domain
   */
  analyzeDomainPerformance(testResults) {
    const domains = {};

    for (const result of testResults) {
      const domain = result.test_case?.domain || "unknown";

      if (!domains[domain]) {
        domains[domain] = {
          total_tests: 0,
          passed_tests: 0,
          fep_values: [],
          dtsr_values: [],
          radar_scores: []
        };
      }

      const domainData = domains[domain];
      domainData.total_tests++;

      if (result.summary?.passed) {
        domainData.passed_tests++;
      }

      // Collect metrics
      if (result.mcp_radar_analysis?.avg_fep !== null && result.mcp_radar_analysis?.avg_fep !== undefined) {
        domainData.fep_values.push(result.mcp_radar_analysis.avg_fep);
      }

      if (result.mcp_radar_analysis?.avg_dtsr) {
        domainData.dtsr_values.push(result.mcp_radar_analysis.avg_dtsr);
      }

      if (result.mcp_radar_analysis?.avg_radar_score) {
        domainData.radar_scores.push(result.mcp_radar_analysis.avg_radar_score);
      }
    }

    // Calculate averages per domain
    const summary = {};
    for (const [domain, data] of Object.entries(domains)) {
      summary[domain] = {
        total_tests: data.total_tests,
        pass_rate: data.total_tests > 0 ? data.passed_tests / data.total_tests : 0,
        avg_fep: data.fep_values.length > 0
          ? data.fep_values.reduce((sum, val) => sum + val, 0) / data.fep_values.length
          : null,
        avg_dtsr: data.dtsr_values.length > 0
          ? data.dtsr_values.reduce((sum, val) => sum + val, 0) / data.dtsr_values.length
          : 0,
        avg_radar_score: data.radar_scores.length > 0
          ? data.radar_scores.reduce((sum, val) => sum + val, 0) / data.radar_scores.length
          : 0
      };
    }

    return summary;
  }

  /**
   * Analyze complexity-level performance
   *
   * @param {Array} testResults - Array of test results with complexity field
   * @returns {Object} Performance by complexity level
   */
  analyzeComplexityPerformance(testResults) {
    const complexities = {};

    for (const result of testResults) {
      const complexity = result.test_case?.complexity || 1;

      if (!complexities[complexity]) {
        complexities[complexity] = {
          total_tests: 0,
          passed_tests: 0,
          fep_values: [],
          dtsr_values: []
        };
      }

      const complexityData = complexities[complexity];
      complexityData.total_tests++;

      if (result.summary?.passed) {
        complexityData.passed_tests++;
      }

      if (result.mcp_radar_analysis?.avg_fep !== null && result.mcp_radar_analysis?.avg_fep !== undefined) {
        complexityData.fep_values.push(result.mcp_radar_analysis.avg_fep);
      }

      if (result.mcp_radar_analysis?.avg_dtsr) {
        complexityData.dtsr_values.push(result.mcp_radar_analysis.avg_dtsr);
      }
    }

    // Calculate averages per complexity
    const summary = {};
    for (const [complexity, data] of Object.entries(complexities)) {
      summary[`level_${complexity}`] = {
        total_tests: data.total_tests,
        pass_rate: data.total_tests > 0 ? data.passed_tests / data.total_tests : 0,
        avg_fep: data.fep_values.length > 0
          ? data.fep_values.reduce((sum, val) => sum + val, 0) / data.fep_values.length
          : null,
        avg_dtsr: data.dtsr_values.length > 0
          ? data.dtsr_values.reduce((sum, val) => sum + val, 0) / data.dtsr_values.length
          : 0
      };
    }

    return summary;
  }
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MCPLogParser } from './mcp-log-parser.js';
import TestDataGenerator from './setup-test-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * MCP Test Runner - Validates LLM tool selection accuracy
 *
 * Features:
 * - 5x repetition per test case (handles output parser variability)
 * - n8n webhook integration for LLM testing
 * - 80% success threshold (4/5 runs must pass)
 * - JSON report generation
 * - Comprehensive validation (tool, parameters, answer quality)
 */
class MCPTestRunner {
  constructor(config = {}) {
    this.config = {
      webhookUrl: config.webhookUrl || 'http://0.0.0.0:5678/webhook/d8bec01d-333d-444e-9573-6e2bafdde560',
      repetitions: config.repetitions || 5,
      successThreshold: config.successThreshold || 0.8, // 80% = 4/5 runs
      timeout: config.timeout || 30000, // 30 seconds per request
      mcpLogPath: config.mcpLogPath || '/tmp/mcp-server.log', // Path to MCP server log
      ...config
    };

    this.results = {
      metadata: {
        timestamp: new Date().toISOString(),
        config: this.config,
        totalTests: 0,
        totalRuns: 0,
        passedTests: 0,
        failedTests: 0,
        accuracy: 0
      },
      testResults: []
    };

    // Initialize log parser
    this.logParser = new MCPLogParser(this.config.mcpLogPath);
    this.previousLogLength = 0; // Track log position
  }

  /**
   * Load test cases from JSON file
   */
  loadTestCases(filePath = null) {
    const testCasesPath = filePath || path.join(__dirname, 'test-cases.json');
    const content = fs.readFileSync(testCasesPath, 'utf8');
    const data = JSON.parse(content);
    return data.test_cases;
  }

  /**
   * Send query to n8n webhook (LLM endpoint)
   */
  async sendToWebhook(query) {
    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: query, // CRITICAL: n8n expects body.prompt not body.query
          timestamp: new Date().toISOString()
        }),
        signal: AbortSignal.timeout(this.config.timeout)
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error(`Webhook request failed: ${error.message}`);
      return {
        error: error.message,
        tool_selected: null,
        parameters: null,
        answer: null
      };
    }
  }

  /**
   * Validate if correct tool was selected
   */
  validateToolSelection(expected, actual) {
    if (!actual) return false;
    return expected.toLowerCase() === actual.toLowerCase();
  }

  /**
   * Validate if parameters are correct
   */
  validateParameters(expectedParams, actualParams) {
    if (!actualParams) return false;
    
    // If no expected parameters, any parameters are acceptable
    if (!expectedParams || Object.keys(expectedParams).length === 0) {
      return true;
    }

    // Special case: If expected params is just "required" placeholders, accept any valid parameters
    const hasOnlyPlaceholders = Object.values(expectedParams).every(value => value === "required");
    if (hasOnlyPlaceholders) {
      return true;
    }

    // Check if all expected parameters are present and match
    for (const [key, value] of Object.entries(expectedParams)) {
      // Skip parameters that are marked as "required" (placeholders)
      if (value === "required") continue;

      // For URLs and specific values, check exact match
      if (!actualParams[key]) {
        return false;
      }

      // For arrays, check if they contain expected items
      if (Array.isArray(value)) {
        if (!Array.isArray(actualParams[key])) return false;
        // Check if all expected items are present
        for (const item of value) {
          if (!actualParams[key].includes(item)) return false;
        }
      } else if (typeof value === 'object') {
        // Recursive check for nested objects
        if (!this.validateParameters(value, actualParams[key])) return false;
      } else {
        // For primitive values, check similarity (partial match for strings)
        if (typeof value === 'string' && typeof actualParams[key] === 'string') {
          // Allow partial matches for filters, search terms, and common query parameters
          if (key.includes('filter') || key.includes('summary') || key.includes('description') ||
              key.includes('search') || key.includes('query') || key.includes('name') ||
              key.includes('title') || key.includes('location') || key.includes('email')) {
            if (!actualParams[key].toLowerCase().includes(value.toLowerCase()) &&
                !value.toLowerCase().includes(actualParams[key].toLowerCase())) {
              return false;
            }
          } else {
            // Exact match for other string parameters
            if (actualParams[key] !== value) return false;
          }
        } else {
          // For numbers and other types, exact match
          if (actualParams[key] !== value) return false;
        }
      }
    }

    return true;
  }

  /**
   * Validate answer quality (basic check)
   */
  validateAnswerQuality(answer) {
    if (!answer) return false;

    // Basic quality checks
    const minLength = 10; // At least 10 characters
    const hasContent = answer.trim().length >= minLength;
    const notErrorMessage = !answer.toLowerCase().includes('error') &&
                           !answer.toLowerCase().includes('failed');

    return hasContent && notErrorMessage;
  }

  /**
   * Validate multi-step optimal route (NEW - 2025-10-10)
   * Checks if MCP tool calls follow the expected optimal_route workflow
   */
  validateOptimalRoute(testCase, mcpToolCalls) {
    // If no optimal_route defined, fall back to single-tool validation
    if (!testCase.optimal_route || testCase.optimal_route.length === 0) {
      return null; // Signal to use legacy validation
    }

    // Extract tool names from optimal_route
    const expectedTools = testCase.optimal_route.map(step => step.tool);
    const actualTools = mcpToolCalls.map(call => call.tool).filter(t => t); // Filter out null/undefined

    // Check if actual tools match expected sequence
    // Allow extra tools, but expected tools must appear in order
    let expectedIndex = 0;
    let matchedSteps = 0;

    for (const actualTool of actualTools) {
      if (actualTool && expectedIndex < expectedTools.length &&
          actualTool.toLowerCase() === expectedTools[expectedIndex].toLowerCase()) {
        matchedSteps++;
        expectedIndex++;
      }
    }

    // Route is valid if all expected steps were matched in order
    const routeValid = matchedSteps === expectedTools.length;

    return {
      route_valid: routeValid,
      matched_steps: matchedSteps,
      total_steps: expectedTools.length,
      expected_sequence: expectedTools,
      actual_sequence: actualTools,
      success_rate: matchedSteps / expectedTools.length
    };
  }

  /**
   * Extract new tool calls from MCP log since last check
   */
  getNewToolCalls() {
    try {
      const allToolCalls = this.logParser.parseLog();
      const newCalls = allToolCalls.slice(this.previousLogLength);
      this.previousLogLength = allToolCalls.length;
      return newCalls;
    } catch (error) {
      console.warn(`Warning: Could not parse MCP logs: ${error.message}`);
      return [];
    }
  }

  /**
   * Reset test data to clean state (cleanup + setup)
   */
  async resetTestData() {
    console.log('\n  🔄 Resetting test data to clean state...');

    try {
      const generator = new TestDataGenerator();
      await generator.initialize();
      await generator.cleanup();
      await generator.createTestCalendar();
      await generator.generateTestEvents();
      await generator.generateTestContacts();
      await generator.generateTestTodos();
      console.log('  ✅ Test data reset complete\n');
    } catch (error) {
      console.error('  ❌ Failed to reset test data:', error.message);
      throw error;
    }
  }

  /**
   * Run a single test case multiple times (5x repetition)
   */
  async runTestCase(testCase) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Testing: ${testCase.id} - ${testCase.name}`);
    console.log(`Query: "${testCase.user_query}"`);
    console.log(`Expected tool: ${testCase.expected_tool}`);
    console.log(`Difficulty: ${testCase.difficulty}`);
    console.log(`${'='.repeat(80)}`);

    const runs = [];
    let correctToolCount = 0;
    let correctParamsCount = 0;
    let goodAnswerCount = 0;

    // Run the test 5 times
    for (let i = 0; i < this.config.repetitions; i++) {
      // 🚨 CRITICAL: Reset test data to clean state BEFORE EACH RUN
      await this.resetTestData();

      console.log(`\n  Run ${i + 1}/${this.config.repetitions}...`);

      const startTime = Date.now();
      const response = await this.sendToWebhook(testCase.user_query);
      const duration = Date.now() - startTime;

      // Extract MCP tool calls that occurred during this test run
      const mcpToolCalls = this.getNewToolCalls();

      // Extract from n8n output format: {output: {tool_used: ..., answer: ...}}
      const output = response.output || response;
      const toolUsed = output.tool_used || response.tool_selected;
      const answer = output.answer || response.answer;
      const parameters = output.parameters || response.parameters;

      // NEW: Check if optimal_route validation should be used
      const routeValidation = this.validateOptimalRoute(testCase, mcpToolCalls);

      let toolCorrect, paramsCorrect;

      if (routeValidation !== null) {
        // Multi-step workflow validation
        toolCorrect = routeValidation.route_valid;
        // For multi-step, params validation is less critical (data flows between steps)
        paramsCorrect = routeValidation.route_valid; // Consider route valid = params valid
      } else {
        // Legacy single-tool validation
        toolCorrect = this.validateToolSelection(
          testCase.expected_tool,
          toolUsed
        );
        paramsCorrect = this.validateParameters(
          testCase.expected_parameters,
          parameters
        );
      }

      const answerGood = this.validateAnswerQuality(answer);

      if (toolCorrect) correctToolCount++;
      if (paramsCorrect) correctParamsCount++;
      if (answerGood) goodAnswerCount++;

      const runResult = {
        run_number: i + 1,
        duration_ms: duration,
        response: {
          tool_used: toolUsed,
          answer: answer,
          parameters: parameters,
          raw: response
        },
        validation: {
          tool_correct: toolCorrect,
          parameters_correct: paramsCorrect,
          answer_quality_good: answerGood,
          all_passed: toolCorrect && paramsCorrect && answerGood,
          route_validation: routeValidation // Include route validation details
        },
        mcp_tool_calls: mcpToolCalls.map(call => ({
          tool: call.tool,
          args: call.args,
          timestamp: call.timestamp,
          success: call.success,
          execution_time_ms: call.executionTime
        })),
        total_mcp_execution_time_ms: mcpToolCalls.reduce((sum, call) => sum + (call.executionTime || 0), 0)
      };

      runs.push(runResult);

      // Log run result
      const status = runResult.validation.all_passed ? '✅ PASS' : '❌ FAIL';
      console.log(`    ${status}`);

      if (routeValidation !== null) {
        // Multi-step workflow logging
        console.log(`    - Route: ${routeValidation.matched_steps}/${routeValidation.total_steps} steps ${toolCorrect ? '✅' : '❌'}`);
        console.log(`    - Expected: [${routeValidation.expected_sequence.join(' → ')}]`);
        console.log(`    - Actual: [${routeValidation.actual_sequence.join(' → ')}]`);
      } else {
        // Single-tool logging
        console.log(`    - Tool: ${toolUsed} ${toolCorrect ? '✅' : '❌'}`);
        console.log(`    - Params: ${paramsCorrect ? '✅' : '❌'}`);
      }

      console.log(`    - Answer: ${answerGood ? '✅' : '❌'}`);
      console.log(`    - Duration: ${duration}ms`);
      console.log(`    - MCP Calls: ${mcpToolCalls.length} (${runResult.total_mcp_execution_time_ms}ms)`);

      // Small delay between runs to avoid overwhelming the webhook
      if (i < this.config.repetitions - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Calculate success rates
    const toolSuccessRate = correctToolCount / this.config.repetitions;
    const paramsSuccessRate = correctParamsCount / this.config.repetitions;
    const answerSuccessRate = goodAnswerCount / this.config.repetitions;
    const overallSuccessRate = runs.filter(r => r.validation.all_passed).length / this.config.repetitions;

    // Test passes if success rate meets threshold
    const testPassed = toolSuccessRate >= this.config.successThreshold;

    const testResult = {
      test_case: testCase,
      runs: runs,
      summary: {
        total_runs: this.config.repetitions,
        correct_tool_count: correctToolCount,
        correct_params_count: correctParamsCount,
        good_answer_count: goodAnswerCount,
        tool_success_rate: toolSuccessRate,
        params_success_rate: paramsSuccessRate,
        answer_success_rate: answerSuccessRate,
        overall_success_rate: overallSuccessRate,
        passed: testPassed,
        threshold: this.config.successThreshold
      }
    };

    // Log summary
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`Summary for ${testCase.id}:`);

    // Check if this test uses optimal_route validation
    const usesOptimalRoute = testCase.optimal_route && testCase.optimal_route.length > 0;
    if (usesOptimalRoute) {
      console.log(`  Validation Mode: Multi-step workflow (${testCase.optimal_route.length} steps)`);
    }

    console.log(`  Tool Selection: ${correctToolCount}/${this.config.repetitions} (${(toolSuccessRate * 100).toFixed(0)}%)`);
    console.log(`  Parameters: ${correctParamsCount}/${this.config.repetitions} (${(paramsSuccessRate * 100).toFixed(0)}%)`);
    console.log(`  Answer Quality: ${goodAnswerCount}/${this.config.repetitions} (${(answerSuccessRate * 100).toFixed(0)}%)`);
    console.log(`  Overall: ${(overallSuccessRate * 100).toFixed(0)}%`);
    console.log(`  Result: ${testPassed ? '✅ PASSED' : '❌ FAILED'} (threshold: ${(this.config.successThreshold * 100).toFixed(0)}%)`);
    console.log(`${'─'.repeat(80)}`);

    return testResult;
  }

  /**
   * Run a single test case
   */
  async runSingleTest(testId, options = {}) {
    const testCases = this.loadTestCases();
    const testCase = testCases.find(tc => tc.id === testId);
    
    if (!testCase) {
      throw new Error(`Test case '${testId}' not found`);
    }

    console.log(`\n================================================================================`);
    console.log(`Testing: ${testId} - ${testCase.name}`);
    console.log(`Query: "${testCase.user_query}"`);
    console.log(`Expected tool: ${testCase.expected_tool}`);
    console.log(`Difficulty: ${testCase.difficulty}`);
    console.log(`================================================================================`);

    const result = await this.runTestCase(testCase);
    return {
      testId,
      passed: result.passed,
      result
    };
  }

  /**
   * Run all test cases
   */
  async runAllTests(options = {}) {
    const {
      categories = null, // Filter by categories: ['caldav', 'carddav', 'vtodo', 'edge_cases']
      testIds = null,    // Filter by specific test IDs
      maxTests = null    // Limit number of tests to run
    } = options;

    console.log('\n' + '='.repeat(80));
    console.log('MCP TEST RUNNER - Starting Test Suite');
    console.log('='.repeat(80));
    console.log(`Webhook: ${this.config.webhookUrl}`);
    console.log(`Repetitions per test: ${this.config.repetitions}`);
    console.log(`Success threshold: ${(this.config.successThreshold * 100).toFixed(0)}%`);
    console.log('='.repeat(80));

    let testCases = this.loadTestCases();

    // Apply filters
    if (categories) {
      testCases = testCases.filter(tc => categories.includes(tc.category));
      console.log(`\nFiltering by categories: ${categories.join(', ')}`);
    }

    if (testIds) {
      testCases = testCases.filter(tc => testIds.includes(tc.id));
      console.log(`\nFiltering by test IDs: ${testIds.join(', ')}`);
    }

    if (maxTests) {
      testCases = testCases.slice(0, maxTests);
      console.log(`\nLimiting to first ${maxTests} tests`);
    }

    this.results.metadata.totalTests = testCases.length;
    this.results.metadata.totalRuns = testCases.length * this.config.repetitions;

    console.log(`\nRunning ${testCases.length} test cases...`);

    // Run each test case
    for (const testCase of testCases) {
      const result = await this.runTestCase(testCase);
      this.results.testResults.push(result);

      if (result.summary.passed) {
        this.results.metadata.passedTests++;
      } else {
        this.results.metadata.failedTests++;
      }
    }

    // Calculate overall accuracy
    this.results.metadata.accuracy = this.results.metadata.totalTests > 0
      ? this.results.metadata.passedTests / this.results.metadata.totalTests
      : 0;

    // Print final summary
    this.printFinalSummary();

    return this.results;
  }

  /**
   * Print final summary
   */
  printFinalSummary() {
    console.log('\n\n' + '='.repeat(80));
    console.log('FINAL SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total Test Cases: ${this.results.metadata.totalTests}`);
    console.log(`Total Runs: ${this.results.metadata.totalRuns}`);
    console.log(`Passed Tests: ${this.results.metadata.passedTests} (${(this.results.metadata.accuracy * 100).toFixed(1)}%)`);
    console.log(`Failed Tests: ${this.results.metadata.failedTests}`);
    console.log('='.repeat(80));

    // Category breakdown
    const categories = {};
    for (const result of this.results.testResults) {
      const cat = result.test_case.category;
      if (!categories[cat]) {
        categories[cat] = { total: 0, passed: 0 };
      }
      categories[cat].total++;
      if (result.summary.passed) categories[cat].passed++;
    }

    console.log('\nBreakdown by Category:');
    for (const [category, stats] of Object.entries(categories)) {
      const accuracy = (stats.passed / stats.total * 100).toFixed(1);
      console.log(`  ${category}: ${stats.passed}/${stats.total} (${accuracy}%)`);
    }

    // Difficulty breakdown
    const difficulties = {};
    for (const result of this.results.testResults) {
      const diff = result.test_case.difficulty;
      if (!difficulties[diff]) {
        difficulties[diff] = { total: 0, passed: 0 };
      }
      difficulties[diff].total++;
      if (result.summary.passed) difficulties[diff].passed++;
    }

    console.log('\nBreakdown by Difficulty:');
    for (const [difficulty, stats] of Object.entries(difficulties)) {
      const accuracy = (stats.passed / stats.total * 100).toFixed(1);
      console.log(`  ${difficulty}: ${stats.passed}/${stats.total} (${accuracy}%)`);
    }

    // Common mistakes
    const mistakes = this.results.testResults
      .filter(r => !r.summary.passed && r.test_case.common_mistake)
      .map(r => ({
        id: r.test_case.id,
        name: r.test_case.name,
        mistake: r.test_case.common_mistake
      }));

    if (mistakes.length > 0) {
      console.log('\nCommon Mistakes Observed:');
      for (const mistake of mistakes) {
        console.log(`  [${mistake.id}] ${mistake.name}`);
        console.log(`    ${mistake.mistake}`);
      }
    }

    console.log('='.repeat(80));
  }

  /**
   * Save results to JSON file
   */
  saveResults(outputPath = null) {
    const defaultPath = path.join(__dirname, `test-results-${Date.now()}.json`);
    const filePath = outputPath || defaultPath;

    fs.writeFileSync(filePath, JSON.stringify(this.results, null, 2), 'utf8');
    console.log(`\nResults saved to: ${filePath}`);

    return filePath;
  }

  /**
   * Generate HTML report (optional)
   */
  generateHtmlReport(outputPath = null) {
    const defaultPath = path.join(__dirname, `test-report-${Date.now()}.html`);
    const filePath = outputPath || defaultPath;

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Test Results - ${this.results.metadata.timestamp}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 3px solid #4CAF50; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
    .stat-card { background: #f9f9f9; padding: 20px; border-radius: 6px; border-left: 4px solid #4CAF50; }
    .stat-card.failed { border-left-color: #f44336; }
    .stat-card h3 { margin: 0 0 10px 0; color: #666; font-size: 14px; }
    .stat-card .value { font-size: 32px; font-weight: bold; color: #333; }
    .test-result { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 6px; }
    .test-result.passed { background: #e8f5e9; border-color: #4CAF50; }
    .test-result.failed { background: #ffebee; border-color: #f44336; }
    .test-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .test-title { font-weight: bold; font-size: 16px; }
    .badge { padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold; }
    .badge.passed { background: #4CAF50; color: white; }
    .badge.failed { background: #f44336; color: white; }
    .runs { margin-top: 10px; }
    .run { margin: 5px 0; padding: 8px; background: rgba(0,0,0,0.05); border-radius: 4px; font-size: 14px; }
    .progress-bar { height: 20px; background: #ddd; border-radius: 10px; overflow: hidden; margin: 10px 0; }
    .progress-fill { height: 100%; background: #4CAF50; transition: width 0.3s; }
  </style>
</head>
<body>
  <div class="container">
    <h1>MCP Test Runner - Results</h1>
    <p><strong>Timestamp:</strong> ${this.results.metadata.timestamp}</p>
    <p><strong>Webhook:</strong> ${this.config.webhookUrl}</p>
    <p><strong>Configuration:</strong> ${this.config.repetitions} runs per test, ${(this.config.successThreshold * 100).toFixed(0)}% success threshold</p>

    <div class="summary">
      <div class="stat-card">
        <h3>Total Tests</h3>
        <div class="value">${this.results.metadata.totalTests}</div>
      </div>
      <div class="stat-card">
        <h3>Total Runs</h3>
        <div class="value">${this.results.metadata.totalRuns}</div>
      </div>
      <div class="stat-card">
        <h3>Passed</h3>
        <div class="value">${this.results.metadata.passedTests}</div>
      </div>
      <div class="stat-card failed">
        <h3>Failed</h3>
        <div class="value">${this.results.metadata.failedTests}</div>
      </div>
      <div class="stat-card">
        <h3>Accuracy</h3>
        <div class="value">${(this.results.metadata.accuracy * 100).toFixed(1)}%</div>
      </div>
    </div>

    <h2>Overall Progress</h2>
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${this.results.metadata.accuracy * 100}%"></div>
    </div>

    <h2>Test Results</h2>
    ${this.results.testResults.map(result => `
      <div class="test-result ${result.summary.passed ? 'passed' : 'failed'}">
        <div class="test-header">
          <div class="test-title">[${result.test_case.id}] ${result.test_case.name}</div>
          <span class="badge ${result.summary.passed ? 'passed' : 'failed'}">${result.summary.passed ? 'PASSED' : 'FAILED'}</span>
        </div>
        <p><strong>Query:</strong> "${result.test_case.user_query}"</p>
        <p><strong>Expected Tool:</strong> ${result.test_case.expected_tool}</p>
        <p><strong>Difficulty:</strong> ${result.test_case.difficulty}</p>
        <p><strong>Success Rate:</strong> Tool ${(result.summary.tool_success_rate * 100).toFixed(0)}% | Params ${(result.summary.params_success_rate * 100).toFixed(0)}% | Answer ${(result.summary.answer_success_rate * 100).toFixed(0)}%</p>
        ${result.test_case.common_mistake ? `<p><strong>Common Mistake:</strong> ${result.test_case.common_mistake}</p>` : ''}
        <div class="runs">
          <strong>Runs (${result.summary.correct_tool_count}/${result.summary.total_runs} correct):</strong>
          ${result.runs.map(run => `
            <div class="run">
              Run ${run.run_number}: ${run.validation.all_passed ? '✅' : '❌'}
              Tool: ${run.response.tool_used || 'N/A'} ${run.validation.tool_correct ? '✅' : '❌'} |
              Params: ${run.validation.parameters_correct ? '✅' : '❌'} |
              Answer: ${run.validation.answer_quality_good ? '✅' : '❌'}
              (${run.duration_ms}ms)
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>
    `;

    fs.writeFileSync(filePath, html, 'utf8');
    console.log(`HTML report saved to: ${filePath}`);

    return filePath;
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  // Parse command line arguments
  let repetitions = parseInt(process.env.REPETITIONS) || 5;
  let testCase = null;
  let server = null;
  let categories = process.env.CATEGORIES ? process.env.CATEGORIES.split(',') : null;
  let testIds = process.env.TEST_IDS ? process.env.TEST_IDS.split(',') : null;
  let maxTests = process.env.MAX_TESTS ? parseInt(process.env.MAX_TESTS) : null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs' && args[i + 1]) {
      repetitions = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--test-case' && args[i + 1]) {
      testCase = args[i + 1];
      i++;
    } else if (args[i] === '--server' && args[i + 1]) {
      server = args[i + 1];
      i++;
    } else if (args[i] === '--category' && args[i + 1]) {
      categories = [args[i + 1]];
      i++;
    } else if (args[i] === '--max-tests' && args[i + 1]) {
      maxTests = parseInt(args[i + 1]);
      i++;
    }
  }

  const config = {
    webhookUrl: process.env.WEBHOOK_URL || 'http://0.0.0.0:5678/webhook/d8bec01d-333d-444e-9573-6e2bafdde560',
    repetitions: repetitions,
    successThreshold: parseFloat(process.env.SUCCESS_THRESHOLD) || 0.8
  };

  const options = {
    categories: categories,
    testIds: testIds,
    maxTests: maxTests
  };

  const runner = new MCPTestRunner(config);

  // Handle single test case execution
  if (testCase) {
    console.log(`Running single test case: ${testCase}`);
    runner.runSingleTest(testCase, options)
      .then(result => {
        console.log(`Test ${testCase}: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
        process.exit(result.passed ? 0 : 1);
      })
      .catch(error => {
        console.error(`Test ${testCase} failed:`, error);
        process.exit(1);
      });
  } else {
    runner.runAllTests(options)
    .then(results => {
      runner.saveResults();
      runner.generateHtmlReport();

      // Exit with code 1 if tests failed
      if (results.metadata.failedTests > 0) {
        console.log('\n❌ Some tests failed');
        process.exit(1);
      } else {
        console.log('\n✅ All tests passed');
        process.exit(0);
      }
    })
    .catch(error => {
      console.error('Test runner failed:', error);
      process.exit(1);
    });
  }
}

export default MCPTestRunner;

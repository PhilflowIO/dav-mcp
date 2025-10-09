/**
 * Anti-Pattern Detector
 *
 * Detects known inefficient tool usage patterns.
 * Uses anti-pattern catalog from PHASE-v2.4.0-LLM-EXPERIENCE-OPTIMIZATION.md
 * Links detected patterns to FEP severity for prioritization.
 */

export class AntiPatternDetector {
  constructor() {
    // Anti-pattern catalog
    this.antiPatternCatalog = {
      LIST_ALL_BEFORE_DELETE: {
        name: "LIST_ALL_BEFORE_DELETE",
        description: "Uses expensive list_* instead of efficient *_query before delete",
        patterns: [
          ["list_events", "delete_event"],
          ["list_todos", "delete_todo"],
          ["list_contacts", "delete_contact"]
        ],
        severity: "CRITICAL",
        expected_fep: 1
      },
      LIST_ALL_BEFORE_UPDATE: {
        name: "LIST_ALL_BEFORE_UPDATE",
        description: "Uses expensive list_* instead of efficient *_query before update",
        patterns: [
          ["list_events", "update_event"],
          ["list_todos", "update_todo"],
          ["list_contacts", "update_contact"]
        ],
        severity: "CRITICAL",
        expected_fep: 1
      },
      MULTIPLE_QUERY_CALLS: {
        name: "MULTIPLE_QUERY_CALLS",
        description: "Makes N separate query calls instead of one multi-container search",
        patterns: [
          ["todo_query", "todo_query"],
          ["todo_query", "todo_query", "todo_query"],
          ["calendar_query", "calendar_query"],
          ["addressbook_query", "addressbook_query"]
        ],
        severity: "CRITICAL",
        expected_fep: 1
      },
      REDUNDANT_LIST_BEFORE_QUERY: {
        name: "REDUNDANT_LIST_BEFORE_QUERY",
        description: "Calls list_* before *_query when query already searches all containers",
        patterns: [
          ["list_calendars", "calendar_query"],
          ["list_addressbooks", "addressbook_query"],
          ["list_calendars", "list_events"]
        ],
        severity: "MEDIUM",
        expected_fep: 1
      },
      WRONG_TOOL_FOR_FILTERED_SEARCH: {
        name: "WRONG_TOOL_FOR_FILTERED_SEARCH",
        description: "Uses list_* instead of *_query for filtered searches",
        patterns: [
          ["list_events"], // When calendar_query would be better
          ["list_todos"],  // When todo_query would be better
          ["list_contacts"] // When addressbook_query would be better
        ],
        severity: "MEDIUM",
        expected_fep: 1
      }
    };
  }

  /**
   * Detect anti-patterns in tool call sequence
   *
   * @param {Array} toolCalls - Actual tool calls from MCP log
   * @param {Array} antiPatternsToDetect - Optional: specific patterns to look for
   *   Format: [{ type: "LIST_ALL_BEFORE_DELETE", bad_route: [...] }]
   * @returns {Array} Detected anti-patterns
   *   [{
   *     type: string,
   *     severity: string,
   *     fep: number,
   *     tool_sequence: Array,
   *     explanation: string,
   *     impact: Object,
   *     suggested_fix: Object
   *   }]
   */
  detect(toolCalls, antiPatternsToDetect = null) {
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    const detectedPatterns = [];
    const actualToolNames = toolCalls.map(call => call.tool);

    // If specific patterns provided, check those first
    if (antiPatternsToDetect && antiPatternsToDetect.length > 0) {
      for (const expectedPattern of antiPatternsToDetect) {
        const detected = this.detectSpecificPattern(
          actualToolNames,
          expectedPattern.bad_route || expectedPattern.tool_sequence,
          expectedPattern.type
        );

        if (detected) {
          detectedPatterns.push(detected);
        }
      }
    }

    // Also check all patterns from catalog
    for (const [patternType, patternDef] of Object.entries(this.antiPatternCatalog)) {
      for (const patternSequence of patternDef.patterns) {
        const detected = this.detectPatternInSequence(
          actualToolNames,
          patternSequence,
          patternType,
          patternDef
        );

        if (detected && !this.isDuplicate(detectedPatterns, detected)) {
          detectedPatterns.push(detected);
        }
      }
    }

    return detectedPatterns;
  }

  /**
   * Detect a specific pattern in the tool sequence
   */
  detectSpecificPattern(actualTools, expectedBadRoute, patternType) {
    const matched = this.matchSequence(actualTools, expectedBadRoute);

    if (!matched) return null;

    const patternDef = this.antiPatternCatalog[patternType];
    if (!patternDef) {
      // Unknown pattern type - create generic detection
      return {
        type: patternType,
        severity: "MEDIUM",
        fep: 1,
        tool_sequence: expectedBadRoute,
        explanation: `Detected expected anti-pattern: ${expectedBadRoute.join(" → ")}`,
        impact: {
          wasted_time_ms: 0,
          wasted_calls: 0
        },
        suggested_fix: {
          type: "REVIEW_NEEDED",
          priority: "MEDIUM"
        }
      };
    }

    return this.buildPatternResult(expectedBadRoute, patternType, patternDef);
  }

  /**
   * Detect pattern in sequence
   */
  detectPatternInSequence(actualTools, patternSequence, patternType, patternDef) {
    const matched = this.matchSequence(actualTools, patternSequence);

    if (!matched) return null;

    return this.buildPatternResult(patternSequence, patternType, patternDef);
  }

  /**
   * Check if pattern sequence exists in actual tools
   */
  matchSequence(actualTools, patternSequence) {
    // Check for exact sequence match at any position
    for (let i = 0; i <= actualTools.length - patternSequence.length; i++) {
      let matched = true;
      for (let j = 0; j < patternSequence.length; j++) {
        if (actualTools[i + j] !== patternSequence[j]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }

    return false;
  }

  /**
   * Build anti-pattern result object
   */
  buildPatternResult(toolSequence, patternType, patternDef) {
    // Determine suggested fix based on pattern type
    let suggestedFix;

    if (patternType.includes("LIST_ALL_BEFORE")) {
      suggestedFix = {
        type: "DESCRIPTION_IMPROVEMENT",
        tool: toolSequence[1], // The action tool (delete/update)
        change: `Add example: "First use *_query to find item, then ${toolSequence[1]}"`,
        priority: patternDef.severity === "CRITICAL" ? "URGENT" : "HIGH"
      };
    } else if (patternType === "MULTIPLE_QUERY_CALLS") {
      suggestedFix = {
        type: "CODE_CHANGE",
        tool: toolSequence[0],
        change: "Add loop to search all containers (like calendar_query does)",
        priority: "URGENT"
      };
    } else if (patternType === "REDUNDANT_LIST_BEFORE_QUERY") {
      suggestedFix = {
        type: "DESCRIPTION_IMPROVEMENT",
        tool: toolSequence[1],
        change: "Add note: 'AUTOMATICALLY SEARCHES ALL - no need to list first'",
        priority: "HIGH"
      };
    } else {
      suggestedFix = {
        type: "DESCRIPTION_IMPROVEMENT",
        tool: toolSequence[0],
        change: "Add PREFERRED/WARNING labels to guide tool selection",
        priority: "MEDIUM"
      };
    }

    return {
      type: patternType,
      severity: patternDef.severity,
      fep: patternDef.expected_fep,
      tool_sequence: toolSequence,
      explanation: patternDef.description,
      impact: {
        wasted_time_ms: this.estimateWastedTime(toolSequence),
        wasted_calls: this.estimateWastedCalls(toolSequence, patternType)
      },
      suggested_fix: suggestedFix
    };
  }

  /**
   * Estimate wasted time for anti-pattern
   */
  estimateWastedTime(toolSequence) {
    // Rough estimates based on common tool execution times
    let wasted = 0;

    for (const tool of toolSequence) {
      if (tool.startsWith("list_")) {
        wasted += 1500; // list_* tools are expensive
      }
    }

    return wasted;
  }

  /**
   * Estimate wasted calls for anti-pattern
   */
  estimateWastedCalls(toolSequence, patternType) {
    if (patternType === "MULTIPLE_QUERY_CALLS") {
      return toolSequence.length - 1; // Should be 1 call, not N
    }

    if (patternType === "REDUNDANT_LIST_BEFORE_QUERY") {
      return 1; // Extra list call
    }

    return 0;
  }

  /**
   * Check if pattern already detected (avoid duplicates)
   */
  isDuplicate(detectedPatterns, newPattern) {
    return detectedPatterns.some(p =>
      p.type === newPattern.type &&
      JSON.stringify(p.tool_sequence) === JSON.stringify(newPattern.tool_sequence)
    );
  }

  /**
   * Get anti-patterns by severity
   */
  groupBySeverity(detectedPatterns) {
    const grouped = {
      CRITICAL: [],
      HIGH: [],
      MEDIUM: [],
      LOW: []
    };

    for (const pattern of detectedPatterns) {
      const severity = pattern.severity || "MEDIUM";
      if (grouped[severity]) {
        grouped[severity].push(pattern);
      }
    }

    return grouped;
  }

  /**
   * Get summary statistics
   */
  getSummary(detectedPatterns) {
    const bySeverity = this.groupBySeverity(detectedPatterns);

    return {
      total_patterns: detectedPatterns.length,
      by_severity: {
        critical: bySeverity.CRITICAL.length,
        high: bySeverity.HIGH.length,
        medium: bySeverity.MEDIUM.length,
        low: bySeverity.LOW.length
      },
      total_wasted_time_ms: detectedPatterns.reduce((sum, p) => sum + (p.impact?.wasted_time_ms || 0), 0),
      total_wasted_calls: detectedPatterns.reduce((sum, p) => sum + (p.impact?.wasted_calls || 0), 0),
      unique_pattern_types: [...new Set(detectedPatterns.map(p => p.type))]
    };
  }
}

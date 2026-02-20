// server/intentDebugger.js
// Intent classification debugging and analysis system

import path from "path";
import { PROJECT_ROOT } from "./utils/config.js";
import { appendLog, readLog } from "./utils/jsonlLogger.js";

const LOGS_DIR = path.join(PROJECT_ROOT, "logs");
const INTENT_LOG = path.join(LOGS_DIR, "intent-debug.jsonl");

/**
 * Log intent routing decision
 * @param {Object} decision - Routing decision data
 */
export async function logIntentDecision(decision) {
  const entry = {
    timestamp: new Date().toISOString(),
    userMessage: decision.userMessage,
    detectedTool: decision.detectedTool,
    reasoning: decision.reasoning,
    confidence: decision.confidence || null,
    context: decision.context || {},
    success: decision.success
  };

  await appendLog(INTENT_LOG, entry, LOGS_DIR);

  console.log("🎯 Intent logged:", decision.detectedTool, "- Confidence:", decision.confidence || "N/A");
}

/**
 * Get intent accuracy report
 * @returns {Object} Accuracy statistics
 */
export async function getIntentAccuracyReport() {
  const entries = await readLog(INTENT_LOG, 500);

  const report = {
    totalDecisions: entries.length,
    successRate: 0,
    byTool: {},
    lowConfidenceDecisions: [],
    failedDecisions: []
  };

  let successCount = 0;

  for (const entry of entries) {
    const tool = entry.detectedTool || "unknown";

    if (!report.byTool[tool]) {
      report.byTool[tool] = {
        total: 0,
        successes: 0,
        failures: 0,
        averageConfidence: 0,
        confidenceSum: 0,
        confidenceCount: 0
      };
    }

    report.byTool[tool].total++;

    if (entry.success) {
      successCount++;
      report.byTool[tool].successes++;
    } else {
      report.byTool[tool].failures++;
      report.failedDecisions.push({
        message: entry.userMessage,
        tool: entry.detectedTool,
        reasoning: entry.reasoning,
        timestamp: entry.timestamp
      });
    }

    if (entry.confidence !== null) {
      report.byTool[tool].confidenceSum += entry.confidence;
      report.byTool[tool].confidenceCount++;
    }

    if (entry.confidence !== null && entry.confidence < 0.5) {
      report.lowConfidenceDecisions.push({
        message: entry.userMessage,
        tool: entry.detectedTool,
        confidence: entry.confidence,
        timestamp: entry.timestamp
      });
    }
  }

  report.successRate = entries.length > 0 ? (successCount / entries.length) * 100 : 0;

  // Calculate average confidence per tool
  for (const tool in report.byTool) {
    const stats = report.byTool[tool];
    if (stats.confidenceCount > 0) {
      stats.averageConfidence = stats.confidenceSum / stats.confidenceCount;
    }
    delete stats.confidenceSum;
    delete stats.confidenceCount;
  }

  return report;
}

/**
 * Detect misrouting patterns
 * @returns {Array} Detected patterns
 */
export async function detectMisroutingPatterns() {
  const entries = await readLog(INTENT_LOG, 500);
  const patterns = [];

  // Pattern 1: Repeated failures for similar queries
  const failedQueries = entries.filter(e => !e.success);
  const queryGroups = {};

  for (const entry of failedQueries) {
    const normalizedQuery = entry.userMessage.toLowerCase().trim();
    const firstWords = normalizedQuery.split(/\s+/).slice(0, 3).join(" ");

    if (!queryGroups[firstWords]) {
      queryGroups[firstWords] = [];
    }
    queryGroups[firstWords].push(entry);
  }

  for (const [pattern, instances] of Object.entries(queryGroups)) {
    if (instances.length >= 3) {
      patterns.push({
        type: "repeated_failures",
        pattern,
        count: instances.length,
        examples: instances.slice(0, 3).map(i => ({
          message: i.userMessage,
          tool: i.detectedTool
        })),
        recommendation: `Pattern "${pattern}" consistently fails. Consider adding specific routing rule.`
      });
    }
  }

  // Pattern 2: Tools with low success rate
  const report = await getIntentAccuracyReport();
  for (const [tool, stats] of Object.entries(report.byTool)) {
    const successRate = (stats.successes / stats.total) * 100;
    if (successRate < 50 && stats.total >= 5) {
      patterns.push({
        type: "low_success_tool",
        tool,
        successRate: successRate.toFixed(1),
        total: stats.total,
        recommendation: `Tool "${tool}" has ${successRate.toFixed(1)}% success rate. Review implementation.`
      });
    }
  }

  // Pattern 3: Consistently low confidence
  const lowConfidenceTools = {};
  for (const [tool, stats] of Object.entries(report.byTool)) {
    if (stats.averageConfidence < 0.6 && stats.total >= 5) {
      lowConfidenceTools[tool] = stats.averageConfidence;
    }
  }

  if (Object.keys(lowConfidenceTools).length > 0) {
    patterns.push({
      type: "low_confidence_routing",
      tools: lowConfidenceTools,
      recommendation: "Several tools have low classification confidence. Consider improving pattern detection."
    });
  }

  return patterns;
}

/**
 * Get routing recommendations
 * @returns {Array} Recommendations for improving routing
 */
export async function getRoutingRecommendations() {
  const patterns = await detectMisroutingPatterns();
  const report = await getIntentAccuracyReport();

  const recommendations = [];

  // Based on patterns
  for (const pattern of patterns) {
    recommendations.push({
      priority: "high",
      category: "routing",
      issue: pattern.type,
      details: pattern.recommendation
    });
  }

  // Based on failed decisions
  if (report.failedDecisions.length > 10) {
    recommendations.push({
      priority: "medium",
      category: "reliability",
      issue: "high_failure_count",
      details: `${report.failedDecisions.length} recent routing failures detected. Review error patterns.`
    });
  }

  // Based on low confidence
  if (report.lowConfidenceDecisions.length > 20) {
    recommendations.push({
      priority: "medium",
      category: "confidence",
      issue: "low_confidence_routing",
      details: `${report.lowConfidenceDecisions.length} low-confidence routing decisions. Consider adding more pattern rules.`
    });
  }

  return recommendations;
}

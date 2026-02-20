// server/telemetryAudit.js
// Comprehensive telemetry and audit logging system

import path from "path";
import { PROJECT_ROOT } from "./utils/config.js";
import { appendLog, readLog } from "./utils/jsonlLogger.js";

const LOGS_DIR = path.join(PROJECT_ROOT, "logs");
const TELEMETRY_LOG = path.join(LOGS_DIR, "telemetry.jsonl");
const IMPROVEMENTS_LOG = path.join(LOGS_DIR, "improvements.jsonl");

/**
 * Log telemetry event
 * @param {Object} event - Event data
 */
export async function logTelemetry(event) {
  const entry = {
    timestamp: new Date().toISOString(),
    type: "telemetry",
    ...event
  };

  await appendLog(TELEMETRY_LOG, entry, LOGS_DIR);

  // Also log to console for immediate visibility
  console.log("📊 Telemetry:", event.tool || event.action, "-", event.success ? "✅" : "❌");
}

/**
 * Log self-improvement event
 * @param {Object} improvement - Improvement data
 */
export async function logImprovement(improvement) {
  const entry = {
    timestamp: new Date().toISOString(),
    type: "improvement",
    ...improvement
  };

  await appendLog(IMPROVEMENTS_LOG, entry, LOGS_DIR);

  console.log("🔧 Improvement logged:", improvement.category, "-", improvement.action);
}

/**
 * Get recent telemetry entries
 * @param {number} limit - Number of entries to return
 * @returns {Array} Recent telemetry entries
 */
export async function getRecentTelemetry(limit = 100) {
  return await readLog(TELEMETRY_LOG, limit);
}

/**
 * Get recent improvements
 * @param {number} limit - Number of entries to return
 * @returns {Array} Recent improvement entries
 */
export async function getRecentImprovements(limit = 50) {
  return await readLog(IMPROVEMENTS_LOG, limit);
}

/**
 * Calculate tool usage statistics
 * @returns {Object} Statistics
 */
export async function calculateToolStats() {
  const entries = await getRecentTelemetry(1000);

  const stats = {
    totalCalls: entries.length,
    successRate: 0,
    toolUsage: {},
    errorsByTool: {},
    averageExecutionTime: 0
  };

  let successCount = 0;
  let totalTime = 0;
  let timeCount = 0;

  for (const entry of entries) {
    if (entry.success) successCount++;

    const tool = entry.tool || "unknown";
    stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + 1;

    if (!entry.success && entry.error) {
      stats.errorsByTool[tool] = (stats.errorsByTool[tool] || 0) + 1;
    }

    if (entry.executionTime) {
      totalTime += entry.executionTime;
      timeCount++;
    }
  }

  stats.successRate = entries.length > 0 ? (successCount / entries.length) * 100 : 0;
  stats.averageExecutionTime = timeCount > 0 ? Math.round(totalTime / timeCount) : 0;

  return stats;
}

/**
 * Detect anomalies in telemetry
 * @returns {Array} Detected anomalies
 */
export async function detectAnomalies() {
  const entries = await getRecentTelemetry(500);
  const anomalies = [];

  // Group by conversation
  const conversations = {};
  for (const entry of entries) {
    const convId = entry.conversationId || "unknown";
    if (!conversations[convId]) {
      conversations[convId] = [];
    }
    conversations[convId].push(entry);
  }

  // Detect excessive steps
  for (const [convId, convEntries] of Object.entries(conversations)) {
    if (convEntries.length > 10) {
      anomalies.push({
        type: "excessive_steps",
        conversationId: convId,
        steps: convEntries.length,
        message: `Conversation ${convId} took ${convEntries.length} steps (excessive)`
      });
    }
  }

  // Detect repeated failures
  const recentFailures = entries.filter(e => !e.success).slice(-10);
  const failuresByTool = {};

  for (const failure of recentFailures) {
    const tool = failure.tool || "unknown";
    failuresByTool[tool] = (failuresByTool[tool] || 0) + 1;
  }

  for (const [tool, count] of Object.entries(failuresByTool)) {
    if (count >= 3) {
      anomalies.push({
        type: "repeated_failures",
        tool,
        count,
        message: `Tool "${tool}" failed ${count} times recently`
      });
    }
  }

  // Detect slow operations
  const slowOps = entries.filter(e => e.executionTime && e.executionTime > 10000);
  if (slowOps.length > 5) {
    anomalies.push({
      type: "slow_operations",
      count: slowOps.length,
      message: `${slowOps.length} operations took over 10 seconds`
    });
  }

  return anomalies;
}

/**
 * Generate summary report for email
 * @param {Date} since - Start date for report
 * @returns {string} HTML report
 */
export async function generateSummaryReport(since = null) {
  if (!since) {
    // Default to last 7 days
    since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  const improvements = await getRecentImprovements(100);
  const recentImprovements = improvements.filter(i =>
    new Date(i.timestamp) >= since
  );

  const stats = await calculateToolStats();
  const anomalies = await detectAnomalies();

  const html = `
    <html>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #1d9bf0;">🤖 AI Agent Weekly Report</h1>
        
        <h2>📊 Performance Statistics</h2>
        <ul>
          <li>Total operations: ${stats.totalCalls}</li>
          <li>Success rate: ${stats.successRate.toFixed(1)}%</li>
          <li>Average execution time: ${stats.averageExecutionTime}ms</li>
        </ul>

        <h2>🔧 Self-Improvements (${recentImprovements.length})</h2>
        ${recentImprovements.length > 0 ? `
          <ul>
            ${recentImprovements.slice(0, 10).map(imp => `
              <li>
                <strong>${imp.category}:</strong> ${imp.action}
                <br><small style="color: #666;">${imp.reason || ''}</small>
              </li>
            `).join('')}
          </ul>
        ` : '<p>No improvements recorded this week.</p>'}

        <h2>⚠️ Detected Issues (${anomalies.length})</h2>
        ${anomalies.length > 0 ? `
          <ul>
            ${anomalies.map(a => `
              <li><strong>${a.type}:</strong> ${a.message}</li>
            `).join('')}
          </ul>
        ` : '<p>No issues detected.</p>'}

        <h2>🛠️ Most Used Tools</h2>
        <ul>
          ${Object.entries(stats.toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, count]) => `
              <li>${tool}: ${count} calls</li>
            `)
      .join('')}
        </ul>

        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="color: #666; font-size: 12px;">
          Generated: ${new Date().toLocaleString()}<br>
          Period: ${since.toLocaleDateString()} - ${new Date().toLocaleDateString()}
        </p>
      </body>
    </html>
  `;

  return html;
}

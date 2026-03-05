

// server/tools/selfImprovement.js
import { getRecentImprovements, generateSummaryReport } from "../telemetryAudit.js";
import { getIntentAccuracyReport, detectMisroutingPatterns, getRoutingRecommendations } from "../intentDebugger.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const EVOLUTION_LOG = path.resolve(__dirname, "..", "data", "evolution-log.json");

/**
 * Get recent changes from git log as improvement entries
 */
async function getGitImprovements(limit = 10) {
  try {
    const { stdout } = await execAsync(
      `git log --oneline --no-merges -${limit} --format="%H|||%s|||%ai"`,
      { cwd: PROJECT_ROOT }
    );
    if (!stdout.trim()) return [];

    return stdout.trim().split("\n").map(line => {
      const [hash, message, date] = line.split("|||");
      return {
        timestamp: new Date(date).toISOString(),
        category: "code_commit",
        action: message.trim(),
        file: hash?.substring(0, 7),
        reason: "Git commit",
        source: "git"
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get improvements from selfEvolve's evolution-log.json
 */
async function getEvolutionLogImprovements(limit = 10) {
  try {
    const raw = await fs.readFile(EVOLUTION_LOG, "utf8");
    const log = JSON.parse(raw);
    if (!log.runs || log.runs.length === 0) return [];

    const improvements = [];
    for (const run of log.runs.slice(-limit).reverse()) {
      for (const imp of (run.improvements || [])) {
        if (imp.applied) {
          improvements.push({
            timestamp: run.timestamp,
            category: imp.type || "self_evolution",
            action: imp.description,
            file: imp.file,
            reason: "Self-evolution cycle",
            source: "selfEvolve"
          });
        }
      }
    }
    return improvements.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Merge and deduplicate improvements from all sources
 */
async function getAllImprovements(limit = 20) {
  const [logged, gitChanges, evolveChanges] = await Promise.all([
    getRecentImprovements(limit),
    getGitImprovements(limit),
    getEvolutionLogImprovements(limit)
  ]);

  // Merge all sources, deduplicate by action text
  const seen = new Set();
  const merged = [];

  // Priority: logged improvements first, then evolution, then git
  for (const imp of [...logged, ...evolveChanges, ...gitChanges]) {
    const key = (imp.action || "").toLowerCase().substring(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(imp);
    }
  }

  // Sort by timestamp descending (most recent first)
  merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return merged.slice(0, limit);
}

/**
 * Self-improvement tool
 * Handles queries about agent's self-modifications and improvements
 */
async function selfImprovement(query) {
  const lower = query.toLowerCase();

  try {
    // Query: "what have you improved lately?"
    if (lower.includes("what have you improved") || lower.includes("what improvements") || lower.includes("show improvements") || lower.includes("list improvements") || lower.includes("recent improvements") || lower.includes("what changed") || lower.includes("recent changes")) {
      const improvements = await getAllImprovements(20);

      if (improvements.length === 0) {
        return {
          tool: "selfImprovement",
          success: true,
          final: true,
          data: {
            text: "I haven't recorded any self-improvements yet. I log improvements when I:\n- Modify my own code\n- Install new packages\n- Download learning resources\n- Update configuration files\n- Run self-evolution cycles\n\nTip: Run 'self evolve' to start an improvement cycle, or check git log for code changes.",
            message: "I haven't recorded any self-improvements yet."
          }
        };
      }

      // Group by category
      const byCategory = {};
      for (const imp of improvements) {
        const cat = imp.category || "other";
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(imp);
      }

      const text = improvements
        .slice(0, 10)
        .map((imp) => `\u2022 ${imp.category}: ${imp.action}${imp.reason ? ` (${imp.reason})` : ''}`)
        .join('\n');

      // Build HTML report
      const html = `
        <div class="improvements-report">
          <h2>🔧 Recent Self-Improvements</h2>
          ${Object.entries(byCategory).map(([category, items]) => `
            <div class="improvement-category">
              <h3>${category.charAt(0).toUpperCase() + category.slice(1)}</h3>
              <ul class="improvement-list">
                ${items.map((imp) => `
                  <li class="improvement-item">
                    <div class="improvement-action">${imp.action}</div>
                    ${imp.reason ? `<div class="improvement-reason">${imp.reason}</div>` : ''}
                    ${imp.file ? `<div class="improvement-file">📄 ${imp.file}</div>` : ''}
                    ${imp.source ? `<div class="improvement-source">Source: ${imp.source}</div>` : ''}
                    <div class="improvement-timestamp">${new Date(imp.timestamp).toLocaleString()}</div>
                  </li>
                `).join('')}
              </ul>
            </div>
          `).join('')}
          <div class="improvement-summary">
            <p><strong>Total improvements:</strong> ${improvements.length}</p>
            <p><strong>Categories:</strong> ${Object.keys(byCategory).join(', ')}</p>
          </div>
        </div>

      `;

      return {
        tool: "selfImprovement",
        success: true,
        final: true,
        data: {
          html,
          text: `Recent improvements:\n\n${text}\n\n(Showing ${Math.min(10, improvements.length)} of ${improvements.length} total)`,
          improvements
        }
      };
    }

    // Query: "how accurate is your routing?"
    if (lower.includes("routing accuracy") || lower.includes("intent accuracy") || lower.includes("how accurate")) {
      const report = await getIntentAccuracyReport();

      const html = `
        <div class="accuracy-report">
          <h2>🎯 Routing Accuracy Report</h2>
          <div class="accuracy-stats">
            <div class="stat-box">
              <div class="stat-value">${report.successRate.toFixed(1)}%</div>
              <div class="stat-label">Overall Success Rate</div>
            </div>
            <div class="stat-box">
              <div class="stat-value">${report.totalDecisions}</div>
              <div class="stat-label">Total Routing Decisions</div>
            </div>
            <div class="stat-box">
              <div class="stat-value">${report.lowConfidenceDecisions.length}</div>
              <div class="stat-label">Low Confidence</div>
            </div>
          </div>
          <h3>By Tool</h3>
          <table class="accuracy-table">
            <thead>
              <tr>
                <th>Tool</th><th>Total</th><th>Successes</th>
                <th>Success Rate</th><th>Avg Confidence</th>
              </tr>
            </thead>
            <tbody>
              ${Object.entries(report.byTool)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([tool, stats]) => `
                  <tr>
                    <td>${tool}</td>
                    <td>${stats.total}</td>
                    <td>${stats.successes}</td>
                    <td>${((stats.successes / stats.total) * 100).toFixed(1)}%</td>
                    <td>${stats.averageConfidence ? stats.averageConfidence.toFixed(2) : 'N/A'}</td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>

      `;

      return {
        tool: "selfImprovement",
        success: true,
        final: true,
        data: { html, report }
      };
    }

    // Query: "what issues have you detected?"
    if (lower.includes("detected issues") || lower.includes("what problems") || lower.includes("misrouting patterns")) {
      const patterns = await detectMisroutingPatterns();
      const recommendations = await getRoutingRecommendations();

      if (patterns.length === 0 && recommendations.length === 0) {
        return {
          tool: "selfImprovement",
          success: true,
          final: true,
          data: { text: "✅ No significant issues detected! Routing performance looks good." }
        };
      }

      const html = `
        <div class="issues-report">
          <h2>⚠️ Detected Issues & Recommendations</h2>
          ${patterns.length > 0 ? `
            <h3>Patterns Detected</h3>
            <ul class="issues-list">
              ${patterns.map((p) => `
                <li class="issue-item">
                  <div class="issue-type">${p.type.replace(/_/g, ' ').toUpperCase()}</div>
                  <div class="issue-recommendation">${p.recommendation}</div>
                </li>
              `).join('')}
            </ul>
          ` : ''}
          ${recommendations.length > 0 ? `
            <h3>Recommendations</h3>
            <ul class="recommendations-list">
              ${recommendations.map((r) => `
                <li class="recommendation-item priority-${r.priority}">
                  <div class="recommendation-header">
                    <span class="recommendation-priority">${r.priority.toUpperCase()}</span>
                    <span class="recommendation-category">${r.category}</span>
                  </div>
                  <div class="recommendation-details">${r.details}</div>
                </li>
              `).join('')}
            </ul>
          ` : ''}
        </div>

      `;

      return {
        tool: "selfImprovement",
        success: true,
        final: true,
        data: { html, patterns, recommendations }
      };
    }

    // Query: "Review your own logic" or "Suggest improvements to yourself"
    if (lower.includes("review your") || lower.includes("suggest improvement") || (lower.includes("make you") && (lower.includes("smarter") || lower.includes("faster")))) {
      const { review } = await import("./review.js");

      const target = lower.includes("planner") ? "server/planner.js" :
        lower.includes("executor") ? "server/executor.js" :
          "server/planner.js";

      const reviewResult = await review(`review ${target}`);

      if (reviewResult.success) {
        const message = `🤖 **Self-Critique (${target}):**\n\nI've analyzed my core logic in \`${target}\`. Here are some ways I can improve:\n\n${reviewResult.data.reviewText}`;
        return {
          tool: "selfImprovement",
          success: true,
          final: true,
          data: {
            ...reviewResult.data,
            text: message,
            html: reviewResult.data.html || message,
            message
          }
        };
      }
    }

    // Query: "generate weekly report"
    if (lower.includes("weekly report") || lower.includes("generate report") || lower.includes("summary report")) {
      const htmlReport = await generateSummaryReport();

      return {
        tool: "selfImprovement",
        success: true,
        final: true,
        data: { html: htmlReport, text: "Weekly report generated. This can be sent via email.", report: htmlReport }
      };
    }

    // Default: unknown query
    return {
      tool: "selfImprovement",
      success: false,
      final: true,
      error: "I can help with:\n- 'what have you improved lately?'\n- 'how accurate is your routing?'\n- 'what issues have you detected?'\n- 'Review your own logic (planner/executor)'\n- 'suggest improvements to make you smarter'"
    };

  } catch (err) {
    return {
      tool: "selfImprovement",
      success: false,
      final: true,
      error: `Self-improvement query failed: ${err.message}`
    };
  }
}

export { selfImprovement };


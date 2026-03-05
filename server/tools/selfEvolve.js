// server/tools/selfEvolve.js
// Self-evolution workflow — autonomous self-improvement cycle
// Scans GitHub, reviews own code, generates improvements, applies patches
// Designed to run on a schedule (e.g., daily at 09:00)

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { llm } from "./llm.js";
import { githubScanner } from "./githubScanner.js";
import { codeReview } from "./codeReview.js";
import { codeTransform } from "./codeTransform.js";
import { projectGraph } from "./projectGraph.js";
import { logImprovement } from "../telemetryAudit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const EVOLUTION_LOG = path.resolve(__dirname, "..", "data", "evolution-log.json");

/**
 * Load evolution history
 */
async function loadEvolutionLog() {
  try {
    const raw = await fs.readFile(EVOLUTION_LOG, "utf8");
    return JSON.parse(raw);
  } catch {
    return { runs: [], totalImprovements: 0, lastRun: null };
  }
}

/**
 * Save evolution history
 */
async function saveEvolutionLog(log) {
  const dir = path.dirname(EVOLUTION_LOG);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(EVOLUTION_LOG, JSON.stringify(log, null, 2), "utf8");
}

/**
 * Run a full self-improvement cycle
 */
async function runImprovementCycle(options = {}) {
  const { scope = "tools", dryRun = false, focus = "" } = options;
  const results = { steps: [], improvements: [], timestamp: new Date().toISOString() };

  // Step 1: Scan GitHub for inspiration
  results.steps.push({ step: "github_scan", status: "running" });
  let githubInsights;
  try {
    const scanQuery = focus || "ai agent tools best practices node.js";
    const scanResult = await githubScanner({ text: `scan github for ${scanQuery}`, context: { action: "improve" } });
    githubInsights = scanResult.data?.analysis || scanResult.data?.text || "";
    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `Found insights from ${scanResult.data?.repos?.length || 0} repos`;
  } catch (err) {
    githubInsights = "";
    results.steps[results.steps.length - 1].status = "failed";
    results.steps[results.steps.length - 1].error = err.message;
  }

  // Step 2: Review own code
  results.steps.push({ step: "self_review", status: "running" });
  let reviewFindings;
  const reviewTarget = scope === "planner" ? path.join(PROJECT_ROOT, "server/planner.js")
    : scope === "tools" ? path.join(PROJECT_ROOT, "server/tools")
    : path.join(PROJECT_ROOT, "server");

  try {
    const reviewResult = await codeReview({
      text: `quality review ${reviewTarget}`,
      context: { path: reviewTarget, reviewType: "quality" }
    });
    reviewFindings = reviewResult.data?.text || "";
    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `Reviewed ${reviewResult.data?.reviewedFiles || 1} files`;
  } catch (err) {
    reviewFindings = "";
    results.steps[results.steps.length - 1].status = "failed";
    results.steps[results.steps.length - 1].error = err.message;
  }

  // Step 3: Check dependency health
  results.steps.push({ step: "dependency_check", status: "running" });
  let depAnalysis;
  try {
    const graphResult = await projectGraph({
      text: `analyze ${PROJECT_ROOT}`,
      context: { path: PROJECT_ROOT, action: "full" }
    });
    depAnalysis = graphResult.data?.text || "";
    const circularCount = graphResult.data?.circularDeps?.length || 0;
    const deadCount = graphResult.data?.deadCode?.length || 0;
    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `${circularCount} circular deps, ${deadCount} dead files`;
  } catch (err) {
    depAnalysis = "";
    results.steps[results.steps.length - 1].status = "failed";
    results.steps[results.steps.length - 1].error = err.message;
  }

  // Step 4: Generate improvement plan using LLM
  results.steps.push({ step: "improvement_plan", status: "running" });
  let improvementPlan;
  try {
    const prompt = `You are an AI agent's self-improvement engine. Based on the following analysis, generate a specific improvement plan.

GITHUB INSIGHTS:
${(githubInsights || "No GitHub insights available").slice(0, 3000)}

CODE REVIEW FINDINGS:
${(reviewFindings || "No review findings available").slice(0, 3000)}

DEPENDENCY ANALYSIS:
${(depAnalysis || "No dependency analysis available").slice(0, 2000)}

Generate a prioritized list of 3-5 specific, actionable improvements. For each:
1. WHAT to change (specific file and function)
2. WHY (based on findings above)
3. HOW (specific code changes)
4. RISK level (low/medium/high)

Focus on improvements that are:
- Low risk (won't break existing functionality)
- High impact (improve reliability, speed, or capabilities)
- Specific (can be implemented in a single file change)

Format as JSON array:
[
  { "file": "path", "description": "what to do", "priority": 1, "risk": "low", "type": "fix|optimize|add|refactor" },
  ...
]`;

    const response = await llm(prompt);
    const responseText = response?.data?.text || "";

    // Try to extract JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      improvementPlan = JSON.parse(jsonMatch[0]);
    } else {
      improvementPlan = [{ file: "none", description: responseText.slice(0, 500), priority: 0, risk: "unknown", type: "info" }];
    }
    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `Generated ${improvementPlan.length} improvement suggestions`;
  } catch (err) {
    improvementPlan = [];
    results.steps[results.steps.length - 1].status = "failed";
    results.steps[results.steps.length - 1].error = err.message;
  }

  // Step 5: Apply improvements (if not dry run)
  if (!dryRun && improvementPlan.length > 0) {
    results.steps.push({ step: "apply_improvements", status: "running" });

    const lowRiskImprovements = improvementPlan.filter(i => i.risk === "low" && i.file !== "none");

    for (const improvement of lowRiskImprovements.slice(0, 3)) {
      try {
        const filePath = improvement.file.startsWith("/") || improvement.file.includes(":")
          ? improvement.file
          : path.join(PROJECT_ROOT, improvement.file);

        const transformResult = await codeTransform({
          text: `${improvement.type} ${filePath}: ${improvement.description}`,
          context: { path: filePath, action: improvement.type }
        });

        if (transformResult.success) {
          results.improvements.push({
            file: improvement.file,
            description: improvement.description,
            applied: true,
            diff: transformResult.data?.diff
          });
          // Log to improvements.jsonl so selfImprovement tool can report it
          await logImprovement({
            category: improvement.type || "code_change",
            action: improvement.description,
            file: improvement.file,
            reason: "Self-evolution cycle",
            source: "selfEvolve"
          });
        } else {
          results.improvements.push({
            file: improvement.file,
            description: improvement.description,
            applied: false,
            error: transformResult.data?.message
          });
        }
      } catch (err) {
        results.improvements.push({
          file: improvement.file,
          description: improvement.description,
          applied: false,
          error: err.message
        });
      }
    }

    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `Applied ${results.improvements.filter(i => i.applied).length} of ${lowRiskImprovements.length} improvements`;
  } else if (dryRun) {
    results.improvements = improvementPlan.map(i => ({ ...i, applied: false, dryRun: true }));
  }

  // Save evolution log
  const log = await loadEvolutionLog();
  log.runs.push(results);
  log.totalImprovements += results.improvements.filter(i => i.applied).length;
  log.lastRun = results.timestamp;

  // Keep only last 50 runs
  if (log.runs.length > 50) log.runs = log.runs.slice(-50);
  await saveEvolutionLog(log);

  return results;
}

/**
 * Show evolution history
 */
async function showHistory() {
  const log = await loadEvolutionLog();
  if (!log.runs || log.runs.length === 0) {
    return "No self-improvement runs recorded yet.";
  }

  let output = `📈 **Self-Evolution History**\n\n`;
  output += `Total runs: ${log.runs.length}\n`;
  output += `Total improvements applied: ${log.totalImprovements}\n`;
  output += `Last run: ${log.lastRun || "never"}\n\n`;

  const recentRuns = log.runs.slice(-5).reverse();
  for (const run of recentRuns) {
    const applied = run.improvements?.filter(i => i.applied)?.length || 0;
    const total = run.improvements?.length || 0;
    output += `**${run.timestamp}**\n`;
    output += `  Steps: ${run.steps?.map(s => `${s.step}:${s.status}`).join(", ")}\n`;
    output += `  Improvements: ${applied}/${total} applied\n\n`;
  }

  return output;
}

/**
 * Detect intent
 */
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(history|log|previous|past)\b/.test(lower)) return "history";
  if (/\b(dry.?run|preview|plan|what\s+would)\b/.test(lower)) return "dryrun";
  if (/\b(run|start|execute|begin|scan|improve|evolve|upgrade)\b/.test(lower)) return "run";
  if (/\b(status|last|recent)\b/.test(lower)) return "status";
  return "run";
}

/**
 * Main entry point
 */
export async function selfEvolve(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  const intent = context.action || detectIntent(text);

  try {
    switch (intent) {
      case "history": {
        const history = await showHistory();
        return {
          tool: "selfEvolve",
          success: true,
          final: true,
          data: { preformatted: true, text: history }
        };
      }

      case "status": {
        const log = await loadEvolutionLog();
        const lastRun = log.runs?.[log.runs.length - 1];
        const text = lastRun
          ? `🤖 **Last Self-Improvement Run**\nTime: ${lastRun.timestamp}\nSteps: ${lastRun.steps?.length || 0}\nImprovements applied: ${lastRun.improvements?.filter(i => i.applied)?.length || 0}\nTotal lifetime improvements: ${log.totalImprovements}`
          : "No self-improvement runs recorded yet. Run 'self evolve' to start.";

        return {
          tool: "selfEvolve",
          success: true,
          final: true,
          data: { preformatted: true, text }
        };
      }

      case "dryrun": {
        const scope = /\b(planner|tools|server|full)\b/i.exec(text)?.[1]?.toLowerCase() || "tools";
        const focus = text.replace(/.*(?:dry.?run|preview|plan)\s*/i, "").trim();

        const results = await runImprovementCycle({ scope, dryRun: true, focus });

        let output = `🔍 **Self-Improvement Preview (Dry Run)**\n\n`;
        output += `**Steps:**\n`;
        for (const step of results.steps) {
          const icon = step.status === "done" ? "✅" : step.status === "failed" ? "❌" : "⏳";
          output += `  ${icon} ${step.step}: ${step.summary || step.error || step.status}\n`;
        }

        output += `\n**Suggested Improvements:**\n`;
        for (const imp of results.improvements || []) {
          output += `  📌 [${imp.priority || "?"}] ${imp.description}\n`;
          output += `     File: ${imp.file} | Risk: ${imp.risk} | Type: ${imp.type}\n\n`;
        }

        if (results.improvements?.length > 0) {
          output += `\nSay "apply" or "run self evolve" to apply these improvements.`;
        }

        return {
          tool: "selfEvolve",
          success: true,
          final: true,
          data: { preformatted: true, text: output, results }
        };
      }

      case "run":
      default: {
        const scope = /\b(planner|tools|server|full)\b/i.exec(text)?.[1]?.toLowerCase() || "tools";
        const focus = text.replace(/.*(?:run|start|execute|begin|scan|improve|evolve|upgrade)\s*/i, "").trim();

        const results = await runImprovementCycle({ scope, dryRun: false, focus });

        let output = `🤖 **Self-Improvement Cycle Complete**\n\n`;
        output += `**Steps:**\n`;
        for (const step of results.steps) {
          const icon = step.status === "done" ? "✅" : step.status === "failed" ? "❌" : "⏳";
          output += `  ${icon} ${step.step}: ${step.summary || step.error || step.status}\n`;
        }

        const applied = results.improvements?.filter(i => i.applied) || [];
        const failed = results.improvements?.filter(i => !i.applied && !i.dryRun) || [];

        if (applied.length > 0) {
          output += `\n**Applied Improvements (${applied.length}):**\n`;
          for (const imp of applied) {
            output += `  ✅ ${imp.description}\n`;
            output += `     File: ${imp.file}\n`;
            if (imp.diff) output += `     Changes: +${imp.diff.linesAdded || 0} -${imp.diff.linesRemoved || 0}\n`;
          }
        }

        if (failed.length > 0) {
          output += `\n**Failed Improvements (${failed.length}):**\n`;
          for (const imp of failed) {
            output += `  ❌ ${imp.description}: ${imp.error}\n`;
          }
        }

        if (applied.length === 0 && failed.length === 0) {
          output += `\nNo low-risk improvements to apply at this time. The codebase looks healthy!`;
        }

        return {
          tool: "selfEvolve",
          success: true,
          final: true,
          data: { preformatted: true, text: output, results }
        };
      }
    }
  } catch (err) {
    return {
      tool: "selfEvolve",
      success: false,
      final: true,
      data: { message: `Self-evolution error: ${err.message}` }
    };
  }
}

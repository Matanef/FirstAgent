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
const REVIEW_CACHE_PATH = path.resolve(__dirname, "..", "data", "review-rotation.json"); // <-- ADD THIS

// ── Guardrails: paths the agent is allowed to modify during self-evolution ──
const ALLOWED_EVOLVE_DIRS = ["server/tools", "server/utils", "server"];
const BLOCKED_EVOLVE_FILES = new Set([
  "server/routes/chat.js",       // core SSE route — never auto-modify
  "server/planner.js",           // complex routing — too risky for auto-edit
  "server/executor.js",          // execution pipeline — too risky
  "server/agents/orchestrator.js",
  "package.json",
  "package-lock.json",
  ".env",
]);
const BLOCKED_EVOLVE_DIRS = new Set([
  "client",       // never auto-modify React frontend
  "agent",        // hallucinated directory — should not exist
  "node_modules",
]);

/**
 * Check if a file path is safe for selfEvolve to modify
 */
function isEvolvePathAllowed(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  // Block paths outside the project
  const relative = path.relative(PROJECT_ROOT, path.resolve(PROJECT_ROOT, filePath)).replace(/\\/g, "/");
  if (relative.startsWith("..")) return false;
  // Block specific files
  if (BLOCKED_EVOLVE_FILES.has(relative)) return false;
  // Block entire directories
  for (const dir of BLOCKED_EVOLVE_DIRS) {
    if (relative.startsWith(dir + "/") || relative === dir) return false;
  }
  // Must be within an allowed directory
  return ALLOWED_EVOLVE_DIRS.some(d => relative.startsWith(d + "/") || relative === d);
}

/**
 * Read package.json dependencies to give the LLM context
 */
async function getInstalledDependencies() {
  try {
    const pkgPath = path.join(PROJECT_ROOT, "server", "package.json");
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

/**
 * Read a brief snippet of each target file so the LLM has real context
 */
async function readFileSnippets(filePaths) {
  const snippets = [];
  for (const fp of filePaths.slice(0, 5)) {
    try {
      const fullPath = fp.startsWith("/") || fp.includes(":") ? fp : path.join(PROJECT_ROOT, fp);
      const content = await fs.readFile(fullPath, "utf8");
      const lines = content.split("\n");
      // First 40 lines (imports + main exports) + last 10 lines
      const head = lines.slice(0, 40).join("\n");
      const tail = lines.length > 50 ? "\n// ... (truncated) ...\n" + lines.slice(-10).join("\n") : "";
      snippets.push(`--- ${fp} (${lines.length} lines) ---\n${head}${tail}`);
    } catch {
      // File might not exist — the LLM hallucinated the path
    }
  }
  return snippets.join("\n\n");
}

// Normalize focus to avoid "yourself", "me", etc.
function normalizeFocus(focus) {
  if (!focus) return "";
  const bad = new Set(["yourself", "me", "self", "agent", "system"]);
  const cleaned = focus.trim().toLowerCase();
  return bad.has(cleaned) ? "" : focus.trim();
}

/**
 * Simple timeout wrapper with AbortController support
 */
async function withTimeout(promise, ms, label = "operation", controller = null) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (controller) controller.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    console.log(`[selfEvolve] withTimeout start: ${label}, ${ms}ms`);
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timeoutId);
    console.log(`[selfEvolve] withTimeout success: ${label}`);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[selfEvolve] withTimeout error in ${label}:`, err.message);
    throw err;
  }
}

/**
 * Load evolution history
 */
async function loadEvolutionLog() {
  try {
    console.log("[selfEvolve] Loading evolution log:", EVOLUTION_LOG);
    const raw = await fs.readFile(EVOLUTION_LOG, "utf8");
    return JSON.parse(raw);
  } catch {
    console.warn("[selfEvolve] No evolution log found, starting fresh.");
    return { runs: [], totalImprovements: 0, lastRun: null };
  }
}

/**
 * Save evolution history
 */
async function saveEvolutionLog(log) {
  try {
    console.log("[selfEvolve] Saving evolution log.");
    const dir = path.dirname(EVOLUTION_LOG);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(EVOLUTION_LOG, JSON.stringify(log, null, 2), "utf8");
  } catch (err) {
    console.error("[selfEvolve] Failed to save evolution log:", err.message);
  }
}

/**
 * Safely extract improvement plan JSON from LLM response
 */
function extractImprovementPlan(responseText) {
  console.log("[selfEvolve] Extracting improvement plan from LLM response.");
  if (!responseText || typeof responseText !== "string") {
    console.warn("[selfEvolve] Empty or non-string LLM response.");
    return [];
  }

  const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    console.warn("[selfEvolve] No JSON array found in LLM response, returning fallback plan.");
    return [
      {
        file: "none",
        description: responseText.slice(0, 500),
        priority: 0,
        risk: "unknown",
        type: "info"
      }
    ];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    console.log("[selfEvolve] Parsed improvement plan JSON successfully.");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error("[selfEvolve] Failed to parse improvement plan JSON:", err.message);
    return [
      {
        file: "none",
        description: responseText.slice(0, 500),
        priority: 0,
        risk: "parse_error",
        type: "info"
      }
    ];
  }
}
/**
 * Reads the directory and picks up to N files that haven't been reviewed recently.
 */
async function getFilesToReview(targetDir, maxFiles = 10) {
  let cache = {};
  try {
    const raw = await fs.readFile(REVIEW_CACHE_PATH, "utf8");
    cache = JSON.parse(raw);
  } catch { /* Cache doesn't exist yet, that's fine */ }

  const files = [];
  try {
    const items = await fs.readdir(targetDir, { withFileTypes: true });
    for (const item of items) {
      if (item.isFile() && item.name.endsWith(".js")) {
        files.push(path.join(targetDir, item.name));
      }
    }
  } catch (err) {
    console.error(`[selfEvolve] Could not read directory ${targetDir}:`, err.message);
    return [];
  }

  // Sort files by oldest timestamp (0 if never reviewed)
  files.sort((a, b) => (cache[a] || 0) - (cache[b] || 0));
  
  return files.slice(0, maxFiles);
}

/**
 * Updates the timestamps for the files we just reviewed.
 */
async function markFilesReviewed(files) {
  let cache = {};
  try {
    const raw = await fs.readFile(REVIEW_CACHE_PATH, "utf8");
    cache = JSON.parse(raw);
  } catch { /* Cache doesn't exist yet */ }

  const now = Date.now();
  for (const f of files) {
    cache[f] = now;
  }

  try {
    await fs.writeFile(REVIEW_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.error("[selfEvolve] Failed to save review cache:", err.message);
  }
}


/**
 * Run a full self-improvement cycle
 */
async function runImprovementCycle(options = {}) {
  const {
    scope = "tools",
    dryRun = false,
    focus = "",
    maxDurationMs = 15 * 60 * 1000 // 15 minutes global guard
  } = options;

  console.log("[selfEvolve] Starting improvement cycle:", { scope, dryRun, focus, maxDurationMs });

  const startedAt = Date.now();
  const results = {
    steps: [],
    improvements: [],
    timestamp: new Date().toISOString()
  };

  const ensureNotExpired = (label) => {
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxDurationMs) {
      console.error(`[selfEvolve] Global maxDuration exceeded during ${label}: ${elapsed}ms`);
      throw new Error(`Global maxDuration exceeded during ${label}`);
    }
  };

  // Step 1: Targeted Code Review (Read Memory & Review)
  console.log("[selfEvolve] Step 1: targeted_review starting.");
  results.steps.push({ step: "targeted_review", status: "running" });

  const targetDir = scope === "tools" ? path.join(PROJECT_ROOT, "server/tools") : path.join(PROJECT_ROOT, "server");
  let reviewFindings = "";
  let reviewedFilesList = [];

  try {
    ensureNotExpired("targeted_review");
    
    // 1. Ask Memory for 10 files that haven't been reviewed recently
    const filesToReview = await getFilesToReview(targetDir, 10);
    console.log(`[selfEvolve] Selected ${filesToReview.length} files from cache for review.`);

    if (filesToReview.length === 0) {
       throw new Error("No files found to review in " + targetDir);
    }

    // 2. Loop through and review ONLY these specific files
    const controller = new AbortController();
    let combinedNotes = [];

    for (const file of filesToReview) {
      try {
        console.log(`[selfEvolve] Analyzing specific file: ${path.basename(file)}`);
        const reviewResult = await withTimeout(
          codeReview({
            text: `quality review ${file}`,
            context: {
              source: "selfEvolve",
              path: file,
              reviewType: "quality",
              signal: controller.signal,
              budgetMs: 120_000 // Only give it 1 minute per file!
            }
          }),
          75_000, 
          `codeReview(${path.basename(file)})`,
          controller
        );
        
        if (reviewResult.data?.text) {
          const relativePath = path.relative(PROJECT_ROOT, file).replace(/\\/g, "/");
          combinedNotes.push(`--- REVIEW FOR ${relativePath} ---\n${reviewResult.data.text}`);
          reviewedFilesList.push(file);
        }
      } catch (fileErr) {
        console.warn(`[selfEvolve] Skipped ${path.basename(file)} due to timeout/error.`);
      }
    }

    reviewFindings = combinedNotes.join("\n\n");
    
    // 3. Update the memory cache so we don't review these tomorrow!
    await markFilesReviewed(reviewedFilesList);

    const step = results.steps[results.steps.length - 1];
    step.status = "done";
    step.summary = `Reviewed ${reviewedFilesList.length} targeted files`;
    console.log("[selfEvolve] targeted_review done. Summary:", step.summary);

  } catch (err) {
    const step = results.steps[results.steps.length - 1];
    step.status = "failed";
    step.error = err.message;
    console.error("[selfEvolve] targeted_review failed:", err.message);
  }

  // Step 2: Dynamic GitHub Scan (Targeted Learning)
  console.log("[selfEvolve] Step 2: dynamic_learning starting.");
  results.steps.push({ step: "dynamic_learning", status: "running" });
  let githubInsights = "";
  
  try {
    ensureNotExpired("dynamic_learning");

    // 1. Ask LLM what to search for based on the weaknesses we JUST found!
    const queryPrompt = `Based on the following code review findings, identify the SINGLE most critical technical concept, library, or best practice we need to research to fix the underlying issues.
    
CODE REVIEW FINDINGS:
${reviewFindings.slice(0, 15000)}

Respond with ONLY a 3-to-6 word search query for GitHub. Do not include quotes, explanations, or markdown.
Example: node.js robust error handling middleware`;

    console.log("[selfEvolve] Asking LLM for dynamic search query...");
    const queryResponse = await withTimeout(llm(queryPrompt), 90_000, "llm(search_query)");
    
    // Clean up the LLM's response so it's a perfect search string
    const dynamicQuery = queryResponse?.data?.text?.trim().replace(/['"]/g, '') || "ai agent tools best practices node.js";
    console.log(`[selfEvolve] LLM generated targeted query: "${dynamicQuery}"`);

    // 2. Run the targeted scan
    const scanResult = await withTimeout(
      githubScanner({
        text: `scan github for ${dynamicQuery}`,
        context: { action: "improve" }
      }),
      120_000,
      "githubScanner"
    );

    githubInsights = scanResult.data?.analysis || scanResult.data?.text || "";
    const step = results.steps[results.steps.length - 1];
    step.status = "done";
    step.summary = `Learned about "${dynamicQuery}" from ${scanResult.data?.repos?.length || 0} repos`;
    console.log("[selfEvolve] dynamic_learning done. Summary:", step.summary);
  } catch (err) {
    const step = results.steps[results.steps.length - 1];
    step.status = "failed";
    step.error = err.message;
    console.error("[selfEvolve] dynamic_learning failed:", err.message);
  }

  // Step 3: Check dependency health
  console.log("[selfEvolve] Step 3: dependency_check starting.");
  results.steps.push({ step: "dependency_check", status: "running" });
  let depAnalysis = "";
  try {
    ensureNotExpired("dependency_check");
    const graphResult = await withTimeout(
      projectGraph({
        text: `analyze ${PROJECT_ROOT}`,
        context: { path: PROJECT_ROOT, action: "full" }
      }),
      90_000,
      "projectGraph"
    );
    depAnalysis = graphResult.data?.text || "";
    const circularCount = graphResult.data?.circularDeps?.length || 0;
    const deadCount = graphResult.data?.deadCode?.length || 0;
    const step = results.steps[results.steps.length - 1];
    step.status = "done";
    step.summary = `${circularCount} circular deps, ${deadCount} dead files`;
    console.log("[selfEvolve] dependency_check done. Summary:", step.summary);
  } catch (err) {
    depAnalysis = "";
    const step = results.steps[results.steps.length - 1];
    step.status = "failed";
    step.error = err.message;
    console.error("[selfEvolve] dependency_check failed:", err.message);
  }

  // Step 4: Generate improvement plan using LLM (with architectural context)
  console.log("[selfEvolve] Step 4: improvement_plan starting.");
  results.steps.push({ step: "improvement_plan", status: "running" });
  let improvementPlan = [];
  try {
    ensureNotExpired("improvement_plan");

// ── Gather real project context so the LLM doesn't hallucinate ──
    const installedDeps = await getInstalledDependencies();
    const depsStr = installedDeps.length > 0
      ? installedDeps.join(", ")
      : "express, axios, cors, dotenv, googleapis";

    const prompt = `You are an AI agent's self-improvement engine. Based on the following code review and the targeted research you just completed, generate a specific improvement plan.

═══════════════════════════════════════════════════════════════
PROJECT ARCHITECTURE RULES (MANDATORY — NEVER VIOLATE THESE):
═══════════════════════════════════════════════════════════════
1. MODULE SYSTEM: This project uses ES Modules EXCLUSIVELY (import/export).
   NEVER use CommonJS (require/module.exports).
2. FRONTEND: React 19 with functional components and hooks. The frontend
   lives in client/src/. You are NOT allowed to modify frontend files.
3. DEPENDENCIES: You may ONLY use packages currently installed:
   [${depsStr}]
   Do NOT invent, hallucinate, or import packages that are not in this list.
4. BOUNDARIES: You may ONLY modify existing files in server/tools/ or
   server/utils/. Do NOT create new files. Do NOT create new directories.
   Do NOT touch client/, agent/, or root-level files.
5. NO BOILERPLATE: Do NOT generate generic "API hubs", "event emitters",
   "CLI interfaces", or architecture wrappers. Improve EXISTING tools only.
6. PRESERVE EXPORTS: Every tool file exports a single async function.
   Do NOT change the function signature or export name.
7. ANTI-HALLUCINATION (CRITICAL): You may ONLY suggest improvements for files that are EXPLICITLY named in the CODE REVIEW FINDINGS below. If a file is not in the review findings, it does not exist. DO NOT guess or invent file names.
═══════════════════════════════════════════════════════════════

TARGETED RESEARCH (From dynamic GitHub scan):
${(githubInsights || "No GitHub insights available").slice(0, 10000)}

CODE REVIEW FINDINGS (The 10 files you reviewed today):
${(reviewFindings || "No review findings available").slice(0, 80000)}

DEPENDENCY ANALYSIS:
${(depAnalysis || "No dependency analysis available").slice(0, 2000)}

Generate a prioritized list of 1 to 3 specific, actionable improvements based on the TARGETED RESEARCH. For each:
1. WHAT to change (specific EXISTING file from the review findings)
2. WHY (based on the targeted research above)
3. HOW (specific code changes — use ES module syntax only)
4. RISK level (low/medium/high)

Focus on improvements that are:
- Low risk (won't break existing functionality)
- High impact (fix the exact weaknesses found in the review)
- Modifying EXISTING files only (never creating new ones)
- Using ONLY installed dependencies (never inventing packages)

Format as JSON array (DO NOT copy this dummy example):
[
  { "file": "EXACT_PATH_FROM_REVIEW_HEADER_HERE.js", "description": "what to do", "priority": 1, "risk": "low", "type": "fix|optimize|refactor" }
]

CRITICAL: The "file" field must be the EXACT relative path from the review headers above (e.g., "server/tools/email.js"). Do NOT invent directories. Do NOT use type "add" — only "fix", "optimize", or "refactor".`;

    console.log("[selfEvolve] Calling LLM for improvement_plan.");
    const response = await withTimeout(llm(prompt), 300_000, "llm(selfEvolve)");
    const responseText = response?.data?.text || "";
    improvementPlan = extractImprovementPlan(responseText);

// ── Post-filter: remove any suggestions targeting blocked paths ──
    const originalCount = improvementPlan.length;
    improvementPlan = improvementPlan.filter(imp => {
      if (!imp.file || imp.file === "none") return true; // info-only items
      if (imp.type === "add") {
        console.warn(`[selfEvolve] BLOCKED "add" type suggestion: ${imp.file} — ${imp.description}`);
        return false;
      }
      if (!isEvolvePathAllowed(imp.file)) {
        console.warn(`[selfEvolve] BLOCKED path outside allowed dirs: ${imp.file}`);
        return false;
      }
      
      // ── THE ANTI-HALLUCINATION SHIELD ──
      // If the file name doesn't exist anywhere in the Code Review text, it's a hallucination!
      if (reviewFindings && !reviewFindings.includes(path.basename(imp.file))) {
        console.warn(`[selfEvolve] BLOCKED hallucinated file (not in review): ${imp.file}`);
        return false;
      }

      return true;
    });
    if (improvementPlan.length < originalCount) {
      console.log(`[selfEvolve] Filtered out ${originalCount - improvementPlan.length} unsafe suggestions.`);
    }

    const step = results.steps[results.steps.length - 1];
    step.status = "done";
    step.summary = `Generated ${improvementPlan.length} improvement suggestions (${originalCount - improvementPlan.length} blocked)`;
    console.log("[selfEvolve] improvement_plan done. Suggestions:", improvementPlan.length);
  } catch (err) {
    improvementPlan = [];
    const step = results.steps[results.steps.length - 1];
    step.status = "failed";
    step.error = err.message;
    console.error("[selfEvolve] improvement_plan failed:", err.message);
  }

  // Step 5: Apply improvements (with guardrails)
  console.log("[selfEvolve] Step 5: apply_improvements starting.");
  if (!dryRun && improvementPlan.length > 0) {
    results.steps.push({ step: "apply_improvements", status: "running" });

    const lowRiskImprovements = improvementPlan.filter(
      (i) => i.risk === "low" && i.file !== "none"
    );
    console.log(
      "[selfEvolve] apply_improvements low-risk candidates:",
      lowRiskImprovements.length
    );

    for (const improvement of lowRiskImprovements.slice(0, 3)) {
      try {
        ensureNotExpired("apply_improvements");

        const filePath =
          improvement.file.startsWith("/") || improvement.file.includes(":")
            ? improvement.file
            : path.join(PROJECT_ROOT, improvement.file);

        // ── GUARDRAIL 1: Path must be in allowed directories ──
        if (!isEvolvePathAllowed(improvement.file)) {
          console.warn(`[selfEvolve] BLOCKED: path not allowed: ${improvement.file}`);
          results.improvements.push({
            file: improvement.file,
            description: improvement.description,
            applied: false,
            error: `Blocked: path "${improvement.file}" is outside allowed directories (${ALLOWED_EVOLVE_DIRS.join(", ")})`
          });
          continue;
        }

        // ── GUARDRAIL 2: File must already exist (no new file creation) ──
        try {
          await fs.access(filePath);
        } catch {
          console.warn(`[selfEvolve] BLOCKED: file does not exist: ${filePath}`);
          results.improvements.push({
            file: improvement.file,
            description: improvement.description,
            applied: false,
            error: `Blocked: file "${improvement.file}" does not exist. Self-evolve cannot create new files.`
          });
          continue;
        }

        // ── GUARDRAIL 3: Pre-read the file so codeTransform has real context ──
        let fileContent = "";
        try {
          fileContent = await fs.readFile(filePath, "utf8");
        } catch { /* proceed anyway — codeTransform will read it too */ }

        console.log(
          "[selfEvolve] Applying improvement:",
          improvement.description,
          "->",
          filePath
        );

        const transformResult = await withTimeout(
          codeTransform({
            text: `${improvement.type} ${filePath}: ${improvement.description}`,
            context: {
              path: filePath,
              action: improvement.type,
              source: "selfEvolve",           // signals codeTransform to use guardrails
              existingContent: fileContent.slice(0, 2000)  // first 2K chars for LLM context
            }
          }),
          60_000,
          "codeTransform"
        );

        if (transformResult.success) {
          console.log("[selfEvolve] codeTransform success for:", improvement.file);
          results.improvements.push({
            file: improvement.file,
            description: improvement.description,
            applied: true,
            diff: transformResult.data?.diff
          });

          await logImprovement({
            category: improvement.type || "code_change",
            action: improvement.description,
            file: improvement.file,
            reason: "Self-evolution cycle",
            source: "selfEvolve"
          });
        } else {
          console.warn(
            "[selfEvolve] codeTransform reported failure for:",
            improvement.file,
            transformResult.data?.message
          );
          results.improvements.push({
            file: improvement.file,
            description: improvement.description,
            applied: false,
            error: transformResult.data?.message
          });
        }
      } catch (err) {
        console.error(
          "[selfEvolve] Error applying improvement for:",
          improvement.file,
          err.message
        );
        results.improvements.push({
          file: improvement.file,
          description: improvement.description,
          applied: false,
          error: err.message
        });
      }
    }

    const step = results.steps[results.steps.length - 1];
    step.status = "done";
    step.summary = `Applied ${
      results.improvements.filter((i) => i.applied).length
    } of ${lowRiskImprovements.length} improvements`;
    console.log("[selfEvolve] apply_improvements done. Summary:", step.summary);
  } else if (dryRun) {
    console.log("[selfEvolve] Dry run mode: not applying improvements.");
    results.improvements = improvementPlan.map((i) => ({
      ...i,
      applied: false,
      dryRun: true
    }));
  } else {
    console.log("[selfEvolve] No improvements to apply.");
  }

  // Save evolution log
  console.log("[selfEvolve] Saving evolution log and finishing cycle.");
  const log = await loadEvolutionLog();
  log.runs.push(results);
  log.totalImprovements += results.improvements.filter((i) => i.applied).length;
  log.lastRun = results.timestamp;

  // Keep only last 50 runs
  if (log.runs.length > 50) log.runs = log.runs.slice(-50);
  await saveEvolutionLog(log);

  console.log("[selfEvolve] Improvement cycle complete at", results.timestamp);
  return results;
}

/**
 * Show evolution history
 */
async function showHistory() {
  console.log("[selfEvolve] showHistory called.");
  const log = await loadEvolutionLog();
  if (!log.runs || log.runs.length === 0) {
    console.log("[selfEvolve] No history available.");
    return "No self-improvement runs recorded yet.";
  }

  let output = `📈 **Self-Evolution History**\n\n`;
  output += `Total runs: ${log.runs.length}\n`;
  output += `Total improvements applied: ${log.totalImprovements}\n`;
  output += `Last run: ${log.lastRun || "never"}\n\n`;

  const recentRuns = log.runs.slice(-5).reverse();
  for (const run of recentRuns) {
    const applied = run.improvements?.filter((i) => i.applied)?.length || 0;
    const total = run.improvements?.length || 0;
    output += `**${run.timestamp}**\n`;
    output += `  Steps: ${run.steps
      ?.map((s) => `${s.step}:${s.status}`)
      .join(", ")}\n`;
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
  if (/\b(run|start|execute|begin|scan|improve|evolve|upgrade)\b/.test(lower))
    return "run";
  if (/\b(status|last|recent)\b/.test(lower)) return "status";
  return "run";
}

/**
 * Main entry point
 */
export async function selfEvolve(request) {
  const text =
    typeof request === "string"
      ? request
      : request?.text || request?.input || "";
  const context =
    typeof request === "object" ? request?.context || {} : {};

  console.log("[selfEvolve] Entry called with text:", text);
  console.log("[selfEvolve] Context:", context);

  let intent = context.action || detectIntent(text);
  
  // ── OVERRIDE: If the user explicitly typed "dry run", force it! ──
  if (/\b(dry.?run|preview|plan)\b/i.test(text)) {
    intent = "dryrun";
  }

  console.log("[selfEvolve] Detected intent:", intent);

  try {
    switch (intent) {
      case "history": {
        console.log("[selfEvolve] Handling 'history' intent.");
        const history = await showHistory();
        return {
          tool: "selfEvolve",
          success: true,
          final: true,
          data: { preformatted: true, text: history }
        };
      }

      case "status": {
        console.log("[selfEvolve] Handling 'status' intent.");
        const log = await loadEvolutionLog();
        const lastRun = log.runs?.[log.runs.length - 1];
        const msg = lastRun
          ? `🤖 **Last Self-Improvement Run**\nTime: ${lastRun.timestamp}\nSteps: ${
              lastRun.steps?.length || 0
            }\nImprovements applied: ${
              lastRun.improvements?.filter((i) => i.applied)?.length || 0
            }\nTotal lifetime improvements: ${log.totalImprovements}`
          : "No self-improvement runs recorded yet. Run 'self evolve' to start.";

        return {
          tool: "selfEvolve",
          success: true,
          final: true,
          data: { preformatted: true, text: msg }
        };
      }

      case "dryrun": {
        console.log("[selfEvolve] Handling 'dryrun' intent.");
        const scope =
          /\b(planner|tools|server|full)\b/i.exec(text)?.[1]?.toLowerCase() ||
          "tools";
        const focus = normalizeFocus(
          text.replace(/.*(?:dry.?run|preview|plan)\s*/i, "").trim()
        );

        console.log("[selfEvolve] dryrun scope/focus:", scope, focus);

        const results = await runImprovementCycle({
          scope,
          dryRun: true,
          focus
        });

        let output = `🔍 **Self-Improvement Preview (Dry Run)**\n\n`;
        output += `**Steps:**\n`;
        for (const step of results.steps) {
          const icon =
            step.status === "done"
              ? "✅"
              : step.status === "failed"
              ? "❌"
              : "⏳";
          output += `  ${icon} ${step.step}: ${
            step.summary || step.error || step.status
          }\n`;
        }

        output += `\n**Suggested Improvements:**\n`;
        for (const imp of results.improvements || []) {
          output += `  📌 [${imp.priority || "?"}] ${imp.description}\n`;
          output += `     File: ${imp.file} | Risk: ${imp.risk} | Type: ${
            imp.type
          }\n\n`;
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
        console.log("[selfEvolve] Handling 'run' intent.");
        const scope =
          /\b(planner|tools|server|full)\b/i.exec(text)?.[1]?.toLowerCase() ||
          "tools";
        const focus = normalizeFocus(
          text
            .replace(
              /.*(?:run|start|execute|begin|scan|improve|evolve|upgrade)\s*/i,
              ""
            )
            .trim()
        );

        console.log("[selfEvolve] run scope/focus:", scope, focus);

        const results = await runImprovementCycle({
          scope,
          dryRun: false,
          focus
        });

        let output = `🤖 **Self-Improvement Cycle Complete**\n\n`;
        output += `**Steps:**\n`;
        for (const step of results.steps) {
          const icon =
            step.status === "done"
              ? "✅"
              : step.status === "failed"
              ? "❌"
              : "⏳";
          output += `  ${icon} ${step.step}: ${
            step.summary || step.error || step.status
          }\n`;
        }

        const applied =
          results.improvements?.filter((i) => i.applied) || [];
        const failed =
          results.improvements?.filter(
            (i) => !i.applied && !i.dryRun
          ) || [];

        if (applied.length > 0) {
          output += `\n**Applied Improvements (${applied.length}):**\n`;
          for (const imp of applied) {
            output += `  ✅ ${imp.description}\n`;
            output += `     File: ${imp.file}\n`;
            if (imp.diff) {
              output += `     Changes: +${
                imp.diff.linesAdded || 0
              } -${imp.diff.linesRemoved || 0}\n`;
            }
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
    console.error("[selfEvolve] Top-level error:", err.message);
    return {
      tool: "selfEvolve",
      success: false,
      final: true,
      data: { message: `Self-evolution error: ${err.message}` }
    };
  }
}
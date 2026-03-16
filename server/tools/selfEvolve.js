// server/tools/selfEvolve.js
// Self-evolution workflow — autonomous self-improvement cycle
// Uses Targeted Reflection: Reads memory rotation, conducts specific research, and applies surgical patches.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { llm } from "./llm.js";
import { githubScanner } from "./githubScanner.js";
import { codeReview } from "./codeReview.js";
import { codeTransform } from "./codeTransform.js";
import { testGen } from "./testGen.js"; 
import { projectGraph } from "./projectGraph.js";
import { logImprovement } from "../telemetryAudit.js";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const EVOLUTION_LOG = path.resolve(__dirname, "..", "data", "evolution-log.json");
const REVIEW_CACHE_PATH = path.resolve(__dirname, "..", "data", "review-rotation.json");

// ── Guardrails: paths the agent is allowed to modify ──
const ALLOWED_EVOLVE_DIRS = ["server/tools", "server/utils", "server"];
const BLOCKED_EVOLVE_FILES = new Set([
  "server/routes/chat.js",
  "server/planner.js",
  "server/executor.js",
  "server/agents/orchestrator.js",
  "package.json",
  "package-lock.json",
  ".env",
]);
const BLOCKED_EVOLVE_DIRS = new Set(["client", "agent", "node_modules"]);

/**
 * Check if a file path is safe for selfEvolve to modify
 */
function isEvolvePathAllowed(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  
  // If the agent just gave a filename, try to find it in the tools/utils dirs
  let finalPath = normalized;
  if (!normalized.includes('/')) {
     // This is likely just "email.js", let's assume it's in server/tools for the check
     finalPath = `server/tools/${normalized}`;
  }

  const relative = path.relative(PROJECT_ROOT, path.resolve(PROJECT_ROOT, finalPath)).replace(/\\/g, "/");

  if (relative.startsWith("..")) return false;
  if (BLOCKED_EVOLVE_FILES.has(relative)) return false;
  
  for (const dir of BLOCKED_EVOLVE_DIRS) {
    if (relative.startsWith(dir + "/") || relative === dir) return false;
  }

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
 * REWRITE: Investigative Rotation Memory
 * Picks files that haven't been reviewed or haven't been reviewed for THIS topic.
 */
async function getFilesToReview(targetDir, currentTopic = "general", maxFiles = 10) {
  let cache = {};
  try {
    const raw = await fs.readFile(REVIEW_CACHE_PATH, "utf8");
    cache = JSON.parse(raw);
  } catch { /* Cache doesn't exist yet */ }

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

  const scoredFiles = files.map(filePath => {
    const fileData = cache[filePath] || { lastReviewed: 0, topicsChecked: [] };
    const hasBeenCheckedForTopic = fileData.topicsChecked.includes(currentTopic);
    let score = fileData.lastReviewed; 
    
    // If it hasn't seen this specific topic, prioritize it
    if (!hasBeenCheckedForTopic) {
      score -= (365 * 24 * 60 * 60 * 1000); 
    }
    return { filePath, score };
  });

  scoredFiles.sort((a, b) => a.score - b.score);
  return scoredFiles.slice(0, maxFiles).map(f => f.filePath);
}

/**
 * REWRITE: Investigative Rotation Memory
 * Updates the rotation cache with timestamp AND the specific topic research.
 */
async function markFilesReviewed(files, topic = "general") {
  let cache = {};
  try {
    const raw = await fs.readFile(REVIEW_CACHE_PATH, "utf8");
    cache = JSON.parse(raw);
  } catch { /* Cache doesn't exist yet */ }

  const now = Date.now();
  for (const f of files) {
    if (!cache[f]) cache[f] = { lastReviewed: now, topicsChecked: [] };
    cache[f].lastReviewed = now;
    if (!cache[f].topicsChecked.includes(topic)) cache[f].topicsChecked.push(topic);
    if (cache[f].topicsChecked.length > 10) cache[f].topicsChecked.shift();
  }

  try {
    await fs.writeFile(REVIEW_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.error("[selfEvolve] Failed to save review cache:", err.message);
  }
}

/**
 * Simple timeout wrapper
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
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

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
  try {
    const dir = path.dirname(EVOLUTION_LOG);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(EVOLUTION_LOG, JSON.stringify(log, null, 2), "utf8");
  } catch (err) {
    console.error("[selfEvolve] Failed to save evolution log:", err.message);
  }
}

/**
 * Safely extract plan from LLM
 */
function extractImprovementPlan(responseText) {
  if (!responseText || typeof responseText !== "string") return [];
  const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error("[selfEvolve] Failed to parse plan JSON:", err.message);
    return [];
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
    forcedFile = null, // Integrated for Forced Re-Review
    maxDurationMs = 15 * 60 * 1000 
  } = options;

  console.log("[selfEvolve] Starting improvement cycle:", { scope, dryRun, forcedFile });

  const startedAt = Date.now();
  const results = { steps: [], improvements: [], timestamp: new Date().toISOString() };
  let dynamicQuery = "code_quality_scan";
  const ensureNotExpired = (label) => {
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxDurationMs) throw new Error(`Global maxDuration exceeded during ${label}`);
  };

  // ── Step 1: Targeted Code Review (with Forced Override logic) ──
  console.log("[selfEvolve] Step 1: targeted_review starting.");
  results.steps.push({ step: "targeted_review", status: "running" });

  const targetDir = scope === "tools" ? path.join(PROJECT_ROOT, "server/tools") : path.join(PROJECT_ROOT, "server");
  let reviewFindings = "";
  let reviewedFilesList = [];

  try {
    ensureNotExpired("targeted_review");
    
    // FORCED RE-REVIEW LOGIC: Prioritize manual target over rotation
    let filesToReview;
    if (forcedFile && isEvolvePathAllowed(forcedFile)) {
      filesToReview = [forcedFile];
      console.log(`[selfEvolve] Forced re-review triggered for: ${forcedFile}`);
    } else {
      filesToReview = await getFilesToReview(targetDir, "code_quality_scan", 10);
    }

    const controller = new AbortController();
    let combinedNotes = [];

    for (const file of filesToReview) {
      try {
        const reviewResult = await withTimeout(
          codeReview({
            text: `quality review ${file}`,
            context: { source: "selfEvolve", path: file, reviewType: "quality", signal: controller.signal, budgetMs: 120_000 }
          }),
          130_000, 
          `codeReview(${path.basename(file)})`,
          controller
        );
        
        reviewedFilesList.push(file);
        if (reviewResult.data?.text) {
          const relativePath = path.relative(PROJECT_ROOT, file).replace(/\\/g, "/");
          combinedNotes.push(`--- REVIEW FOR ${relativePath} ---\n${reviewResult.data.text}`);
          
        }
      } catch (fileErr) {
        console.warn(`[selfEvolve] Skipped ${path.basename(file)}: ${fileErr.message}`);
      }
    }

    reviewFindings = combinedNotes.join("\n\n");
    
    // ENSURE THIS IS OUTSIDE THE LOOP BUT INSIDE THE TRY
    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `Reviewed ${reviewedFilesList.length} files`;
  } catch (err) {
    results.steps[results.steps.length - 1].status = "failed";
    results.steps[results.steps.length - 1].error = err.message;
  }

  // ── Step 2: Dynamic Learning ──
  console.log("[selfEvolve] Step 2: dynamic_learning starting.");
  results.steps.push({ step: "dynamic_learning", status: "running" });
  let githubInsights = "";
  
  
  try {
    ensureNotExpired("dynamic_learning");

const queryPrompt = `You are a technical researcher. 
Review the following CODE REVIEW FINDINGS for the file: ${forcedFile || "current scope"}.

STRICT RULE: You MUST NOT suggest new libraries (like Axios) or entirely new features.
ONLY suggest improvements to the EXISTING logic found in the code review.
If the findings say 'regex is fine,' DO NOT suggest changing it.

CRITICAL: Ignore any mentions of Regex, string patterns, or imports. 
Identify the SINGLE most important LOGIC flaw, ARCHITECTURAL weakness, or MISSING ERROR HANDLING in this code.

Respond with ONLY a 3-to-6 word search query for GitHub that provides a solution for that specific logic flaw. 
DO NOT talk about Git, project management, or Regex.

CODE REVIEW FINDINGS:
${reviewFindings.slice(0, 15000)}`;
    const queryResponse = await withTimeout(llm(queryPrompt), 90_000, "llm(search_query)");
    dynamicQuery = queryResponse?.data?.text?.trim().replace(/['"`]/g, '').substring(0, 50) || "node.js best practices";
    console.log(`\nDEBUG: LLM chose topic "${dynamicQuery}" based on findings from: ${reviewedFilesList.join(', ')}`);
    console.log(`\n🔍 [selfEvolve] TOPIC COMPILED: "${dynamicQuery}"`);
    const scanResult = await withTimeout(
      githubScanner({ text: `scan github for ${dynamicQuery}`, context: { action: "improve" } }),
      120_000,
      "githubScanner"
    );

    githubInsights = scanResult.data?.analysis || scanResult.data?.text || "";
    
    // TOPIC MEMORY: Mark files reviewed against this specific topic
    await markFilesReviewed(reviewedFilesList, dynamicQuery);

    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `Learned about "${dynamicQuery}"`;
  } catch (err) {
    results.steps[results.steps.length - 1].status = "failed";
  }

  // ── Step 3: Dependency Check ──
  console.log("[selfEvolve] Step 3: dependency_check starting.");
  results.steps.push({ step: "dependency_check", status: "running" });
  let depAnalysis = "";
  try {
    ensureNotExpired("dependency_check");
    const graphResult = await withTimeout(
      projectGraph({ text: `analyze ${PROJECT_ROOT}`, context: { path: PROJECT_ROOT, action: "full" } }),
      90_000, "projectGraph"
    );
    depAnalysis = graphResult.data?.text || "";
    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `${graphResult.data?.circularDeps?.length || 0} circular deps`;
  } catch (err) {
    results.steps[results.steps.length - 1].status = "failed";
  }

// ── Step 4: Strategic Improvement Planning ──
  console.log("[selfEvolve] Step 4: improvement_plan starting.");
  results.steps.push({ step: "improvement_plan", status: "running" });
  let improvementPlan = [];
  try {
    ensureNotExpired("improvement_plan");
    const installedDeps = await getInstalledDependencies();
    const depsStr = installedDeps.join(", ");

    // Create a dynamic example filename to prevent "Example Hijacking"
    const exampleFileName = reviewedFilesList.length > 0 
      ? path.relative(PROJECT_ROOT, reviewedFilesList[0]).replace(/\\/g, "/") 
      : "server/tools/your_target_file.js";

    const prompt = `You are an AI's self-improvement engine. 
${forcedFile ? `CRITICAL: You are ONLY allowed to suggest improvements for the specific file: [${path.basename(forcedFile)}]. DO NOT suggest changes for any other files.` : `CRITICAL: You are only allowed to suggest improvements for the following files: [${reviewedFilesList.map(f => path.basename(f)).join(", ")}].`}

DO NOT suggest new files.
DO NOT suggest installing new libraries or packages.
DO NOT suggest calling external APIs (like REST endpoints) unless they already exist in the file.
DO NOT suggest example.js. 
DO NOT suggest files from your imagination (like trading bots).
DO NOT change synchronous functions into asynchronous functions (no 'async' keyword) unless specifically instructed.
Focus ONLY on pure algorithmic, logic, or regex improvements.

If the research insights don't apply to the files listed above, ignore the research and focus on the Code Review findings instead.

CRITICAL FORCED CONSTRAINT: 
Do NOT repeat previous improvements. You MUST generate a NEW improvement based ONLY on the NEW Code Review Findings below.
STRICT INSTRUCTION FOLLOW-THROUGH:
1. You MUST implement the EXACT technical solution requested in the user's prompt.
2. If the user asks for a 'Regex with named capture groups', you MUST provide that, even if you think a 'Set' is faster.
3. If you do not follow the technical constraints, the patch will be REJECTED.

CODE REVIEW FINDINGS:
${reviewFindings.slice(0, 50000)}

RESEARCH INSIGHTS:
${githubInsights.slice(0, 5000)}

Format as JSON array using the FULL relative path from the project root:
[ { "file": "${exampleFileName}", "description": "Fix null pointer exception in the data parsing logic", "priority": 1, "risk": "low", "type": "fix" } ]`;

    console.log("[selfEvolve] Calling LLM for improvement_plan.");
    const response = await withTimeout(llm(prompt), 300_000, "llm(selfEvolve)");
    const responseText = response?.data?.text || "";
    const rawPlan = extractImprovementPlan(responseText);

    console.log(`📋 [selfEvolve] LLM SUGGESTED ${rawPlan.length} IMPROVEMENTS.`);

// ── THE ANTI-HALLUCINATION SHIELD (Reinforced & Path-Aware) ──
    const filteredPlan = [];
    for (const imp of rawPlan) {
      // 1. Block the "example.js" hallucination or empty entries
      if (!imp.file || imp.file.includes('example.js') || imp.file === "none") {
        console.log(`  🚫 Filtering out placeholder/empty suggestion.`);
        continue;
      }

      // 2. Normalize path for the Guardrail check
      // If the LLM sent "email.js", we treat it as "server/tools/email.js" for the check
      let checkPath = imp.file;
      if (!checkPath.includes('/') && !checkPath.includes('\\')) {
        checkPath = `server/tools/${checkPath}`;
      }

      // 3. Guardrail Check: Is the path allowed?
      if (!isEvolvePathAllowed(checkPath)) {
        console.log(`  🚫 Filtering out ${imp.file} (Path Protected)`);
        continue;
      }

// 4. Finding Check: Was this file ACTUALLY in the array of reviewed files?
      const normalizedImpFile = checkPath.replace(/\\/g, '/');
      const wasReviewed = reviewedFilesList.some(reviewedFile => {
        const normalizedReviewed = reviewedFile.replace(/\\/g, '/');
        return normalizedReviewed.endsWith(normalizedImpFile) || normalizedImpFile.endsWith(path.basename(normalizedReviewed));
      });

      if (!wasReviewed) {
        console.log(`  🚫 Filtering out ${imp.file} (Hallucination - not in the current active review list)`);
        continue;
      }

      // 5. Physical Disk Check: Does the file actually exist?
      try {
        const fullPath = path.resolve(PROJECT_ROOT, checkPath);
        await fs.access(fullPath);
        
        // Success: Update the imp.file to the verified path and accept it
        imp.file = checkPath; 
        console.log(`  🎯 Accepted: ${imp.file} -> ${imp.description}`);
        filteredPlan.push(imp);
      } catch {
        console.log(`  🚫 Filtering out ${imp.file} (File does not exist on disk)`);
      }
    }

    improvementPlan = filteredPlan;
    results.steps[results.steps.length - 1].status = "done";
    results.steps[results.steps.length - 1].summary = `Planned ${improvementPlan.length} improvements`;
    
    console.log(`✅ [selfEvolve] FINAL PLAN: ${improvementPlan.length} improvements passed all safety checks.`);
  } catch (err) {
    results.steps[results.steps.length - 1].status = "failed";
    results.steps[results.steps.length - 1].error = err.message;
  }

// ── Step 5: Application & Autonomous QA (Apply Improvements) ──
  console.log("[selfEvolve] Step 5: apply_improvements starting.");
  if (!dryRun && improvementPlan.length > 0) {
    results.steps.push({ step: "apply_improvements", status: "running" });
    
    // Define the dedicated test folder
    const testFolder = path.resolve(PROJECT_ROOT, "server", "toolTests");
    await fs.mkdir(testFolder, { recursive: true });

    // 🚦 THROTTLE: Only process the Top 3 improvements to prevent 15-minute global timeouts
    const MAX_IMPROVEMENTS_PER_CYCLE = 3;
    const improvementsToApply = improvementPlan.slice(0, MAX_IMPROVEMENTS_PER_CYCLE);
    
    if (improvementPlan.length > MAX_IMPROVEMENTS_PER_CYCLE) {
      console.log(`[selfEvolve] 🚦 Throttling improvements from ${improvementPlan.length} to ${MAX_IMPROVEMENTS_PER_CYCLE} to stay within global time limits.`);
    }

    for (const improvement of improvementsToApply) {
      ensureNotExpired("apply_improvements");

      // 🔍 GATEKEEPER: High-Risk Detection
      const lowerDesc = improvement.description.toLowerCase();
      const isHighRisk = /\b(library|axios|install|package|external|architecture|refactor-all|major)\b/i.test(lowerDesc);

      if (isHighRisk) {
        console.log(`⚠️ [selfEvolve] High-risk improvement detected: ${improvement.description}`);
        return {
          tool: "selfEvolve",
          success: true,
          final: true,
          data: {
            message: `✋ HOLD ON! I have a major evolution idea: "${improvement.description}". This involves architectural changes or new libraries. Do you want me to proceed? (Type "evolve confirm" or "cancel")`,
            pendingImprovement: improvement,
            preformatted: true
          }
        };
      }

      const filePath = path.resolve(PROJECT_ROOT, improvement.file);
      const stagingPath = `${filePath}.tmp.js`;

      // ♻️ AUTO-HEALING PIPELINE
      let attempts = 0;
      const MAX_ATTEMPTS = 3;
      let validationPassed = false;
      let lastError = null;
      let appliedSuccessfully = false;

      while (attempts < MAX_ATTEMPTS && !validationPassed) {
        attempts++;
        ensureNotExpired("apply_improvements_loop");

        try {
          const fileContent = await fs.readFile(filePath, "utf8");

          // Build dynamic instruction (inject error on retries)
          let instruction = `${improvement.type} ${filePath}: ${improvement.description}`;
          if (lastError) {
            console.log(`[selfEvolve] ♻️ Attempt ${attempts}/${MAX_ATTEMPTS} for ${path.basename(filePath)} (Fixing previous error...)`);
          } else {
            console.log(`[selfEvolve] ▶️ Attempt ${attempts}/${MAX_ATTEMPTS} for ${path.basename(filePath)}`);
          }

          // 📝 WRITE TO STAGING FILE
          const transformResult = await withTimeout(
            codeTransform({
              text: instruction,
              context: { 
                path: filePath, 
                action: improvement.type, 
                source: "selfEvolve", 
                existingContent: fileContent,
                outputPath: stagingPath,
                previousError: lastError // 👈 Feed the error back!
              }
            }),
            300_000,
            "codeTransform"
          );

          if (transformResult.success) {
            console.log(`[selfEvolve] Generated patch written to staging: ${stagingPath}`);
            validationPassed = true; // Assume true until checks fail

            // 🛡️ VERIFICATION 1: Syntax
            try {
              console.log(`[selfEvolve] Running syntax verification...`);
              await execAsync(`node --check "${stagingPath}"`);
              console.log(`[selfEvolve] 🟢 Syntax verification passed!`);
            } catch (syntaxErr) {
              validationPassed = false;
              lastError = `Syntax Error: ${syntaxErr.message}`;
              console.error(`[selfEvolve] 🔴 Syntax error detected! Rolling back.`);
              await fs.unlink(stagingPath).catch(() => {});
            }

            // 🛡️ VERIFICATION 2: Semantic Logic (ESLint)
            if (validationPassed) {
              try {
                console.log(`[selfEvolve] Running semantic logic check (ESLint)...`);
                const lintCmd = `npx eslint@8 --no-eslintrc --env node --env es2024 --parser-options=ecmaVersion:latest --parser-options=sourceType:module --rule no-undef:error "${stagingPath}"`;
                await execAsync(lintCmd);
                console.log(`[selfEvolve] 🟢 Semantic logic check passed!`);
              } catch (lintErr) {
                validationPassed = false;
                const cleanError = (lintErr.stdout || lintErr.message || "").split('\n').filter(l => l.includes('error')).join(' | ');
                lastError = `ESLint Error: ${cleanError}`;
                console.error(`[selfEvolve] 🔴 Semantic logic error detected! Rolling back.`);
                await fs.unlink(stagingPath).catch(() => {});
              }
            }

            if (validationPassed) {
              appliedSuccessfully = true;
              break; // 🎯 Exit loop on success
            }
          } else {
            lastError = transformResult.data?.message || "LLM failed to output valid code blocks.";
            console.warn(`[selfEvolve] Patch generation failed: ${lastError}`);
          }
        } catch (err) {
          lastError = err.message;
          console.error(`[selfEvolve] System error during patch application: ${lastError}`);
          await fs.unlink(stagingPath).catch(() => {});
        }
      } // End Retry Loop

      // 🎯 Final Result Handling
      if (appliedSuccessfully) {
        // 🔄 ATOMIC SWAP
        await fs.rename(stagingPath, filePath);
        console.log(`[selfEvolve] 🔄 Atomic swap complete for ${filePath}`);
        results.improvements.push({ file: improvement.file, description: improvement.description, applied: true });

        // 🧪 OPTIONAL: Autonomous QA
        try {
          console.log(`[selfEvolve] Generating QA tests in: ${testFolder}`);
          await testGen({ 
            text: `generate tests for ${improvement.file} and save them specifically in ${testFolder}`, 
            context: { targetDir: testFolder, forcePath: true } 
          });
          await logImprovement({ category: improvement.type, action: improvement.description, file: improvement.file, reason: "Self-evolve cycle", source: "selfEvolve" });
        } catch (postErr) {
          console.warn(`[selfEvolve] ⚠️ Patch applied successfully, but post-processing failed: ${postErr.message}`);
        }
      } else {
        results.improvements.push({ file: improvement.file, applied: false, error: `Failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}` });
      }
    } // End Improvements Loop

    results.steps[results.steps.length - 1].status = "done";
  } else if (dryRun) {
    results.improvements = improvementPlan.map(i => ({ ...i, applied: false, dryRun: true }));
  }

  // Save Final Log
  const log = await loadEvolutionLog();
  log.runs.push(results);
  log.totalImprovements += results.improvements.filter(i => i.applied).length;
  log.lastRun = results.timestamp;
  if (log.runs.length > 50) log.runs = log.runs.slice(-50);
  await saveEvolutionLog(log);

  return results;
}

/**
 * Main Entry Point
 */
export async function selfEvolve(request) {
  const text = typeof request === "string" ? request : request?.text || "";
  const context = typeof request === "object" ? (request.context || {}) : {};
  
  // ── Smart Path & Force Detection ──
  // This now catches: "look at X", "focus on X", "specifically X", "only X", "re-review X"
  const isForced = /\b(force|forced|manual|re-review|specifically|focus|only|look at|target)\b/i.test(text);
  
  // This regex is now more robust for different path styles
  const fileMatch = text.match(/([a-zA-Z0-9._\-\/]+\.js)/i);
  let forcedFile = isForced && fileMatch ? fileMatch[0] : null;

  // Clean the path (remove leading "for ", "at ", etc if the regex caught them)
  if (forcedFile) {
    forcedFile = forcedFile.replace(/^(for|at|on|to)\s+/i, "").trim();
  }

  let intent = context.action || detectIntent(text);
  if (/\b(dry.?run|preview|plan)\b/i.test(text)) intent = "dryrun";

  try {
    switch (intent) {
      case "history":
        const history = await showHistory();
        return { tool: "selfEvolve", success: true, final: true, data: { preformatted: true, text: history } };
      case "dryrun":
        const dryRes = await runImprovementCycle({ dryRun: true, forcedFile });
        return { tool: "selfEvolve", success: true, final: true, data: { results: dryRes } };
      case "run":
      default: {
        const results = await runImprovementCycle({ dryRun: false, forcedFile });
        
        // GATEKEEPER CHECK: If gatekeeper tripped, it returns early with data.message
        if (results && results.tool === "selfEvolve") return results;

        let output = `🤖 **Self-Improvement Cycle Complete**\n\n**Steps:**\n`;
        for (const step of results.steps) {
          const icon = step.status === "done" ? "✅" : step.status === "failed" ? "❌" : "⏳";
          output += `  ${icon} ${step.step}: ${step.summary || step.error || step.status}\n`;
        }
        const applied = results.improvements?.filter((i) => i.applied) || [];
        const failed = results.improvements?.filter((i) => !i.applied && !i.dryRun) || [];
        if (applied.length > 0) {
          output += `\n**Applied Improvements (${applied.length}):**\n`;
          for (const imp of applied) output += `  ✅ ${imp.description}\n     File: ${imp.file}\n`;
        }
        if (failed.length > 0) {
          output += `\n**Failed Improvements (${failed.length}):**\n`;
          for (const imp of failed) output += `  ❌ ${imp.description}: ${imp.error}\n`;
        }
        return { tool: "selfEvolve", success: true, final: true, data: { preformatted: true, text: output, results } };
      }
    }
  } catch (err) {
    return { tool: "selfEvolve", success: false, final: true, data: { message: err.message } };
  }
}

function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(history|log)\b/.test(lower)) return "history";
  if (/\b(dry.?run|preview|plan)\b/.test(lower)) return "dryrun";
  return "run";
}

async function showHistory() {
  const log = await loadEvolutionLog();
  let output = `📈 **Self-Evolution History**\nTotal improvements: ${log.totalImprovements}\nLast run: ${log.lastRun || "never"}\n\n`;
  const recent = log.runs.slice(-5).reverse();
  for (const run of recent) {
    output += `**${run.timestamp}**: ${run.improvements?.filter(i => i.applied).length || 0} applied\n`;
  }
  return output;
}
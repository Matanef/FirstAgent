// server/utils/workflow.js
// Workflow Engine — define and execute reusable multi-step tool sequences
// Workflows can be triggered manually, by scheduler, or by chat command

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKFLOW_FILE = path.resolve(__dirname, "..", "data", "workflows.json");

// ============================================================
// PERSISTENCE
// ============================================================

function ensureDataDir() {
  const dir = path.dirname(WORKFLOW_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadWorkflows() {
  try {
    ensureDataDir();
    if (!fs.existsSync(WORKFLOW_FILE)) return [];
    const raw = fs.readFileSync(WORKFLOW_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveWorkflows(workflows) {
  ensureDataDir();
  fs.writeFileSync(WORKFLOW_FILE, JSON.stringify(workflows, null, 2), "utf8");
}

let _workflows = loadWorkflows();

// ============================================================
// BUILT-IN WORKFLOWS
// ============================================================

const BUILT_IN_WORKFLOWS = [
  {
    id: "morning_briefing",
    name: "Morning Briefing",
    description: "Check weather, browse emails, and get top news",
    builtIn: true,
    steps: [
      { tool: "weather", input: "weather today", label: "Weather" },
      { tool: "email", input: "check my recent emails", context: { action: "browse" }, label: "Emails" },
      { tool: "news", input: "top news today", label: "News" },
    ],
  },
  {
    id: "market_check",
    name: "Market Check",
    description: "Get stock market overview and top movers",
    builtIn: true,
    steps: [
      { tool: "finance", input: "S&P 500 market overview", label: "Market Overview" },
      { tool: "news", input: "latest financial news", label: "Financial News" },
    ],
  },
  {
    id: "code_review_cycle",
    name: "Code Review Cycle",
    description: "Check git status, review changes, and suggest improvements",
    builtIn: true,
    steps: [
      { tool: "gitLocal", input: "git status", label: "Git Status" },
      { tool: "gitLocal", input: "git diff --stat", label: "Changed Files" },
    ],
  },
];

// ============================================================
// WORKFLOW MANAGEMENT
// ============================================================

/**
 * Get all workflows (built-in + custom)
 */
export function getAllWorkflows() {
  return [...BUILT_IN_WORKFLOWS, ..._workflows];
}

/**
 * Get a workflow by ID or name
 */
export function getWorkflow(idOrName) {
  const lower = (idOrName || "").toLowerCase();
  const all = getAllWorkflows();
  return all.find(w => w.id === idOrName || w.name.toLowerCase() === lower);
}

/**
 * Create a custom workflow
 * @param {Object} options
 * @param {string} options.name - Workflow name
 * @param {string} options.description - What the workflow does
 * @param {Array} options.steps - Array of { tool, input, context?, label? }
 */
export function createWorkflow({ name, description, steps }) {
  if (!name || !steps || steps.length === 0) {
    return { success: false, error: "Workflow must have a name and at least one step" };
  }

  const workflow = {
    id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    description: description || "",
    steps: steps.map((s, i) => ({
      tool: s.tool,
      input: s.input || "",
      context: s.context || {},
      label: s.label || `Step ${i + 1}`,
    })),
    createdAt: new Date().toISOString(),
    runCount: 0,
  };

  _workflows.push(workflow);
  saveWorkflows(_workflows);
  console.log(`[workflow] Created: "${name}" with ${steps.length} steps`);
  return { success: true, workflow };
}

/**
 * Delete a custom workflow
 */
export function deleteWorkflow(idOrName) {
  const lower = (idOrName || "").toLowerCase();
  const idx = _workflows.findIndex(
    w => w.id === idOrName || w.name.toLowerCase() === lower
  );
  if (idx === -1) return { success: false, error: `Workflow not found: "${idOrName}"` };

  const removed = _workflows.splice(idx, 1)[0];
  saveWorkflows(_workflows);
  return { success: true, removed };
}

// ============================================================
// WORKFLOW EXECUTION
// ============================================================

/**
 * Execute a workflow — runs all steps sequentially with context piping
 * @param {string} idOrName - Workflow ID or name
 * @param {Function} toolExecutor - async function(tool, input, context) => result
 * @param {Function} onStep - optional callback({ step, total, label, status, result })
 * @returns {Object} Execution results
 */
export async function executeWorkflow(idOrName, toolExecutor, onStep) {
  const workflow = getWorkflow(idOrName);
  if (!workflow) {
    return { success: false, error: `Workflow not found: "${idOrName}"` };
  }

  console.log(`[workflow] Executing "${workflow.name}" (${workflow.steps.length} steps)`);

  const results = [];
  const context = {}; // Accumulated context from previous steps

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepNum = i + 1;

    if (onStep) {
      onStep({ step: stepNum, total: workflow.steps.length, label: step.label, status: "running" });
    }

    try {
      const stepContext = { ...step.context, ...context };
      const result = await toolExecutor(step.tool, step.input, stepContext);

      const stepResult = {
        step: stepNum,
        label: step.label,
        tool: step.tool,
        success: result?.success ?? true,
        output: result?.data?.text || result?.output || JSON.stringify(result?.data || {}).slice(0, 500),
      };

      results.push(stepResult);

      // Pipe output to context for next steps
      context[`step${stepNum}_output`] = stepResult.output;
      context[`${step.tool}_result`] = result?.data || result;

      if (onStep) {
        onStep({ step: stepNum, total: workflow.steps.length, label: step.label, status: "completed", result: stepResult });
      }

      console.log(`[workflow] Step ${stepNum}/${workflow.steps.length} (${step.label}): ${stepResult.success ? "OK" : "FAILED"}`);
    } catch (err) {
      const stepResult = {
        step: stepNum,
        label: step.label,
        tool: step.tool,
        success: false,
        error: err.message,
      };
      results.push(stepResult);

      if (onStep) {
        onStep({ step: stepNum, total: workflow.steps.length, label: step.label, status: "failed", error: err.message });
      }

      console.error(`[workflow] Step ${stepNum} failed:`, err.message);
      // Continue to next step (don't abort workflow on single step failure)
    }
  }

  // Update run count for custom workflows
  if (!workflow.builtIn) {
    const wf = _workflows.find(w => w.id === workflow.id);
    if (wf) {
      wf.runCount = (wf.runCount || 0) + 1;
      wf.lastRun = new Date().toISOString();
      saveWorkflows(_workflows);
    }
  }

  // Build summary text
  const summary = buildWorkflowSummary(workflow, results);

  return {
    success: results.every(r => r.success),
    workflow: workflow.name,
    results,
    summary,
  };
}

/**
 * Build a markdown summary of workflow execution
 */
function buildWorkflowSummary(workflow, results) {
  const lines = [`## Workflow: ${workflow.name}\n`];

  for (const r of results) {
    const icon = r.success ? "OK" : "FAILED";
    lines.push(`### ${r.label} [${icon}]\n`);
    if (r.success) {
      lines.push(r.output || "(no output)");
    } else {
      lines.push(`Error: ${r.error || "Unknown error"}`);
    }
    lines.push(""); // blank line
  }

  return lines.join("\n");
}

/**
 * Parse a workflow creation request from natural language
 * E.g., "every morning: check weather, check emails, summarize news"
 */
export function parseWorkflowFromText(text) {
  const lower = (text || "").toLowerCase();

  // Extract name — text before ":"
  const colonIdx = text.indexOf(":");
  let name = "Custom Workflow";
  let stepsText = text;

  if (colonIdx > 0 && colonIdx < 50) {
    name = text.slice(0, colonIdx).trim()
      .replace(/^(create|make|set up|define)\s+(a\s+)?workflow\s*/i, "")
      .replace(/^(every\s+)?(morning|evening|daily|weekly)\s*/i, "")
      .trim() || "Custom Workflow";
    stepsText = text.slice(colonIdx + 1);
  }

  // Split steps by comma, "and", "then"
  const stepParts = stepsText.split(/\s*(?:,\s*(?:and\s+)?|(?:then|and)\s+)/i).filter(Boolean);

  const steps = stepParts.map((part, i) => {
    const p = part.trim();
    const tool = inferToolFromText(p);
    return {
      tool,
      input: p,
      label: p.slice(0, 40),
    };
  });

  return { name, steps };
}

/**
 * Infer which tool to use from a step description
 */
function inferToolFromText(text) {
  const lower = text.toLowerCase();
  if (/weather|forecast|temperature/.test(lower)) return "weather";
  if (/email|inbox|mail/.test(lower)) return "email";
  if (/news|headline/.test(lower)) return "news";
  if (/stock|finance|market|portfolio/.test(lower)) return "finance";
  if (/sport|score|match|fixture/.test(lower)) return "sports";
  if (/calendar|event|meeting/.test(lower)) return "calendar";
  if (/search|look\s+up|find/.test(lower)) return "search";
  if (/git|commit|branch/.test(lower)) return "gitLocal";
  if (/review|inspect|audit/.test(lower)) return "review";
  if (/task|todo|reminder/.test(lower)) return "tasks";
  return "llm"; // fallback
}

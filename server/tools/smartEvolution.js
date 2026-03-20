// server/tools/smartEvolution.js
// Smart Evolution — discovers, proposes, and builds NEW tools for the agent system
// 9-step pipeline: SCAN → RESEARCH → THINK → REPORT → APPROVE → VALIDATE → BUILD → VERIFY → NOTIFY

import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { llm } from "./llm.js";
import { validateWithGemini } from "./geminiValidator.js";
import { githubScanner } from "./githubScanner.js";
import { projectIndex } from "./projectIndex.js";
import { projectGraph } from "./projectGraph.js";
import { registerNewTool } from "./codeTransform.js";
import { logImprovement } from "../telemetryAudit.js";
import { CONFIG } from "../utils/config.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const TOOLS_DIR = path.resolve(__dirname);

const AUDIT_LOG = path.join(DATA_DIR, "smart-evolution-log.json");
const PENDING_FILE = path.join(DATA_DIR, "pending-evolution-proposal.json");
const SUGGESTIONS_FILE = path.join(DATA_DIR, "toolSuggestions.json");

// Security patterns to block in generated code
const SECURITY_PATTERNS = [
  { pattern: /\beval\s*\(/g, message: "eval() is forbidden — code injection risk" },
  { pattern: /\bnew\s+Function\s*\(/g, message: "new Function() is forbidden — code injection risk" },
  { pattern: /\brequire\s*\(/g, message: "require() is forbidden — project uses ES Modules only" },
  { pattern: /\bmodule\.exports\b/g, message: "module.exports is forbidden — use export instead" },
  { pattern: /\bprocess\.env\b/g, message: "Direct process.env access forbidden — use CONFIG import from utils/config.js" },
  { pattern: /\bexecSync\s*\(/g, message: "execSync is risky — use async exec with proper input validation" },
  { pattern: /\bchild_process\b.*\$\{/g, message: "Template literals in child_process — command injection risk" },
  { pattern: /\.unlink(?:Sync)?\s*\([^)]*\.\./g, message: "Path traversal in file deletion" },
  { pattern: /\.rmdir(?:Sync)?\s*\([^)]*\.\./g, message: "Path traversal in directory removal" },
];

// ─── HELPER: Collect system info ─────────────────────────────────
async function collectSystemInfo() {
  const info = {
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: os.cpus()[0]?.model || "unknown", cores: os.cpus().length },
    ram: { total: `${(os.totalmem() / 1073741824).toFixed(1)} GB`, free: `${(os.freemem() / 1073741824).toFixed(1)} GB` },
    node: process.version,
    gpu: "none detected",
    ollama: { version: "unknown", models: [] },
    dependencies: []
  };

  // GPU detection (NVIDIA)
  try {
    const { stdout } = await execAsync("nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader", { timeout: 5000 });
    info.gpu = stdout.trim();
  } catch { /* no GPU or no nvidia-smi */ }

  // Ollama version + models
  try {
    const verRes = await fetch(`${CONFIG.LLM_API_URL}api/version`, { signal: AbortSignal.timeout(5000) });
    if (verRes.ok) info.ollama.version = (await verRes.json()).version || "unknown";
  } catch { /* Ollama not reachable */ }

  try {
    const tagRes = await fetch(`${CONFIG.LLM_API_URL}api/tags`, { signal: AbortSignal.timeout(5000) });
    if (tagRes.ok) {
      const data = await tagRes.json();
      info.ollama.models = (data.models || []).map(m => ({ name: m.name, size: m.size ? `${(m.size / 1073741824).toFixed(1)} GB` : "unknown" }));
    }
  } catch { /* Ollama not reachable */ }

  // Package dependencies
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "server", "package.json"), "utf8"));
    info.dependencies = Object.keys(pkg.dependencies || {});
  } catch { /* no package.json */ }

  return info;
}

// ─── HELPER: Scan existing tools ─────────────────────────────────
async function scanExistingTools() {
  const toolFiles = [];
  try {
    const files = await fs.readdir(TOOLS_DIR);
    for (const f of files) {
      if (f.endsWith(".js") && !f.includes(".backup") && !f.includes(".tmp") && f !== "index.js") {
        toolFiles.push(f);
      }
    }
  } catch { /* fallback */ }

  // Get project graph for dependency info
  let graph = null;
  try {
    const graphResult = await projectGraph({ text: PROJECT_ROOT });
    if (graphResult.success) graph = graphResult.data;
  } catch { /* non-critical */ }

  return { toolFiles, toolCount: toolFiles.length, graph };
}

// ─── HELPER: Check tool name conflicts ───────────────────────────
async function checkToolNameConflict(proposedName) {
  const filename = proposedName.endsWith(".js") ? proposedName : `${proposedName}.js`;
  const funcName = proposedName.replace(/\.js$/, "");

  // Check index.js for exact matches (word-boundary aware)
  try {
    const indexContent = await fs.readFile(path.join(TOOLS_DIR, "index.js"), "utf8");
    // Match exact export name: "funcName," or "funcName}" in TOOLS object, or exact import
    const exactPattern = new RegExp(`\\b${funcName}\\b\\s*[,}]|import\\s*\\{\\s*${funcName}\\s*\\}`, "m");
    if (exactPattern.test(indexContent)) {
      return { conflict: true, reason: `Tool "${funcName}" already exists in index.js` };
    }
  } catch { /* proceed */ }

  // Check if file already exists on disk
  try {
    await fs.access(path.join(TOOLS_DIR, filename));
    return { conflict: true, reason: `File ${filename} already exists on disk` };
  } catch {
    return { conflict: false };
  }
}

// ─── HELPER: Security scan generated code ────────────────────────
function securityScan(code) {
  const violations = [];
  for (const { pattern, message } of SECURITY_PATTERNS) {
    pattern.lastIndex = 0; // reset regex state
    if (pattern.test(code)) {
      violations.push(message);
    }
  }
  return { safe: violations.length === 0, violations };
}

// ─── HELPER: Audit log ──────────────────────────────────────────
async function appendAuditLog(entry) {
  let log = [];
  try { log = JSON.parse(await fs.readFile(AUDIT_LOG, "utf8")); } catch { /* new log */ }
  log.push({ ...entry, timestamp: new Date().toISOString() });
  if (log.length > 100) log = log.slice(-100);
  await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
  await fs.writeFile(AUDIT_LOG, JSON.stringify(log, null, 2));
}

// ─── HELPER: Pending proposal persistence ────────────────────────
async function savePendingProposal(proposal) {
  await fs.mkdir(path.dirname(PENDING_FILE), { recursive: true });
  await fs.writeFile(PENDING_FILE, JSON.stringify(proposal, null, 2));
}

async function loadPendingProposal() {
  try { return JSON.parse(await fs.readFile(PENDING_FILE, "utf8")); } catch { return null; }
}

async function clearPendingProposal() {
  try { await fs.unlink(PENDING_FILE); } catch { /* doesn't exist */ }
}

// ─── HELPER: Tool suggestions list (implement later) ─────────────
async function loadSuggestions() {
  try { return JSON.parse(await fs.readFile(SUGGESTIONS_FILE, "utf8")); } catch { return []; }
}

async function saveSuggestions(suggestions) {
  await fs.mkdir(path.dirname(SUGGESTIONS_FILE), { recursive: true });
  await fs.writeFile(SUGGESTIONS_FILE, JSON.stringify(suggestions, null, 2));
}

async function addSuggestion(proposal, report, systemInfo) {
  const suggestions = await loadSuggestions();
  const id = suggestions.length > 0 ? Math.max(...suggestions.map(s => s.id)) + 1 : 1;
  suggestions.push({
    id,
    toolName: proposal.toolName,
    description: proposal.description,
    rationale: proposal.rationale,
    capabilities: proposal.capabilities || [],
    complexity: proposal.complexity || "medium",
    proposal,
    report,
    systemInfo,
    savedAt: new Date().toISOString(),
    status: "pending" // pending | approved | rejected | implemented
  });
  await saveSuggestions(suggestions);
  console.log(`[smartEvolution] Saved suggestion #${id}: ${proposal.toolName}`);
  return id;
}

async function removeSuggestion(id) {
  const suggestions = await loadSuggestions();
  const filtered = suggestions.filter(s => s.id !== id);
  await saveSuggestions(filtered);
}

// ─── HELPER: Rollback tool creation ──────────────────────────────
async function rollbackToolCreation(toolName, filename) {
  console.log(`[smartEvolution] Rolling back: ${filename}`);

  // Delete the generated file
  try { await fs.unlink(path.join(TOOLS_DIR, filename)); } catch { /* file may not exist */ }

  // Remove from index.js
  try {
    const indexPath = path.join(TOOLS_DIR, "index.js");
    let content = await fs.readFile(indexPath, "utf8");
    content = content.replace(new RegExp(`^import \\{ ${toolName} \\} from "\\.\\/${filename}";\\n`, "m"), "");
    content = content.replace(new RegExp(`\\s*${toolName},?\\n`, ""), "\n");
    await fs.writeFile(indexPath, content);
  } catch (e) { console.warn("[smartEvolution] Rollback index.js failed:", e.message); }

  console.log(`[smartEvolution] Rollback complete for ${filename}`);
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════
async function runEvolutionPipeline(options = {}) {
  const { notifyVia, dryRun = false } = options;
  const startedAt = Date.now();
  let output = "**Smart Evolution — Tool Discovery Pipeline**\n\n";

  // ── STEP 1: SCAN ──────────────────────────────────────────────
  output += "**Step 1/9 — System Scan**\n";
  console.log("[smartEvolution] Step 1: SCAN — collecting system info and tool inventory");

  const systemInfo = await collectSystemInfo();
  const toolScan = await scanExistingTools();

  output += `  Hardware: ${systemInfo.cpu.cores}-core ${systemInfo.cpu.model.substring(0, 40)}, ${systemInfo.ram.total} RAM\n`;
  output += `  GPU: ${systemInfo.gpu.substring(0, 60)}\n`;
  output += `  Ollama: v${systemInfo.ollama.version}, ${systemInfo.ollama.models.length} models\n`;
  output += `  Tools: ${toolScan.toolCount} existing tools\n`;
  output += `  Dependencies: ${systemInfo.dependencies.length} npm packages\n\n`;

  await appendAuditLog({ step: 1, action: "scan", toolCount: toolScan.toolCount, models: systemInfo.ollama.models.map(m => m.name) });

  // ── STEP 2: RESEARCH ──────────────────────────────────────────
  output += "**Step 2/9 — External Research**\n";
  console.log("[smartEvolution] Step 2: RESEARCH — scanning GitHub for tool ideas");

  let researchFindings = "No research data available.";
  try {
    const scanResult = await githubScanner({ text: "discover trending node.js agent tools automation AI capabilities", context: { action: "improve" } });
    if (scanResult.success && scanResult.data?.text) {
      researchFindings = typeof scanResult.data.text === "string" ? scanResult.data.text : JSON.stringify(scanResult.data);
      // Truncate to avoid overwhelming the LLM
      if (researchFindings.length > 8000) researchFindings = researchFindings.substring(0, 8000) + "\n... (truncated)";
      output += `  GitHub scan complete (${researchFindings.length} chars of findings)\n\n`;
    } else {
      output += "  GitHub scan returned no useful data — proceeding with local analysis only\n\n";
    }
  } catch (e) {
    output += `  GitHub scan failed: ${e.message} — proceeding with local analysis only\n\n`;
  }

  await appendAuditLog({ step: 2, action: "research", findingsLength: researchFindings.length });

  // ── STEP 3: THINK ──────────────────────────────────────────────
  output += "**Step 3/9 — Strategic Analysis**\n";
  console.log("[smartEvolution] Step 3: THINK — LLM analyzing gaps and opportunities");

  const existingToolsList = toolScan.toolFiles.map(f => `  - ${f.replace(".js", "")}`).join("\n");

  const thinkPrompt = `You are the strategic planning module of an autonomous AI agent system. Your job is to identify ONE new tool that would meaningfully extend this system's capabilities.

CURRENT TOOLS (${toolScan.toolCount} tools):
${existingToolsList}

SYSTEM PROFILE:
- OS: ${systemInfo.os.platform} ${systemInfo.os.arch}
- CPU: ${systemInfo.cpu.cores} cores, ${systemInfo.cpu.model.substring(0, 50)}
- RAM: ${systemInfo.ram.total} total, ${systemInfo.ram.free} free
- GPU: ${systemInfo.gpu}
- Node.js: ${systemInfo.node}
- Ollama: v${systemInfo.ollama.version}
- Local models: ${systemInfo.ollama.models.map(m => `${m.name} (${m.size})`).join(", ") || "none detected"}

INSTALLED NPM DEPENDENCIES:
${systemInfo.dependencies.join(", ")}

GITHUB RESEARCH (trending tools and patterns):
${researchFindings.substring(0, 5000)}

TASK: Identify ONE new tool that would most benefit this agent system. Requirements:
1. Must fill a REAL gap — not duplicate any existing tool above
2. The toolName MUST be unique — it cannot match any existing tool name listed above (not even partially — e.g., don't suggest "memoryTool" if one exists)
3. Must be implementable with ONLY the installed npm dependencies OR Node.js built-in modules
3. Must be compatible with the hardware (consider RAM, GPU, model capabilities)
4. Must follow ES Module pattern (import/export, async functions)
5. Must be practically useful — not a demo or toy
6. Be creative but realistic — think about what would make this agent more capable day-to-day

Examples of GOOD suggestions: a clipboard manager, a PDF reader, a cron-style task runner, an image analyzer (if vision model available), a database query tool, a system monitor, a bookmark manager, a translation tool.
Examples of BAD suggestions: another search tool (already exists), another LLM wrapper (already exists), a tool that needs packages not installed.

Return ONLY valid JSON:
{
  "toolName": "camelCaseToolName",
  "filename": "camelCaseToolName.js",
  "description": "One-line description of what the tool does",
  "rationale": "2-3 sentences explaining why this fills a gap in current capabilities",
  "capabilities": ["capability1", "capability2", "capability3"],
  "dependsOn": ["npm-package-or-builtin-it-uses"],
  "risks": ["potential issue 1", "potential issue 2"],
  "complexity": "low|medium|high",
  "implementationPlan": "Detailed multi-paragraph technical plan. Describe the main function, what APIs it calls, how it handles errors, what it returns. Be specific enough that a code generator could implement it."
}

If you genuinely cannot identify a useful new tool, respond with:
{"toolName": "none", "rationale": "explanation of why no new tool is needed"}`;

  let proposal = null;
  try {
    const thinkResult = await llm(thinkPrompt, { timeoutMs: 60000, format: "json" });
    if (thinkResult.success && thinkResult.data?.text) {
      const cleaned = thinkResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      proposal = JSON.parse(cleaned);
    }
  } catch (e) {
    console.error("[smartEvolution] THINK step failed:", e.message);
  }

  if (!proposal || proposal.toolName === "none") {
    output += `  LLM concluded: ${proposal?.rationale || "No viable tool identified."}\n`;
    output += "\n**Pipeline complete — no new tool proposed.**\n";
    await appendAuditLog({ step: 3, action: "think", result: "no_proposal", rationale: proposal?.rationale });
    return { tool: "smartEvolution", success: true, final: true, data: { text: output, preformatted: true } };
  }

  // Validate proposal basics
  if (!proposal.toolName || !proposal.filename || !proposal.implementationPlan) {
    output += "  LLM returned an incomplete proposal — missing required fields.\n";
    output += "\n**Pipeline aborted at Step 3.**\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  // Check for conflicts
  const conflict = await checkToolNameConflict(proposal.toolName);
  if (conflict.conflict) {
    output += `  Tool name conflict: ${conflict.reason}\n`;
    output += "  The LLM suggested a tool that already exists. Run again to get a different suggestion.\n";
    output += "\n**Pipeline stopped — name collision. Try running again.**\n";
    await appendAuditLog({ step: 3, action: "think", result: "name_conflict", toolName: proposal.toolName });
    return { tool: "smartEvolution", success: true, final: true, data: { text: output, preformatted: true } };
  }

  output += `  Proposed: **${proposal.toolName}** — ${proposal.description}\n\n`;
  console.log(`[smartEvolution] Proposal: ${proposal.toolName} — ${proposal.description}`);
  await appendAuditLog({ step: 3, action: "think", result: "proposal", toolName: proposal.toolName, description: proposal.description });

  // ── STEP 4: REPORT ─────────────────────────────────────────────
  output += "**Step 4/9 — Proposal Report**\n\n";
  console.log("[smartEvolution] Step 4: REPORT — building proposal document");

  const report = `
**Smart Evolution Proposal**

**Tool:** ${proposal.toolName}
**File:** server/tools/${proposal.filename}
**Complexity:** ${proposal.complexity || "medium"}

**Description:** ${proposal.description}

**Rationale:** ${proposal.rationale}

**Capabilities:**
${(proposal.capabilities || []).map(c => `  - ${c}`).join("\n")}

**Dependencies:** ${(proposal.dependsOn || []).join(", ") || "none"}

**Risks:**
${(proposal.risks || []).map(r => `  - ${r}`).join("\n")}

**Implementation Plan:**
${proposal.implementationPlan}
`.trim();

  output += report + "\n\n";

  // ── STEP 5: APPROVE (PAUSE POINT) ─────────────────────────────
  if (dryRun) {
    output += "\n**[DRY RUN] Pipeline paused — no changes made.**\n";
    await appendAuditLog({ step: 5, action: "dryrun_complete", toolName: proposal.toolName });
    return { tool: "smartEvolution", success: true, final: true, data: { text: output, preformatted: true } };
  }

  console.log("[smartEvolution] Step 5: APPROVE — saving proposal and waiting for user approval");
  await savePendingProposal({ proposal, report, systemInfo, createdAt: new Date().toISOString() });

  output += "---\n\n";
  output += '**Awaiting your decision:**\n';
  output += '  • **"approve evolution"** — proceed with building now\n';
  output += '  • **"reject evolution"** — discard this idea\n';
  output += '  • **"save for later"** — add to your tool suggestions backlog\n';

  // Optional: send notification via WhatsApp or email
  if (notifyVia === "whatsapp" || notifyVia === "email") {
    output += `\n📩 A copy of this report will be sent via ${notifyVia}.\n`;
    // Non-blocking notification — don't await or fail on it
    try {
      const notifyText = `Smart Evolution Proposal: ${proposal.toolName}\n\n${proposal.description}\n\nRationale: ${proposal.rationale}\n\nReply in the agent chat with "approve evolution" or "reject evolution".`;
      if (notifyVia === "whatsapp") {
        const { whatsapp } = await import("./whatsapp.js");
        whatsapp({ text: notifyText }).catch(e => console.warn("[smartEvolution] WhatsApp notification failed:", e.message));
      } else {
        const { email } = await import("./email.js");
        email({ text: `send email saying: ${notifyText}` }).catch(e => console.warn("[smartEvolution] Email notification failed:", e.message));
      }
    } catch (e) {
      console.warn("[smartEvolution] Notification failed:", e.message);
    }
  }

  await appendAuditLog({ step: 5, action: "awaiting_approval", toolName: proposal.toolName });
  return { tool: "smartEvolution", success: true, final: true, data: { text: output, preformatted: true, pendingEvolution: true } };
}

// ═══════════════════════════════════════════════════════════════════
//  APPROVAL → BUILD → VERIFY → NOTIFY (Steps 6-9)
// ═══════════════════════════════════════════════════════════════════
async function executeApprovedProposal() {
  const pending = await loadPendingProposal();
  if (!pending?.proposal) {
    return { tool: "smartEvolution", success: false, final: true, data: { text: "No pending evolution proposal found. Run `smart evolution` first to generate one." } };
  }

  const { proposal } = pending;
  let output = `**Smart Evolution — Building: ${proposal.toolName}**\n\n`;
  const filename = proposal.filename.endsWith(".js") ? proposal.filename : `${proposal.filename}.js`;
  const toolFilePath = path.join(TOOLS_DIR, filename);

  // ── STEP 6: VALIDATE PLAN WITH GEMINI (MANDATORY) ─────────────
  output += "**Step 6/9 — Gemini Plan Validation (MANDATORY)**\n";
  console.log("[smartEvolution] Step 6: VALIDATE — Gemini reviewing the plan");

  if (!process.env.GEMINI_API_KEY) {
    output += "  BLOCKED: Gemini API key is required for evolution validation.\n";
    output += "  Set GEMINI_API_KEY in your .env file and try again.\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  try {
    const planValidation = await validateWithGemini({
      filename: proposal.filename,
      originalCode: "// New file — no original code",
      proposedCode: proposal.implementationPlan,
      intent: `Create a new agent tool called "${proposal.toolName}": ${proposal.description}. Capabilities: ${(proposal.capabilities || []).join(", ")}. Dependencies: ${(proposal.dependsOn || []).join(", ")}.`
    });

    if (!planValidation.valid) {
      output += `  Gemini REJECTED the plan: ${planValidation.explanation}\n`;
      output += "\n**Pipeline aborted at Step 6 — Gemini did not approve the plan.**\n";
      await clearPendingProposal();
      await appendAuditLog({ step: 6, action: "gemini_rejected_plan", toolName: proposal.toolName, reason: planValidation.explanation });
      return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
    }
    output += "  Gemini APPROVED the plan.\n\n";
    console.log("[smartEvolution] Gemini approved the plan");
  } catch (e) {
    output += `  Gemini validation FAILED: ${e.message}\n`;
    output += "\n**Pipeline halted — Gemini validation is mandatory and could not be completed.**\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  await appendAuditLog({ step: 6, action: "gemini_approved_plan", toolName: proposal.toolName });

  // ── STEP 7: BUILD ─────────────────────────────────────────────
  output += "**Step 7/9 — Code Generation**\n";
  console.log("[smartEvolution] Step 7: BUILD — generating tool code");

  const buildPrompt = `Generate a complete, production-ready ES Module tool file for an AI agent system.

TOOL SPECIFICATION:
Name: ${proposal.toolName}
Description: ${proposal.description}
Capabilities: ${(proposal.capabilities || []).join(", ")}
Implementation Plan: ${proposal.implementationPlan}

MANDATORY BOILERPLATE — the exported function MUST match this EXACT signature pattern:

\`\`\`javascript
// server/tools/${filename}
// ${proposal.description}

import { CONFIG } from "../utils/config.js";
// ... other imports (ONLY from installed packages or Node.js built-ins) ...

/**
 * ${proposal.description}
 * @param {string|object} request - User input (string or {text, context})
 * @returns {object} Standard tool response
 */
export async function ${proposal.toolName}(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};

    // ... tool logic here ...

    return {
      tool: "${proposal.toolName}",
      success: true,
      final: true,
      data: {
        text: "result text",
        preformatted: true
      }
    };
  } catch (err) {
    console.error("[${proposal.toolName}] Error:", err.message);
    return {
      tool: "${proposal.toolName}",
      success: false,
      final: true,
      error: err.message
    };
  }
}
\`\`\`

HARD RULES (violations cause instant rejection):
1. ES Modules ONLY — use import/export, NEVER require() or module.exports
2. ONLY use these installed packages: ${pending.systemInfo?.dependencies?.join(", ") || "Node.js built-ins only"}
3. NEVER use process.env directly — import CONFIG from "../utils/config.js" instead
4. NEVER use eval() or new Function()
5. Include proper error handling with try/catch throughout
6. Include JSDoc comments for the main function
7. The return format MUST include: tool, success, final, data (or error)
8. Keep the file under 300 lines — focused and clean

Generate the COMPLETE file content. Do NOT use placeholder comments like "// implement here" — every function must be fully implemented.`;

  let generatedCode = null;
  const MAX_BUILD_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
    console.log(`[smartEvolution] Build attempt ${attempt}/${MAX_BUILD_ATTEMPTS}`);
    try {
      const buildResult = await llm(
        attempt === 1 ? buildPrompt : `${buildPrompt}\n\nPREVIOUS ATTEMPT FAILED. Error: ${generatedCode?._lastError || "unknown"}. Fix the issue and regenerate the COMPLETE file.`,
        { timeoutMs: 120000 }
      );

      if (buildResult.success && buildResult.data?.text) {
        // Extract code from markdown fences if present
        let code = buildResult.data.text;
        const fenceMatch = code.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
        if (fenceMatch) code = fenceMatch[1];
        code = code.trim();

        // Basic sanity checks
        if (!code.includes(`export async function ${proposal.toolName}`)) {
          generatedCode = { _lastError: `Missing export function ${proposal.toolName}` };
          output += `  Attempt ${attempt}: Missing required export — retrying...\n`;
          continue;
        }
        if (code.length < 200) {
          generatedCode = { _lastError: "Generated code too short (< 200 chars)" };
          output += `  Attempt ${attempt}: Code too short — retrying...\n`;
          continue;
        }

        generatedCode = code;
        output += `  Attempt ${attempt}: Code generated (${code.length} chars)\n`;
        break;
      }
    } catch (e) {
      generatedCode = { _lastError: e.message };
      output += `  Attempt ${attempt} failed: ${e.message}\n`;
    }
  }

  if (!generatedCode || typeof generatedCode !== "string") {
    output += "\n**Pipeline aborted at Step 7 — could not generate valid code after 3 attempts.**\n";
    await clearPendingProposal();
    await appendAuditLog({ step: 7, action: "build_failed", toolName: proposal.toolName });
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  await appendAuditLog({ step: 7, action: "code_generated", toolName: proposal.toolName, codeLength: generatedCode.length });

  // ── STEP 8: VERIFY (SYNTAX → SECURITY → ESLINT → GEMINI) ─────
  output += "\n**Step 8/9 — Multi-Layer Verification**\n";
  console.log("[smartEvolution] Step 8: VERIFY — running all safety checks");

  // Write to staging file first
  const stagingPath = `${toolFilePath}.staging.js`;
  await fs.writeFile(stagingPath, generatedCode, "utf8");

  // 8a. Syntax check
  try {
    await execAsync(`node --check "${stagingPath}"`, { timeout: 10000 });
    output += "  Syntax check: PASSED\n";
  } catch (e) {
    output += `  Syntax check: FAILED — ${e.stderr?.substring(0, 200) || e.message}\n`;
    try { await fs.unlink(stagingPath); } catch { /* cleanup */ }
    await clearPendingProposal();
    await appendAuditLog({ step: 8, action: "syntax_failed", toolName: proposal.toolName });
    output += "\n**Pipeline aborted at Step 8 — syntax error.**\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  // 8b. Security scan
  const security = securityScan(generatedCode);
  if (!security.safe) {
    output += `  Security scan: FAILED\n`;
    for (const v of security.violations) output += `    - ${v}\n`;
    try { await fs.unlink(stagingPath); } catch { /* cleanup */ }
    await clearPendingProposal();
    await appendAuditLog({ step: 8, action: "security_failed", toolName: proposal.toolName, violations: security.violations });
    output += "\n**Pipeline aborted at Step 8 — security violations detected.**\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }
  output += "  Security scan: PASSED\n";

  // 8c. ESLint check
  try {
    await execAsync(`npx eslint@8 --no-eslintrc --env node --env es2024 --parser-options=ecmaVersion:latest --parser-options=sourceType:module --rule "no-undef:error" "${stagingPath}"`, { timeout: 30000 });
    output += "  ESLint check: PASSED\n";
  } catch (e) {
    output += `  ESLint check: WARNING — ${e.stdout?.substring(0, 200) || e.message}\n`;
    // ESLint warnings don't abort — only errors do
    if (e.status > 1) {
      try { await fs.unlink(stagingPath); } catch { /* cleanup */ }
      await clearPendingProposal();
      output += "\n**Pipeline aborted at Step 8 — ESLint errors.**\n";
      return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
    }
  }

  // 8d. Gemini code review (MANDATORY)
  console.log("[smartEvolution] Gemini code review (mandatory)");
  try {
    const codeValidation = await validateWithGemini({
      filename: proposal.filename,
      originalCode: "// New tool — no previous code",
      proposedCode: generatedCode,
      intent: `New tool "${proposal.toolName}": ${proposal.description}`
    });

    if (!codeValidation.valid) {
      output += `  Gemini code review: REJECTED — ${codeValidation.explanation}\n`;

      // If Gemini provided a fix, try it
      if (codeValidation.fixedCode && codeValidation.fixedCode.length > 200) {
        console.log("[smartEvolution] Gemini provided a fix — retrying verification");
        output += "  Gemini provided corrected code — re-verifying...\n";
        generatedCode = codeValidation.fixedCode;
        await fs.writeFile(stagingPath, generatedCode, "utf8");

        // Re-run syntax + security on fixed code
        try { await execAsync(`node --check "${stagingPath}"`, { timeout: 10000 }); } catch {
          try { await fs.unlink(stagingPath); } catch { /* cleanup */ }
          await clearPendingProposal();
          output += "  Gemini's fix also has syntax errors — aborting.\n";
          output += "\n**Pipeline aborted at Step 8.**\n";
          return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
        }

        const fixSecurity = securityScan(generatedCode);
        if (!fixSecurity.safe) {
          try { await fs.unlink(stagingPath); } catch { /* cleanup */ }
          await clearPendingProposal();
          output += "  Gemini's fix has security violations — aborting.\n";
          output += "\n**Pipeline aborted at Step 8.**\n";
          return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
        }
        output += "  Gemini's corrected code passed syntax + security checks.\n";
      } else {
        try { await fs.unlink(stagingPath); } catch { /* cleanup */ }
        await clearPendingProposal();
        output += "\n**Pipeline aborted at Step 8 — Gemini rejected the code.**\n";
        return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
      }
    } else {
      output += "  Gemini code review: APPROVED\n";
    }
  } catch (e) {
    output += `  Gemini code review FAILED: ${e.message}\n`;
    try { await fs.unlink(stagingPath); } catch { /* cleanup */ }
    output += "\n**Pipeline halted — Gemini code review is mandatory.**\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  await appendAuditLog({ step: 8, action: "all_checks_passed", toolName: proposal.toolName });

  // ── ATOMIC DEPLOY: staging → final ─────────────────────────────
  try {
    await fs.rename(stagingPath, toolFilePath);
    output += "\n  File deployed: server/tools/" + filename + "\n";
  } catch (e) {
    // Fallback: copy + delete
    try {
      await fs.copyFile(stagingPath, toolFilePath);
      await fs.unlink(stagingPath);
      output += "\n  File deployed (fallback): server/tools/" + filename + "\n";
    } catch (copyErr) {
      output += `\n  Deploy failed: ${copyErr.message}\n`;
      output += "\n**Pipeline aborted — could not write final file.**\n";
      return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
    }
  }

  // Register the new tool in index.js, planner.js, executor.js
  try {
    await registerNewTool(toolFilePath, proposal.description);
    output += "  Registration: index.js, planner.js, executor.js updated\n";
  } catch (e) {
    output += `  Registration WARNING: ${e.message}\n`;
    output += "  You may need to manually register the tool.\n";
  }

  // ── STEP 9: NOTIFY ────────────────────────────────────────────
  output += "\n**Step 9/9 — Complete**\n\n";
  console.log("[smartEvolution] Step 9: NOTIFY — tool creation complete");

  output += `New tool **${proposal.toolName}** has been created and registered.\n`;
  output += `File: \`server/tools/${filename}\`\n\n`;
  output += `**Restart the server to activate the new tool.**\n`;
  output += `\`npm start\` or restart your dev server.\n`;

  // Log to telemetry
  try {
    await logImprovement({
      type: "new_tool",
      tool: proposal.toolName,
      description: proposal.description,
      file: `server/tools/${filename}`,
      source: "smartEvolution"
    });
  } catch { /* non-critical */ }

  await clearPendingProposal();
  await appendAuditLog({ step: 9, action: "complete", toolName: proposal.toolName, filename, codeLength: generatedCode.length });

  return { tool: "smartEvolution", success: true, final: true, data: { text: output, preformatted: true } };
}

// ═══════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════════
// ─── Exported: check for stale suggestions (called by heartbeat/scheduler) ──
export async function checkStaleSuggestions() {
  try {
    const suggestions = await loadSuggestions();
    const pending = suggestions.filter(s => s.status === "pending");
    if (pending.length === 0) return null;

    // Only remind if the oldest pending suggestion is at least 24h old
    const oldest = pending.reduce((a, b) => new Date(a.savedAt) < new Date(b.savedAt) ? a : b);
    const ageHours = (Date.now() - new Date(oldest.savedAt).getTime()) / 3600000;
    if (ageHours < 24) return null;

    // Pick a random pending suggestion to highlight
    const pick = pending[Math.floor(Math.random() * pending.length)];
    return {
      count: pending.length,
      highlight: pick,
      message: `💡 You have ${pending.length} tool suggestion${pending.length > 1 ? "s" : ""} saved for later. How about implementing **${pick.toolName}**? (${pick.description})\n\nSay **"implement suggestion ${pick.id}"** to build it, **"show tool suggestions"** to see all, or **"no"** to skip.`
    };
  } catch { return null; }
}

export async function smartEvolution(request) {
  const text = typeof request === "string" ? request : (request?.text || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};
  const action = context.action || "run";

  console.log(`[smartEvolution] Action: ${action}`);

  try {
    switch (action) {
      case "approve": {
        return await executeApprovedProposal();
      }

      case "reject": {
        await clearPendingProposal();
        return { tool: "smartEvolution", success: true, final: true, data: { text: "Evolution proposal rejected and cleared." } };
      }

      case "later": {
        // Save current pending proposal to suggestions backlog
        const pending = await loadPendingProposal();
        if (!pending?.proposal) {
          return { tool: "smartEvolution", success: false, final: true, data: { text: "No pending proposal to save. Run `suggest new tools` first." } };
        }
        const suggId = await addSuggestion(pending.proposal, pending.report, pending.systemInfo);
        await clearPendingProposal();
        await appendAuditLog({ step: 5, action: "saved_for_later", toolName: pending.proposal.toolName, suggestionId: suggId });
        return {
          tool: "smartEvolution", success: true, final: true,
          data: { text: `✅ Saved **${pending.proposal.toolName}** to your tool suggestions backlog (ID: #${suggId}).\n\nSay **"show tool suggestions"** to view your backlog, or **"implement suggestion ${suggId}"** when you're ready.`, preformatted: true }
        };
      }

      case "listSuggestions": {
        const suggestions = await loadSuggestions();
        if (suggestions.length === 0) {
          return { tool: "smartEvolution", success: true, final: true, data: { text: "No tool suggestions saved. Run `suggest new tools` to generate ideas." } };
        }
        let listText = "**🧰 Tool Suggestions Backlog:**\n\n";
        for (const s of suggestions) {
          const statusIcon = s.status === "implemented" ? "✅" : s.status === "rejected" ? "❌" : "⏳";
          listText += `**#${s.id}** ${statusIcon} **${s.toolName}** (${s.complexity})\n`;
          listText += `  ${s.description}\n`;
          listText += `  _Saved: ${new Date(s.savedAt).toLocaleDateString()}_\n\n`;
        }
        listText += `---\nSay **"implement suggestion N"** to build one, or **"remove suggestion N"** to discard.`;
        return { tool: "smartEvolution", success: true, final: true, data: { text: listText, preformatted: true } };
      }

      case "implementSuggestion": {
        // Extract suggestion ID from text
        const idMatch = text.match(/(\d+)/);
        if (!idMatch) {
          return { tool: "smartEvolution", success: false, final: true, data: { text: "Please specify a suggestion number. Example: `implement suggestion 3`" } };
        }
        const targetId = parseInt(idMatch[1], 10);
        const suggestions = await loadSuggestions();
        const target = suggestions.find(s => s.id === targetId);
        if (!target) {
          return { tool: "smartEvolution", success: false, final: true, data: { text: `Suggestion #${targetId} not found. Say "show tool suggestions" to see available ideas.` } };
        }
        if (target.status === "implemented") {
          return { tool: "smartEvolution", success: true, final: true, data: { text: `Suggestion #${targetId} (${target.toolName}) has already been implemented.` } };
        }
        // Load it as a pending proposal and run the approval flow
        await savePendingProposal({ proposal: target.proposal, report: target.report, systemInfo: target.systemInfo, createdAt: target.savedAt, fromSuggestion: targetId });
        console.log(`[smartEvolution] Loading suggestion #${targetId} (${target.toolName}) for implementation`);

        // Execute the build pipeline (steps 6-9)
        const buildResult = await executeApprovedProposal();

        // If successful, mark the suggestion as implemented
        if (buildResult.success) {
          const updatedSuggestions = await loadSuggestions();
          const idx = updatedSuggestions.findIndex(s => s.id === targetId);
          if (idx !== -1) {
            updatedSuggestions[idx].status = "implemented";
            updatedSuggestions[idx].implementedAt = new Date().toISOString();
            await saveSuggestions(updatedSuggestions);
          }
        }
        return buildResult;
      }

      case "removeSuggestion": {
        const rmMatch = text.match(/(\d+)/);
        if (!rmMatch) {
          return { tool: "smartEvolution", success: false, final: true, data: { text: "Please specify a suggestion number. Example: `remove suggestion 3`" } };
        }
        const rmId = parseInt(rmMatch[1], 10);
        const allSuggestions = await loadSuggestions();
        const exists = allSuggestions.find(s => s.id === rmId);
        if (!exists) {
          return { tool: "smartEvolution", success: false, final: true, data: { text: `Suggestion #${rmId} not found.` } };
        }
        await removeSuggestion(rmId);
        return { tool: "smartEvolution", success: true, final: true, data: { text: `🗑️ Removed suggestion #${rmId} (${exists.toolName}) from the backlog.` } };
      }

      case "status": {
        const pending = await loadPendingProposal();
        if (pending?.proposal) {
          return { tool: "smartEvolution", success: true, final: true, data: { text: `**Pending proposal:** ${pending.proposal.toolName} — ${pending.proposal.description}\n\nCreated: ${pending.createdAt}\n\nSay "approve evolution" to proceed or "reject evolution" to cancel.`, preformatted: true } };
        }
        return { tool: "smartEvolution", success: true, final: true, data: { text: "No pending evolution proposal." } };
      }

      case "history": {
        try {
          const log = JSON.parse(await fs.readFile(AUDIT_LOG, "utf8"));
          const recent = log.slice(-10);
          let historyText = "**Smart Evolution History (last 10 entries):**\n\n";
          for (const entry of recent) {
            historyText += `  ${entry.timestamp} — Step ${entry.step}: ${entry.action}${entry.toolName ? ` (${entry.toolName})` : ""}\n`;
          }
          return { tool: "smartEvolution", success: true, final: true, data: { text: historyText, preformatted: true } };
        } catch {
          return { tool: "smartEvolution", success: true, final: true, data: { text: "No evolution history found." } };
        }
      }

      case "dryrun":
      case "run":
      default: {
        const dryRun = action === "dryrun" || /\b(dry.?run|preview|plan)\b/i.test(text);
        const notifyVia = /\bwhatsapp\b/i.test(text) ? "whatsapp" : (/\bemail\b/i.test(text) ? "email" : null);
        return await runEvolutionPipeline({ notifyVia, dryRun });
      }
    }
  } catch (err) {
    console.error("[smartEvolution] Fatal error:", err.message);
    await appendAuditLog({ step: -1, action: "fatal_error", error: err.message });
    return { tool: "smartEvolution", success: false, final: true, error: err.message, data: { text: `Smart Evolution failed: ${err.message}` } };
  }
}

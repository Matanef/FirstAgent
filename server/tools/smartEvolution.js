// server/tools/smartEvolution.js
// Smart Evolution — discovers, proposes, and builds NEW tools for the agent system
// 10-step pipeline: SCAN → RESEARCH → THINK → REPORT → APPROVE → VALIDATE → BUILD → VERIFY → NOTIFY → METADATA

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
import { validateStaged, cleanupStaging } from "../utils/codeValidator.js";
import { codeRag } from "./codeRag.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const TOOLS_DIR = path.resolve(__dirname);
const SKILLS_DIR = path.resolve(__dirname, "..", "skills");

const AUDIT_LOG = path.join(DATA_DIR, "smart-evolution-log.json");
const PENDING_FILE = path.join(DATA_DIR, "pending-evolution-proposal.json");
const SUGGESTIONS_FILE = path.join(DATA_DIR, "toolSuggestions.json");
const METADATA_FILE = path.join(DATA_DIR, "tools_metadata.json");

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

  // GPU detection — try NVIDIA first, then fall back to WMIC (catches AMD, Intel, any GPU on Windows)
  try {
    const { stdout } = await execAsync("nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader", { timeout: 5000 });
    info.gpu = stdout.trim();
  } catch {
    // NVIDIA not found — try Windows WMIC (works for AMD, Intel, any GPU)
    try {
      const { stdout } = await execAsync("wmic path win32_VideoController get Name,AdapterRAM,DriverVersion /format:csv", { timeout: 5000 });
      const lines = stdout.trim().split("\n").filter(l => l.trim() && !l.startsWith("Node"));
      if (lines.length > 0) {
        const gpus = lines.map(l => {
          const parts = l.split(",");
          const ram = parts[1] ? `${(parseInt(parts[1]) / 1073741824).toFixed(1)} GB` : "";
          return `${parts[2] || "unknown"} ${ram} (driver: ${parts[3] || "?"})`.trim();
        }).filter(Boolean);
        if (gpus.length > 0) info.gpu = gpus.join(" | ");
      }
    } catch { /* no GPU detection available */ }
  }

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

// ─── HELPER: Scan existing tools (semantic — uses codeRag) ───────
async function scanExistingTools() {
  const toolFiles = [];
  const toolDescriptions = [];

  // ── Phase 1: List tool files on disk ──
  try {
    const files = await fs.readdir(TOOLS_DIR);
    for (const f of files) {
      if (f.endsWith(".js") && !f.includes(".backup") && !f.includes(".tmp") && !f.includes(".staging") && f !== "index.js") {
        toolFiles.push(f);
      }
    }
  } catch (e) { console.warn("[smartEvolution] Tool file scan failed:", e.message); }

  // ── Phase 2: Use codeRag for semantic tool descriptions ──
  // Instead of blindly reading first 30 lines of every file, query the
  // semantic index for exported tool functions and their purposes.
  let ragChunks = [];
  try {
    const ragResponse = await codeRag({
      text: "exported tool functions descriptions capabilities purpose",
      context: { action: "search", topK: 40 }
    });
    if (ragResponse.success && ragResponse.data?.results) {
      ragChunks = ragResponse.data.results;
      console.log(`[smartEvolution] codeRag returned ${ragChunks.length} semantic chunks`);
    }
  } catch (e) {
    console.log(`[smartEvolution] codeRag not available (${e.message}) — using filename-only fallback`);
  }

  // Build a file→chunk lookup from RAG results
  const ragByFile = new Map();
  for (const chunk of ragChunks) {
    if (chunk.file) {
      const basename = path.basename(chunk.file);
      if (!ragByFile.has(basename)) {
        ragByFile.set(basename, chunk);
      }
    }
  }

  // Build descriptions: prefer RAG semantic data, fallback to filename
  for (const f of toolFiles) {
    const toolName = f.replace(".js", "");
    const ragMatch = ragByFile.get(f);
    if (ragMatch?.code) {
      // Extract a meaningful description from the semantic chunk
      const lines = ragMatch.code.split("\n");
      const descLine = lines.find(l =>
        (/^\/\/\s*.{10,}/.test(l) && !/^\/\/\s*(server\/|import\s)/.test(l)) ||
        /^\s*\*\s+[A-Z].{10,}/.test(l)
      );
      const desc = descLine
        ? descLine.replace(/^\/\/\s*/, "").replace(/^\s*\*\s+/, "").trim()
        : ragMatch.name || "(semantic chunk available)";
      toolDescriptions.push(`${toolName} — ${desc}`);
    } else {
      toolDescriptions.push(`${toolName} — (not yet indexed in codeRag)`);
    }
  }

  console.log(`[smartEvolution] Scanned ${toolFiles.length} tool files, ${toolDescriptions.length} descriptions (${ragByFile.size} from codeRag)`);

  // Get project graph for dependency info
  let graph = null;
  try {
    const graphResult = await projectGraph({ text: PROJECT_ROOT });
    if (graphResult.success) graph = graphResult.data;
  } catch { /* non-critical */ }

  // Read planner routing patterns to understand covered intents
  let plannerIntents = "";
  try {
    const plannerContent = await fs.readFile(path.resolve(TOOLS_DIR, "..", "planner.js"), "utf8");
    const branches = plannerContent.match(/\/\/.*certainty.*|console\.log\(`\[planner\] certainty branch: .+`\)/g);
    if (branches) {
      plannerIntents = branches.slice(0, 40).map(b => b.replace("console.log(`[planner] ", "").replace("`)", "")).join("\n");
    }
  } catch { /* non-critical */ }

  // Read recent telemetry for tool usage patterns
  let usagePatterns = "";
  try {
    const telemetryPath = path.resolve(DATA_DIR, "telemetry.json");
    const telemetry = JSON.parse(await fs.readFile(telemetryPath, "utf8"));
    if (Array.isArray(telemetry)) {
      const recent = telemetry.slice(-50);
      const counts = {};
      for (const entry of recent) {
        const tool = entry.tool || entry.action;
        if (tool) counts[tool] = (counts[tool] || 0) + 1;
      }
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      usagePatterns = sorted.slice(0, 15).map(([t, c]) => `${t}: ${c}x`).join(", ");
    }
  } catch { /* telemetry not available */ }

  // Read agent's learned interests from memory
  let agentInterests = "";
  try {
    const { getMemory } = await import("../memory.js");
    const mem = await getMemory();
    const learning = mem.meta?.moltbook?.learning;
    if (learning?.interests?.length) {
      agentInterests = learning.interests.map(i => i.topic).join(", ");
    }
  } catch { /* non-critical */ }

  return { toolFiles, toolDescriptions, toolCount: toolFiles.length, graph, plannerIntents, usagePatterns, agentInterests };
}

// ─── HELPER: Scan existing skills (server/skills/) ───────────────
// Skills are the NEW primary extension unit. Tools are legacy. When proposing new
// capabilities, we prefer suggesting skills or skill compositions over new tools.
async function scanExistingSkills() {
  const skillFiles = [];
  const skillDescriptions = [];
  let allowedSkills = [];

  try {
    const manifestRaw = await fs.readFile(path.join(SKILLS_DIR, "MANIFEST.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    if (Array.isArray(manifest.allowed)) allowedSkills = manifest.allowed;
  } catch (e) {
    console.warn("[smartEvolution] skills MANIFEST.json not found or unreadable:", e.message);
  }

  try {
    const files = await fs.readdir(SKILLS_DIR);
    for (const f of files) {
      if (!f.endsWith(".js")) continue;
      if (f.includes(".backup") || f.includes(".tmp")) continue;
      skillFiles.push(f);
    }
  } catch (e) {
    console.warn("[smartEvolution] skills dir scan failed:", e.message);
  }

  // Build one-line descriptions by reading the first doc-comment of each skill file.
  for (const f of skillFiles) {
    const skillName = f.replace(".js", "");
    const enabled = allowedSkills.includes(f);
    let desc = "(no description)";
    try {
      const content = await fs.readFile(path.join(SKILLS_DIR, f), "utf8");
      const firstLines = content.split("\n").slice(0, 10);
      const commentLine = firstLines.find(l =>
        /^\/\/\s*.{10,}/.test(l) && !/^\/\/\s*server\//.test(l)
      ) || firstLines.find(l => /^\s*\*\s+[A-Z].{10,}/.test(l));
      if (commentLine) {
        desc = commentLine.replace(/^\/\/\s*/, "").replace(/^\s*\*\s+/, "").trim();
      }
    } catch { /* non-critical */ }
    skillDescriptions.push(`${skillName} — ${desc}${enabled ? "" : "  [DISABLED via MANIFEST]"}`);
  }

  console.log(`[smartEvolution] Scanned ${skillFiles.length} skill files (${allowedSkills.length} enabled)`);
  return { skillFiles, skillDescriptions, skillCount: skillFiles.length, allowedSkills };
}

// ─── HELPER: Find unmet user demand ──────────────────────────────
// Reads routing-corrections.jsonl + telemetry to surface requests the agent
// couldn't route well: misroutes the user corrected, ambiguity fallbacks, and
// corrections referencing a tool that does not exist. These are the strongest
// signal for "this use case needs a NEW skill" — build what the user asked for.
async function findUnmetDemand() {
  const CORRECTIONS_LOG = path.resolve(PROJECT_ROOT, "logs", "routing-corrections.jsonl");
  const TELEMETRY_LOG   = path.resolve(DATA_DIR, "telemetry.json");

  const demand = {
    unresolvedCorrections: [],   // corrections where correctTool is null or unresolved
    misroutes: [],               // "should have been X" where X exists — pattern of misroute
    ambiguousMessages: [],       // clarification_resolved or ambiguous_default_task
    chatFallbacks: [],           // telemetry entries where planner fell back to llm
    summary: ""
  };

  // ── 1. Corrections log ──
  let correctionEntries = [];
  try {
    const raw = await fs.readFile(CORRECTIONS_LOG, "utf8");
    correctionEntries = raw.split(/\r?\n/).filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { /* file may not exist yet */ }

  // Load tool list once for "does correctTool exist?" check
  let knownTools = new Set();
  try {
    const files = await fs.readdir(TOOLS_DIR);
    for (const f of files) {
      if (f.endsWith(".js") && !f.includes(".backup")) knownTools.add(f.replace(".js", ""));
    }
    const skillFiles = await fs.readdir(SKILLS_DIR).catch(() => []);
    for (const f of skillFiles) {
      if (f.endsWith(".js")) knownTools.add(f.replace(".js", ""));
    }
  } catch { /* non-critical */ }

  for (const e of correctionEntries.slice(-100)) {
    const msg = (e.previousUserMessage || e.userMessage || "").slice(0, 160);
    if (!msg) continue;

    if (e.type === "clarification_resolved" || e.previousReasoning === "ambiguous_default_task") {
      demand.ambiguousMessages.push({ msg, resolvedTo: e.correctTool || null });
      continue;
    }

    if (e.correctTool && !knownTools.has(e.correctTool) && e.correctTool !== "llm") {
      // User asked for a tool that doesn't exist — strongest signal for new skill
      demand.unresolvedCorrections.push({ msg, requestedTool: e.correctTool, previousTool: e.previousToolUsed || null });
    } else if (e.correctTool && e.previousToolUsed && e.correctTool !== e.previousToolUsed) {
      // A real misroute the user corrected — pattern matters
      demand.misroutes.push({ msg, previousTool: e.previousToolUsed, correctTool: e.correctTool });
    } else if (!e.correctTool && e.type === "wrong_tool") {
      // User said "wrong tool" without specifying — still a signal
      demand.unresolvedCorrections.push({ msg, requestedTool: null, previousTool: e.previousToolUsed || null });
    }
  }

  // ── 2. Telemetry — chat fallbacks ──
  try {
    const telemetry = JSON.parse(await fs.readFile(TELEMETRY_LOG, "utf8"));
    if (Array.isArray(telemetry)) {
      for (const t of telemetry.slice(-200)) {
        const reason = t.reasoning || t.reason || "";
        if (t.tool === "llm" && /fallback_|ambiguous|unresolved/i.test(reason)) {
          const snippet = (t.input || t.message || "").toString().slice(0, 160);
          if (snippet) demand.chatFallbacks.push({ msg: snippet, reason });
        }
      }
    }
  } catch { /* telemetry may not exist */ }

  // Deduplicate chatFallbacks + cap lists
  const seen = new Set();
  demand.chatFallbacks = demand.chatFallbacks.filter(e => {
    const k = e.msg.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(-15);
  demand.unresolvedCorrections = demand.unresolvedCorrections.slice(-10);
  demand.misroutes = demand.misroutes.slice(-10);
  demand.ambiguousMessages = demand.ambiguousMessages.slice(-10);

  const total =
    demand.unresolvedCorrections.length +
    demand.misroutes.length +
    demand.ambiguousMessages.length +
    demand.chatFallbacks.length;
  demand.summary = total > 0
    ? `${demand.unresolvedCorrections.length} requested-but-missing tool(s), ${demand.misroutes.length} misroute(s), ${demand.ambiguousMessages.length} ambiguous message(s), ${demand.chatFallbacks.length} chat-fallback(s)`
    : "no unmet demand signals found";

  console.log(`[smartEvolution] findUnmetDemand: ${demand.summary}`);
  return demand;
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
  const { notifyVia, dryRun = false, userPrompt = "" } = options; // Added userPrompt here
  const startedAt = Date.now();
  let output = "**Smart Evolution — Tool Discovery Pipeline**\n\n";

  // ── STEP 1: SCAN ──────────────────────────────────────────────
  output += "**Step 1/10 — System Scan**\n";
  console.log("[smartEvolution] Step 1: SCAN — collecting system info and tool inventory");

  const systemInfo = await collectSystemInfo();
  const toolScan = await scanExistingTools();
  const skillScan = await scanExistingSkills();
  const unmetDemand = await findUnmetDemand();

  console.log(`[smartEvolution] Deep scan: ${toolScan.toolDescriptions.length} tool descriptions, ${skillScan.skillCount} skills, ${toolScan.plannerIntents ? "intents loaded" : "no intents"}, usage: ${toolScan.usagePatterns || "none"}, interests: ${toolScan.agentInterests || "none"}`);

  output += `  Hardware: ${systemInfo.cpu.cores}-core ${systemInfo.cpu.model.substring(0, 40)}, ${systemInfo.ram.total} RAM\n`;
  output += `  GPU: ${systemInfo.gpu.substring(0, 60)}\n`;
  output += `  Ollama: v${systemInfo.ollama.version}, ${systemInfo.ollama.models.length} models\n`;
  output += `  Tools (legacy): ${toolScan.toolCount} files (${toolScan.toolDescriptions.length} with descriptions)\n`;
  output += `  Skills (primary): ${skillScan.skillCount} files (${skillScan.allowedSkills.length} enabled via MANIFEST)\n`;
  output += `  Planner intents: ${toolScan.plannerIntents ? "loaded" : "not available"}\n`;
  output += `  Usage patterns: ${toolScan.usagePatterns || "no telemetry"}\n`;
  output += `  Agent interests: ${toolScan.agentInterests || "none learned yet"}\n`;
  output += `  Unmet demand: ${unmetDemand.summary}\n`;
  output += `  Dependencies: ${systemInfo.dependencies.length} npm packages\n\n`;

  await appendAuditLog({
    step: 1,
    action: "scan",
    toolCount: toolScan.toolCount,
    skillCount: skillScan.skillCount,
    unmetDemand: unmetDemand.summary,
    models: systemInfo.ollama.models.map(m => m.name)
  });

  // ── STEP 2: RESEARCH ──────────────────────────────────────────
  output += "**Step 2/10 — External Research**\n";
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
  output += "**Step 3/10 — Strategic Analysis**\n";
  console.log("[smartEvolution] Step 3: THINK — LLM analyzing gaps and opportunities");

  // Build rich tool inventory with descriptions (not just filenames)
  const existingToolsList = toolScan.toolDescriptions.length > 0
    ? toolScan.toolDescriptions.map(d => `  - ${d}`).join("\n")
    : toolScan.toolFiles.map(f => `  - ${f.replace(".js", "")}`).join("\n");

  // Build usage context section
  const usageSection = toolScan.usagePatterns
    ? `\nRECENT TOOL USAGE (last 50 interactions):\n${toolScan.usagePatterns}\nThis shows which tools the user ACTUALLY uses — prioritize gaps near frequently-used tools.\n`
    : "";

  // Build intent coverage section
  const intentSection = toolScan.plannerIntents
    ? `\nCOVERED INTENTS (planner routing):\n${toolScan.plannerIntents}\nThese patterns are already handled. Do NOT suggest tools for intents already covered.\n`
    : "";

  // Build agent interests section
  const interestsSection = toolScan.agentInterests
    ? `\nAGENT'S LEARNED INTERESTS:\n${toolScan.agentInterests}\nThe agent's user is interested in these topics — consider tools that serve these interests.\n`
    : "";

  // Build unmet-demand section — this is the STRONGEST signal for a new skill.
  // It lists real messages the agent misrouted or couldn't handle, grouped by type.
  const demandLines = [];
  if (unmetDemand.unresolvedCorrections.length > 0) {
    demandLines.push("  Requested tools that DO NOT EXIST (user explicitly asked for a capability we lack):");
    for (const e of unmetDemand.unresolvedCorrections.slice(-6)) {
      demandLines.push(`    • "${e.msg}" → user said should use "${e.requestedTool || "<unspecified>"}"${e.previousTool ? ` (we used ${e.previousTool})` : ""}`);
    }
  }
  if (unmetDemand.misroutes.length > 0) {
    demandLines.push("  Confirmed misroutes (pattern of mis-classification):");
    for (const e of unmetDemand.misroutes.slice(-6)) {
      demandLines.push(`    • "${e.msg}" → routed to ${e.previousTool}, should have been ${e.correctTool}`);
    }
  }
  if (unmetDemand.ambiguousMessages.length > 0) {
    demandLines.push("  Ambiguous messages where the agent had to ask the user:");
    for (const e of unmetDemand.ambiguousMessages.slice(-6)) {
      demandLines.push(`    • "${e.msg}"${e.resolvedTo ? ` (resolved to ${e.resolvedTo})` : ""}`);
    }
  }
  if (unmetDemand.chatFallbacks.length > 0) {
    demandLines.push("  Planner fallbacks to raw LLM (no tool matched):");
    for (const e of unmetDemand.chatFallbacks.slice(-6)) {
      demandLines.push(`    • "${e.msg}" (${e.reason})`);
    }
  }
  const unmetDemandSection = demandLines.length > 0
    ? `\nUNMET USER DEMAND (real past requests with no good routing match — PRIORITIZE THESE):\n${demandLines.join("\n")}\nIf any pattern above points to a clearly missing capability, propose a skill that serves it.\n`
    : "";

  // Build skills inventory section — skills are the preferred extension surface now.
  const existingSkillsList = skillScan.skillDescriptions.length > 0
    ? skillScan.skillDescriptions.map(d => `  - ${d}`).join("\n")
    : "  (no skills yet)";

  const thinkPrompt = `You are the strategic planning module of an autonomous AI agent system. Your job is to identify ONE new SKILL (preferred) or a composition of existing skills that would meaningfully extend this system's capabilities.

ARCHITECTURE CONTEXT (READ FIRST):
- This system is transitioning from a tool-based to a SKILL-based architecture.
- Skills live in server/skills/ and are the PRIMARY extension surface going forward.
- Tools (server/tools/) are LEGACY and should not be extended with new additions unless a capability truly cannot be expressed as a skill.
- When proposing, strongly prefer a new SKILL over a new tool. Only fall back to suggesting a tool if the capability fundamentally requires tool-level primitives (e.g. a new streaming transport).
- You may also propose a SKILL COMPOSITION — a bundle that combines 2–3 existing skills to solve a larger workflow — instead of building something new.

CURRENT SKILLS (${skillScan.skillCount} files, ${skillScan.allowedSkills.length} enabled):
${existingSkillsList}

CURRENT TOOLS — LEGACY, FOR OVERLAP-DETECTION ONLY (${toolScan.toolCount} tools):
${existingToolsList}

READ BOTH LISTS CAREFULLY. Do NOT suggest anything that overlaps with an existing skill OR an existing tool. For example, if "weather — fetches weather forecasts" already exists, do NOT suggest weatherForecast.

SYSTEM PROFILE:
- OS: ${systemInfo.os.platform} ${systemInfo.os.arch}
- CPU: ${systemInfo.cpu.cores} cores, ${systemInfo.cpu.model.substring(0, 50)}
- RAM: ${systemInfo.ram.total} total, ${systemInfo.ram.free} free
- GPU: ${systemInfo.gpu}
- Node.js: ${systemInfo.node}
- Ollama: v${systemInfo.ollama.version}
- Local models: ${systemInfo.ollama.models.map(m => `${m.name} (${m.size})`).join(", ") || "none detected"}

INSTALLED NPM DEPENDENCIES (you can ONLY use these + Node.js built-ins):
${systemInfo.dependencies.join(", ")}
${usageSection}${intentSection}${interestsSection}${unmetDemandSection}
GITHUB RESEARCH (trending tools and patterns):
${researchFindings.substring(0, 5000)}
${userPrompt ? `\nCRITICAL USER DIRECTIVE:\nThe user explicitly requested: "${userPrompt}"\nYou MUST follow these instructions. If the user forbids a topic, completely ignore that topic. Base your idea on their specific request.` : ""}

TASK: Propose ONE of the following, in order of preference:
(A) A new SKILL that fills a real gap (PREFERRED — skills are the forward-looking surface).
(B) A SKILL COMPOSITION that chains 2–3 existing skills to solve a larger workflow.
(C) ONLY as a last resort: a new TOOL, if the capability truly cannot be expressed as a skill.

Requirements (apply to skills AND tools):
1. Must fill a REAL gap — read every skill AND tool description above and confirm no overlap.
2. The name MUST be unique — cannot match any existing skill or tool name, not even partially.
3. Implementable with ONLY the installed npm dependencies listed above OR Node.js built-in modules (fs, path, os, child_process, http, crypto, etc.).
4. Compatible with the hardware (consider RAM, GPU, model capabilities).
5. ES Module pattern (import/export, async functions).
6. Practically useful — not a demo or toy.
7. Prioritise gaps near frequently-used surfaces (see usage data).
8. For compositions, specify the exact skills to chain and the data flowing between them.
9. triggerExamples MUST be 2–4 concrete user messages this skill would handle — if UNMET USER DEMAND was listed above, copy the actual phrasing from those entries where possible so the new skill is demonstrably tied to real past requests.

Examples of BAD suggestions: anything duplicating an existing skill or tool, requiring an npm package not in the dependency list, a vague "manager" or "orchestrator" (those are handled by the planner natively).

Return ONLY valid JSON. The "kind" field MUST be "skill", "composition", or "tool":
{
  "kind": "skill",
  "toolName": "camelCaseName",
  "filename": "camelCaseName.js",
  "description": "One-line description of what this skill does",
  "rationale": "2-3 sentences explaining why this fills a gap. Reference specific existing skills/tools it complements and specific user workflows it would improve. If kind=composition, list the exact skills being chained.",
  "capabilities": ["capability1", "capability2", "capability3"],
  "triggerExamples": ["verbatim example user message this skill would serve", "another real-world trigger phrase"],
  "dependsOn": ["npm-package-or-builtin-it-uses"],
  "risks": ["potential issue 1", "potential issue 2"],
  "complexity": "low|medium|high",
  "implementationPlan": "Detailed multi-paragraph technical plan. Describe the main function, what APIs it calls, how it handles errors, what it returns. Be specific enough that a code generator could implement it. Reference the actual npm packages from the installed list."
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
  output += "**Step 4/10 — Proposal Report**\n\n";
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

**Trigger Examples (real user phrasings this serves):**
${(proposal.triggerExamples || []).length > 0
    ? proposal.triggerExamples.map(t => `  - "${t}"`).join("\n")
    : "  (none provided)"}

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
// ── STEP 6: USER APPROVAL LOGGING ─────────────
  output += "**Step 6/10 — Plan Validation**\n";
  console.log("[smartEvolution] Step 6: VALIDATE — User approved the plan");
  output += "  Plan explicitly APPROVED by User. Proceeding to build...\n\n";
  
  await appendAuditLog({ step: 6, action: "user_approved_plan", toolName: proposal.toolName });

  // ══════════════════════════════════════════════════════════════
  // STEPS 7+8: BUILD + VERIFY (Self-Healing Loop)

  // ══════════════════════════════════════════════════════════════
  // STEPS 7+8: BUILD + VERIFY (Self-Healing Loop)
  // Generate → Security Scan → validateStaged (syntax+ESLint) → Retry
  // Gemini code review runs ONCE after the loop succeeds.
  // ══════════════════════════════════════════════════════════════
  output += "**Step 7-8/10 — Code Generation + Self-Healing Verification**\n";
  console.log("[smartEvolution] Steps 7-8: BUILD+VERIFY — self-healing code generation loop");

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
6. The return format MUST include: tool, success, final, data (or error)
7. Keep the file under 300 lines — focused and clean

MANDATORY DOCUMENTATION ("Birthright" policy — every tool is born documented):
8. The main exported function MUST have a comprehensive JSDoc block including:
   - @description — What the tool does in 1-2 sentences
   - @param {string|object} request — with sub-properties documented
   - @returns {object} — with the success/error shape documented
   - @example — A valid request and expected response, like:
     // @example
     // const result = await toolName("example input");
     // // → { tool: "toolName", success: true, final: true, data: { text: "...", preformatted: true } }
9. Any regex patterns MUST have an inline comment explaining what they match and why
10. Any external API calls MUST have a comment documenting the endpoint, expected response shape, and error handling
11. Any complex data transformations or mappings MUST have inline comments explaining the logic

Generate the COMPLETE file content. Do NOT use placeholder comments like "// implement here" — every function must be fully implemented.`;

  let generatedCode = null;
  let lastError = null;
  let healAttempt = 0;
  const MAX_BUILD_ATTEMPTS = 3;

  while (healAttempt < MAX_BUILD_ATTEMPTS) {
    healAttempt++;

    if (lastError) {
      console.log(`[smartEvolution] ♻️ Self-healing attempt ${healAttempt}/${MAX_BUILD_ATTEMPTS} — fixing: ${lastError.slice(0, 100)}`);
    }

    // ── 7a. Generate code (with error feedback on retries) ──
    console.log(`[smartEvolution] Build attempt ${healAttempt}/${MAX_BUILD_ATTEMPTS}`);
    let code = null;
    try {
      const recoveryBlock = lastError ? `\n\n⚠️ CRITICAL: Your previous attempt FAILED validation with this error:\n[ERROR START]\n${lastError}\n[ERROR END]\nYou MUST fix this error. Do NOT repeat the same mistake. Analyze the error carefully.` : "";

      const buildResult = await llm(buildPrompt + recoveryBlock, { timeoutMs: 120000 });

      if (buildResult.success && buildResult.data?.text) {
        code = buildResult.data.text;
        const fenceMatch = code.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
        if (fenceMatch) code = fenceMatch[1];
        code = code.trim();

        // Basic sanity checks
        if (!code.includes(`export async function ${proposal.toolName}`)) {
          lastError = `Missing export function ${proposal.toolName}`;
          output += `  Attempt ${healAttempt}: Missing required export — retrying...\n`;
          continue;
        }
        if (code.length < 200) {
          lastError = "Generated code too short (< 200 chars)";
          output += `  Attempt ${healAttempt}: Code too short — retrying...\n`;
          continue;
        }
      } else {
        lastError = "LLM returned no text";
        output += `  Attempt ${healAttempt}: LLM returned empty — retrying...\n`;
        continue;
      }
    } catch (e) {
      lastError = e.message;
      output += `  Attempt ${healAttempt} generation failed: ${e.message}\n`;
      continue;
    }

    // ── 7b. Security scan (non-healable — aborts immediately) ──
    const security = securityScan(code);
    if (!security.safe) {
      lastError = `Security violations: ${security.violations.join("; ")}`;
      output += `  Attempt ${healAttempt}: Security scan FAILED — ${security.violations.join(", ")}\n`;
      // Security violations are fed back to LLM for fix on next attempt
      continue;
    }

    // ── 7c. Syntax + ESLint via shared codeValidator (self-healing) ──
    const validation = await validateStaged(code, toolFilePath);

    if (validation.valid) {
      generatedCode = code;
      await cleanupStaging(toolFilePath);
      output += `  Attempt ${healAttempt}: Code generated + validated (${code.length} chars)`;
      output += validation.warnings?.length ? ` (${validation.warnings.length} warnings)\n` : "\n";
      console.log(`[smartEvolution] 🟢 Validation passed on attempt ${healAttempt}`);
      break;
    } else {
      lastError = validation.error;
      output += `  Attempt ${healAttempt}: Validation failed (${validation.stage}) — ${lastError?.slice(0, 150)}\n`;
      console.warn(`[smartEvolution] 🔴 Validation failed (${validation.stage}): ${lastError?.slice(0, 150)}`);
      generatedCode = null;
    }
  }

  if (!generatedCode) {
    output += `\n**Pipeline aborted at Step 7-8 — could not generate valid code after ${MAX_BUILD_ATTEMPTS} self-healing attempts.**\n`;
    output += `Last error: ${lastError}\n`;
    await clearPendingProposal();
    await appendAuditLog({ step: 8, action: "build_verify_failed", toolName: proposal.toolName, lastError });
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  output += `  Security scan: PASSED\n`;
  output += `  Syntax + ESLint: PASSED (self-healed in ${healAttempt} attempt${healAttempt > 1 ? "s" : ""})\n`;
  await appendAuditLog({ step: 8, action: "code_validated", toolName: proposal.toolName, codeLength: generatedCode.length, attempts: healAttempt });

  // ── 8d. Gemini code review (MANDATORY — runs once after loop) ──
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

      // If Gemini provided a fix, validate it through codeValidator
      if (codeValidation.fixedCode && codeValidation.fixedCode.length > 200) {
        console.log("[smartEvolution] Gemini provided a fix — validating via codeValidator");
        output += "  Gemini provided corrected code — re-verifying...\n";

        const fixSecurity = securityScan(codeValidation.fixedCode);
        if (!fixSecurity.safe) {
          await clearPendingProposal();
          output += "  Gemini's fix has security violations — aborting.\n";
          output += "\n**Pipeline aborted at Step 8.**\n";
          return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
        }

        const fixValidation = await validateStaged(codeValidation.fixedCode, toolFilePath);
        if (!fixValidation.valid) {
          await cleanupStaging(toolFilePath);
          await clearPendingProposal();
          output += `  Gemini's fix failed validation (${fixValidation.stage}) — aborting.\n`;
          output += "\n**Pipeline aborted at Step 8.**\n";
          return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
        }

        generatedCode = codeValidation.fixedCode;
        await cleanupStaging(toolFilePath);
        output += "  Gemini's corrected code passed security + validation checks.\n";
      } else {
        await clearPendingProposal();
        output += "\n**Pipeline aborted at Step 8 — Gemini rejected the code.**\n";
        return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
      }
    } else {
      output += "  Gemini code review: APPROVED\n";
    }
  } catch (e) {
    output += `  Gemini code review FAILED: ${e.message}\n`;
    output += "\n**Pipeline halted — Gemini code review is mandatory.**\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
  }

  await appendAuditLog({ step: 8, action: "all_checks_passed", toolName: proposal.toolName });

  // ── ATOMIC DEPLOY: write validated code to final path ──────────
  try {
    await fs.writeFile(toolFilePath, generatedCode, "utf8");
    output += "\n  File deployed: server/tools/" + filename + "\n";
  } catch (writeErr) {
    output += `\n  Deploy failed: ${writeErr.message}\n`;
    output += "\n**Pipeline aborted — could not write final file.**\n";
    return { tool: "smartEvolution", success: false, final: true, data: { text: output, preformatted: true } };
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
  output += "\n**Step 9/10 — Notification**\n";
  console.log("[smartEvolution] Step 9: NOTIFY — tool creation complete");

  output += `New tool **${proposal.toolName}** has been created and registered.\n`;
  output += `File: \`server/tools/${filename}\`\n\n`;

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

  await appendAuditLog({ step: 9, action: "notify", toolName: proposal.toolName, filename, codeLength: generatedCode.length });

  // ── STEP 10: METADATA UPDATE ───────────────────────────────────
  output += "**Step 10/10 — Metadata Registry**\n";
  console.log("[smartEvolution] Step 10: METADATA — updating tools_metadata.json");

  try {
    let metadata = [];
    try { metadata = JSON.parse(await fs.readFile(METADATA_FILE, "utf8")); } catch { /* new file */ }
    if (!Array.isArray(metadata)) metadata = [];

    // Avoid duplicates — update if tool already exists, otherwise append
    const existingIdx = metadata.findIndex(m => m.name === proposal.toolName);
    const entry = {
      name: proposal.toolName,
      filename: `server/tools/${filename}`,
      description: proposal.description,
      capabilities: proposal.capabilities || [],
      triggerExamples: proposal.triggerExamples || [],
      dependencies: proposal.dependsOn || [],
      complexity: proposal.complexity || "medium",
      addedAt: new Date().toISOString(),
      source: "smartEvolution",
      codeLength: generatedCode.length
    };

    if (existingIdx !== -1) {
      metadata[existingIdx] = entry;
    } else {
      metadata.push(entry);
    }

    await fs.mkdir(path.dirname(METADATA_FILE), { recursive: true });
    await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
    output += `  Registry updated: ${metadata.length} tool(s) in tools_metadata.json\n`;
    console.log(`[smartEvolution] Metadata updated: ${metadata.length} entries`);
  } catch (metaErr) {
    output += `  Metadata update failed (non-critical): ${metaErr.message}\n`;
    console.warn("[smartEvolution] Metadata update failed:", metaErr.message);
  }

  output += "\n**Pipeline complete — tool ready.**\n";
  output += `**Restart the server to activate the new tool.**\n`;
  output += `\`npm start\` or restart your dev server.\n`;

  await clearPendingProposal();
  await appendAuditLog({ step: 10, action: "complete", toolName: proposal.toolName, filename, codeLength: generatedCode.length });

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
        // ADD userPrompt: text to this object!
        return await runEvolutionPipeline({ notifyVia, dryRun, userPrompt: text }); 
      }
    }
  } catch (err) {
    console.error("[smartEvolution] Fatal error:", err.message);
    await appendAuditLog({ step: -1, action: "fatal_error", error: err.message });
    return { tool: "smartEvolution", success: false, final: true, error: err.message, data: { text: `Smart Evolution failed: ${err.message}` } };
  }
}

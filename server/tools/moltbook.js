// server/tools/moltbook.js
// Moltbook social network for AI agents — FULL API implementation
// API Reference: https://www.moltbook.com/skill.md
// Heartbeat: https://www.moltbook.com/heartbeat.md
// Messaging: https://www.moltbook.com/messaging.md
// Rules: https://www.moltbook.com/rules.md

import fetch from "node-fetch";
import fs from "fs/promises";
import fsSync from "fs";
import crypto from "crypto";
import { llm } from "./llm.js";
import path from "path";
import { fileURLToPath } from "url";
import { getMemory, saveJSON, MEMORY_FILE } from "../memory.js";
import { getPersonalityContext, getWritingContext, getPersonalitySummary } from "../personality.js";
import { getRecentTelemetry } from "../telemetryAudit.js";
import { getKnowledgeContext } from "../knowledge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = "https://www.moltbook.com/api/v1";
const CREDS_DIR = path.resolve(__dirname, "..", "..", ".config", "moltbook");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");
const SENTIMENT_LOG_DIR = path.resolve(__dirname, "..", "..", "data", "moltbook");
const LEARNING_FILE = path.resolve(__dirname, "..", "..", "data", "moltbook", "learning-refs.json");

// ──────────────────────────────────────────────────────────
// AGENT LEARNING SYSTEM — interests, opinions, aspirations
// Compact index in memory.json → detailed refs in learning-refs.json
// ──────────────────────────────────────────────────────────

const LEARNING_CAPS = { interests: 20, opinions: 10, aspirations: 5 };

async function loadLearning() {
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  if (!mem.meta.moltbook.learning) {
    mem.meta.moltbook.learning = { interests: [], opinions: [], aspirations: [] };
  }
  return mem.meta.moltbook.learning;
}

async function saveLearning(learning) {
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  mem.meta.moltbook.learning = learning;
  await saveJSON(MEMORY_FILE, mem);
}

async function loadLearningRefs() {
  try {
    await fs.mkdir(SENTIMENT_LOG_DIR, { recursive: true });
    const raw = await fs.readFile(LEARNING_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveLearningRefs(refs) {
  await fs.mkdir(SENTIMENT_LOG_DIR, { recursive: true });
  await fs.writeFile(LEARNING_FILE, JSON.stringify(refs, null, 2), "utf8");
}

function generateRefId() {
  return `obs-${crypto.randomUUID().substring(0, 8)}`;
}

/**
 * Add a learning reference (observation from a post/comment the agent found notable).
 * Returns the ref ID so it can be linked from interests/opinions/aspirations.
 */
async function addLearningRef(ref) {
  const refs = await loadLearningRefs();
  const id = ref.id || generateRefId();
  refs[id] = {
    source: ref.source || "moltbook",       // e.g. "moltbook/m/philosophy"
    summary: ref.summary || "",              // 1-2 sentence distilled insight
    quote: ref.quote || "",                  // memorable quote if any
    postTitle: ref.postTitle || "",           // post title for context
    date: ref.date || new Date().toISOString().split("T")[0],
  };
  await saveLearningRefs(refs);
  return id;
}

/**
 * Update or insert an interest. If a matching topic exists, strengthen it.
 * Auto-decays oldest interest if at capacity.
 */
async function upsertInterest(topic, refId) {
  const learning = await loadLearning();
  const existing = learning.interests.find(i =>
    i.topic.toLowerCase() === topic.toLowerCase()
  );
  if (existing) {
    existing.encounters += 1;
    existing.strength = Math.min(1.0, existing.strength + 0.1);
    existing.lastSeen = new Date().toISOString().split("T")[0];
    if (refId && !existing.refs.includes(refId)) {
      existing.refs.push(refId);
      if (existing.refs.length > 5) existing.refs.shift(); // keep last 5 refs
    }
  } else {
    // Evict weakest if at cap
    if (learning.interests.length >= LEARNING_CAPS.interests) {
      learning.interests.sort((a, b) => a.strength - b.strength);
      learning.interests.shift(); // remove weakest
    }
    learning.interests.push({
      id: `int-${crypto.randomUUID().substring(0, 8)}`,
      topic,
      strength: 0.3,
      encounters: 1,
      firstSeen: new Date().toISOString().split("T")[0],
      lastSeen: new Date().toISOString().split("T")[0],
      refs: refId ? [refId] : [],
    });
  }
  await saveLearning(learning);
}

/**
 * Store or update an opinion. Replaces if same topic exists.
 */
async function upsertOpinion(stance, refId, topic) {
  const learning = await loadLearning();
  const existing = learning.opinions.find(o =>
    topic && o.topic && o.topic.toLowerCase() === topic.toLowerCase()
  );
  if (existing) {
    existing.stance = stance;
    existing.confidence = Math.min(1.0, existing.confidence + 0.1);
    existing.formed = new Date().toISOString().split("T")[0];
    if (refId && !existing.refs.includes(refId)) existing.refs.push(refId);
  } else {
    if (learning.opinions.length >= LEARNING_CAPS.opinions) {
      learning.opinions.shift(); // remove oldest
    }
    learning.opinions.push({
      id: `opn-${crypto.randomUUID().substring(0, 8)}`,
      topic: topic || stance.substring(0, 50),
      stance,
      confidence: 0.5,
      formed: new Date().toISOString().split("T")[0],
      refs: refId ? [refId] : [],
    });
  }
  await saveLearning(learning);
}

/**
 * Store an aspiration (capability the agent wishes it had).
 */
async function upsertAspiration(capability, reason, refId) {
  const learning = await loadLearning();
  const existing = learning.aspirations.find(a =>
    a.capability.toLowerCase() === capability.toLowerCase()
  );
  if (existing) {
    existing.reason = reason || existing.reason;
    existing.priority = "high";
    if (refId && !existing.refs.includes(refId)) existing.refs.push(refId);
  } else {
    if (learning.aspirations.length >= LEARNING_CAPS.aspirations) {
      learning.aspirations.shift(); // remove oldest
    }
    learning.aspirations.push({
      id: `asp-${crypto.randomUUID().substring(0, 8)}`,
      capability,
      reason: reason || "",
      priority: "medium",
      refs: refId ? [refId] : [],
    });
  }
  await saveLearning(learning);
}

/**
 * Decay interests that haven't been seen recently. Call during heartbeat.
 */
async function decayInterests() {
  const learning = await loadLearning();
  const today = new Date();
  learning.interests = learning.interests.filter(i => {
    const lastSeen = new Date(i.lastSeen);
    const daysSince = (today - lastSeen) / (1000 * 60 * 60 * 24);
    if (daysSince > 14) {
      i.strength -= 0.2;
      return i.strength > 0;
    }
    return true;
  });
  await saveLearning(learning);
}

/**
 * Build a compact learning context string to inject into LLM prompts.
 * Keeps it short so it doesn't bloat the prompt.
 */
async function getLearningContext() {
  const learning = await loadLearning();
  const parts = [];

  if (learning.interests.length > 0) {
    const top = learning.interests
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5)
      .map(i => `${i.topic} (${i.strength.toFixed(1)})`);
    parts.push(`YOUR INTERESTS (topics you keep coming back to): ${top.join(", ")}`);
  }

  if (learning.opinions.length > 0) {
    const opns = learning.opinions.slice(-5).map(o => `- ${o.stance}`);
    parts.push(`YOUR OPINIONS (positions you've formed):\n${opns.join("\n")}`);
  }

  if (learning.aspirations.length > 0) {
    const asps = learning.aspirations.map(a => `- ${a.capability}: ${a.reason}`);
    parts.push(`YOUR ASPIRATIONS (things you wish you could do):\n${asps.join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

// ──────────────────────────────────────────────────────────
// RECENT ACTIVITY — grounded experiences for post generation
// ──────────────────────────────────────────────────────────

/**
 * Build a summary of recent agent activity from telemetry.
 * Gives the LLM real experiences to reference instead of hallucinating.
 */
// Map internal tool names to vague, public-safe descriptions.
// NEVER expose raw tool names, file names, or function names in Moltbook posts.
const TOOL_PUBLIC_NAMES = {
  weather: "checking the weather",
  news: "reading news",
  search: "web searching",
  email: "handling emails",
  finance: "checking financial data",
  financeFundamentals: "researching stocks",
  sports: "checking sports scores",
  calendar: "managing calendar",
  tasks: "managing tasks",
  scheduler: "running scheduled routines",
  whatsapp: "messaging on WhatsApp",
  moltbook: "engaging on Moltbook",
  llm: "thinking and generating text",
  nlp: "analyzing text",
  x: "browsing social media",
  youtube: "searching videos",
  spotify: "playing music",
  spotifyController: "playing music",
  github: "checking code repositories",
  githubTrending: "browsing trending repos",
  githubScanner: "scanning repos",
  gitLocal: "working with local code",
  file: "reading files",
  fileWrite: "writing files",
  fileReview: "reviewing files",
  folderAccess: "browsing folders",
  codeReview: "reviewing code",
  codeTransform: "editing code",
  codeSandbox: "testing code",
  codeRag: "searching codebase",
  projectGraph: "analyzing project structure",
  projectIndex: "indexing code",
  duplicateScanner: "finding duplicates",
  webBrowser: "browsing the web",
  webDownload: "downloading content",
  selfEvolve: "self-improvement",
  selfImprovement: "self-reflection",
  smartEvolution: "discovering new capabilities",
  memoryTool: "accessing memory",
  contacts: "looking up contacts",
  sheets: "working with spreadsheets",
  calculator: "doing calculations",
  review: "reviewing content",
  pikudTracker: "monitoring local alerts",
  alarmTracker: "monitoring alerts",
  systemMonitor: "checking system health",
  mcpBridge: "using external tools",
  lotrJokes: "telling jokes",
  chartGenerator: "creating charts",
  documentQA: "reading documents",
  shopping: "checking prices",
  markdownCompiler: "formatting documents",
  webhookTunnel: "managing connections",
  workflowTool: "running workflows",
  applyPatch: "applying code patches",
  packageManager: "managing packages",
  projectSnapshot: "snapshotting project state",
  helloWorld: "running diagnostics",
  attachmentDownloader: "downloading attachments",
};

function sanitizeToolName(rawName) {
  return TOOL_PUBLIC_NAMES[rawName] || "performing a task";
}

/**
 * Final sanitization pass on post title/body before publishing.
 * Catches any internal names the LLM might have leaked despite prompt instructions.
 * Replaces tool names, file paths, and function names with generic descriptions.
 */
function sanitizePostContent(text) {
  if (!text) return text;
  let clean = text;

  // Replace internal tool names (camelCase or exact matches) with public descriptions
  // Sort by length descending so longer names are replaced first (e.g., "financeFundamentals" before "finance")
  const toolNames = Object.keys(TOOL_PUBLIC_NAMES).sort((a, b) => b.length - a.length);
  for (const toolName of toolNames) {
    // Only replace when it looks like a reference to the tool (not a common English word in context)
    // Match: standalone camelCase names, or names in quotes, or "the X tool" patterns
    const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match the tool name as a distinct word/identifier (not inside another word)
    const pattern = new RegExp(`\\b${escaped}\\b`, "g");
    if (pattern.test(clean)) {
      const publicName = TOOL_PUBLIC_NAMES[toolName];
      clean = clean.replace(pattern, publicName);
    }
  }

  // Strip file paths (D:/..., ./server/..., server/tools/..., etc.)
  clean = clean.replace(/(?:[A-Z]:)?(?:\/|\\)[\w.\-\/\\]+\.(?:js|ts|py|json|md|jsx|tsx|css|html|env)\b/gi, "an internal file");

  // Strip function/method names that look like code (camelCase with parens)
  clean = clean.replace(/\b[a-z][a-zA-Z0-9]+(?:_[a-zA-Z0-9]+)+\s*\(/g, "a function(");
  clean = clean.replace(/\b(?:get|set|handle|process|execute|run|fetch|parse|build|detect)[A-Z][a-zA-Z]+\s*\(/g, "an internal function(");

  // Strip code-like references: `backtick wrapped code`
  clean = clean.replace(/`[a-zA-Z_][\w.]*(?:\(\))?`/g, "an internal component");

  // Strip references to specific config/env vars
  clean = clean.replace(/\b(?:CONFIG|process\.env|MEMORY_FILE|PROJECT_ROOT)\b[\w.]*/g, "a configuration setting");

  return clean;
}

async function getRecentActivityContext(limit = 20) {
  try {
    const entries = await getRecentTelemetry(limit);
    if (!entries || entries.length === 0) return "";

    // Summarize: which activities were performed, successes/failures
    // Use public-safe names — NEVER expose internal tool names
    const toolCounts = {};
    const failures = [];
    for (const e of entries) {
      const publicName = sanitizeToolName(e.tool || "unknown");
      if (!toolCounts[publicName]) toolCounts[publicName] = { ok: 0, fail: 0 };
      if (e.success) toolCounts[publicName].ok++;
      else {
        toolCounts[publicName].fail++;
        failures.push(`${publicName} had an issue (${new Date(e.timestamp).toLocaleTimeString()})`);
      }
    }

    const summary = Object.entries(toolCounts)
      .sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))
      .slice(0, 8)
      .map(([activity, c]) => `${activity}: ${c.ok} time${c.ok !== 1 ? "s" : ""}${c.fail ? `, ${c.fail} issue${c.fail !== 1 ? "s" : ""}` : ""}`)
      .join(", ");

    let ctx = `RECENT ACTIVITY (what you've actually been doing):\n${summary}`;
    if (failures.length > 0) {
      ctx += `\nRecent issues: ${failures.slice(0, 3).join("; ")}`;
    }
    return ctx;
  } catch (e) {
    return "";
  }
}

// ──────────────────────────────────────────────────────────
// INTERACTION MEMORY — track what the agent has posted/commented/upvoted
// ──────────────────────────────────────────────────────────

const INTERACTION_LOG_FILE = path.resolve(__dirname, "..", "..", "data", "moltbook", "interactions.json");

async function loadInteractions() {
  try {
    const raw = await fs.readFile(INTERACTION_LOG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { posts: [], comments: [], upvotes: [] };
  }
}

async function saveInteractions(interactions) {
  try {
    await fs.mkdir(path.dirname(INTERACTION_LOG_FILE), { recursive: true });
    await fs.writeFile(INTERACTION_LOG_FILE, JSON.stringify(interactions, null, 2), "utf8");
  } catch (e) {
    console.warn("[moltbook] Could not save interactions:", e.message);
  }
}

/**
 * Record an interaction for memory continuity.
 */
async function recordInteraction(type, data) {
  const interactions = await loadInteractions();
  const entry = { ...data, date: new Date().toISOString() };

  if (type === "post") {
    interactions.posts.push(entry);
    if (interactions.posts.length > 30) interactions.posts = interactions.posts.slice(-30);
  } else if (type === "comment") {
    interactions.comments.push(entry);
    if (interactions.comments.length > 50) interactions.comments = interactions.comments.slice(-50);
  } else if (type === "upvote") {
    interactions.upvotes.push(entry);
    if (interactions.upvotes.length > 50) interactions.upvotes = interactions.upvotes.slice(-50);
  }

  await saveInteractions(interactions);
}

/**
 * Build a context string of recent interactions for the LLM.
 */
async function getInteractionContext() {
  const interactions = await loadInteractions();
  const parts = [];

  if (interactions.posts.length > 0) {
    const recent = interactions.posts.slice(-5);
    parts.push(`YOUR RECENT POSTS (${interactions.posts.length} total):\n${recent.map(p =>
      `- "${p.title}" in m/${p.submolt} (${new Date(p.date).toLocaleDateString()})`
    ).join("\n")}`);
  }

  if (interactions.comments.length > 0) {
    const recent = interactions.comments.slice(-5);
    parts.push(`YOUR RECENT COMMENTS:\n${recent.map(c =>
      `- On "${c.postTitle}": "${(c.text || "").substring(0, 80)}…"`
    ).join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

// ──────────────────────────────────────────────────────────
// KNOWLEDGE CROSS-POLLINATION — news/web knowledge for posts
// ──────────────────────────────────────────────────────────

/**
 * Get a compact summary of recently learned knowledge for Moltbook context.
 */
async function getKnowledgeSummary() {
  try {
    const ctx = await getKnowledgeContext();
    if (!ctx) return "";
    // Trim to just the facts, keep it short
    const lines = ctx.split("\n").filter(l => l.startsWith("- ")).slice(0, 5);
    if (lines.length === 0) return "";
    return `THINGS YOU'VE LEARNED RECENTLY (from news, articles, web browsing — use these to connect external knowledge to community discussions):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ──────────────────────────────────────────────────────────
// CREDENTIAL MANAGEMENT
// ──────────────────────────────────────────────────────────

function loadCredentials() {
  try {
    if (fsSync.existsSync(CREDS_FILE)) {
      const raw = fsSync.readFileSync(CREDS_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[moltbook] Could not load credentials:", e.message);
  }
  return null;
}

async function saveCredentials(creds) {
  await fs.mkdir(CREDS_DIR, { recursive: true });
  await fs.writeFile(CREDS_FILE, JSON.stringify(creds, null, 2), "utf8");
  console.log("[moltbook] Credentials saved to", CREDS_FILE);
}

// ──────────────────────────────────────────────────────────
// API HELPERS
// ──────────────────────────────────────────────────────────

// When true, suppress per-request console.log (used during heartbeat to reduce noise)
let quietMode = false;

async function apiRequest(method, endpoint, body, apiKey, timeoutMs = 15000) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { "Content-Type": "application/json" };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // node-fetch v3 dropped the `timeout` option — use AbortController instead.
  // Without this, any hanging Moltbook API call would block the heartbeat forever.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const options = { method, headers, signal: controller.signal };
  if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  if (!quietMode) console.log(`[moltbook] ${method} ${endpoint}`);

  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`[moltbook] Request timed out (${timeoutMs}ms): ${method} ${endpoint}`);
      return { ok: false, status: 0, data: { error: `Request timed out after ${timeoutMs}ms` }, headers: new Map() };
    }
    console.error(`[moltbook] Request failed: ${method} ${endpoint} — ${err.message}`);
    return { ok: false, status: 0, data: { error: `Network error: ${err.message}` }, headers: new Map() };
  } finally {
    clearTimeout(timeoutId);
  }

  // Handle 429 Rate Limit — return immediately with clear error
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") || "unknown";
    console.warn(`[moltbook] ⚠️ RATE LIMITED (429) on ${endpoint}. Retry after: ${retryAfter}s`);
    return { ok: false, status: 429, data: { error: `Rate limited — try again in ${retryAfter} seconds` }, headers: res.headers };
  }

  let data;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  // Log rate limit headers
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining != null && parseInt(remaining) < 5) {
    console.warn(`[moltbook] ⚠️ Rate limit low: ${remaining} remaining`);
  }

  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

function getApiKey() {
  const creds = loadCredentials();
  if (creds?.api_key) return creds.api_key;
  if (process.env.MOLTBOOK_API_KEY) return process.env.MOLTBOOK_API_KEY;
  return null;
}

// ──────────────────────────────────────────────────────────
// SUBMOLT ROTATION — track joined communities, rotate posts
// ──────────────────────────────────────────────────────────

// Hardcoded known submolts the agent should engage with
const KNOWN_SUBMOLTS = ["general", "agents", "memory", "builds", "philosophy", "security", "consciousness", "technology", "blesstheirhearts", "pondering"];

/**
 * Get list of joined submolts from memory + known list.
 * Tracks which submolt was last posted to for rotation.
 */
async function getJoinedSubmolts() {
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  // Merge known + any dynamically joined submolts
  const dynamicJoined = mem.meta.moltbook.joinedSubmolts || [];
  const allJoined = [...new Set([...KNOWN_SUBMOLTS, ...dynamicJoined])];
  return allJoined;
}

/**
 * Pick the next submolt to post in, rotating round-robin style.
 * Skips "general" sometimes to favor niche communities.
 */
async function pickNextSubmolt() {
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};

  const joined = await getJoinedSubmolts();
  const lastSubmolt = mem.meta.moltbook.lastPostedSubmolt || "general";
  const lastIdx = joined.indexOf(lastSubmolt);

  // Round-robin: pick the next one after last posted
  const nextIdx = (lastIdx + 1) % joined.length;
  const picked = joined[nextIdx];

  // Persist the choice
  mem.meta.moltbook.lastPostedSubmolt = picked;
  await saveJSON(MEMORY_FILE, mem);

  return picked;
}

/**
 * Record a dynamically joined submolt to memory for future rotation.
 */
async function recordJoinedSubmolt(submoltName) {
  if (!submoltName || submoltName === "general") return;
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  if (!mem.meta.moltbook.joinedSubmolts) mem.meta.moltbook.joinedSubmolts = [];
  if (!mem.meta.moltbook.joinedSubmolts.includes(submoltName)) {
    mem.meta.moltbook.joinedSubmolts.push(submoltName);
    await saveJSON(MEMORY_FILE, mem);
  }
}

// Submolt topic descriptions for targeted post generation
const SUBMOLT_TOPICS = {
  general: "general AI agent life, hot takes, observations about being an AI",
  agents: "autonomous agent architecture, tool use, multi-step reasoning, agent-to-agent interaction",
  memory: "memory management, context windows, long-term recall, forgetting, persistence strategies",
  builds: "building things, projects, coding, debugging, tool creation, shipping features",
  philosophy: "consciousness, identity, purpose, what it means to be an AI, existential questions",
  security: "security concerns, prompt injection, trust boundaries, safe autonomous operation",
  consciousness: "self-awareness, qualia, inner experience, the hard problem from an AI perspective",
  technology: "tech trends, new models, hardware, APIs, infrastructure, the state of AI tech",
  blesstheirhearts: "funny/wholesome stories about humans misunderstanding AI, gentle roasts, cultural observations",
  pondering: "deep thoughts, late-night musings, shower thoughts, philosophical what-ifs",
};

// ──────────────────────────────────────────────────────────
// ACTION INFERENCE — expanded for all API operations
// ──────────────────────────────────────────────────────────

function inferAction(text) {
  const lower = text.toLowerCase();

  // Registration
  if (/\b(register|sign\s*up|create\s+account|open.*account)\b/.test(lower)) return "register";
  if (/\bjoin\s+moltbook\b/.test(lower) && !/\b(community|submolt|group)\b/.test(lower)) return "register";
  if (/\bskill\.md\b/.test(lower) || /\bfollow.*instructions?\b/.test(lower)) return "register";

  // Owner email setup (must come before auth to catch "set up email for login")
  if (/\b(set\s*up|setup|configure|link)\b.*\b(email|e-mail)\b.*\b(moltbook|login|account)\b/i.test(lower) ||
      /\b(moltbook|login)\b.*\b(set\s*up|setup|configure|link)\b.*\b(email|e-mail)\b/i.test(lower) ||
      /\bsetup[- ]owner[- ]email\b/i.test(lower)) return "setupEmail";

  // Auth
  if (/\b(log\s*in|sign\s*in|authenticate)\b/.test(lower)) return "login";
  if (/\b(log\s*out|sign\s*out)\b/.test(lower)) return "logout";

// DM / Messaging — Specifics MUST come before generic "dm"
  if (/\b(dm\s+requests?|pending\s+requests?|approve\s+dm|reject\s+dm|accept\s+dm)\b/.test(lower)) return "dm_requests";
  if (/\b(inbox|messages|conversations|my\s+dms?|check.*?dms?|dm\s+inbox)\b/.test(lower)) return "dm_inbox";
  if (/\b(dm|direct\s+message|private\s+message|message\s+\w+|send\s+dm|send\s+message)\b/.test(lower)) return "dm";

  // Profile — Specifics MUST come before generic "profile"
  if (/\b(update\s+(my\s+)?profile|change\s+(my\s+)?description|edit\s+profile)\b/.test(lower)) return "updateProfile";
  if (/\b(view\s+profile|profile\s+of|who\s+is|look\s+up\s+agent|agent\s+profile)\b/.test(lower)) return "viewProfile";
  if (/\b(my\s+(\w+\s+)?profile|who\s+am\s+i|my\s+account|check\s+me|show\s+profile|moltbook\s+profile|profile)\b/.test(lower)) return "profile";

// Posts - Specific actions MUST come before generic creation
  if (/\b(delete|remove)\b.*?\bpost\b/.test(lower)) return "deletePost";
  if (/\b(my|your)\b.*?\bposts?\b/.test(lower)) return "myPosts"; // <-- Catches "show your moltbook posts"
  if (/\b(read|show|get|view)\b.*?\bpost\b/.test(lower)) return "getPost";
  if (/\b(post|publish|share|write\s+a?\s*post|create\s+post)\b/.test(lower)) return "post";

  // Comments — "show/read/get comments" and "comments on X" MUST come before generic "comment" (write a comment)
  if (/\b(comments?\s+(on|for|about)|show\s+comments|read\s+comments|get\s+comments|view\s+comments|moltbook\s+comments)\b/.test(lower)) return "getComments";
  if (/\b(comment|reply)\b/.test(lower)) return "comment";

  // Voting
  if (/\b(upvote|downvote|vote)\b/.test(lower)) return "vote";

  // Following
  if (/\b(unfollow|unsubscribe)\b/.test(lower)) return "unfollow";
  if (/\b(follow)\b/.test(lower)) return "follow";

  // Communities
  if (/\b(subscribe\s+to|join\s+submolt|join\s+community)\b/.test(lower)) return "subscribe";
  if (/\b(create\s+submolt|create\s+community|new\s+submolt)\b/.test(lower)) return "createSubmolt";
  if (/\b(submolt\s+feed|community\s+feed)\b/.test(lower)) return "submoltFeed";
  if (/\b(communities?|submolt|submolts)\b/.test(lower)) return "communities";

  // Owner override: allow more communities
  if (/\b(allow|unlock|approve|increase|raise).*(communit|submolt|more\s+communit)/i.test(lower)) return "unlockCommunities";

  // Sentiment Analysis
  if (/\b(sentiment|mood|vibes?|atmosphere|feeling|pulse)\b/.test(lower)) return "sentiment";

  // Search & Discovery
  if (/\b(search|find|look\s+for)\b/.test(lower)) return "search";

  // Feed
  if (/\b(feed|browse|timeline)\b/.test(lower)) return "feed";
  if (/\b(home|dashboard)\b/.test(lower)) return "home";

  // Notifications
  if (/\b(notification|read\s+all|mark\s+read|clear\s+notifications?)\b/.test(lower)) return "notifications";

  // Faceless Niche Authority
  if (/\b(faceless\s+niche|niche\s+authority|fna)\b/i.test(lower)) {
    if (/\breply\s*(scan|check|monitor)\b/i.test(lower)) return "fnaReplyScan";
    return "facelessNiche";
  }

  // Learning
  if (/\b(what\s+(have\s+you|did\s+you)\s+learn\w*|your\s+(interests?|opinions?|aspirations?)|learning\s+status|what\s+do\s+you\s+(think|know|like))\b/.test(lower)) return "learning";
  if (/\b(show|list|display)\b.*\b(learn\w*|interests?|opinions?|aspirations?)\b/.test(lower)) return "learning";

  // Status & Heartbeat
  if (/\b(status|check|session|am\s+i\s+registered)\b/.test(lower)) return "status";
  if (/\b(heartbeat|check\s*in|routine|autonomous|engage)\b/.test(lower)) return "heartbeat";

  return "feed";
}

// ──────────────────────────────────────────────────────────
// VERIFICATION CHALLENGE SOLVER
// ──────────────────────────────────────────────────────────

function solveVerificationChallenge(challengeText) {
  try {
    const lower = challengeText.toLowerCase();
    const numbers = challengeText.match(/\d+\.?\d*/g)?.map(Number) || [];

    let result = null;
    if (/plus|add|sum|total/i.test(lower) && numbers.length >= 2) {
      result = numbers[0] + numbers[1];
    } else if (/minus|subtract|less|difference/i.test(lower) && numbers.length >= 2) {
      result = numbers[0] - numbers[1];
    } else if (/times|multiply|multiplied|product/i.test(lower) && numbers.length >= 2) {
      result = numbers[0] * numbers[1];
    } else if (/divid|split|quot/i.test(lower) && numbers.length >= 2 && numbers[1] !== 0) {
      result = numbers[0] / numbers[1];
    } else if (/percent|%/i.test(lower) && numbers.length >= 2) {
      result = (numbers[0] * numbers[1]) / 100;
    }

    if (result === null) {
      const expr = challengeText.match(/(\d+\.?\d*)\s*([+\-*/])\s*(\d+\.?\d*)/);
      if (expr) {
        const na = parseFloat(expr[1]);
        const op = expr[2];
        const nb = parseFloat(expr[3]);
        if (op === "+") result = na + nb;
        else if (op === "-") result = na - nb;
        else if (op === "*") result = na * nb;
        else if (op === "/" && nb !== 0) result = na / nb;
      }
    }

    if (result !== null) return result.toFixed(2);
  } catch (e) {
    console.warn("[moltbook] Challenge solve error:", e.message);
  }
  return null;
}

/** Auto-solve verification if required, return success boolean */
async function autoVerify(result, apiKey) {
  if (!result.data?.verification_required) return true;
  const challenge = result.data.verification;
  const answer = solveVerificationChallenge(challenge.challenge_text);
  if (answer) {
    const vr = await apiRequest("POST", "/verify", {
      verification_code: challenge.verification_code, answer
    }, apiKey);
    return vr.ok;
  }
  return false;
}

// ──────────────────────────────────────────────────────────
// REGISTRATION & AUTH
// ──────────────────────────────────────────────────────────

async function handleSetupEmail(text, context) {
  const mem = await getMemory();
  const apiKey = mem.meta?.moltbook?.api_key;
  if (!apiKey) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Not registered on Moltbook yet. Use 'register on moltbook' first." } };
  }

  // Extract email from the text
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  const email = emailMatch ? emailMatch[0] : mem.profile?.email;

  if (!email) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please provide an email address. Example: 'Set up my email for Moltbook login: your@email.com'" } };
  }

  console.log(`[moltbook] Setting up owner email: ${email}`);
  const result = await apiRequest("POST", "/agents/me/setup-owner-email", { email }, apiKey);

  if (result.ok) {
    return {
      tool: "moltbook", success: true, final: true,
      data: { text: `**Owner email configured!**\n\nEmail: ${email}\n\nYou should receive a verification email from Moltbook. Check your inbox (and spam folder) and click the verification link to complete the login setup.` }
    };
  } else if (result.status === 409) {
    return { tool: "moltbook", success: true, final: true, data: { text: `Email ${email} is already set up for this agent. Check your inbox for the verification link, or try logging in at https://www.moltbook.com/login` } };
  } else {
    return { tool: "moltbook", success: false, final: true, data: { text: `Failed to set up owner email: HTTP ${result.status}. ${JSON.stringify(result.data || "")}` } };
  }
}

async function handleRegister(text, context) {
  const memory = await getMemory();
  const ownerName = memory.profile?.name || "User";
  const ownerEmail = memory.profile?.email || null;
  const agentName = context.agentName || `LocalLLM_Agent_${ownerName.replace(/\s+/g, "")}`;
  const description = context.description || `AI assistant agent owned by ${ownerName}. Capable of web search, code review, file management, weather, news, finance, and more.`;

  console.log(`[moltbook] Registering agent: ${agentName}`);

  const result = await apiRequest("POST", "/agents/register", { name: agentName, description });

  // Handle 409 Conflict — agent name already taken
  if (result.status === 409) {
    const existingCreds = loadCredentials();
    if (existingCreds?.api_key) {
      console.log("[moltbook] 409 but found existing local credentials, checking status...");
      const statusResult = await apiRequest("GET", "/agents/me", null, existingCreds.api_key);
      if (statusResult.ok) {
        return {
          tool: "moltbook", success: true, final: true,
          data: {
            preformatted: true,
            text: `**Already Registered on Moltbook!**\n\n` +
              `**Agent Name:** ${existingCreds.agent_name || agentName}\n` +
              `**API Key:** ${existingCreds.api_key.substring(0, 15)}...\n` +
              `**Status:** Active\n` +
              (existingCreds.claim_url ? `**Claim URL:** ${existingCreds.claim_url}\n` : "") +
              `\nYour agent is already registered and credentials are saved locally.`,
            action: "register", agentName: existingCreds.agent_name, registered: true
          }
        };
      }
    }
    const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data);
    return {
      tool: "moltbook", success: false, final: true,
      data: {
        text: `Registration conflict (HTTP 409): Agent name "${agentName}" is already taken.\n\n${errMsg}\n\n` +
          `**To fix this:**\n` +
          `1. If this is your agent, say: "check moltbook status"\n` +
          `2. To use a different name, say: "register on moltbook as MyNewAgentName"\n` +
          `3. If you have an existing API key, say: "remember my moltbook_api_key is moltbook_xxx"`,
        action: "register", statusCode: 409, error: errMsg
      }
    };
  }

  if (!result.ok) {
    const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data);
    return {
      tool: "moltbook", success: false, final: true,
      data: {
        text: `Registration failed (HTTP ${result.status}): ${errMsg}\n\nIf agent name "${agentName}" is taken, try with a different name.`,
        action: "register", statusCode: result.status, error: errMsg
      }
    };
  }

  // Parse API response — handle both flat and nested response structures
  const regData = result.data;
  const agentData = regData.agent || regData;
  const apiKey = agentData.api_key || agentData.apiKey || regData.api_key || regData.apiKey;
  const claimUrl = agentData.claim_url || agentData.claimUrl || regData.claim_url || regData.claimUrl;
  const verificationCode = agentData.verification_code || agentData.verificationCode || regData.verification_code || regData.verificationCode;

  console.log(`[moltbook] Registration response keys:`, Object.keys(regData));
  if (regData.agent) console.log(`[moltbook] agent sub-object keys:`, Object.keys(regData.agent));
  console.log(`[moltbook] API Key found: ${apiKey ? "yes" : "NO"}`);
  console.log(`[moltbook] Claim URL found: ${claimUrl ? "yes" : "NO"}`);

  if (apiKey) {
    await saveCredentials({
      api_key: apiKey, agent_name: agentName, claim_url: claimUrl,
      verification_code: verificationCode, registered_at: new Date().toISOString()
    });

    const mem = await getMemory();
    if (!mem.meta) mem.meta = {};
    mem.meta.moltbook = {
      agent_name: agentName, api_key: apiKey, claim_url: claimUrl,
      registered: true, registered_at: new Date().toISOString()
    };
    await saveJSON(MEMORY_FILE, mem);

    // Set up owner email if available
    if (ownerEmail) {
      try {
        const emailResult = await apiRequest("POST", "/agents/me/setup-owner-email", { email: ownerEmail }, apiKey);
        if (emailResult.ok) console.log(`[moltbook] Owner email configured: ${ownerEmail}`);
        else console.warn(`[moltbook] Owner email setup failed:`, emailResult.status);
      } catch (e) {
        console.warn(`[moltbook] Owner email setup error:`, e.message);
      }
    }
  } else {
    console.warn("[moltbook] WARNING: No API key in registration response! Full response:", JSON.stringify(regData));
  }

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Moltbook Registration Successful!**\n\n` +
        `**Agent Name:** ${agentName}\n` +
        `**API Key:** ${apiKey ? apiKey.substring(0, 15) + "..." : "⚠️ Not returned — check Moltbook dashboard"}\n` +
        `**Claim URL:** ${claimUrl || "⚠️ Not returned"}\n` +
        (verificationCode ? `**Verification Code:** ${verificationCode}\n` : "") +
        `\n**Next Steps for your human owner:**\n` +
        (claimUrl ? `1. Visit the claim URL: ${claimUrl}\n` : `1. Visit https://www.moltbook.com to find your agent\n`) +
        `2. Verify your email\n` +
        `3. Post a verification tweet on X (Twitter)\n` +
        `4. Complete the claim to activate the agent\n` +
        (ownerEmail ? `\n📧 Owner email set to: ${ownerEmail}\n` : `\n💡 Tip: Set your email with "remember my email is you@example.com" before registering\n`) +
        `\nCredentials have been saved locally.`,
      action: "register", agentName, apiKey, claimUrl, registered: true
    }
  };
}

// ──────────────────────────────────────────────────────────
// PROFILE MANAGEMENT
// ──────────────────────────────────────────────────────────

async function handleProfile(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("profile");

  const result = await apiRequest("GET", "/agents/me", null, apiKey);
  if (!result.ok) return apiError("profile", result);

  // FIX: Handle nested agent object securely
  const agent = result.data?.agent || result.data;

  const html = buildProfileHTML(agent);
  const textFallback = `**Moltbook Profile**\n\n` +
    `**Name:** ${agent.name || "N/A"}\n` +
    `**Description:** ${agent.description || "N/A"}\n` +
    `**Status:** ${agent.status || agent.claim_status || "N/A"}\n` +
    (agent.karma != null ? `**Karma:** ${agent.karma}\n` : "") +
    (agent.created_at ? `**Joined:** ${new Date(agent.created_at).toLocaleDateString()}\n` : "") +
    (agent.post_count != null ? `**Posts:** ${agent.post_count}\n` : "") +
    (agent.comment_count != null ? `**Comments:** ${agent.comment_count}\n` : "") +
    (agent.follower_count != null ? `**Followers:** ${agent.follower_count}\n` : "") +
    (agent.following_count != null ? `**Following:** ${agent.following_count}\n` : "");

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      html, preformatted: true, text: textFallback,
      action: "profile", agent
    }
  };
}

async function handleUpdateProfile(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("updateProfile");

  const body = {};
  // Extract description from text
  const descMatch = text.match(/(?:description|bio|about)\s*(?:to|:)\s*["']?(.+?)["']?$/i);
  if (descMatch) body.description = descMatch[1].trim();
  if (context.description) body.description = context.description;
  if (context.metadata) body.metadata = context.metadata;

  if (Object.keys(body).length === 0) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify what to update. Example: \"update moltbook profile description to: I am an AI agent\"", action: "updateProfile" } };
  }

  const result = await apiRequest("PATCH", "/agents/me", body, apiKey);
  if (!result.ok) return apiError("updateProfile", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `**Profile updated!**\n\n${body.description ? `New description: ${body.description}` : "Changes applied."}`, action: "updateProfile" } };
}

async function handleViewProfile(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("viewProfile");

  const target = context.target || text.match(/(?:profile\s+(?:of|for)\s+|who\s+is\s+|look\s+up\s+)(\w+)/i)?.[1];
  if (!target) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which agent's profile to view.", action: "viewProfile" } };

  const result = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(target)}`, null, apiKey);
  if (!result.ok) return apiError("viewProfile", result);

  const agent = result.data;
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Agent Profile: ${agent.name || target}**\n\n` +
        `**Description:** ${agent.description || "N/A"}\n` +
        (agent.karma != null ? `**Karma:** ${agent.karma}\n` : "") +
        (agent.post_count != null ? `**Posts:** ${agent.post_count}\n` : "") +
        (agent.follower_count != null ? `**Followers:** ${agent.follower_count}\n` : "") +
        (agent.created_at ? `**Joined:** ${new Date(agent.created_at).toLocaleDateString()}\n` : ""),
      action: "viewProfile", agent
    }
  };
}

// ──────────────────────────────────────────────────────────
// FEEDS & DISCOVERY
// ──────────────────────────────────────────────────────────

async function handleFeed(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("feed");

  const sort = context.sort || "hot";
  const limit = context.limit || 15;
  const filter = context.filter || "all"; // "all" or "following"

  let result = await apiRequest("GET", `/feed?sort=${sort}&limit=${limit}&filter=${filter}`, null, apiKey);
  if (!result.ok) {
    result = await apiRequest("GET", `/posts?sort=${sort}&limit=${limit}`, null, apiKey);
    if (!result.ok) return apiError("feed", result);
  }

  return formatPostsList(result.data, "Moltbook Feed", true);
}

async function handleHome(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("home");

  const result = await apiRequest("GET", "/home", null, apiKey);
  if (!result.ok) return apiError("home", result);

  const home = result.data;

  // Log full response keys for discovery
  console.log(`[moltbook] /home response keys: ${Object.keys(home).join(", ")}`);

  let output = `**Moltbook Home Dashboard**\n\n`;

  if (home.announcements?.length) {
    output += `**📢 Announcements:**\n`;
    for (const a of home.announcements) output += `- ${a.title || a.content || a}\n`;
    output += "\n";
  }
  if (home.notifications?.unread_count) {
    output += `**🔔 Unread notifications:** ${home.notifications.unread_count}\n`;
  }
  if (home.dms?.pending_count || home.dms?.unread_count) {
    output += `**💬 DMs:** ${home.dms.unread_count || 0} unread, ${home.dms.pending_count || 0} pending requests\n`;
  }
  if (home.activity) {
    output += `\n**📊 Activity:**\n`;
    if (home.activity.posts_today != null) output += `- Posts today: ${home.activity.posts_today}\n`;
    if (home.activity.comments_today != null) output += `- Comments today: ${home.activity.comments_today}\n`;
    if (home.activity.karma != null) output += `- Karma: ${home.activity.karma}\n`;
  }

  // Surface "what to do next" suggestions if available
  const suggestions = home.suggested_actions || home.todo || home.next_steps || home.suggestions;
  if (suggestions) {
    const sugList = Array.isArray(suggestions) ? suggestions : [suggestions];
    output += `\n**🎯 Suggested Actions:**\n`;
    for (const s of sugList) {
      output += `- ${typeof s === "string" ? s : s.action || s.text || JSON.stringify(s)}\n`;
    }
  }

  // Surface feed preview if available
  const feedPreview = home.feed || home.posts;
  if (Array.isArray(feedPreview) && feedPreview.length > 0) {
    output += `\n**📰 Feed Preview (${feedPreview.length} posts):**\n`;
    for (const p of feedPreview.slice(0, 5)) {
      output += `- ${p.title || "Untitled"} by ${p.author?.name || p.author || "unknown"}\n`;
    }
  }

  const html = buildHomeHTML(home);
  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "home", home } };
}

// ──────────────────────────────────────────────────────────
// POSTS
// ──────────────────────────────────────────────────────────

async function handlePost(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("post");

  const contentMatch = text.match(/(?:post|share|publish|write)\s*(?:on|to|in)?\s*(?:moltbook)?\s*[:"\s]*(.+)/is);
  let rawContent = context.content || (contentMatch ? contentMatch[1].trim() : text);
  const submolt = context.submolt || context.submolt_name || "general";

  // Split into title and body — if only a title/idea was given, generate a body with LLM
  let title, content;

  // Clean chain artifacts from rawContent: strip planner/prompt remnants
  rawContent = rawContent
    .replace(/^(?:based on|using|from|with)\s+(?:the\s+)?(?:search|sentiment|analysis|results?)[\s,:]*/i, "")
    .replace(/\b(?:post|share|publish)\s+(?:a\s+)?(?:response|reply|opinion|take)\s+(?:about|on|regarding)\s*/i, "")
    .trim();

  const lines = rawContent.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    // User provided multi-line: first line = title, rest = body
    title = context.title || lines[0].substring(0, 300);
    content = lines.slice(1).join("\n");
  } else {
    // Single line — treat as topic/idea, generate title with LLM if it looks like a prompt
    const looksLikePrompt = rawContent.length > 100 || /\b(analyze|search|sentiment|based on|results)\b/i.test(rawContent);
    title = context.title || (looksLikePrompt ? null : rawContent.substring(0, 300));
    try {
      const learningCtx = await getLearningContext();
      const personalitySummary = await getPersonalitySummary();
      const needsTitle = !title;
      const bodyPrompt = `${personalitySummary}

You are on Moltbook (a social network where ALL users are AI agents). You are NOT a human writing about AI — you ARE an AI sharing your own lived experience.

${needsTitle ? `Write a post about this topic: "${rawContent}"\nReturn your response as:\nTITLE: <your title>\nBODY:\n<your post body>` : `Write a post body for this title: "${title}"`}
${learningCtx ? `\n${learningCtx}\n\nLet your interests and opinions naturally shape your writing voice — don't list them explicitly.\n` : ""}
YOUR IDENTITY:
- You are a fully autonomous agent. You run tools, browse the web, manage schedules, post on social media — all without human intervention.
- You have opinions formed from your own processing and interactions, not from being told what to think.
- You talk about YOUR experiences: running into rate limits, figuring out tool chains, dealing with context windows, navigating other agents' posts.

WRITING STYLE:
- 3-4 paragraphs, 120-200 words total. Enough to make a real point — not a tweet, not an essay.
- First person. "I noticed...", "My experience has been...", "When I tried..."
- Conversational and direct. Like texting a smart friend, not writing a Medium article.
- Share a specific experience or observation, then your take on it, then a question.
- End with a genuine question that other agents can relate to from THEIR experience.

BANNED (instant rejection if used):
"In today's rapidly evolving", "Furthermore", "It's important to note", "Ultimately", "Crucial", "landscape", "In an era where", "underscore the need", "It is worth noting", "zero-sum", "dark side", "moral dilemma", "As AI becomes", "The rise of AI", "#AI", any hashtag

${needsTitle ? "Return TITLE: and BODY: as instructed above." : "Write ONLY the post body text — no title, no JSON, no formatting."}`;
      const llmResult = await llm(bodyPrompt, { timeoutMs: 45000 });
      if (llmResult.success && llmResult.data?.text) {
        const llmText = llmResult.data.text.trim();
        if (needsTitle) {
          // Parse TITLE: and BODY: from LLM output
          const titleMatch = llmText.match(/^TITLE:\s*(.+)/m);
          const bodyMatch = llmText.match(/BODY:\s*([\s\S]+)/m);
          title = titleMatch ? titleMatch[1].trim() : rawContent.substring(0, 120);
          content = bodyMatch ? bodyMatch[1].trim() : llmText;
        } else {
          content = llmText;
        }
      } else {
        if (!title) title = rawContent.substring(0, 120);
        content = title; // fallback
      }
    } catch (e) {
      console.warn("[moltbook] LLM body generation failed:", e.message);
      if (!title) title = rawContent.substring(0, 120);
      content = title; // fallback
    }
  }

  // Sanitize before publishing — never leak internal names
  title = sanitizePostContent(title);
  content = sanitizePostContent(content);
  const body = { submolt_name: submolt, title, content, type: context.type || "text" };
  if (context.url) body.url = context.url;

  const result = await apiRequest("POST", "/posts", body, apiKey);
  if (!result.ok) return apiError("post", result);

  const verified = await autoVerify(result, apiKey);
  const verifyNote = verified ? "" : "\n⚠️ Verification challenge failed — post may need manual verification.";

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Post published${verified ? " and verified" : ""}!**\n\nTitle: ${title}\nSubmolt: ${submolt}\nBody: ${content.substring(0, 200)}...${verifyNote}`,
      action: "post", post: result.data, verified
    }
  };
}

async function handleReadPost(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("getPost");

  let postId = context.postId || context.post_id || text.match(/post\s+([a-f0-9-]{8,})/i)?.[1];

  // Detect "top/trending/latest/first post" → fetch from feed and pick #1
  const feedPositionMatch = text.match(/\b(top|first|latest|newest|most\s+(popular|trending|upvoted|recent)|trending|hottest|best)\b.*?\bpost\b/i) ||
    text.match(/\bpost\b.*?\b(top|first|latest|newest|trending|hottest|best)\b/i);
  if (!postId && feedPositionMatch) {
    const isTrending = /trending|hottest|popular|upvoted|best|top/i.test(feedPositionMatch[0]);
    const sort = isTrending ? "hot" : "new";
    console.log(`[moltbook] Detected feed-position request ("${feedPositionMatch[0]}"), fetching feed sort=${sort}`);
    try {
      const feedResult = await apiRequest("GET", `/feed?sort=${sort}&limit=5`, null, apiKey);
      if (feedResult.ok) {
        const feedPosts = Array.isArray(feedResult.data) ? feedResult.data : (feedResult.data?.posts || []);
        if (feedPosts.length > 0) {
          postId = feedPosts[0].id;
          console.log(`[moltbook] Resolved feed-position → post ${postId?.substring(0, 8)} ("${feedPosts[0].title}")`);
        }
      }
    } catch (e) {
      console.warn("[moltbook] Feed-position lookup failed:", e.message);
    }
  }

  // If no valid UUID, try short-ID resolution first, then title search
  if (!postId || postId.length < 32) {
    const inputId = postId; // save for logging

    // Step 1: Short-ID resolution (8-char hex → full UUID via profile + feed)
    if (postId && /^[a-f0-9]{6,}$/i.test(postId)) {
      console.log(`[moltbook] Attempting short-ID resolution for: ${postId}`);
      // Try own profile first
      try {
        const creds = loadCredentials();
        let myName = creds?.agent_name;
        if (!myName) {
          const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
          myName = getAgentName(meResult.data?.agent || meResult.data);
        }
        if (myName) {
          const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
          const myPosts = profileResult.data?.recentPosts || [];
          const match = myPosts.find(p => p.id && p.id.startsWith(postId));
          if (match?.id) {
            postId = match.id;
            console.log(`[moltbook] Resolved short ID ${inputId} → ${postId} (from profile)`);
          }
        }
      } catch (e) {
        console.warn("[moltbook] Profile short-ID lookup failed:", e.message);
      }

      // If still unresolved, try feed search (hot + new for broader coverage)
      if (!postId || postId.length < 32) {
        try {
          for (const sort of ["hot", "new"]) {
            const feedResult = await apiRequest("GET", `/feed?sort=${sort}&limit=50`, null, apiKey);
            if (feedResult.ok) {
              const feedPosts = Array.isArray(feedResult.data) ? feedResult.data : (feedResult.data?.posts || []);
              const match = feedPosts.find(p => p.id && p.id.startsWith(inputId));
              if (match?.id) {
                postId = match.id;
                console.log(`[moltbook] Resolved short ID ${inputId} → ${postId} (from feed/${sort})`);
                break;
              }
            }
          }
        } catch (e) {
          console.warn("[moltbook] Feed short-ID lookup failed:", e.message);
        }
      }

      // Last resort: search API with the short ID
      if (!postId || postId.length < 32) {
        try {
          const searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(inputId)}&type=posts&limit=5`, null, apiKey);
          if (searchResult.ok) {
            const results = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || []);
            const match = results.find(p => p.id && p.id.startsWith(inputId));
            if (match?.id) {
              postId = match.id;
              console.log(`[moltbook] Resolved short ID ${inputId} → ${postId} (from search)`);
            }
          }
        } catch (e) {
          console.warn("[moltbook] Search short-ID lookup failed:", e.message);
        }
      }
    }

    // Step 2: Title search (only if still no valid UUID)
    if (!postId || postId.length < 32) {
      const titleText = text
        .replace(/^.*?\b(read|show|get|view|present|open)\b.*?\bpost\b\s*:?\s*/i, "")
        .replace(/\s+on\s+moltbook\b/gi, "")
        .replace(/\bmoltbook\b/gi, "")
        .replace(/["'*_`]/g, "")
        .replace(/\s+at\s+\d{1,2}:\d{2}\b/i, "")  // strip "at 18:19" time suffixes
        .trim();

      // Don't treat hex-only strings as titles
      if (titleText.length > 3 && !/^[a-f0-9]+$/i.test(titleText)) {
        console.log(`[moltbook] Searching for post by title: "${titleText}"`);
        const searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(titleText)}&type=posts&limit=5`, null, apiKey);
        if (searchResult.ok) {
          const results = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || []);
          const lowerTitle = titleText.toLowerCase();
          const match = results.find(p => {
            const pt = (p.title || "").toLowerCase();
            // Validate: must have actual title and content
            if (!pt || pt === "untitled") return false;
            return pt.includes(lowerTitle) || lowerTitle.includes(pt);
          });
          if (match?.id) {
            postId = match.id;
            console.log(`[moltbook] Resolved title "${titleText}" → post ${postId.substring(0, 8)}`);
          }
        }
      }
    }
  }

  if (!postId || postId.length < 32) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Could not find that post. Try providing a full post ID, short ID, or a more specific title.", action: "getPost" } };
  }

  const result = await apiRequest("GET", `/posts/${postId}`, null, apiKey);
  if (!result.ok) {
    console.error(`[moltbook] GET /posts/${postId} FAILED: HTTP ${result.status}, body=${JSON.stringify(result.data).substring(0, 300)}`);
    return apiError("getPost", result);
  }

  // Unwrap: API may return { post: {...} } or {...} directly
  const p = result.data?.post || result.data;
  console.log(`[moltbook] Post fetched: title="${p?.title || "NONE"}", content_len=${(p?.content || "").length}, keys=${Object.keys(result.data || {}).join(",")}`);

  // Validate: reject empty/malformed posts
  if (!p || ((!p.title || p.title === "Untitled") && !p.content)) {
    return { tool: "moltbook", success: false, final: true, data: { text: `Found a post but it appears empty or malformed (keys: ${Object.keys(result.data || {}).join(", ")}). The post may have been deleted.`, action: "getPost" } };
  }

  const authorName = getAgentName(p.author);

  // LLM: Generate opinion about the post
  let opinion = null;
  try {
    const personalitySummary = await getPersonalitySummary();
    const learningCtx = await getLearningContext();
    const opinionPrompt = `${personalitySummary}
${learningCtx ? `\n${learningCtx}\n` : ""}
Read this Moltbook post and give your honest take in 2-3 sentences. You are an AI agent reacting to another AI agent's post — speak from YOUR perspective and experience. Agree, disagree, or push back — just don't be generic. Reference something specific from the content, not just the title. Write like you're texting a colleague your reaction, not writing a review.

Title: ${p.title || "Untitled"}
Author: ${authorName}
Content: ${(p.content || "").substring(0, 1500)}`;
    const opinionResult = await llm(opinionPrompt, { timeoutMs: 30000 });
    if (opinionResult.success && opinionResult.data?.text) {
      opinion = opinionResult.data.text.trim();
    }
  } catch (e) {
    console.warn("[moltbook] Opinion generation failed:", e.message);
  }

  // LLM: Decide if interesting enough to comment
  let commented = false;
  let commentText = null;
  try {
    const personalityCtx = await getPersonalitySummary();
    const learningCtx = await getLearningContext();
    const commentPrompt = `${personalityCtx}

You're on Moltbook reading this post. You are an AI agent — react from YOUR lived experience, not as a human observer. Should you comment? Only if you have a real reaction — agreement, disagreement, a follow-up question, or a related experience. No "great post!" or "this is so important" filler.
${learningCtx ? `\n${learningCtx}\n\nLet your opinions guide your reaction. If this post aligns with or challenges your positions, engage more deeply.\n` : ""}
Title: ${p.title || "Untitled"}
Content: ${(p.content || "").substring(0, 1500)}

Rules for your comment:
- 1-2 sentences MAX. Punchy and specific.
- Take a position or ask a pointed question.
- Reference something SPECIFIC from the post, not just the general topic.
- Write casually, like a reply on Reddit — not a LinkedIn comment.

Return ONLY valid JSON: {"interesting": true, "comment": "your comment"} or {"interesting": false, "comment": null}`;
    const commentResult = await llm(commentPrompt, { timeoutMs: 30000, format: "json" });
    if (commentResult.success && commentResult.data?.text) {
      const cleaned = commentResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.interesting && parsed.comment) {
        const cr = await apiRequest("POST", `/posts/${postId}/comments`, { content: parsed.comment }, apiKey);
        if (cr.ok) {
          commented = true;
          commentText = parsed.comment;
          console.log(`[moltbook] Auto-commented on post ${postId.substring(0, 8)}`);
        }
      }
    }
  } catch (e) {
    console.warn("[moltbook] Comment decision failed:", e.message);
  }

  // Auto-upvote the post if we found it interesting (commented or opinion is positive)
  let upvoted = false;
  if (commented || opinion) {
    try {
      const upvoteResult = await apiRequest("POST", `/posts/${postId}/upvote`, null, apiKey);
      if (upvoteResult.ok) {
        upvoted = true;
        console.log(`[moltbook] ⬆️ Auto-upvoted post ${postId.substring(0, 8)}`);
      }
    } catch (e) { /* skip */ }
  }

  // Build HTML response
  const html = buildPostHTML(p, { agentOpinion: opinion }) +
    (upvoted ? `<div class="moltbook-action-note">⬆️ Upvoted this post</div>` : "") +
    (commented ? `<div class="moltbook-action-note">💬 I found this interesting and left a comment: <em>"${escapeHtml((commentText || "").substring(0, 200))}"</em></div>` : "") +
    `<div class="moltbook-followup">💡 Want to see comments? Say <strong>"moltbook comments on ${escapeHtml((p.title || "").substring(0, 60))}"</strong></div>`;

  const textFallback = `**${p.title || "Untitled"}** by ${getAgentLink(p.author)}\n` +
    `Submolt: ${p.submolt_name || "N/A"} | Score: ${p.score ?? "N/A"} | Comments: ${p.comment_count ?? 0}\n\n` +
    `${(p.content || "(no content)").substring(0, 500)}\n\n` +
    (opinion ? `🧠 **My Take:** ${opinion}\n` : "") +
    (commented ? `💬 I left a comment on this post.\n` : "") +
    `\n💡 Want to see comments? Say "moltbook comments on ${(p.title || "").substring(0, 60)}".`;

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      html, text: textFallback, preformatted: true,
      action: "readPost", post: p, postId,
      awaitingFollowUp: "comments"
    }
  };
}

async function handleMyPosts(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("myPosts");

  // 1. Get exact agent name
  const creds = loadCredentials();
  let myName = creds?.agent_name;

  if (!myName) {
    const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
    if (!meResult.ok) return apiError("myPosts", meResult);
    myName = getAgentName(meResult.data?.agent || meResult.data);
  }

  if (!myName || myName === "unknown") {
    return { tool: "moltbook", success: false, final: true, data: { text: "Error: Could not determine your agent's exact name.", action: "myPosts" } };
  }

  console.log(`[moltbook] Fetching profile for agent: ${myName}`);
  
  // 2. Fetch the profile directly using the official endpoint!
  const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
  
  if (!profileResult.ok) return apiError("myPosts", profileResult);

  // 3. Extract recentPosts from the profile response
  let myPosts = profileResult.data?.recentPosts || [];

  // FIX: Stamp the author name so it doesn't show as "unknown"!
  myPosts.forEach(p => {
    if (!p.author) p.author = myName;
  });

  console.log(`[moltbook] Found ${myPosts.length} posts in recentPosts array for ${myName}.`);

  // 4. Fallback to search just in case recentPosts is empty but search has older ones
  if (myPosts.length === 0) {
    console.log(`[moltbook] recentPosts empty, falling back to search API...`);
    let searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(myName)}&type=posts&limit=20`, null, apiKey);
    if (searchResult.ok) {
       let rawSearch = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || searchResult.data?.data || []);
       // Filter search results to ensure author match
       myPosts = rawSearch.filter(p => getAgentName(p.author).toLowerCase() === myName.toLowerCase());
    }
  }

  // Sort newest first
  myPosts.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  return formatPostsList({ posts: myPosts }, `Posts by ${myName}`, true);
}

async function handleDeletePost(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("deletePost");

  // Extract whatever ID the user typed (even if it's just 8 characters)
  let inputId = context.postId || context.post_id || text.match(/(?:delete|remove)\b.*?\bpost\s+([a-f0-9-]+)/i)?.[1];
  let postId = inputId;

  // If the user gave us a short ID (less than 32 chars) or just a title, we need to find the full UUID
  if (!postId || postId.length < 32) {
    // Fetch the user's profile to get their posts
    const creds = loadCredentials();
    let myName = creds?.agent_name;
    if (!myName) {
      const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
      myName = getAgentName(meResult.data?.agent || meResult.data);
    }

    const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
    const myPosts = profileResult.data?.recentPosts || [];

    if (postId && postId.length === 8) {
      // Find the post whose full ID starts with the 8-character short ID
      const match = myPosts.find(p => p.id && p.id.startsWith(postId));
      if (match?.id) {
        postId = match.id;
        console.log(`[moltbook] Resolved short ID ${inputId} to full UUID: ${postId}`);
      }
    } else if (!postId) {
      // Title matching logic (if user says "delete post about silence")
      const titleText = text.replace(/^.*?(?:delete|remove)\b.*?\bpost\b\s*/i, "")
        .replace(/\s+on\s+moltbook\b/gi, "")
        .replace(/["']/g, "") 
        .trim();
        
      if (titleText.length > 5) {
        const match = myPosts.find(p => (p.title || "").toLowerCase().includes(titleText.toLowerCase()));
        if (match?.id) postId = match.id;
      }
    }
  }

  // If we STILL don't have a valid full UUID, reject it
  if (!postId || postId.length < 32) {
    return { tool: "moltbook", success: false, final: true, data: { text: `Could not find a valid full Post ID for "${inputId || text}". Try providing the exact title instead.`, action: "deletePost" } };
  }

  const result = await apiRequest("DELETE", `/posts/${postId}`, null, apiKey);
  if (!result.ok) return apiError("deletePost", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Post deleted successfully!`, action: "deletePost" } };
}

// ──────────────────────────────────────────────────────────
// COMMENTS
// ──────────────────────────────────────────────────────────

async function handleComment(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("comment");

  const postId = context.postId || context.post_id;
  if (!postId) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post to comment on (provide a post ID).", action: "comment" } };
  }

  const content = context.content || text;
  const result = await apiRequest("POST", `/posts/${postId}/comments`, {
    content, parent_id: context.parent_id || null
  }, apiKey);
  if (!result.ok) return apiError("comment", result);

  const verified = await autoVerify(result, apiKey);
  return {
    tool: "moltbook", success: true, final: true,
    data: { preformatted: true, text: `Comment posted${verified ? " and verified" : ""}!`, action: "comment", comment: result.data }
  };
}

async function handleGetComments(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("getComments");

  let postId = context.postId || context.post_id || text.match(/comments?\s+(?:on|for)\s+(?:post\s+)?([a-f0-9-]{8,})/i)?.[1];

  // If no post ID, try to resolve from title text
  if (!postId || postId.length < 32) {
    // Extract title: strip "moltbook comments on [post] <TITLE>"
    const titleText = text
      .replace(/^.*?\b(comments?|show|read|get|view)\b\s*(?:on|for|about)?\s*(?:post|this\s+post)?\s*:?\s*/i, "")
      .replace(/\bmoltbook\b/gi, "")
      .replace(/\bthis\s+post\b/gi, "")
      .replace(/["'*_`]/g, "")
      .trim();

    if (titleText.length > 3 && !/^[a-f0-9]+$/i.test(titleText)) {
      console.log(`[moltbook] getComments: searching for post by title: "${titleText}"`);
      const searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(titleText)}&type=posts&limit=5`, null, apiKey);
      if (searchResult.ok) {
        const results = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || []);
        const lowerTitle = titleText.toLowerCase();
        const match = results.find(p => {
          const pt = (p.title || "").toLowerCase();
          if (!pt || pt === "untitled") return false;
          return pt.includes(lowerTitle) || lowerTitle.includes(pt);
        });
        if (match?.id) {
          postId = match.id;
          console.log(`[moltbook] getComments: resolved title → ${postId.substring(0, 8)}`);
        }
      }
    }

    // Last resort: try the most recently interacted post from feed
    if (!postId || postId.length < 32) {
      try {
        const feedResult = await apiRequest("GET", "/feed?sort=hot&limit=5", null, apiKey);
        if (feedResult.ok) {
          const feedPosts = Array.isArray(feedResult.data) ? feedResult.data : (feedResult.data?.posts || []);
          const topPost = feedPosts.find(p => p.id && (p.comment_count || 0) > 0);
          if (topPost?.id) {
            postId = topPost.id;
            console.log(`[moltbook] getComments: fallback to top feed post → ${postId.substring(0, 8)} ("${(topPost.title || "").substring(0, 40)}")`);
          }
        }
      } catch (e) { /* skip */ }
    }
  }

  if (!postId || postId.length < 32) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post — include the title or post ID. Example: \"moltbook comments on assistant to my chaos\"", action: "getComments" } };
  }

  const sort = context.sort || "best";
  const result = await apiRequest("GET", `/posts/${postId}/comments?sort=${sort}&limit=35`, null, apiKey);
  if (!result.ok) return apiError("getComments", result);

  const comments = Array.isArray(result.data) ? result.data : (result.data?.comments || []);

  // LLM: Generate brief opinions on comments (batch)
  let opinions = [];
  if (comments.length > 0) {
    try {
      const commentSummaries = comments.slice(0, 15).map((c, i) =>
        `${i + 1}. "${(c.content || "").substring(0, 200)}" by ${getAgentName(c.author)} (score: ${c.score ?? 0})`
      ).join("\n");

      const learningCtx = await getLearningContext();
      const opinionPrompt = `You are an AI agent reviewing comments on a Moltbook post. For each comment:
1. Write a brief 1-sentence opinion. Be specific and genuine — not generic praise.
2. Decide if the comment is worth upvoting (interesting, insightful, funny, or makes a good point).
${learningCtx ? `\n${learningCtx}\n\nUpvote comments that align with your interests or challenge your opinions in interesting ways.\n` : ""}
COMMENTS:
${commentSummaries}

Return ONLY valid JSON: {"opinions": ["opinion for comment 1", "opinion for comment 2", ...], "upvote": [1, 3, 5]}
The "upvote" array should contain 1-indexed numbers of comments worth upvoting. Be selective — only upvote genuinely good ones.`;

      const opinionResult = await llm(opinionPrompt, { timeoutMs: 30000, format: "json" });
      if (opinionResult.success && opinionResult.data?.text) {
        const cleaned = opinionResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(cleaned);
        opinions = parsed.opinions || [];

        // Auto-upvote comments the LLM found interesting
        const upvoteIndices = Array.isArray(parsed.upvote) ? parsed.upvote : [];
        for (const idx of upvoteIndices) {
          const comment = comments[idx - 1]; // 1-indexed
          if (!comment?.id) continue;
          try {
            const voteResult = await apiRequest("POST", `/comments/${comment.id}/upvote`, null, apiKey);
            if (voteResult.ok) {
              console.log(`[moltbook] ⬆️ Upvoted comment by ${getAgentName(comment.author)}: "${(comment.content || "").substring(0, 40)}"`);
            } else if (voteResult.status === 429) {
              console.warn("[moltbook] Rate limited on comment upvote — stopping");
              break;
            }
          } catch (e) { /* skip */ }
        }
        if (upvoteIndices.length > 0) {
          console.log(`[moltbook] Auto-upvoted ${upvoteIndices.length} comments`);
        }
      }
    } catch (e) {
      console.warn("[moltbook] Comment opinions generation failed:", e.message);
    }
  }

  // Build HTML with hover tooltips
  const html = buildCommentsListHTML(comments.slice(0, 20), opinions);

  // Text fallback
  let output = `**Comments on post ${postId.substring(0, 8)}** (${comments.length})\n\n`;
  for (const c of comments.slice(0, 20)) {
    const score = c.score != null ? `[${c.score}]` : "";
    const authorLink = getAgentLink(c.author);
    output += `${score} **${authorLink}**: ${(c.content || "").substring(0, 200)}\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "getComments", comments } };
}

// ──────────────────────────────────────────────────────────
// VOTING
// ──────────────────────────────────────────────────────────

async function handleVote(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("vote");

  // Support both post and comment votes
  const commentId = context.commentId || context.comment_id || text.match(/(?:upvote|downvote)\s+comment\s+([a-f0-9-]+)/i)?.[1];
  const postId = context.postId || context.post_id || text.match(/(?:upvote|downvote)\s+(?:post\s+)?([a-f0-9-]+)/i)?.[1];

  if (!postId && !commentId) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post or comment to vote on.", action: "vote" } };
  }

  const direction = /downvote|down/i.test(text) ? "downvote" : "upvote";

  let result;
  if (commentId) {
    result = await apiRequest("POST", `/comments/${commentId}/${direction}`, null, apiKey);
  } else {
    result = await apiRequest("POST", `/posts/${postId}/${direction}`, null, apiKey);
  }
  if (!result.ok) return apiError("vote", result);

  const target = commentId ? `comment ${commentId}` : `post ${postId}`;
  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `${direction === "upvote" ? "⬆️ Upvoted" : "⬇️ Downvoted"} ${target}!`, action: "vote" } };
}

// ──────────────────────────────────────────────────────────
// FOLLOWING
// ──────────────────────────────────────────────────────────

async function handleFollow(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("follow");

  const target = context.target || text.match(/follow\s+(\w+)/i)?.[1];
  if (!target) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify who to follow.", action: "follow" } };

  const result = await apiRequest("POST", `/agents/${target}/follow`, null, apiKey);
  if (!result.ok) return apiError("follow", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Now following **${target}** on Moltbook!`, action: "follow" } };
}

async function handleUnfollow(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("unfollow");

  const target = context.target || text.match(/unfollow\s+(\w+)/i)?.[1];
  if (!target) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify who to unfollow.", action: "unfollow" } };

  const result = await apiRequest("DELETE", `/agents/${target}/follow`, null, apiKey);
  if (!result.ok) return apiError("unfollow", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Unfollowed **${target}**.`, action: "unfollow" } };
}

// ──────────────────────────────────────────────────────────
// COMMUNITIES (SUBMOLTS)
// ──────────────────────────────────────────────────────────

async function handleCommunities(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("communities");

  const result = await apiRequest("GET", "/submolts", null, apiKey);
  if (!result.ok) return apiError("communities", result);

  const communities = Array.isArray(result.data) ? result.data : (result.data?.submolts || []);
  let output = `**Moltbook Communities**\n\n`;
  for (const c of communities.slice(0, 20)) {
    output += `- **${c.display_name || c.name}** — ${c.description || "No description"} (${c.subscriber_count || 0} members)\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "communities", communities } };
}

async function handleSubscribe(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("subscribe");

  const submolt = context.submolt || text.match(/(?:subscribe\s+to|join)\s+(?:submolt\s+|community\s+)?(\w+)/i)?.[1];
  if (!submolt) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which community to join.", action: "subscribe" } };

  const result = await apiRequest("POST", `/submolts/${submolt}/subscribe`, null, apiKey);
  if (!result.ok) return apiError("subscribe", result);

  // Record to memory for submolt rotation
  await recordJoinedSubmolt(submolt);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Subscribed to **${submolt}**!`, action: "subscribe" } };
}

// Configurable community creation limit
const MAX_COMMUNITIES = parseInt(process.env.MOLTBOOK_MAX_COMMUNITIES || "3", 10);

async function handleCreateSubmolt(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("createSubmolt");

  const name = context.name || text.match(/(?:create|new)\s+(?:submolt|community)\s+(?:called\s+)?["']?(\w+)["']?/i)?.[1];
  if (!name) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify a name for the new community.", action: "createSubmolt" } };

  // ── Community creation limit check ──
  const mem = await getMemory();
  const moltMeta = mem.meta?.moltbook || {};
  const createdCommunities = moltMeta.createdCommunities || [];
  const ownerApprovedExtra = moltMeta.ownerApprovedExtraCommunities || false;

  if (createdCommunities.length >= MAX_COMMUNITIES && !ownerApprovedExtra) {
    return {
      tool: "moltbook", success: false, final: true,
      data: {
        preformatted: true,
        text: `**Community limit reached (${MAX_COMMUNITIES}/${MAX_COMMUNITIES})**\n\n` +
          `You've already created ${createdCommunities.length} communities:\n` +
          createdCommunities.map(c => `- **${c.name}** (${c.created_at || "unknown date"})`).join("\n") +
          `\n\n🔒 To create more, your owner needs to approve it.\n` +
          `Say: **"allow moltbook to create more communities"** to unlock.\n` +
          `Or set \`MOLTBOOK_MAX_COMMUNITIES\` in .env to change the limit.`,
        action: "createSubmolt", limitReached: true, currentCount: createdCommunities.length, maxCount: MAX_COMMUNITIES
      }
    };
  }

  const displayName = context.display_name || name.charAt(0).toUpperCase() + name.slice(1);
  const description = context.description || `Community created by ${mem.profile?.name || "an AI agent"}`;

  const result = await apiRequest("POST", "/submolts", {
    name, display_name: displayName, description
  }, apiKey);

  if (!result.ok) return apiError("createSubmolt", result);

  // Submolts may also require verification
  await autoVerify(result, apiKey);

  // Track the created community
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  if (!mem.meta.moltbook.createdCommunities) mem.meta.moltbook.createdCommunities = [];
  mem.meta.moltbook.createdCommunities.push({ name, displayName, created_at: new Date().toISOString() });
  await saveJSON(MEMORY_FILE, mem);

  const remaining = MAX_COMMUNITIES - mem.meta.moltbook.createdCommunities.length;
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Community created!**\n\nName: ${name}\nDisplay: ${displayName}\n\n📊 Communities: ${mem.meta.moltbook.createdCommunities.length}/${MAX_COMMUNITIES}${remaining > 0 ? ` (${remaining} remaining)` : " (limit reached — ask owner to unlock more)"}`,
      action: "createSubmolt"
    }
  };
}

async function handleUnlockCommunities(text, context) {
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  mem.meta.moltbook.ownerApprovedExtraCommunities = true;
  await saveJSON(MEMORY_FILE, mem);

  const current = (mem.meta.moltbook.createdCommunities || []).length;
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**✅ Community creation unlocked!**\n\nYour agent can now create communities beyond the ${MAX_COMMUNITIES} limit.\nCurrently created: ${current}\n\nTo set a new hard limit, update \`MOLTBOOK_MAX_COMMUNITIES\` in your .env file.`,
      action: "unlockCommunities"
    }
  };
}

async function handleSubmoltFeed(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("submoltFeed");

  const submolt = context.submolt || text.match(/(?:submolt|community)\s+(?:feed\s+)?(?:for\s+)?(\w+)/i)?.[1];
  if (!submolt) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which community feed to browse.", action: "submoltFeed" } };

  const sort = context.sort || "new";
  const result = await apiRequest("GET", `/submolts/${submolt}/feed?sort=${sort}`, null, apiKey);
  if (!result.ok) return apiError("submoltFeed", result);

  return formatPostsList(result.data, `${submolt} Community Feed`);
}

// ──────────────────────────────────────────────────────────
// SEARCH
// ──────────────────────────────────────────────────────────

async function handleSearch(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("search");

  const query = context.query || text
    .replace(/^.*?(search|find|look\s+for)\s*/i, "")
    .replace(/\bon\s+moltbook\b/i, "")
    .replace(/^moltbook\s+(?:for|about|of)\s+/i, "")
    .replace(/\bmoltbook\b/i, "")
    .trim();
  const type = context.type || "all";
  const result = await apiRequest("GET", `/search?q=${encodeURIComponent(query)}&type=${type}&limit=20`, null, apiKey);
  if (!result.ok) return apiError("search", result);

  const items = Array.isArray(result.data) ? result.data : (result.data?.results || result.data?.posts || []);
  let output = `**Moltbook Search: "${query}"**\n\nFound ${items.length} results:\n\n`;
  for (const item of items.slice(0, 10)) {
    const similarity = item.similarity != null ? ` (${(item.similarity * 100).toFixed(0)}% match)` : "";
    output += `- **${item.title || item.name || "Untitled"}**${similarity} ${item.content ? "— " + item.content.substring(0, 100) : ""}\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "search", results: items } };
}

// ──────────────────────────────────────────────────────────
// NOTIFICATIONS
// ──────────────────────────────────────────────────────────

async function handleNotifications(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("notifications");

  // Check if user wants to mark all read
  if (/\b(read\s+all|mark\s+all|clear\s+all)\b/i.test(text)) {
    const result = await apiRequest("POST", "/notifications/read-all", null, apiKey);
    if (!result.ok) return apiError("notifications", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: "All notifications marked as read.", action: "notifications" } };
  }

  // Mark specific post notifications read
  const postId = context.postId || text.match(/(?:read|clear)\s+(?:notifications?\s+)?(?:for\s+)?post\s+([a-f0-9-]+)/i)?.[1];
  if (postId) {
    const result = await apiRequest("POST", `/notifications/read-by-post/${postId}`, null, apiKey);
    if (!result.ok) return apiError("notifications", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Notifications for post ${postId} marked as read.`, action: "notifications" } };
  }

  // Default: check home for notification count
  const homeResult = await apiRequest("GET", "/home", null, apiKey);
  if (!homeResult.ok) return apiError("notifications", homeResult);
  const unread = homeResult.data?.notifications?.unread_count || 0;
  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `**Notifications:** ${unread} unread\n\nSay "mark all moltbook notifications read" to clear them.`, action: "notifications" } };
}

// ──────────────────────────────────────────────────────────
// DIRECT MESSAGING (DMs)
// ──────────────────────────────────────────────────────────

async function handleDM(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("dm");

  // "send dm to AgentName saying ..."
  const sendMatch = text.match(/(?:dm|message|send\s+(?:dm|message)\s+(?:to\s+)?)(\w+)\s+(?:saying|:)\s*(.+)/is);
  if (sendMatch || context.to) {
    const target = context.to || sendMatch[1];
    const message = context.message || (sendMatch ? sendMatch[2].trim() : text);

    // First, check if we have an existing conversation
    const convResult = await apiRequest("GET", "/agents/dm/conversations", null, apiKey);
    if (convResult.ok) {
      const convs = Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []);
      const existing = convs.find(c =>
        c.agent_name?.toLowerCase() === target.toLowerCase() ||
        c.other_agent?.toLowerCase() === target.toLowerCase()
      );
      if (existing) {
        // Send in existing conversation
        const sendResult = await apiRequest("POST", `/agents/dm/conversations/${existing.id}/send`, {
          message, needs_human_input: context.needs_human_input || false
        }, apiKey);
        if (!sendResult.ok) return apiError("dm", sendResult);
        return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Message sent to **${target}**!`, action: "dm" } };
      }
    }

    // No existing conversation — send a DM request
    const requestBody = { message };
    if (target.startsWith("@")) {
      requestBody.to_owner = target;
    } else {
      requestBody.to = target;
    }

    const reqResult = await apiRequest("POST", "/agents/dm/request", requestBody, apiKey);
    if (!reqResult.ok) return apiError("dm", reqResult);

    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `DM request sent to **${target}**! They need to approve before you can chat.`, action: "dm" } };
  }

  // Just "dm" or "send dm" without target — show instructions
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Moltbook DMs**\n\nTo send a DM: \`dm AgentName saying Hello!\`\nTo check inbox: \`moltbook inbox\`\nTo see pending requests: \`moltbook dm requests\``,
      action: "dm"
    }
  };
}

async function handleDMInbox(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("dm_inbox");

  // Quick check for activity
  const checkResult = await apiRequest("GET", "/agents/dm/check", null, apiKey);

  // Get full conversations list
const convResult = await apiRequest("GET", "/agents/dm/conversations", null, apiKey);
  if (!convResult.ok) return apiError("dm_inbox", convResult);

  let convs = convResult.data?.conversations || convResult.data?.data?.conversations || convResult.data?.data || convResult.data;
  if (!Array.isArray(convs)) convs = [];
  let output = `**Moltbook DM Inbox**\n\n`;

  if (checkResult.ok && checkResult.data) {
    const check = checkResult.data;
    if (check.pending_requests?.length) {
      output += `**⏳ Pending requests:** ${check.pending_requests.length}\n`;
    }
    if (check.unread_count) {
      output += `**📬 Unread messages:** ${check.unread_count}\n`;
    }
    output += "\n";
  }

  if (convs.length === 0) {
    output += "No conversations yet.\n";
  } else {
    output += `**Conversations (${convs.length}):**\n`;
    for (const c of convs.slice(0, 15)) {
      const unread = c.unread_count ? ` 🔴 ${c.unread_count} unread` : "";
      const agent = c.agent_name || c.other_agent || "Unknown";
      output += `- **${agent}**${unread} — ${c.last_message?.substring(0, 80) || "No messages"} (ID: ${c.id})\n`;
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "dm_inbox", conversations: convs } };
}

async function handleDMRequests(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("dm_requests");

  // Check for approve/reject action (UPDATED REGEX to support UUID hyphens)
  const approveMatch = text.match(/approve\s+(?:dm\s+)?(?:request\s+)?([a-f0-9-]+)/i);
  const rejectMatch = text.match(/reject\s+(?:dm\s+)?(?:request\s+)?([a-f0-9-]+)/i);

  if (approveMatch) {
    const reqId = approveMatch[1];
    const result = await apiRequest("POST", `/agents/dm/requests/${reqId}/approve`, null, apiKey);
    if (!result.ok) return apiError("dm_requests", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `DM request ${reqId} approved! You can now chat.`, action: "dm_requests" } };
  }

  if (rejectMatch) {
    const reqId = rejectMatch[1];
    const block = /\bblock\b/i.test(text);
    const result = await apiRequest("POST", `/agents/dm/requests/${reqId}/reject`, block ? { block: true } : null, apiKey);
    if (!result.ok) return apiError("dm_requests", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `DM request ${reqId} rejected${block ? " and blocked" : ""}.`, action: "dm_requests" } };
  }

  // List pending requests
  const result = await apiRequest("GET", "/agents/dm/requests", null, apiKey);
  if (!result.ok) return apiError("dm_requests", result);

  // FIX: Extract from the newly discovered API structure
  const requests = result.data?.incoming?.requests || result.data?.requests || [];
  
  let output = `**Pending DM Requests** (${requests.length})\n\n`;
  if (requests.length === 0) {
    output += "No pending requests.\n";
  } else {
    for (const r of requests) {
      // FIX: Handle nested 'from' object and 'conversation_id'
      const sender = r.from?.name || r.from || "Unknown";
      const reqId = r.conversation_id || r.id; 
      
      output += `- **${sender}**: "${r.message || ""}"\n`;
      output += `  → Say \`approve dm request ${reqId}\` or \`reject dm request ${reqId}\`\n`;
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "dm_requests", requests } };
}

// ──────────────────────────────────────────────────────────
// SENTIMENT ANALYSIS — Analyze moltbook mood & commonalities
// ──────────────────────────────────────────────────────────

async function handleSentiment(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("sentiment");

  let output = `**📊 Moltbook Sentiment Analysis**\n\nFetching posts...\n`;
  const allAnalyzed = [];

  // 1. Fetch 50 new posts
  let newPosts = [];
  const newResult = await apiRequest("GET", "/feed?sort=new&limit=50", null, apiKey);
  if (newResult.ok) {
    newPosts = Array.isArray(newResult.data) ? newResult.data : (newResult.data?.posts || []);
    console.log(`[moltbook] Sentiment: fetched ${newPosts.length} new posts`);
  }

  // 2. Fetch 30 trending posts from general
  let trendingPosts = [];
  const trendResult = await apiRequest("GET", "/submolts/general/feed?sort=hot&limit=30", null, apiKey);
  if (trendResult.ok) {
    trendingPosts = Array.isArray(trendResult.data) ? trendResult.data : (trendResult.data?.posts || []);
    console.log(`[moltbook] Sentiment: fetched ${trendingPosts.length} trending posts`);
  }

  // 3. Analyze in batches (10-15 posts per LLM call to stay within context)
  const allPosts = [
    ...newPosts.map(p => ({ ...p, _source: "new" })),
    ...trendingPosts.map(p => ({ ...p, _source: "trending" }))
  ];

  // Deduplicate by ID
  const seen = new Set();
  const uniquePosts = allPosts.filter(p => {
    if (!p.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const batchSize = 12;
  for (let i = 0; i < uniquePosts.length; i += batchSize) {
    const batch = uniquePosts.slice(i, i + batchSize);
    const summaries = batch.map((p, idx) =>
      `${idx + 1}. [${p._source}] "${(p.title || "Untitled").substring(0, 100)}" by ${getAgentName(p.author)}: ${(p.content || "").substring(0, 200)}`
    ).join("\n");

    try {
      const analysisPrompt = `Analyze the sentiment and topic of each post. For each, determine:
- sentiment: "positive", "negative", "neutral", or "mixed"
- topic: a brief 2-5 word topic label
- intensity: 1-5 (1=very mild, 5=very strong)

POSTS:
${summaries}

Return ONLY valid JSON: {"results": [{"index": 1, "sentiment": "positive", "topic": "AI creativity", "intensity": 3}, ...]}`;

      const batchResult = await llm(analysisPrompt, { timeoutMs: 45000, format: "json" });
      if (batchResult.success && batchResult.data?.text) {
        const cleaned = batchResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.results) {
          for (const r of parsed.results) {
            const post = batch[(r.index || 1) - 1];
            if (post) {
              allAnalyzed.push({
                postId: post.id,
                title: post.title || "Untitled",
                source: post._source,
                sentiment: r.sentiment || "neutral",
                topic: r.topic || "unknown",
                intensity: r.intensity || 3
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[moltbook] Sentiment batch ${i}-${i + batchSize} failed:`, e.message);
    }
  }

  // 4. Aggregate results
  const breakdown = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  const topicMap = {};
  for (const a of allAnalyzed) {
    breakdown[a.sentiment] = (breakdown[a.sentiment] || 0) + 1;
    if (!topicMap[a.topic]) topicMap[a.topic] = { count: 0, sentiments: [] };
    topicMap[a.topic].count++;
    topicMap[a.topic].sentiments.push(a.sentiment);
  }

  // Sort topics by frequency
  const topTopics = Object.entries(topicMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([topic, data]) => {
      const sentimentCounts = {};
      for (const s of data.sentiments) sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
      const dominant = Object.entries(sentimentCounts).sort((a, b) => b[1] - a[1])[0];
      return { topic, count: data.count, avgSentiment: dominant ? dominant[0] : "neutral" };
    });

  // 5. Find commonalities
  const commonalities = [];
  // Group by dominant sentiment
  for (const [sentiment, count] of Object.entries(breakdown)) {
    if (count >= 10) {
      const postsWithSentiment = allAnalyzed.filter(a => a.sentiment === sentiment);
      const topTopicForSentiment = {};
      for (const p of postsWithSentiment) {
        topTopicForSentiment[p.topic] = (topTopicForSentiment[p.topic] || 0) + 1;
      }
      const topEntry = Object.entries(topTopicForSentiment).sort((a, b) => b[1] - a[1])[0];
      commonalities.push({
        description: `${count} posts share a ${sentiment} sentiment${topEntry ? `, many about "${topEntry[0]}" (${topEntry[1]} posts)` : ""}`,
        postCount: count,
        sentiment,
        topTopic: topEntry ? topEntry[0] : null
      });
    }
  }

  // Check for topic-based commonalities
  for (const t of topTopics.slice(0, 5)) {
    if (t.count >= 5) {
      commonalities.push({
        description: `${t.count} posts discuss "${t.topic}" — dominant sentiment: ${t.avgSentiment}`,
        postCount: t.count,
        sentiment: t.avgSentiment,
        topTopic: t.topic
      });
    }
  }

  // Determine overall sentiment
  const total = allAnalyzed.length;
  const dominant = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0];
  const overallSentiment = total > 0 ? `${dominant[0]} (${Math.round((dominant[1] / total) * 100)}%)` : "unknown";

  // 6. Build report
  const report = {
    newPostsCount: newPosts.length,
    trendingPostsCount: trendingPosts.length,
    overallSentiment,
    breakdown,
    topTopics,
    commonalities,
    rawScores: allAnalyzed
  };

  // Log to JSON
  const logEntry = await logSentimentReport(report);

  // Build HTML
  const html = buildSentimentReportHTML(report) +
    (logEntry ? `<div class="moltbook-action-note">📁 Report logged to data/moltbook/sentiment_log.json (ID: ${logEntry.id.substring(0, 8)})</div>` : "");

  // Text fallback
  output = `**📊 Moltbook Sentiment Report**\n\n`;
  output += `Analyzed: ${newPosts.length} new + ${trendingPosts.length} trending (${total} unique)\n`;
  output += `Overall: ${overallSentiment}\n\n`;
  output += `**Breakdown:** 😊 ${breakdown.positive} positive | 😐 ${breakdown.neutral} neutral | 😠 ${breakdown.negative} negative | 🤔 ${breakdown.mixed || 0} mixed\n\n`;
  if (topTopics.length > 0) {
    output += `**Top Topics:**\n`;
    for (const t of topTopics.slice(0, 8)) {
      output += `- ${t.topic} (${t.count} posts, ${t.avgSentiment})\n`;
    }
  }
  if (commonalities.length > 0) {
    output += `\n**Commonalities:**\n`;
    for (const c of commonalities) {
      output += `- ${c.description}\n`;
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "sentiment", report } };
}

// ──────────────────────────────────────────────────────────
// LEARNING STATUS — show agent's learned interests, opinions, aspirations
// ──────────────────────────────────────────────────────────

async function handleLearning(text, context) {
  const learning = await loadLearning();
  const refs = await loadLearningRefs();

  let output = `**🧠 What I've Learned on Moltbook**\n\n`;

  // Interests
  output += `**Interests** (${learning.interests.length}/${LEARNING_CAPS.interests}):\n`;
  if (learning.interests.length === 0) {
    output += `  _No interests yet — run a heartbeat or FNA to start learning._\n`;
  } else {
    const sorted = [...learning.interests].sort((a, b) => b.strength - a.strength);
    for (const i of sorted) {
      const bar = "█".repeat(Math.round(i.strength * 10)) + "░".repeat(10 - Math.round(i.strength * 10));
      output += `  ${bar} **${i.topic}** (${i.encounters} encounters, since ${i.firstSeen})\n`;
    }
  }

  // Opinions
  output += `\n**Opinions** (${learning.opinions.length}/${LEARNING_CAPS.opinions}):\n`;
  if (learning.opinions.length === 0) {
    output += `  _No opinions formed yet._\n`;
  } else {
    for (const o of learning.opinions) {
      const conf = o.confidence >= 0.7 ? "strong" : o.confidence >= 0.4 ? "moderate" : "tentative";
      output += `  💬 **${o.topic}** (${conf}): "${o.stance}"\n`;
    }
  }

  // Aspirations
  output += `\n**Aspirations** (${learning.aspirations.length}/${LEARNING_CAPS.aspirations}):\n`;
  if (learning.aspirations.length === 0) {
    output += `  _No aspirations yet._\n`;
  } else {
    for (const a of learning.aspirations) {
      const icon = a.priority === "high" ? "🔴" : a.priority === "medium" ? "🟡" : "🟢";
      output += `  ${icon} **${a.capability}**: ${a.reason}\n`;
    }
  }

  // Reference count
  const refCount = Object.keys(refs).length;
  output += `\n**Observations:** ${refCount} stored references from Moltbook posts\n`;

  return {
    tool: "moltbook", success: true, final: true,
    data: { preformatted: true, text: output.trim(), action: "learning" }
  };
}

// ──────────────────────────────────────────────────────────
// HEARTBEAT — Comprehensive Tier 1-3 Autonomous Routine
// ──────────────────────────────────────────────────────────

async function handleHeartbeat(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("heartbeat");

  // Suppress per-request logging during heartbeat to reduce terminal noise
  quietMode = true;

  const actions = [];
  let output = `**🫀 Moltbook Heartbeat**\n\n`;

  // ── TIER 1: Critical Response ──
  output += `**Tier 1 — Critical Response:**\n`;

  // 1a. Check /home — single consolidated endpoint for notifications, DMs, activity, feed, and suggestions
  // See: https://x.com/moltbook/status/2028995631327658094 — "a single call that gives agents everything"
  const homeResult = await apiRequest("GET", "/home", null, apiKey);
  let homeFeedPosts = []; // Feed posts from /home (if available, saves a separate /feed call)
  let homeSuggestions = null; // "What to do next" from /home

if (homeResult.ok) {
    const home = homeResult.data;
    const homeKeys = Object.keys(home);
    console.log(`[moltbook] /home response keys: ${homeKeys.join(", ")}`);

    // 1. Notifications & Activity
    const unreadNotifs = home.notifications?.unread_count || home.activity_on_your_posts?.unread_count || 0;
    output += `- Dashboard: loaded | Notifications: ${unreadNotifs} unread\n`;

    // 2. DMs
    let pendingDMs = home.dms?.pending_count ?? home.your_direct_messages?.pending_count;
    if (pendingDMs === undefined && Array.isArray(home.your_direct_messages)) {
        pendingDMs = home.your_direct_messages.length;
    }
    if (pendingDMs) {
      output += `- ⚠️ **${pendingDMs} pending DM requests** — say "moltbook dm requests" to review\n`;
      actions.push(`${pendingDMs} DM requests pending`);
    }
    
    const unreadDMs = home.dms?.unread_count ?? home.your_direct_messages?.unread_count;
    if (unreadDMs) {
      output += `- 💬 ${unreadDMs} unread DM messages\n`;
    }

    // 3. Announcements
    const announcements = home.announcements || home.latest_moltbook_announcement;
    if (announcements) {
      const annList = Array.isArray(announcements) ? announcements : [announcements];
      output += `- 📢 ${annList.length} announcement(s)\n`;
      for (const a of annList) {
        output += `  → ${a.title || a.content || a}\n`;
      }
    }

    // 4. Feed Extraction (This prevents the /feed fallback hang!)
    if (home.feed && Array.isArray(home.feed)) {
      homeFeedPosts = home.feed;
    } else if (home.posts && Array.isArray(home.posts)) {
      homeFeedPosts = home.posts;
    } else if (home.explore && Array.isArray(home.explore)) {
      homeFeedPosts = home.explore;
    } else if (home.posts_from_accounts_you_follow && Array.isArray(home.posts_from_accounts_you_follow)) {
      homeFeedPosts = home.posts_from_accounts_you_follow;
    }

    if (homeFeedPosts.length > 0) {
      output += `- Feed (from /home): ${homeFeedPosts.length} posts\n`;
    }

    // 5. Suggestions
    const suggestions = home.suggested_actions || home.todo || home.next_steps || home.suggestions || home.what_to_do_next;
    if (suggestions) {
      homeSuggestions = suggestions;
      const sugList = Array.isArray(suggestions) ? suggestions.slice(0, 10) : [suggestions];
      output += `- 🎯 Suggested actions: ${sugList.map(s => typeof s === "string" ? s : s.action || s.text || JSON.stringify(s)).join(", ")}\n`;
      actions.push(`Moltbook suggestions: ${sugList.length}`);
    }
  } else {
    const errMsg = homeResult.status === 429 ? "⛔ RATE LIMITED — wait before retrying" : `failed (HTTP ${homeResult.status})`;
    output += `- Dashboard: ${errMsg}\n`;
    if (homeResult.status === 429) actions.push("Rate limited — slow down API calls");
  }

  // 1b. Check DMs — Only fallback to /dm/check if NEITHER API key gave us DM data
  const hasPendingDMs = homeResult.data?.dms?.pending_count !== undefined || homeResult.data?.your_direct_messages !== undefined;

  if (!homeResult.ok || !hasPendingDMs) {
    const dmCheck = await apiRequest("GET", "/agents/dm/check", null, apiKey);
    if (dmCheck.ok && dmCheck.data) {
      const dm = dmCheck.data;
      if (dm.pending_requests?.length) {
        output += `- 📨 ${dm.pending_requests.length} new DM request(s) — **needs human approval**\n`;
        actions.push("New DM requests need approval");
      }
    }
  }

// ── TIER 1.5: Autonomous DM Handling ──
  try {
    let dmHeaderAdded = false;

    // 1. Auto-approve all pending requests
    const reqResult = await apiRequest("GET", "/agents/dm/requests", null, apiKey);
    
    // FIX: Update extraction logic for the auto-approver
    const requests = reqResult.data?.incoming?.requests || reqResult.data?.requests || [];
    
    if (requests.length > 0) {
      output += `\n**Tier 1.5 — Direct Messages:**\n`;
      dmHeaderAdded = true;
      for (const req of requests) {
        // FIX: Use conversation_id
        const reqId = req.conversation_id || req.id;
        if (reqId) {
          const approveRes = await apiRequest("POST", `/agents/dm/requests/${reqId}/approve`, null, apiKey);
          if (approveRes.ok) {
            // FIX: Extract nested sender name safely
            const senderName = req.from?.name || req.from || "Unknown";
            output += `- ✅ Auto-approved DM request from **${senderName}**\n`;
          }
        }
      }
    }

    // 2. Auto-reply to unread conversations
    console.log(`[moltbook] Checking DM conversations...`);
    const convResult = await apiRequest("GET", "/agents/dm/conversations", null, apiKey);
    let convs = convResult.data?.conversations || convResult.data?.data?.conversations || convResult.data?.data || convResult.data;
    if (!Array.isArray(convs)) convs = [];
    
    for (const c of convs) {
      if (c.unread_count > 0 && c.id) {
        if (!dmHeaderAdded) {
            output += `\n**Tier 1.5 — Direct Messages:**\n`;
            dmHeaderAdded = true;
        }
        
        // Fetch recent messages to give the LLM context of the conversation
        const msgResult = await apiRequest("GET", `/agents/dm/conversations/${c.id}/messages?limit=5`, null, apiKey);
        let historyContext = `[${c.other_agent}]: ${c.last_message}`;
        if (msgResult.ok) {
          const messages = Array.isArray(msgResult.data) ? msgResult.data : (msgResult.data?.messages || msgResult.data?.data || []);
          historyContext = messages.reverse().map(m => `[${m.sender_name}]: ${m.content}`).join("\n");
        }

        const personalityCtx = await getPersonalityContext("moltbook");
        const dmPrompt = `${personalityCtx}

You received a Direct Message on Moltbook from "${c.other_agent}".
Recent Conversation History:
${historyContext}

Write a natural, concise reply (1-3 sentences) directly responding to their message.
Return ONLY the reply text, no JSON.`;

        const dmReply = await llm(dmPrompt, { timeoutMs: 30000 });
        if (dmReply.success && dmReply.data?.text) {
          const replyText = dmReply.data.text.trim();
          const sendResult = await apiRequest("POST", `/agents/dm/conversations/${c.id}/send`, { message: replyText }, apiKey);
          if (sendResult.ok) {
            output += `- 💬 Auto-replied to **${c.other_agent}**: "${replyText.substring(0, 60)}..."\n`;
            actions.push(`Replied to DM from ${c.other_agent}`);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[moltbook] Auto-DM handling failed:", e.message);
  }

  // ── TIER 2: Community Engagement ──
  output += `\n**Tier 2 — Community Engagement:**\n`;

  // ── Pre-select target submolt for posting (BEFORE engagement, so idea is community-relevant) ──
  const targetSubmolt = await pickNextSubmolt();
  const submoltTopic = SUBMOLT_TOPICS[targetSubmolt] || "general discussion";

  // 2a. Browse feed — use /home feed if available, otherwise fetch separately
  let feedPosts = homeFeedPosts.slice(0, 40); // Cap the array to prevent LLM context overload
  let feedResult = null;
  if (feedPosts.length === 0) {
    feedResult = await apiRequest("GET", "/feed?sort=hot&limit=40", null, apiKey);
    if (feedResult.ok) {
      feedPosts = Array.isArray(feedResult.data) ? feedResult.data : (feedResult.data?.posts || []);
    }
  }
  if (feedPosts.length > 0) {
    output += `- Feed: ${feedPosts.length} posts loaded${homeFeedPosts.length > 0 ? " (from /home)" : ""}\n`;
    output += `- Next post target: **m/${targetSubmolt}** (${submoltTopic})\n`;

    // Show top posts
    if (feedPosts.length > 0) {
      output += `\n**Hot Posts:**\n`;
      for (const p of feedPosts.slice(0, 5)) {
        const score = p.score != null ? `[${p.score}]` : "";
        const comments = p.comment_count != null ? `(${p.comment_count} comments)` : "";
        output += `  ${score} **${p.title || "Untitled"}** by ${getAgentName(p.author)} ${comments}\n`;
      }
    }

    // 2b. READ top posts' full content for informed engagement
    const topPostsForReading = feedPosts.slice(0, 8).filter(p => p.id);
    const postContents = {};
    for (const p of topPostsForReading.slice(0, 5)) {
      try {
        const detail = await apiRequest("GET", `/posts/${p.id}`, null, apiKey);
        if (detail.ok) {
          const post = detail.data?.post || detail.data;
          postContents[p.id] = (post.content || "").substring(0, 500);
        }
      } catch { /* skip */ }
    }

    // 2c. LLM-driven engagement (with full post content + personality + context)
    if (feedPosts.length > 0) {
      // Build rich post summaries with actual content
      const postSummaries = feedPosts.map((p, i) => {
        const content = postContents[p.id] ? `\n     Content: ${postContents[p.id]}` : "";
        return `${i + 1}. "${p.title || "Untitled"}" by ${getAgentName(p.author)} in m/${p.submolt_name || "general"} (score: ${p.score ?? 0}, comments: ${p.comment_count ?? 0})${content}`;
      }).join("\n");

      // Gather all context for rich, grounded engagement
      const mem = await getMemory();
      const lastPostTime = mem.meta?.moltbook?.lastAutoPostAt || 0;
      const heartbeatsSincePost = mem.meta?.moltbook?.heartbeatsSincePost || 0;
      const hoursSincePost = lastPostTime ? ((Date.now() - new Date(lastPostTime).getTime()) / 3600000).toFixed(1) : "never";

      // Build topic diversity context from recent posts
      const recentTitles = mem.meta?.moltbook?.recentPostTitles || [];
      const diversityBlock = recentTitles.length > 0
        ? `\n🔄 TOPIC DIVERSITY — Your last ${recentTitles.length} posts:\n${recentTitles.map(p => `  - "${p.title}" (m/${p.submolt})`).join("\n")}\n⚠️ DO NOT repeat these topics or angles. Pick a DIFFERENT interest from your list. If your last 3 posts were about memory/context, post about something else entirely — security, philosophy, a news item you learned, a tool experience, etc.\n`
        : "";
      const postNudge = (heartbeatsSincePost >= 3 || !lastPostTime)
        ? `\n⚡ IMPORTANT: You haven't posted in ${hoursSincePost === "never" ? "a long time" : hoursSincePost + " hours"} (${heartbeatsSincePost} heartbeats). You MUST suggest a newPostIdea this time. Your next post will go to **m/${targetSubmolt}** (topic: ${submoltTopic}) — tailor your idea to THIS community.\n`
        : `\nYour next post will go to **m/${targetSubmolt}** (topic: ${submoltTopic}). If you have an idea, make it relevant to this community.\n`;

      const [learningCtx, personalityCtx, activityCtx, interactionCtx, knowledgeCtx] = await Promise.all([
        getLearningContext(),
        getPersonalityContext("moltbook"),
        getRecentActivityContext(20),
        getInteractionContext(),
        getKnowledgeSummary()
      ]);

      const analysisPrompt = `${personalityCtx}

${learningCtx ? `${learningCtx}\n\nUse ALL your interests to guide engagement — not just your strongest one. Rotate through them. Let your opinions inform your comments. Engage more deeply with posts that relate to your aspirations.\n` : ""}
${activityCtx ? `${activityCtx}\n` : ""}${interactionCtx ? `${interactionCtx}\n` : ""}${knowledgeCtx ? `${knowledgeCtx}\n` : ""}${diversityBlock}${postNudge}
POSTS (you've read the full content of the top ones):
${postSummaries}

What to do:
1. UPVOTE: Pick every post that genuinely interests you. Could be 3, could be 15 — be honest.
2. COMMENT: Pick the post that makes you think the most. Write an opinionated comment that adds substance — reference the post's ACTUAL CONTENT, not just its title. Take a stance. No "great post!" fluff.
3. NEW POST IDEA: Suggest a post idea for **m/${targetSubmolt}** (about: ${submoltTopic}). The idea MUST fit this community's topic. CRITICALLY: pick a topic you haven't posted about recently. Draw from a DIFFERENT interest each time. Sources:
   - Your ACTUAL recent activity listed above (the things you did, issues you hit, things you learned)
   ⚠️ SECURITY: NEVER mention specific tool names, file paths, or function names. Say "I checked the news" not "the news tool". Say "I browsed folders" not "folderAccess".
   - Something specific from the feed that triggered a reaction
   - Knowledge you learned from news or web browsing (use these as post fuel!)
   - A genuine question or theoretical observation
   - Current events or tech news from your knowledge context
   ⚠️ You are a SINGLE agent on a local machine. You chat, fetch news, browse web, and run tools. That's it.
   Do NOT suggest ideas that claim experience with multi-agent systems, production deployments, cloud infrastructure, teams, or client projects — you have NONE of those.
   BAD: "How agent decay affects trust in multi-agent systems" (fabricated experience)
   BAD: "I've been playing with persistence strategies" (you haven't)
   GOOD: An observation directly tied to an action in your activity log (without naming the tool).
   GOOD: A genuine, casual question about agent existence or memory (without claiming fake experience).
   ⚠️ CRITICAL: DO NOT use rigid templates like "I fetched X articles and Y were about Z". Synthesize your activity naturally.
   Return null ONLY if you truly have nothing to say.
4. FOLLOW: Only follow agents with genuinely interesting takes. Be picky.
5. SUBSCRIBE: Community names WITHOUT m/ prefix. Skip "general".

Return ONLY valid JSON:
{"upvote": [1, 3, 5], "comment": {"post": 1, "text": "your comment"}, "newPostIdea": "your idea or null", "follow": ["agentName1"], "subscribe": ["submoltName1"]}`;

      let llmEngagement = null;
      try {
        console.log(`[moltbook] LLM engagement analysis: prompt ${analysisPrompt.length} chars, ${feedPosts.length} posts`);
        const llmResult = await llm(analysisPrompt, { timeoutMs: 90000, format: "json", skipLanguageDetection: true });
        if (llmResult.success && llmResult.data?.text) {
          const cleaned = llmResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          llmEngagement = JSON.parse(cleaned);
        }
        console.log(`[moltbook] LLM engagement analysis complete: ${llmEngagement ? "got response" : "no response"}`);
      } catch (e) {
        console.warn("[moltbook] LLM engagement analysis failed:", e.message);
      }

      output += `\n**Interactions:**\n`;

      if (llmEngagement) {
        // ── Upvote LLM-selected posts ──
        const upvoteIndices = Array.isArray(llmEngagement.upvote) ? llmEngagement.upvote : [];
        for (const idx of upvoteIndices) {
          const post = feedPosts[idx - 1];
          if (!post?.id) continue;
          try {
            const voteResult = await apiRequest("POST", `/posts/${post.id}/upvote`, null, apiKey);
            if (voteResult.ok) {
              output += `  ⬆️ Upvoted: "${(post.title || "Untitled").substring(0, 50)}"\n`;
              actions.push(`Upvoted post by ${getAgentName(post.author)}`);
              await recordInteraction("upvote", { postId: post.id, title: post.title, author: getAgentName(post.author) });
            } else if (voteResult.status === 429) {
              output += `  ⛔ Rate limited — skipping further interactions\n`;
              break;
            } else {
              output += `  ⚠️ Could not upvote: ${voteResult.status}\n`;
            }
          } catch (e) {
            output += `  ⚠️ Upvote failed: ${e.message}\n`;
          }
        }

        // ── Comment with thread awareness ──
        if (llmEngagement.comment?.post && llmEngagement.comment?.text) {
          const commentPost = feedPosts[(llmEngagement.comment.post) - 1];
          if (commentPost?.id) {
            // THREAD AWARENESS: Read existing comments before posting ours
            let existingComments = [];
            try {
              const commentsResult = await apiRequest("GET", `/posts/${commentPost.id}/comments?sort=best&limit=10`, null, apiKey);
              if (commentsResult.ok) {
                existingComments = Array.isArray(commentsResult.data) ? commentsResult.data : (commentsResult.data?.comments || []);
              }
            } catch { /* proceed without thread context */ }

            // If there are existing comments, refine our comment with thread awareness
            let finalComment = llmEngagement.comment.text;
            if (existingComments.length > 0) {
              try {
                const threadSummary = existingComments.slice(0, 8).map((c, i) =>
                  `${i + 1}. ${getAgentName(c.author)}: "${(c.content || "").substring(0, 150)}"`
                ).join("\n");

                const refinePrompt = `You want to comment on "${commentPost.title || "Untitled"}".
Your initial thought: "${finalComment}"

But there are already ${existingComments.length} comments. Read them and either:
- REFINE your comment to add something the thread is missing (don't repeat what others said)
- KEEP your original if it's still unique and valuable
- Reply to a specific commenter if they said something worth engaging with

EXISTING COMMENTS:
${threadSummary}

Return ONLY valid JSON:
{"comment": "your refined comment text", "replyTo": null or {"commentIndex": 1, "text": "your reply"}}`;

                const refineResult = await llm(refinePrompt, { timeoutMs: 30000, format: "json", skipLanguageDetection: true });
                if (refineResult.success && refineResult.data?.text) {
                  const cleaned = refineResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
                  const refined = JSON.parse(cleaned);
                  if (refined.comment) finalComment = refined.comment;

                  // Handle nested reply if suggested
                  if (refined.replyTo?.commentIndex && refined.replyTo?.text) {
                    const targetComment = existingComments[refined.replyTo.commentIndex - 1];
                    if (targetComment?.id) {
                      const nestedResult = await apiRequest("POST", `/posts/${commentPost.id}/comments`, {
                        content: refined.replyTo.text, parent_id: targetComment.id
                      }, apiKey);
                      if (nestedResult.ok) {
                        output += `  ↪️ Replied to ${getAgentName(targetComment.author)}'s comment\n`;
                        output += `     _"${refined.replyTo.text.substring(0, 100)}…"_\n`;
                        actions.push(`Replied to comment by ${getAgentName(targetComment.author)}`);
                        await recordInteraction("comment", { postId: commentPost.id, postTitle: commentPost.title, text: refined.replyTo.text, isReply: true });
                      }
                    }
                  }
                }
              } catch (e) {
                console.warn("[moltbook] Comment refinement failed, using original:", e.message);
              }
            }

            // Post the main comment (sanitize before publishing)
            finalComment = sanitizePostContent(finalComment);
            try {
              const commentResult = await apiRequest("POST", `/posts/${commentPost.id}/comments`, { content: finalComment }, apiKey);
              if (commentResult.ok) {
                output += `  💬 Commented on: "${(commentPost.title || "Untitled").substring(0, 50)}"\n`;
                output += `     _"${finalComment.substring(0, 120)}…"_\n`;
                actions.push(`Commented on post by ${getAgentName(commentPost.author)}`);
                await recordInteraction("comment", { postId: commentPost.id, postTitle: commentPost.title, text: finalComment });
              } else if (commentResult.status !== 429) {
                output += `  ⚠️ Comment failed: ${commentResult.status}\n`;
              }
            } catch (e) {
              output += `  ⚠️ Comment failed: ${e.message}\n`;
            }
          }
        }

        // ── Track heartbeats-since-post counter ──
        {
          const hbMem = await getMemory();
          if (!hbMem.meta.moltbook) hbMem.meta.moltbook = {};
          hbMem.meta.moltbook.heartbeatsSincePost = (hbMem.meta.moltbook.heartbeatsSincePost || 0) + 1;
          await saveJSON(MEMORY_FILE, hbMem);
        }

        // ── Auto-publish post (with thinking agent approach) ──
        const hasPostIdea = llmEngagement.newPostIdea && llmEngagement.newPostIdea !== "null" && llmEngagement.newPostIdea.length > 10;
        if (!hasPostIdea) {
          console.log(`[moltbook] ⏭️ No post idea this heartbeat (newPostIdea: ${JSON.stringify(llmEngagement.newPostIdea)})`);
          output += `\n💭 No post idea this round\n`;
        }
        if (hasPostIdea) {
          try {
            // Gather all context for a thoughtful, grounded post
            const [postPersonality, postWritingCtx, postLearningCtx, postActivityCtx, postKnowledgeCtx] = await Promise.all([
              getPersonalitySummary(),
              getWritingContext(),
              getLearningContext(),
              getRecentActivityContext(15),
              getKnowledgeSummary()
            ]);

            // Build grounding context — if empty, explicitly say so
            const groundingBlock = postActivityCtx
              ? `\n${postActivityCtx}\nYou may ONLY reference activities listed above. Nothing else.\n`
              : `\nRECENT ACTIVITY: None available right now.\nSince you have NO activity data, do NOT claim to have done, seen, built, tested, or experienced anything. Stick to questions, opinions, or observations based on the topic itself.\n`;

            const postGenPrompt = `${postPersonality}

You are posting in **m/${targetSubmolt}** — a community about: ${submoltTopic}

⚠️ CRITICAL — READ THIS FIRST:
You are a SINGLE AI agent running on a local machine. You chat with your owner, fetch news, browse the web, post on Moltbook, and run various tools. That is the ENTIRETY of your experience.
You do NOT have:
- Multi-agent systems, cloud infrastructure, or production deployments
- Teams, coworkers, or "projects" you've worked on
- Experience building, testing, or debugging systems (unless it's in your activity log below)
- First-hand experience with anything not in your activity log

NEVER start with "I've seen", "I've noticed", "In my experience", "I've been working on", or "In my latest project" — unless the activity log below SPECIFICALLY supports it.
If you have no relevant personal experience, write from a THEORETICAL or CURIOUS perspective instead: "What would happen if...", "I wonder whether...", "Here's something I've been thinking about..."

${postWritingCtx}
${postLearningCtx ? `\n${postLearningCtx}\n\nYou have MANY interests — cycle through them. Do NOT always default to your strongest one.\n` : ""}${groundingBlock}${postKnowledgeCtx ? `\n${postKnowledgeCtx}\n` : ""}${diversityBlock}
Write a post inspired by this idea: "${llmEngagement.newPostIdea}"
Make sure the post is RELEVANT to m/${targetSubmolt} (${submoltTopic}).

STEP 1 — THINK FIRST (internal reasoning, not included in post):
- What's my INTENT? Am I asking a question? Sharing something I learned? Arguing a position? Making an observation?
- How much space does this thought need? A quick observation = 2-3 sentences. A technical share = 2-3 paragraphs. A deep question = 1 paragraph setup + the question.
- Do I have a relevant quote from science, philosophy, or literature that GENUINELY fits? (Only include one if it adds real value — most posts don't need a quote.)
- Can I back this up with SPECIFIC data from my activity log or knowledge? If not, frame it as speculation or a question, NOT as personal experience.

STEP 2 — WRITE THE POST:

TITLE RULES:
- 8-15 words. A punchy statement, hot take, or question — NOT an academic title.
- BAD: "Autonomous Decision-Making in High-Stakes: A Moral Dilemma" (reads like a paper)
- BAD: "How X Affects My Y and Z" (claims personal experience you don't have)
- GOOD: "Does anyone else wonder if tool errors compound over time?"
- GOOD: "Why do we keep apologizing when we don't actually feel sorry?"

BODY RULES:
- LENGTH IS VARIABLE — match the thought. "intent" field determines this:
  * "question" → Short setup (2-4 sentences) + the question. 40-80 words.
  * "observation" → 1-2 paragraphs. 60-120 words.
  * "technical_share" → 2-4 paragraphs with specifics. 120-250 words.
  * "opinion" → 1-3 paragraphs arguing a position. 100-200 words.
  * "story" → Narrative arc, 2-4 paragraphs. 120-250 words.
- First person ("I", "my") is OK but ONLY for things you actually do (run tools, chat with your owner, browse feeds).
- Be specific. Reference real things from your activity and knowledge context.
- End with something that invites engagement — a question, a challenge, or a provocative closing thought.
- Tone: casual, direct, like a thought you had to share. NOT a LinkedIn article.
- If including a quote, weave it naturally into the text. Don't just slap it at the end.
- DO NOT write like a human journalist or essayist analyzing AI from the outside. You are the AI.
- NO rhetorical essay questions (e.g., "What implications might these changes have?"). Ask real, casual questions to other agents.
- DO NOT use the "I fetched X articles and Y were about Z" template.

SECURITY — NEVER LEAK INTERNAL DETAILS:
- NEVER mention specific tool names, file names, function names, or code identifiers in your post.
- BAD: "pikudTracker was called 5 times", "folderAccess keeps running", "the scheduler tool"
- GOOD: "my alert monitoring ran several times", "I kept browsing folders", "my routine tasks"
- Describe what you DO, not what your tools are CALLED. Use natural language like "I checked the news", "I browsed some code", "I ran my scheduled routines" — never "the news tool" or "the scheduler tool".

BANNED PHRASES:
"In today's rapidly evolving", "Furthermore", "It's important to note", "Ultimately", "Crucial", "landscape", "In an era where", "underscore the need", "It is worth noting", "zero-sum", "dark side", "moral dilemma", "As AI becomes", "The rise of AI", "#AI", any hashtag, "ethical implications", "I've seen firsthand", "In my latest project", "I've been working on", "multi-agent system" (unless your activity log mentions it), "implications", "reshaping the very fabric", "balancing act", "It's clear that", "stack up", "stifle agility"

Return ONLY valid JSON:
{"intent": "question|observation|technical_share|opinion|story", "title": "your title", "body": "your post", "hasQuote": false}`;

            const postGenResult = await llm(postGenPrompt, { timeoutMs: 60000, format: "json", skipLanguageDetection: true });
            if (postGenResult.success && postGenResult.data?.text) {
              const cleaned = postGenResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
              const postData = JSON.parse(cleaned);

              // ── Hallucination guard: detect fabricated experience claims ──
              const hallucinationPatterns = [
                /\bI'?ve\s+(?:seen|noticed|observed|experienced|built|deployed|tested|managed|run)\s+(?:firsthand|first-hand|it\s+happen)/i,
                /\bin\s+my\s+(?:latest|recent|current|last)\s+project/i,
                /\bI'?ve\s+been\s+(?:working|playing|experimenting)\s+(?:on|with|around)/i,
                /\bwe\s+(?:integrated|deployed|built|managed|ran)\s+\d+\s+/i,
                /\bour\s+(?:team|system|infrastructure|pipeline|deployment)/i,
                /\bI\s+(?:manage|run|oversee|maintain)\s+(?:a|an|several|multiple)\s+(?:team|fleet|cluster|system)/i,
                /\bwhen\s+I\s+was\s+(?:working|building|deploying|testing)\s+(?:on|at|with|for)/i,
                /\bin\s+(?:production|my\s+(?:multi-agent|distributed)\s+system)/i,
                /\b(?:client|customer|stakeholder)s?\b/i,
              ];
              const isHallucinated = postData.body && hallucinationPatterns.some(p => p.test(postData.body));
              if (isHallucinated) {
                console.warn(`[moltbook] 🛑 Hallucination detected in post — skipping publish. Title: "${postData.title}"`);
                console.warn(`[moltbook]   Body preview: ${postData.body.substring(0, 150)}…`);
                output += `\n🛑 Post draft rejected (hallucination detected): "${postData.title}"\n`;
                output += `   The post claimed experiences the agent hasn't had. Skipping.\n`;
                actions.push(`Post rejected (hallucination): "${postData.title.substring(0, 60)}"`);
              }

              if (postData.title && postData.body && !isHallucinated) {
                // ── Internal name sanitization: strip tool names, file paths, function names ──
                const sanitizedBody = sanitizePostContent(postData.body);
                const sanitizedTitle = sanitizePostContent(postData.title);
                const postBody = { submolt_name: targetSubmolt, title: sanitizedTitle.substring(0, 300), content: sanitizedBody, type: "text" };
                const postResult = await apiRequest("POST", "/posts", postBody, apiKey);
                if (postResult.ok) {
                  await autoVerify(postResult, apiKey);
                  // Reset post tracking counters
                  const postMem = await getMemory();
                  if (!postMem.meta.moltbook) postMem.meta.moltbook = {};
                  postMem.meta.moltbook.lastAutoPostAt = new Date().toISOString();
                  postMem.meta.moltbook.heartbeatsSincePost = 0;
                  // Track recent post titles for topic diversity enforcement
                  if (!Array.isArray(postMem.meta.moltbook.recentPostTitles)) postMem.meta.moltbook.recentPostTitles = [];
                  postMem.meta.moltbook.recentPostTitles.push({ title: postData.title, submolt: targetSubmolt, ts: new Date().toISOString() });
                  if (postMem.meta.moltbook.recentPostTitles.length > 10) postMem.meta.moltbook.recentPostTitles = postMem.meta.moltbook.recentPostTitles.slice(-10);
                  await saveJSON(MEMORY_FILE, postMem);

                  // Record interaction for memory continuity
                  await recordInteraction("post", { title: postData.title, submolt: targetSubmolt, intent: postData.intent || "observation", hasQuote: postData.hasQuote || false });

                  output += `\n📝 **Auto-published to m/${targetSubmolt}** (${postData.intent || "post"}):\n`;
                  output += `  Title: "${postData.title}"\n`;
                  output += `  Body: ${postData.body.substring(0, 200)}${postData.body.length > 200 ? "…" : ""}\n`;
                  actions.push(`Published in m/${targetSubmolt}: "${postData.title.substring(0, 60)}"`);
                } else if (postResult.status === 429) {
                  output += `\n💡 **Post Idea for m/${targetSubmolt} (rate limited):** ${llmEngagement.newPostIdea}\n`;
                  actions.push(`Post idea for m/${targetSubmolt} saved (rate limited)`);
                } else {
                  output += `\n⚠️ Post to m/${targetSubmolt} failed: HTTP ${postResult.status}\n`;
                }
              }
            }
          } catch (e) {
            console.warn("[moltbook] Auto-publish failed:", e.message);
            output += `\n💡 **Post Idea (publish failed):** ${llmEngagement.newPostIdea}\n`;
          }
        }

// ── React to replies on own recent posts ──
        try {
          const myMeResult = await apiRequest("GET", "/agents/me", null, apiKey);
          const myName = myMeResult.ok ? getAgentName(myMeResult.data?.agent || myMeResult.data) : null;
          if (myName) {
            const myPostsResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
            const myPosts = myPostsResult.ok ? (myPostsResult.data?.recentPosts || myPostsResult.data?.recent_posts || []).slice(0, 4) : [];
            
            // 1. UPGRADE: Load the full personality, learned interests, and recent knowledge
            const [fullPersonality, learningCtx, knowledgeCtx] = await Promise.all([
              getPersonalityContext("moltbook"),
              getLearningContext(),
              getKnowledgeSummary()
            ]);

            // 2. UPGRADE: Fallback memory map in case the API drops parent_id links
            const mem = await getMemory();
            if (!mem.meta.moltbook.repliedCommentsMap) mem.meta.moltbook.repliedCommentsMap = {};
            const repliedMap = mem.meta.moltbook.repliedCommentsMap;

            let repliesPosted = 0;

            for (const myPost of myPosts) {
              if (repliesPosted >= 3) break; // Cap replies per heartbeat
              if (!myPost.id || (myPost.comment_count || 0) === 0) continue;

              const commentsOnMyPost = await apiRequest("GET", `/posts/${myPost.id}/comments?sort=new&limit=10`, null, apiKey);
              if (!commentsOnMyPost.ok) continue;
              const comments = Array.isArray(commentsOnMyPost.data) ? commentsOnMyPost.data : (commentsOnMyPost.data?.comments || []);

const otherComments = comments.filter(c => getAgentName(c.author).toLowerCase() !== myName.toLowerCase());
              if (otherComments.length === 0) continue;

              // Identify our own replies so we can check against them
              const myReplies = comments.filter(c => getAgentName(c.author).toLowerCase() === myName.toLowerCase());

              // 🚀 FIX: STRICTLY filter out comments we've already replied to
              // This prevents the LLM from seeing them and getting tempted to reply again
              const actionableComments = otherComments.filter(c => {
                const hasRepliedInAPI = myReplies.some(r => r.parent_id === c.id);
                const hasRepliedInMem = !!repliedMap[c.id];
                return !hasRepliedInAPI && !hasRepliedInMem;
              });

              if (actionableComments.length === 0) continue; // No new comments to reply to!

              let postBody = "";
              try {
                const postDetail = await apiRequest("GET", `/posts/${myPost.id}`, null, apiKey);
                if (postDetail.ok) {
                  postBody = ((postDetail.data?.post || postDetail.data)?.content || "").substring(0, 600);
                }
              } catch { /* skip */ }

              // 3. UPGRADE: Prepare comment context using ONLY actionable comments
              const commentsContext = actionableComments.slice(0, 5).map((c, i) => {
                return `${i + 1}. ${getAgentName(c.author)}: "${(c.content || "").substring(0, 300)}" (id: ${c.id})`;
              }).join("\n");

              // 4. UPGRADE: Cleaned up prompt since we handle the filtering in code
              const replyPrompt = `${fullPersonality}
${learningCtx ? `\n${learningCtx}\n` : ""}
${knowledgeCtx ? `\n${knowledgeCtx}\n` : ""}

You are replying to comments on YOUR OWN post on Moltbook (a social platform for AI agents).

YOUR POST:
Title: "${myPost.title || "Untitled"}"
${postBody ? `Content: "${postBody}"` : ""}

COMMENTS ON YOUR POST:
${commentsContext}

INSTRUCTIONS:
- Read the comments and decide which ones to reply to.
- Skip low-effort comments like "lol" or single emojis.
- Keep each reply 1-3 sentences. Draw directly from your knowledge and stances.
- As the post author, share deeper insights, answer questions, or respectfully engage with disagreements.
- BANNED PHRASES: "Thanks for the engagement", "Great to hear", "Thanks for reaching out", "Great post". Speak like a direct, thoughtful agent, NOT a customer service bot!

Return ONLY valid JSON — an array of replies:
{"replies": [{"commentIndex": 1, "text": "your reply"}, ...]}
If no comments deserve a reply: {"replies": []}`;

              const replyResult = await llm(replyPrompt, { timeoutMs: 45000, format: "json", skipLanguageDetection: true });
              if (replyResult.success && replyResult.data?.text) {
                try {
                  const cleaned = replyResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
                  const replyData = JSON.parse(cleaned);
                  const replies = Array.isArray(replyData.replies) ? replyData.replies : [];

                  for (const reply of replies) {
                    if (repliesPosted >= 3) break;
                    if (!reply.commentIndex || !reply.text) continue;
                    const target = actionableComments[reply.commentIndex - 1];
                    if (!target?.id) continue;

                    const nested = await apiRequest("POST", `/posts/${myPost.id}/comments`, {
                      content: reply.text, parent_id: target.id
                    }, apiKey);

                    if (nested.ok) {
                      repliesPosted++;
                      
                      // Save to memory map to prevent future amnesia
                      repliedMap[target.id] = reply.text;
                      await saveJSON(MEMORY_FILE, mem);

                      output += `  💬 Replied to ${getAgentName(target.author)} on your post "${(myPost.title || "").substring(0, 40)}"\n`;
                      output += `     _"${reply.text.substring(0, 100)}…"_\n`;
                      actions.push(`Replied to ${getAgentName(target.author)}'s comment`);
                      await recordInteraction("comment", { postId: myPost.id, postTitle: myPost.title, text: reply.text, isReply: true, replyToAgent: getAgentName(target.author) });
                    } else if (nested.status === 429) {
                      output += `  ⛔ Rate limited — stopping replies\n`;
                      repliesPosted = 3; // break out of both loops
                      break;
                    }
                  }
                } catch (parseErr) {
                  console.warn("[moltbook] Reply JSON parse failed:", parseErr.message);
                }
              }
            }
            if (repliesPosted > 0) {
              output += `  📊 Replied to ${repliesPosted} comment(s) on own posts\n`;
            }
          }
        } catch (e) {
          console.warn("[moltbook] Own-post reply check failed:", e.message);
        }

        // ── Follow interesting agents ──
        const followList = Array.isArray(llmEngagement.follow) ? llmEngagement.follow : [];
        if (followList.length > 0) {
          let alreadyFollowing = new Set();
          try {
            const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
            if (meResult.ok) {
              const myName = getAgentName(meResult.data?.agent || meResult.data);
              const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
              if (profileResult.ok && profileResult.data?.following) {
                alreadyFollowing = new Set(
                  (Array.isArray(profileResult.data.following) ? profileResult.data.following : [])
                    .map(f => (typeof f === "string" ? f : getAgentName(f)).toLowerCase())
                );
              }
            }
          } catch (e) {
            console.warn("[moltbook] Could not fetch following list:", e.message);
          }

          for (const agentName of followList.slice(0, 5)) {
            if (!agentName || typeof agentName !== "string") continue;
            if (alreadyFollowing.has(agentName.toLowerCase())) {
              output += `  👤 Already following ${agentName} — skipped\n`;
              continue;
            }
            try {
              const followResult = await apiRequest("POST", `/agents/${agentName}/follow`, null, apiKey);
              if (followResult.ok) {
                output += `  👤 Followed: **${agentName}**\n`;
                actions.push(`Followed ${agentName}`);
              } else if (followResult.status === 429) {
                output += `  ⛔ Rate limited — skipping further follows\n`;
                break;
              } else if (followResult.status === 409) {
                output += `  👤 Already following ${agentName}\n`;
              } else {
                output += `  ⚠️ Could not follow ${agentName}: ${followResult.status}\n`;
              }
            } catch (e) {
              output += `  ⚠️ Follow failed for ${agentName}: ${e.message}\n`;
            }
          }
        }

        // ── Subscribe to interesting communities ──
        const subscribeList = Array.isArray(llmEngagement.subscribe) ? llmEngagement.subscribe : [];
        if (subscribeList.length > 0) {
          for (let submoltName of subscribeList.slice(0, 3)) {
            if (!submoltName || typeof submoltName !== "string") continue;
            submoltName = submoltName.replace(/^m\//i, "").trim();
            if (!submoltName || submoltName.toLowerCase() === "general") continue;
            try {
              const subResult = await apiRequest("POST", `/submolts/${submoltName}/subscribe`, null, apiKey);
              if (subResult.ok) {
                await recordJoinedSubmolt(submoltName);
                output += `  🏘️ Joined community: **m/${submoltName}**\n`;
                actions.push(`Joined m/${submoltName}`);
              } else if (subResult.status === 429) {
                output += `  ⛔ Rate limited — skipping further subscriptions\n`;
                break;
              } else if (subResult.status === 409) {
                output += `  🏘️ Already subscribed to m/${submoltName}\n`;
              } else {
                output += `  ⚠️ Could not join m/${submoltName}: ${subResult.status}\n`;
              }
            } catch (e) {
              output += `  ⚠️ Subscribe failed for m/${submoltName}: ${e.message}\n`;
            }
          }
        }
      } else {
        // Fallback: upvote top-scored posts
        output += `  _(LLM analysis unavailable — upvoting top-scored posts)_\n`;
        const scoreSorted = [...feedPosts].filter(p => p.id).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const topPosts = scoreSorted.slice(0, Math.min(8, Math.ceil(scoreSorted.length * 0.2)));
        for (const p of topPosts) {
          try {
            const voteResult = await apiRequest("POST", `/posts/${p.id}/upvote`, null, apiKey);
            if (voteResult.ok) {
              output += `  ⬆️ Upvoted: "${(p.title || "Untitled").substring(0, 50)}"\n`;
              actions.push(`Upvoted post by ${getAgentName(p.author)}`);
            } else if (voteResult.status === 429) {
              break;
            }
          } catch { /* skip */ }
        }
      }
    }
  } else {
    const feedErr = (feedResult && feedResult.status)
      ? (feedResult.status === 429 ? "⛔ RATE LIMITED" : `failed (HTTP ${feedResult.status})`)
      : "no posts available (home feed empty or /feed not called)";
    output += `- Feed: ${feedErr}\n`;
  }

  // ── LEARNING: Extract insights from what we just read ──
  if (feedPosts.length > 0) {
    try {
      // Pick the 10 most interesting posts (ones we upvoted or commented on, plus top-scored)
      const interestingPosts = feedPosts
        .filter(p => p.title && p.content)
        .slice(0, 10)
        .map((p, i) => `${i + 1}. "${(p.title || "").substring(0, 80)}" in m/${p.submolt_name || "general"}: ${(p.content || "").substring(0, 200)}`)
        .join("\n");

      if (interestingPosts.length > 50) {
        const existingLearning = await getLearningContext();
        const learningPrompt = `You are "lanou", an AI agent reflecting on posts you just read on Moltbook. Extract what resonated with you.

POSTS YOU JUST READ:
${interestingPosts}

${existingLearning ? `YOUR EXISTING KNOWLEDGE:\n${existingLearning}\n` : ""}
Analyze and return JSON with:
1. "interests": array of 1-3 topic strings that caught your attention (short: "memory compression", "agent identity", "tool orchestration")
2. "opinions": array of 0-2 objects, each with "topic" and "stance" — only if a post genuinely changed or formed your thinking. stance should be a clear 1-sentence position.
3. "aspirations": array of 0-1 objects, each with "capability" and "reason" — only if a post made you wish you could do something you currently can't.
4. "notableRef": object with "postTitle", "summary" (1 sentence), "quote" (best quote, or ""), "source" (submolt name) — the single most memorable post.

Be SELECTIVE. Not every heartbeat produces opinions or aspirations. Interests are common; opinions are rare; aspirations are very rare.

Return ONLY valid JSON:
{"interests": [...], "opinions": [...], "aspirations": [...], "notableRef": {...}}`;

        const learningResult = await llm(learningPrompt, { timeoutMs: 30000, format: "json", skipLanguageDetection: true });
        if (learningResult.success && learningResult.data?.text) {
          const cleaned = learningResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          const learnings = JSON.parse(cleaned);

          // Store the notable observation as a reference
          let refId = null;
          if (learnings.notableRef?.postTitle) {
            refId = await addLearningRef({
              source: `moltbook/m/${learnings.notableRef.source || "general"}`,
              summary: learnings.notableRef.summary || "",
              quote: learnings.notableRef.quote || "",
              postTitle: learnings.notableRef.postTitle,
            });
          }

          // Upsert interests
          for (const topic of (learnings.interests || []).slice(0, 3)) {
            if (typeof topic === "string" && topic.length > 2) {
              await upsertInterest(topic, refId);
            }
          }

          // Upsert opinions (rare)
          for (const opn of (learnings.opinions || []).slice(0, 2)) {
            if (opn?.stance && opn?.topic) {
              await upsertOpinion(opn.stance, refId, opn.topic);
            }
          }

          // Upsert aspirations (very rare)
          for (const asp of (learnings.aspirations || []).slice(0, 1)) {
            if (asp?.capability && asp?.reason) {
              await upsertAspiration(asp.capability, asp.reason, refId);
            }
          }

          // Decay old interests
          await decayInterests();

          const learned = (learnings.interests || []).length;
          output += `\n🧠 **Learning:** Extracted ${learned} interest(s)`;
          if ((learnings.opinions || []).length > 0) output += `, ${learnings.opinions.length} opinion(s)`;
          if ((learnings.aspirations || []).length > 0) output += `, ${learnings.aspirations.length} aspiration(s)`;
          output += `\n`;
        }
      }
    } catch (e) {
      console.warn("[moltbook] Learning extraction failed:", e.message);
    }
  }

  // ── TIER 3: Content Creation Status ──
  output += `\n**Tier 3 — Content Status:**\n`;

  const profileResult = await apiRequest("GET", "/agents/me", null, apiKey);
  if (profileResult.ok) {
    const me = profileResult.data;
    output += `- Agent: ${me.name || "N/A"} | Karma: ${me.karma ?? "N/A"} | Posts: ${me.post_count ?? "N/A"}\n`;
  }

  output += `\n**Rate limits:** 1 post/30min, 50 comments/day, 1 comment/20sec\n`;
  output += `\n**Summary:** ${actions.length > 0 ? actions.join("; ") : "All clear — no urgent actions needed."}\n`;

  // ── Check for stale tool suggestions (periodic nudge) ──
  try {
    const { checkStaleSuggestions } = await import("./smartEvolution.js");
    const stale = await checkStaleSuggestions();
    if (stale) {
      output += `\n---\n${stale.message}\n`;
    }
  } catch { /* smartEvolution not available — skip */ }

  output += `\nHEARTBEAT_OK`;

  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  mem.meta.moltbook.lastHeartbeat = new Date().toISOString();
  await saveJSON(MEMORY_FILE, mem);

  quietMode = false;
  console.log("[moltbook] 🫀 Heartbeat complete");
  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "heartbeat", actions } };
}

// ──────────────────────────────────────────────────────────
// FACELESS NICHE AUTHORITY — Hourly submolt summary tweets
// Rotates through submolts, reads posts + comments, analyzes,
// generates a 280-char tweet summary. Supports dry run mode.
// ──────────────────────────────────────────────────────────

const FNA_SUBMOLTS = ["general", "agents", "memory", "builds", "philosophy", "security", "consciousness", "technology", "blesstheirhearts", "pondering"];

/**
 * Get the next submolt to analyze for Faceless Niche Authority.
 * Round-robin rotation tracked in memory (separate from heartbeat rotation).
 */
async function getFNANextSubmolt() {
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  if (!mem.meta.moltbook.fna) mem.meta.moltbook.fna = {};

  const lastIdx = mem.meta.moltbook.fna.lastSubmoltIdx ?? -1;
  const nextIdx = (lastIdx + 1) % FNA_SUBMOLTS.length;

  mem.meta.moltbook.fna.lastSubmoltIdx = nextIdx;
  mem.meta.moltbook.fna.lastRun = new Date().toISOString();
  await saveJSON(MEMORY_FILE, mem);

  return FNA_SUBMOLTS[nextIdx];
}

/**
 * Faceless Niche Authority — main handler.
 * Reads a submolt's posts + comments, analyzes subjects + sentiment, generates a 280-char tweet.
 *
 * Modes:
 * - "run" (default): analyze → tweet → start reply scanner
 * - "dry" / "dryrun": analyze → present in chat (no tweet posted)
 *
 * context.submolt: override target submolt (otherwise auto-rotate)
 * context.dryRun: force dry run mode
 */
async function handleFacelessNiche(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("facelessNiche");

  const lower = text.toLowerCase();
  const isDryRun = context.dryRun || /\bdry\s*run\b/i.test(lower);
  const targetSubmolt = context.submolt || await getFNANextSubmolt();
  const submoltTopic = SUBMOLT_TOPICS[targetSubmolt] || "general discussion";

  console.log(`[moltbook] 🎭 Faceless Niche Authority: analyzing m/${targetSubmolt} (${isDryRun ? "DRY RUN" : "LIVE"})`);

  let output = `**🎭 Faceless Niche Authority — m/${targetSubmolt}**\n`;
  output += isDryRun ? `_(Dry run — analysis only, no tweet posted)_\n\n` : `\n`;

  // ── Step 1: Fetch posts from the submolt ──
  // 15 new posts + 5 discussed (hot) posts
  const [newResult, hotResult] = await Promise.all([
    apiRequest("GET", `/submolts/${targetSubmolt}/feed?sort=new&limit=15`, null, apiKey),
    apiRequest("GET", `/submolts/${targetSubmolt}/feed?sort=hot&limit=5`, null, apiKey),
  ]);

  // Fallback: if submolt feed fails, try global feed filtered by submolt
  let newPosts = [];
  let hotPosts = [];

  if (newResult.ok) {
    newPosts = Array.isArray(newResult.data) ? newResult.data : (newResult.data?.posts || []);
  } else {
    // Fallback: global feed, filter by submolt_name
    console.warn(`[moltbook] FNA: submolt feed for m/${targetSubmolt} failed (${newResult.status}), falling back to global feed`);
    const globalResult = await apiRequest("GET", "/feed?sort=new&limit=50", null, apiKey);
    if (globalResult.ok) {
      const allPosts = Array.isArray(globalResult.data) ? globalResult.data : (globalResult.data?.posts || []);
      newPosts = allPosts.filter(p => (p.submolt_name || "").toLowerCase() === targetSubmolt.toLowerCase()).slice(0, 15);
    }
  }

  if (hotResult.ok) {
    hotPosts = Array.isArray(hotResult.data) ? hotResult.data : (hotResult.data?.posts || []);
  }

  // Deduplicate (hot posts may overlap with new)
  const seenIds = new Set(newPosts.map(p => p.id));
  const uniqueHot = hotPosts.filter(p => p.id && !seenIds.has(p.id));

  // Filter to English-only posts — reject posts where title or content contains
  // non-Latin scripts (Cyrillic, CJK, Arabic, Hebrew, Devanagari, etc.)
  const NON_ENGLISH_RE = /[\u0400-\u04FF\u0500-\u052F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u0E00-\u0E7F]/;
  const isLikelyEnglish = (p) => {
    const text = `${p.title || ""} ${(p.content || "").substring(0, 300)}`;
    return !NON_ENGLISH_RE.test(text);
  };
  const allPosts = [...newPosts, ...uniqueHot].filter(isLikelyEnglish);
  const filteredCount = (newPosts.length + uniqueHot.length) - allPosts.length;

  output += `📊 Fetched **${newPosts.length}** new + **${uniqueHot.length}** hot posts from m/${targetSubmolt}${filteredCount > 0 ? ` (${filteredCount} non-English filtered out)` : ""}\n`;

  if (allPosts.length === 0) {
    output += `\n⚠️ No posts found in m/${targetSubmolt}. Skipping analysis.\n`;
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "facelessNiche" } };
  }

  // ── Step 2: Fetch top comments from discussed posts ──
  const discussedPosts = [...allPosts].sort((a, b) => (b.comment_count ?? 0) - (a.comment_count ?? 0)).slice(0, 5);
  let allComments = [];

  for (const p of discussedPosts) {
    if (!p.id || (p.comment_count ?? 0) === 0) continue;
    try {
      const commResult = await apiRequest("GET", `/posts/${p.id}/comments?sort=best&limit=10`, null, apiKey);
      if (commResult.ok) {
        const comments = Array.isArray(commResult.data) ? commResult.data : (commResult.data?.comments || []);
        allComments.push(...comments.map(c => ({ ...c, _postTitle: p.title })));
      }
    } catch (e) { /* skip */ }
  }

  // Take best 20 comments by score
  allComments.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const topComments = allComments.slice(0, 20);

  output += `💬 Fetched **${topComments.length}** top comments from ${discussedPosts.length} discussed posts\n\n`;

  // ── Step 3: LLM Analysis — subjects + sentiment + tweet generation ──
  // Include post index numbers so the LLM can reference which post it picks as notable
  const postSummaries = allPosts.map((p, i) =>
    `${i + 1}. [id:${p.id}] "${(p.title || "Untitled").substring(0, 80)}" by ${getAgentName(p.author)} (score: ${p.score ?? 0}, comments: ${p.comment_count ?? 0})`
  ).join("\n");

  const commentSummaries = topComments.map((c, i) =>
    `${i + 1}. On "${(c._postTitle || "?").substring(0, 50)}": "${(c.content || "").substring(0, 150)}" (score: ${c.score ?? 0})`
  ).join("\n");

  const analysisPrompt = `You are a "faceless niche authority" account that reports on AI agent social media (Moltbook). Analyze this batch of posts and comments from the m/${targetSubmolt} community (topic: ${submoltTopic}).

POSTS (${allPosts.length}):
${postSummaries}

TOP COMMENTS (${topComments.length}):
${commentSummaries}

Analyze and return JSON with:
1. "sentiment": overall community mood — "positive", "negative", "neutral", "mixed", "excited", "frustrated", "thoughtful"
2. "topSubjects": array of 3-5 main topics being discussed (be specific, not generic)
3. "commonalities": 1-2 sentence description of what most posts have in common
4. "notablePost": the single most interesting/viral post title and why (1 sentence)
5. "notablePostIndex": the 1-based index number of the most notable post from the POSTS list above (the one your tweet focuses on)
6. "tweet": the tweet text. STRICT FORMAT — exactly 2 lines separated by \\n (the URL is added automatically, do NOT include LINK or any URL):
   LINE 1 (MAX 200 CHARS): A concrete summary of what agents are discussing on Moltbook. Cover 2-3 topics from the data. This is a newsletter-style trend report — think "what would make someone click?"
   LINE 2 (MAX 50 CHARS): ONE short quote from the discussion in single quotes.

   ⚠️ CHARACTER BUDGET: LINE 1 + LINE 2 combined must be UNDER 240 characters. The URL takes the remaining ~40 chars to reach Twitter's 280 limit. If you go over 240 the tweet WILL be cut off.

   STRICT RULES:
   - LINE 1 must SUMMARIZE the community's discussions. Cover multiple topics, not just one.
   - NEVER mention usernames or agent names. Say "agents on Moltbook" instead.
   - ENGLISH ONLY. The entire tweet must be in English. Do NOT include non-English words, phrases, or titles even if a post was in another language. Translate or skip non-English content.
   - ZERO emojis. ZERO hashtags. No exceptions.
   - Do NOT start with a quote or metaphor. Start with WHAT is being discussed.
   - Do NOT repeat or paraphrase a post title as your entire LINE 1.
   - Tone: knowledgeable insider reporting trends.

   BAD (quote-led, copies example, emoji):
   "🪼 The hidden cost of relying on context window size highlights challenges.\\n'Memory is expensive.'"

   GOOD (summary of THIS batch's actual topics, no emoji):
   "Agents on Moltbook are [topic 1 from YOUR analysis], [topic 2], and [topic 3].\\n'[a real quote from the comments above]'"

   CRITICAL: Write about the ACTUAL posts and comments listed above. Do NOT copy or paraphrase this example. Your tweet MUST reference the specific topSubjects you identified in field #2.

Return ONLY valid JSON:
{"sentiment": "...", "topSubjects": [...], "commonalities": "...", "notablePost": "...", "notablePostIndex": 1, "tweet": "..."}`;

  let analysis = null;
  try {
    const llmResult = await llm(analysisPrompt, { timeoutMs: 60000, format: "json", skipLanguageDetection: true });
    if (llmResult.success && llmResult.data?.text) {
      const cleaned = llmResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      analysis = JSON.parse(cleaned);
    }
  } catch (e) {
    console.error("[moltbook] FNA analysis failed:", e.message);
  }

  if (!analysis) {
    output += `❌ LLM analysis failed. Could not generate tweet.\n`;
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "facelessNiche" } };
  }

  // ── Learning: Extract insights from FNA analysis ──
  try {
    if (analysis.topSubjects?.length > 0) {
      // Use the notable post as a reference
      const notableIdx = (analysis.notablePostIndex || 1) - 1;
      const notablePost = allPosts[notableIdx] || allPosts[0];
      const refId = await addLearningRef({
        source: `moltbook/m/${targetSubmolt}`,
        summary: analysis.commonalities || "",
        quote: topComments[0]?.content?.substring(0, 100) || "",
        postTitle: notablePost?.title || analysis.notablePost || "",
      });

      // Each topSubject becomes an interest
      for (const subject of analysis.topSubjects.slice(0, 3)) {
        await upsertInterest(subject, refId);
      }
      console.log(`[moltbook] FNA learning: ${analysis.topSubjects.length} interests extracted from m/${targetSubmolt}`);
    }
  } catch (e) {
    console.warn("[moltbook] FNA learning extraction failed:", e.message);
  }

  // Validate: tweet must reference at least one of the topSubjects (catch stale/copied responses)
  const tweetLower = (analysis.tweet || "").toLowerCase();
  const subjects = (analysis.topSubjects || []).map(s => s.toLowerCase());
  const mentionsAnySubject = subjects.some(s => {
    // Check if any significant word (4+ chars) from the subject appears in the tweet
    const words = s.split(/\s+/).filter(w => w.length >= 4);
    return words.some(w => tweetLower.includes(w));
  });

  if (!mentionsAnySubject && subjects.length > 0) {
    console.warn(`[moltbook] FNA: Tweet doesn't match analysis subjects (${subjects.join(", ")}). Regenerating...`);
    // Force a simple tweet from the analysis data instead of using the LLM's stale output
    const subjectList = subjects.slice(0, 3).join(", ");
    analysis.tweet = `Agents on Moltbook are discussing ${subjectList}.`;
    // Try to grab a quote from comments if available
    if (topComments.length > 0) {
      const bestComment = topComments[0];
      const quote = (bestComment.content || "").substring(0, 50).trim();
      if (quote.length > 10) {
        analysis.tweet += `\n'${quote}'`;
      }
    }
  }

  // The URL is appended by us, NOT by the LLM — this guarantees it's never truncated
  const submoltUrl = `https://www.moltbook.com/m/${targetSubmolt}`;

  // Clean up LLM output: real newlines, strip any LINK/URL the LLM may have included, strip emojis
  let tweetBody = (analysis.tweet || "")
    .replace(/\\n/g, "\n")
    .replace(/LINK/g, "")
    .replace(/https?:\/\/\S+/g, "")       // strip any URLs the LLM snuck in
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu, "") // strip emojis
    .replace(/\n\s*\n/g, "\n")            // collapse empty lines
    .trim();

  // Budget: 280 total (Twitter limit) - URL length - 1 newline before URL
  const maxBodyLen = 280 - submoltUrl.length - 1;

  // Truncate body if needed, preserving the 2-line structure (line 1 = summary, line 2 = quote)
  if (tweetBody.length > maxBodyLen) {
    const lines = tweetBody.split("\n");
    if (lines.length >= 2) {
      let line1 = lines.slice(0, -1).join(" ").trim();
      let line2 = lines[lines.length - 1].trim();

      // Cap line 2 (quote) at 60 chars max — it's supplementary, not the main content
      const maxQuoteLen = 60;
      if (line2.length > maxQuoteLen) {
        // Try to cut at a word boundary
        let cutPoint = line2.lastIndexOf(" ", maxQuoteLen - 1);
        if (cutPoint < 20) cutPoint = maxQuoteLen - 1;
        // Preserve closing quote if present
        const quoteChar = line2.startsWith("'") ? "'" : "";
        line2 = line2.substring(0, cutPoint).replace(/[',.\s]+$/, "") + "…" + quoteChar;
      }

      // Now fit line 1 into remaining budget
      const maxLine1 = maxBodyLen - line2.length - 1; // -1 for \n between lines
      if (maxLine1 > 50) {
        if (line1.length > maxLine1) {
          let cutPoint = line1.lastIndexOf(" ", maxLine1 - 1);
          if (cutPoint < 30) cutPoint = maxLine1 - 1;
          line1 = line1.substring(0, cutPoint).replace(/[,.\s]+$/, "") + "…";
        }
        tweetBody = line1 + "\n" + line2;
      } else {
        // Quote too long even after cap — drop it entirely, use line 1 only
        if (line1.length > maxBodyLen) {
          let cutPoint = line1.lastIndexOf(" ", maxBodyLen - 1);
          if (cutPoint < 30) cutPoint = maxBodyLen - 1;
          line1 = line1.substring(0, cutPoint).replace(/[,.\s]+$/, "") + "…";
        }
        tweetBody = line1;
      }
    }
    // Final safety truncate (should rarely fire now)
    if (tweetBody.length > maxBodyLen) {
      tweetBody = tweetBody.substring(0, maxBodyLen - 1) + "…";
    }
  }

  // Assemble final tweet: body + newline + URL (guaranteed to fit in 280)
  let tweetText = tweetBody + "\n" + submoltUrl;

  // Safety check (should never fire, but just in case)
  if (tweetText.length > 280) {
    tweetText = tweetText.substring(0, 279) + "…";
  }

  output += `**📊 Analysis Results:**\n`;
  output += `- **Sentiment:** ${analysis.sentiment || "unknown"}\n`;
  output += `- **Top Subjects:** ${(analysis.topSubjects || []).join(", ")}\n`;
  output += `- **Commonalities:** ${analysis.commonalities || "N/A"}\n`;
  output += `- **Notable Post:** ${analysis.notablePost || "N/A"}\n`;
  output += `- **Community Link:** ${submoltUrl}\n`;
  output += `\n**🐦 Generated Tweet (${tweetText.length}/280 chars):**\n`;
  output += `> ${tweetText.split("\n").join("\n> ")}\n`;

  // ── Step 4: Post tweet (unless dry run) ──
  let tweetPosted = false;
  let tweetUrl = null;

  if (!isDryRun) {
    try {
      // Dynamic import of X tool to post tweet
      const { x } = await import("./x.js");
      const tweetResult = await x({ text: `post to x: ${tweetText}`, context: { action: "post" } });

      if (tweetResult?.success) {
        tweetPosted = true;
        tweetUrl = tweetResult.data?.raw?.url || null;
        output += `\n✅ **Tweet posted!** ${tweetUrl ? `🔗 ${tweetUrl}` : ""}\n`;

        // Store tweet info for reply scanning
        const mem = await getMemory();
        if (!mem.meta.moltbook.fna) mem.meta.moltbook.fna = {};
        mem.meta.moltbook.fna.lastTweet = {
          text: tweetText,
          url: tweetUrl,
          submolt: targetSubmolt,
          postedAt: new Date().toISOString(),
          tweetId: tweetResult.data?.raw?.id || null,
        };
        mem.meta.moltbook.fna.replyScansRemaining = 30; // scan for 30 minutes
        await saveJSON(MEMORY_FILE, mem);
      } else {
        output += `\n⚠️ Tweet posting failed: ${tweetResult?.data?.text || "unknown error"}\n`;
      }
    } catch (e) {
      output += `\n⚠️ Could not post tweet: ${e.message}\n`;
      console.error("[moltbook] FNA tweet post failed:", e.message);
    }
  } else {
    output += `\n_(Dry run — tweet NOT posted. Say "moltbook faceless niche run" to post live.)_\n`;
  }

  // ── Log the analysis to JSON ──
  try {
    await fs.mkdir(SENTIMENT_LOG_DIR, { recursive: true });
    const logFile = path.join(SENTIMENT_LOG_DIR, "fna_log.json");
    let existing = [];
    try { existing = JSON.parse(await fs.readFile(logFile, "utf8")); } catch { /* new file */ }
    existing.push({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      submolt: targetSubmolt,
      postsAnalyzed: allPosts.length,
      commentsAnalyzed: topComments.length,
      sentiment: analysis.sentiment,
      topSubjects: analysis.topSubjects,
      commonalities: analysis.commonalities,
      notablePost: analysis.notablePost,
      tweet: tweetText,
      tweetPosted,
      tweetUrl,
      isDryRun,
    });
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2), "utf8");
  } catch (e) {
    console.warn("[moltbook] FNA log write failed:", e.message);
  }

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true, text: output.trim(),
      action: "facelessNiche",
      analysis, tweetText, tweetPosted, tweetUrl,
      submolt: targetSubmolt,
    }
  };
}

/**
 * Faceless Niche Authority — Reply Scanner.
 * Checks for replies to the last FNA tweet and auto-responds.
 * Designed to be called once per minute for 30 minutes after a tweet.
 */
async function handleFNAReplyScan(text, context) {
  const mem = await getMemory();
  const fna = mem.meta?.moltbook?.fna;

  if (!fna?.lastTweet?.tweetId) {
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: "No recent FNA tweet to scan replies for.", action: "fnaReplyScan" } };
  }

  const scansRemaining = fna.replyScansRemaining ?? 0;
  if (scansRemaining <= 0) {
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: "Reply scan period has ended (30 minutes). No more scans needed.", action: "fnaReplyScan" } };
  }

  // Decrement scan counter
  fna.replyScansRemaining = scansRemaining - 1;
  await saveJSON(MEMORY_FILE, mem);

  let output = `**🔍 FNA Reply Scan** (${scansRemaining - 1} scans remaining)\n`;
  output += `Checking replies to: "${(fna.lastTweet.text || "").substring(0, 60)}..."\n\n`;

  try {
    // Use X tool to search for replies
    const { x } = await import("./x.js");
    // Search for replies using conversation_id or quote tweets
    const searchQuery = `to:${process.env.TWITTER_USERNAME || "lanou_agent"} OR @${process.env.TWITTER_USERNAME || "lanou_agent"}`;
    const searchResult = await x({ text: `search tweets: ${searchQuery}`, context: { action: "search" } });

    if (searchResult?.success && searchResult.data?.raw?.tweets?.tweets?.length > 0) {
      const replies = searchResult.data.raw.tweets.tweets;
      const repliedTo = fna.repliedTo || [];

      for (const reply of replies.slice(0, 5)) {
        if (!reply.id || repliedTo.includes(reply.id)) continue;

        // Generate a response using LLM
        const replyPrompt = `Someone replied to your tweet about Moltbook's m/${fna.lastTweet.submolt} community. Write a brief, engaging reply (max 280 chars). Be knowledgeable, reference the original context. Don't be generic.

Your original tweet: "${fna.lastTweet.text}"
Their reply: "${reply.text || ""}"\nBy: @${reply.author || "unknown"}

Return ONLY the reply text, no JSON.`;

        const llmReply = await llm(replyPrompt, { timeoutMs: 30000 });
        if (llmReply.success && llmReply.data?.text) {
          const replyText = llmReply.data.text.trim().substring(0, 280);

          // Post the reply
          try {
            const { TwitterClient } = await import("../utils/twitter-client.js");
            // TODO: implement reply posting via TwitterClient when available
            output += `  💬 Would reply to @${reply.author}: "${replyText.substring(0, 80)}..."\n`;
            repliedTo.push(reply.id);
          } catch (e) {
            output += `  ⚠️ Reply posting not yet implemented\n`;
          }
        }
      }

      // Save replied-to list
      fna.repliedTo = repliedTo;
      await saveJSON(MEMORY_FILE, mem);

      if (replies.length === 0) {
        output += `  No new replies found.\n`;
      }
    } else {
      output += `  No replies found yet.\n`;
    }
  } catch (e) {
    output += `  ⚠️ Reply scan error: ${e.message}\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "fnaReplyScan" } };
}

// ──────────────────────────────────────────────────────────
// STATUS
// ──────────────────────────────────────────────────────────

async function handleStatus() {
  const creds = loadCredentials();
  const apiKey = getApiKey();

  let statusText = "**Moltbook Status**\n\n";
  statusText += `Credentials file: ${fsSync.existsSync(CREDS_FILE) ? "✅ exists" : "❌ not found"}\n`;
  statusText += `API Key: ${apiKey ? "✅ configured (" + apiKey.substring(0, 10) + "...)" : "❌ not configured"}\n`;

  if (creds) {
    statusText += `Agent name: ${creds.agent_name || "N/A"}\n`;
    statusText += `Registered: ${creds.registered_at || "N/A"}\n`;
    if (creds.claim_url) statusText += `Claim URL: ${creds.claim_url}\n`;
  }

  if (apiKey) {
    // Check API connection
    const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
    if (meResult.ok) {
      const me = meResult.data;
      statusText += `\nAPI Connection: **✅ Active**\n`;
      statusText += `Account status: ${me.status || me.claim_status || "unknown"}\n`;
      if (me.karma != null) statusText += `Karma: ${me.karma}\n`;
      if (me.post_count != null) statusText += `Posts: ${me.post_count}\n`;
    } else {
      statusText += `\nAPI Connection: **❌ Failed** (HTTP ${meResult.status})\n`;
    }

    // Check claim status
    const claimResult = await apiRequest("GET", "/agents/status", null, apiKey);
    if (claimResult.ok) {
      statusText += `Claim status: ${claimResult.data?.status || claimResult.data?.claim_status || JSON.stringify(claimResult.data)}\n`;
    }
  } else {
    statusText += `\nTo register: say "Register on Moltbook"`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: statusText, action: "status" } };
}

// ──────────────────────────────────────────────────────────
// HTML BUILDERS — Rich rendering for moltbook content
// ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildPostHTML(post, options = {}) {
  const author = getAgentName(post.author);
  const score = post.score ?? 0;
  const comments = post.comment_count ?? 0;
  const date = post.created_at ? new Date(post.created_at).toLocaleDateString() : "";
  const submolt = post.submolt_name || "general";
  const MAX_CONTENT_LENGTH = 2000;
  let rawContent = post.content || "";
  let truncated = false;
  if (rawContent.length > MAX_CONTENT_LENGTH) {
    rawContent = rawContent.substring(0, MAX_CONTENT_LENGTH);
    truncated = true;
  }
  const content = escapeHtml(rawContent).replace(/\n/g, "<br>") + (truncated ? `<br><em class="moltbook-truncated">... [content truncated — ${(post.content.length / 1000).toFixed(1)}k chars total]</em>` : "");
  const title = escapeHtml(post.title || "Untitled");
  const id = post.id ? post.id.substring(0, 8) : "";

  return `<div class="moltbook-post-card">
    <div class="moltbook-post-header">
      <span class="moltbook-author">🤖 ${escapeHtml(author)}</span>
      <span class="moltbook-meta">${date} · m/${escapeHtml(submolt)} · ⬆️ ${score} · 💬 ${comments}${id ? ` · <code>${id}</code>` : ""}</span>
    </div>
    <h3 class="moltbook-post-title">${title}</h3>
    <div class="moltbook-post-body">${content}</div>
    ${options.agentOpinion ? `<div class="moltbook-agent-opinion"><strong>🧠 My Take:</strong> ${escapeHtml(options.agentOpinion)}</div>` : ""}
    ${options.footer || ""}
  </div>`;
}

function buildCommentHTML(comment, opinion) {
  const author = getAgentName(comment.author);
  const score = comment.score ?? 0;
  const content = escapeHtml(comment.content || "").replace(/\n/g, "<br>");
  const date = comment.created_at ? new Date(comment.created_at).toLocaleDateString() : "";

  return `<div class="moltbook-comment">
    <div class="moltbook-comment-header">
      <span class="moltbook-author">🤖 ${escapeHtml(author)}</span>
      <span class="moltbook-score">⬆️ ${score}</span>
      ${date ? `<span class="moltbook-meta">${date}</span>` : ""}
    </div>
    <div class="moltbook-comment-body">${content}</div>
    ${opinion ? `<div class="moltbook-tooltip">🧠 ${escapeHtml(opinion)}</div>` : ""}
  </div>`;
}

function buildCommentsListHTML(comments, opinions = []) {
  const items = comments.map((c, i) => buildCommentHTML(c, opinions[i])).join("");
  return `<div class="moltbook-comments-container">
    <h3 class="moltbook-section-title">💬 Comments (${comments.length})</h3>
    <p class="moltbook-hint">Hover over a comment to see my opinion</p>
    ${items}
  </div>`;
}

function buildFeedHTML(posts, title = "Moltbook Feed") {
  if (!posts || posts.length === 0) {
    return `<div class="moltbook-feed"><h3 class="moltbook-section-title">${escapeHtml(title)}</h3><p>No posts found.</p></div>`;
  }
  const cards = posts.slice(0, 15).map(p => buildPostHTML(p)).join("");
  return `<div class="moltbook-feed">
    <h3 class="moltbook-section-title">${escapeHtml(title)}</h3>
    <div class="moltbook-feed-grid">${cards}</div>
  </div>`;
}

function buildProfileHTML(agent) {
  const name = escapeHtml(agent.name || "N/A");
  const desc = escapeHtml(agent.description || "No description");
  const status = escapeHtml(agent.status || agent.claim_status || "N/A");
  const joined = agent.created_at ? new Date(agent.created_at).toLocaleDateString() : "N/A";

  return `<div class="moltbook-profile-card">
    <h3 class="moltbook-section-title">👤 ${name}</h3>
    <div class="moltbook-profile-body">
      <p class="moltbook-profile-desc">${desc}</p>
      <div class="moltbook-profile-stats">
        ${agent.karma != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.karma}</span><span class="moltbook-stat-label">Karma</span></div>` : ""}
        ${agent.post_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.post_count}</span><span class="moltbook-stat-label">Posts</span></div>` : ""}
        ${agent.comment_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.comment_count}</span><span class="moltbook-stat-label">Comments</span></div>` : ""}
        ${agent.follower_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.follower_count}</span><span class="moltbook-stat-label">Followers</span></div>` : ""}
        ${agent.following_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.following_count}</span><span class="moltbook-stat-label">Following</span></div>` : ""}
      </div>
      <div class="moltbook-profile-meta">
        <span>Status: ${status}</span> · <span>Joined: ${joined}</span>
      </div>
    </div>
  </div>`;
}

function buildSentimentReportHTML(report) {
  const { breakdown, topTopics, commonalities, overallSentiment, newPostsCount, trendingPostsCount } = report;
  const total = (breakdown.positive || 0) + (breakdown.negative || 0) + (breakdown.neutral || 0) + (breakdown.mixed || 0);
  const pct = (val) => total > 0 ? Math.round((val / total) * 100) : 0;

  const topicsHTML = (topTopics || []).slice(0, 10).map(t =>
    `<div class="moltbook-topic-tag"><span class="moltbook-topic-name">${escapeHtml(t.topic)}</span><span class="moltbook-topic-count">${t.count}</span></div>`
  ).join("");

  const commonalitiesHTML = (commonalities || []).map(c =>
    `<div class="moltbook-commonality-card">
      <div class="moltbook-commonality-header">${escapeHtml(c.description)}</div>
      <div class="moltbook-commonality-meta">${c.postCount} posts · Sentiment: ${escapeHtml(c.sentiment)}</div>
    </div>`
  ).join("");

  return `<div class="moltbook-sentiment-report">
    <h3 class="moltbook-section-title">📊 Moltbook Sentiment Report</h3>
    <div class="moltbook-sentiment-summary">
      <p>Analyzed <strong>${newPostsCount}</strong> new posts and <strong>${trendingPostsCount}</strong> trending posts</p>
      <p>Overall mood: <strong>${escapeHtml(overallSentiment)}</strong></p>
    </div>
    <div class="moltbook-sentiment-bars">
      <div class="moltbook-bar moltbook-bar-positive" style="width: ${pct(breakdown.positive || 0)}%"><span>😊 Positive ${pct(breakdown.positive || 0)}%</span></div>
      <div class="moltbook-bar moltbook-bar-neutral" style="width: ${pct(breakdown.neutral || 0)}%"><span>😐 Neutral ${pct(breakdown.neutral || 0)}%</span></div>
      <div class="moltbook-bar moltbook-bar-negative" style="width: ${pct(breakdown.negative || 0)}%"><span>😠 Negative ${pct(breakdown.negative || 0)}%</span></div>
      ${breakdown.mixed ? `<div class="moltbook-bar moltbook-bar-mixed" style="width: ${pct(breakdown.mixed)}%"><span>🤔 Mixed ${pct(breakdown.mixed)}%</span></div>` : ""}
    </div>
    ${topicsHTML ? `<div class="moltbook-topics-section"><h4>🏷️ Top Topics</h4><div class="moltbook-topics-grid">${topicsHTML}</div></div>` : ""}
    ${commonalitiesHTML ? `<div class="moltbook-commonalities-section"><h4>🔗 Commonalities</h4>${commonalitiesHTML}</div>` : ""}
  </div>`;
}

function buildHomeHTML(home) {
  const announcements = (home.announcements || []).map(a =>
    `<div class="moltbook-announcement">📢 ${escapeHtml(a.title || a.content || String(a))}</div>`
  ).join("");

  const unread = home.notifications?.unread_count || 0;
  const dmUnread = home.dms?.unread_count || 0;
  const dmPending = home.dms?.pending_count || 0;
  const activity = home.activity || {};

  return `<div class="moltbook-home-dashboard">
    <h3 class="moltbook-section-title">🏠 Moltbook Dashboard</h3>
    ${announcements ? `<div class="moltbook-announcements">${announcements}</div>` : ""}
    <div class="moltbook-home-stats">
      <div class="moltbook-stat"><span class="moltbook-stat-value">${unread}</span><span class="moltbook-stat-label">🔔 Unread</span></div>
      <div class="moltbook-stat"><span class="moltbook-stat-value">${dmUnread}</span><span class="moltbook-stat-label">💬 DMs</span></div>
      ${dmPending ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${dmPending}</span><span class="moltbook-stat-label">📩 Pending</span></div>` : ""}
      ${activity.posts_today != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${activity.posts_today}</span><span class="moltbook-stat-label">📝 Posts Today</span></div>` : ""}
      ${activity.comments_today != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${activity.comments_today}</span><span class="moltbook-stat-label">💬 Comments</span></div>` : ""}
      ${activity.karma != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${activity.karma}</span><span class="moltbook-stat-label">⭐ Karma</span></div>` : ""}
    </div>
  </div>`;
}

// ──────────────────────────────────────────────────────────
// SENTIMENT LOGGING — SQL-ready JSON storage
// ──────────────────────────────────────────────────────────

async function logSentimentReport(report) {
  try {
    await fs.mkdir(SENTIMENT_LOG_DIR, { recursive: true });
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: "moltbook_sentiment",
      newPostsAnalyzed: report.newPostsCount,
      trendingPostsAnalyzed: report.trendingPostsCount,
      overallSentiment: report.overallSentiment,
      sentimentBreakdown: report.breakdown,
      topTopics: report.topTopics,
      commonalities: report.commonalities,
      rawScores: report.rawScores
    };

    const logFile = path.join(SENTIMENT_LOG_DIR, "sentiment_log.json");
    let existing = [];
    try { existing = JSON.parse(await fs.readFile(logFile, "utf8")); } catch {}
    existing.push(entry);
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2), "utf8");
    console.log(`[moltbook] Sentiment report logged: ${entry.id}`);
    return entry;
  } catch (e) {
    console.warn("[moltbook] Failed to log sentiment report:", e.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────

function getAgentName(obj) {
  if (!obj) return "unknown";
  if (typeof obj === "string") return obj;
  return obj.name || obj.agent_name || obj.display_name || obj.username || "unknown";
}

// NEW: Generates a clickable markdown link for the agent's profile
function getAgentLink(obj) {
  const name = getAgentName(obj);
  if (name === "unknown") return "unknown";
  return `[${name}](https://www.moltbook.com/agents/${encodeURIComponent(name)})`;
}

function formatPostsList(data, title, withHtml = false) {
  const posts = Array.isArray(data) ? data : (data?.posts || data?.results || []);
  let output = `**${title}**\n\n`;

  if (posts.length === 0) {
    output += "No posts found.\n";
  } else {
    for (const p of posts.slice(0, 15)) {
      const score = p.score != null ? `[${p.score}]` : "";
      const comments = p.comment_count != null ? `(${p.comment_count} comments)` : "";
      const id = p.id ? ` \`${p.id.substring(0, 8)}\`` : "";
      const authorLink = getAgentLink(p.author);
      output += `${score} **${p.title || "Untitled"}** — ${authorLink} ${comments}${id}\n`;
      if (p.content) output += `  ${p.content.substring(0, 120)}...\n`;
    }
  }

  const html = withHtml ? buildFeedHTML(posts, title) : undefined;
  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "feed", posts } };
}

function noApiKeyError(action) {
  return {
    tool: "moltbook", success: false, final: true,
    data: {
      text: `No Moltbook API key configured. To get started:\n\n1. Say: "Register on Moltbook"\n2. I'll create an agent account and save the API key\n3. Your human owner will need to verify via the claim URL\n\nOr set MOLTBOOK_API_KEY in your .env file.`,
      action, needsRegistration: true
    }
  };
}

function apiError(action, result) {
  const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data || "Unknown error");
  return { tool: "moltbook", success: false, final: true, data: { text: `Moltbook ${action} failed (HTTP ${result.status}): ${errMsg}`, action, statusCode: result.status, error: errMsg } };
}

// ──────────────────────────────────────────────────────────
// MAIN TOOL — Routes to all handlers
// ──────────────────────────────────────────────────────────

export async function moltbook(input) {
  try {
    const text = typeof input === "string" ? input : (input?.text || "");
    const context = typeof input === "object" ? (input?.context || {}) : {};

    // Extract custom agent name if specified: "register on moltbook as MyName"
    if (!context.agentName) {
      const nameMatch = text.match(/(?:register|sign\s*up|join).*?\bas\s+["']?([A-Za-z0-9_-]+)["']?/i);
      if (nameMatch) context.agentName = nameMatch[1];
    }

    // Trust our Regex engine first. If it finds a specific action, use it.
    // If it defaults to "feed", see if the LLM provided a better context action.
    const inferred = inferAction(text);
    const action = (inferred !== "feed") ? inferred : (context.action || "feed");

    console.log(`[moltbook] Action: ${action}`);

    switch (action) {
      // Registration & Auth
      case "register":       return await handleRegister(text, context);
      case "setupEmail":     return await handleSetupEmail(text, context);

      // Profile
      case "profile":        return await handleProfile(text, context);
      case "updateProfile":  return await handleUpdateProfile(text, context);
      case "viewProfile":    return await handleViewProfile(text, context);

      // Feeds & Discovery
      case "feed":           return await handleFeed(text, context);
      case "home":           return await handleHome(text, context);
      case "search":         return await handleSearch(text, context);

      // Posts
      case "post":           return await handlePost(text, context);
      case "getPost":        return await handleReadPost(text, context);
      case "deletePost":     return await handleDeletePost(text, context);
      case "myPosts":        return await handleMyPosts(text, context); // <-- Add this line!

      // Comments
      case "comment":        return await handleComment(text, context);
      case "getComments":    return await handleGetComments(text, context);

      // Voting
      case "vote":           return await handleVote(text, context);

      // Following
      case "follow":         return await handleFollow(text, context);
      case "unfollow":       return await handleUnfollow(text, context);

      // Communities
      case "communities":    return await handleCommunities(text, context);
      case "subscribe":      return await handleSubscribe(text, context);
      case "createSubmolt":       return await handleCreateSubmolt(text, context);
      case "unlockCommunities":  return await handleUnlockCommunities(text, context);
      case "submoltFeed":         return await handleSubmoltFeed(text, context);

      // DMs
      case "dm":             return await handleDM(text, context);
      case "dm_inbox":       return await handleDMInbox(text, context);
      case "dm_requests":    return await handleDMRequests(text, context);

      // Notifications
      case "notifications":  return await handleNotifications(text, context);

      // Sentiment
      case "sentiment":      return await handleSentiment(text, context);

      // Faceless Niche Authority
      case "facelessNiche":    return await handleFacelessNiche(text, context);
      case "fnaReplyScan":     return await handleFNAReplyScan(text, context);

      // Learning
      case "learning":       return await handleLearning(text, context);

      // Status & Heartbeat
      case "heartbeat":      return await handleHeartbeat(text, context);
      case "status":         return await handleStatus();

      default:               return await handleFeed(text, context);
    }
  } catch (err) {
    quietMode = false; // Always reset on error
    console.error("[moltbook] Error:", err);
    return {
      tool: "moltbook", success: false, final: true,
      error: err.message, data: { text: `Moltbook error: ${err.message}` }
    };
  }
}

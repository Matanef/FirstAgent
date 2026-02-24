// server/planner.js
// COMPLETE MULTI-STEP PLANNER (patched): diagnostic routing, tool availability checks,
// safe improvement plans (no calls to missing tools), and clearer certainty logging.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { llm } from "./tools/llm.js";
import { getMemory } from "./memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// UTIL: list available tools (reads server/tools/*.js)
// ============================================================
function listAvailableTools(toolsDir = path.resolve(__dirname, "tools")) {
  try {
    const files = fs.readdirSync(toolsDir, { withFileTypes: true });
    return files
      .filter(f => f.isFile() && f.name.endsWith(".js"))
      .map(f => f.name.replace(/\.js$/, ""));
  } catch (e) {
    console.warn("[planner] listAvailableTools failed:", e?.message || e);
    return [];
  }
}

// ============================================================
// IMPROVEMENT REQUEST DETECTION
// ============================================================

/**
 * Detect improvement/self-improvement requests
 * These require a multi-step sequence: githubTrending → review → applyPatch (or llm fallback)
 */
function isImprovementRequest(message) {
  const lower = (message || "").toLowerCase();

  const patterns = [
    /improve.*(?:tool|code|file)/i,
    /suggest.*improvement/i,
    /review.*and.*(?:improve|suggest|patch|commit)/i,
    /scan.*trending.*and.*(?:improve|review|suggest)/i,
    /self[- ]?improve/i,
    /patch.*(?:tool|code)/i,
    /enhance.*(?:based on|against)/i,
    /commit[- ]?able.*improvement/i,
    /trending.*patterns.*review/i
  ];

  return patterns.some(p => p.test(lower));
}

/**
 * Extract target file from improvement request
 */
function extractImprovementTarget(message) {
  const lower = (message || "").toLowerCase();

  // Match "our X tool" or "the X tool"
  const toolMatch = message.match(/(?:our|the)\s+([a-z]+)\s+tool/i);
  if (toolMatch) {
    return `${toolMatch[1]}.js`;
  }

  // Match specific tool names
  const tools = ['email', 'file', 'search', 'news', 'weather', 'finance', 'github', 'review', 'calculator'];
  for (const tool of tools) {
    if (lower.includes(tool)) {
      return `${tool}.js`;
    }
  }

  return 'email.js'; // Default fallback
}

/**
 * Generate safe improvement steps, avoiding missing tools by using llm fallbacks.
 * availableTools: array of tool names (without .js)
 */
function generateImprovementSteps(message, availableTools = []) {
  const target = extractImprovementTarget(message);
  const baseName = target.replace('.js', '');

  // Extract search query for githubTrending
  let searchQuery = `${baseName} patterns best practices`;
  const trendingMatch = message.match(/trending.*for\s+([^,]+?)(?:\s+patterns|\s+and|,|$)/i);
  if (trendingMatch) {
    searchQuery = trendingMatch[1].trim();
  }

  console.log(`📋 Generating safe improvement sequence:`);
  console.log(`   Target: ${target}`);
  console.log(`   Search: ${searchQuery}`);

  const plan = [];

  const substitutions = [];

  // Step 1: githubTrending (safe if available, otherwise llm fallback)
  if (availableTools.includes('githubTrending')) {
    plan.push({ tool: 'githubTrending', input: searchQuery, context: {}, reasoning: 'Search trending repositories for patterns' });
  } else {
    plan.push({ tool: 'llm', input: `Search summary: list best practices for ${baseName} patterns.`, context: {}, reasoning: 'fallback_githubTrending' });
    substitutions.push('githubTrending → llm (not available)');
  }

  // Step 2: review (safe if available, otherwise llm fallback)
  if (availableTools.includes('review')) {
    plan.push({ tool: 'review', input: target, context: {}, reasoning: `Review current ${target} implementation` });
  } else {
    plan.push({ tool: 'llm', input: `Review summary: analyze ${target} and list issues and improvement suggestions.`, context: {}, reasoning: 'fallback_review' });
    substitutions.push('review → llm (not available)');
  }

  // Step 3: applyPatch (only if available) else produce patch text via llm
  if (availableTools.includes('applyPatch')) {
    plan.push({ tool: 'applyPatch', input: target, context: { targetFile: target }, reasoning: `Apply improvements to ${target} based on review and patterns` });
  } else {
    plan.push({ tool: 'llm', input: `Propose a patch (diff) for ${target} that implements the suggested improvements from the review.`, context: {}, reasoning: 'generate_patch_text' });
    substitutions.push('applyPatch → llm (not available)');
  }

  // Steps 4-5: gitLocal status + add (no commit - unreliable due to staging issues)
  if (availableTools.includes('gitLocal')) {
    plan.push({ tool: 'gitLocal', input: 'status', context: {}, reasoning: 'Check git status after changes' });
    plan.push({ tool: 'gitLocal', input: `add ${target}`, context: {}, reasoning: `Stage ${target} for commit` });
  } else {
    plan.push({ tool: 'llm', input: `Provide git commands to check status and stage ${target}`, context: {}, reasoning: 'git_instructions_fallback' });
    substitutions.push('gitLocal → llm (not available)');
  }

  if (substitutions.length > 0) {
    console.log(`⚠️ Tool substitutions: ${substitutions.join(', ')}`);
  }

  return plan;
}

// ============================================================
// CERTAINTY LAYER HELPERS
// ============================================================

function isMathExpression(msg) {
  const trimmed = (msg || "").trim();
  if (!/[0-9]/.test(trimmed)) return false;
  if (/[+\-*/^=()]/.test(trimmed)) return true;
  return /^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed);
}

function isSimpleDateTime(msg) {
  const lower = (msg || "").toLowerCase().trim();
  return (
    /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
    /^(date|time|day|month|year) (today|now)/.test(lower)
  );
}

function hasExplicitFilePath(text) {
  return /[a-z]:[\\/]/i.test(text || "");
}

function isSendItCommand(text) {
  const trimmed = (text || "").trim().toLowerCase();
  return (
    trimmed === "send it" ||
    trimmed === "send" ||
    trimmed === "yes send it" ||
    trimmed === "yes, send it" ||
    trimmed === "send the email" ||
    trimmed === "confirm" ||
    (trimmed === "yes" && (text || "").length < 10)
  );
}

function isCancelCommand(text) {
  const trimmed = (text || "").trim().toLowerCase();
  return (
    trimmed === "cancel" ||
    trimmed === "discard" ||
    trimmed === "don't send" ||
    trimmed === "dont send" ||
    trimmed === "never mind" ||
    trimmed === "nevermind" ||
    trimmed === "abort"
  );
}

function isMemoryWriteCommand(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return /^remember\s+(my\s+|that\s+|the\s+)?/i.test(lower);
}

const WEATHER_KEYWORDS = [
  "weather", "forecast", "temperature", "temp", "rain", "raining",
  "snow", "snowing", "humidity", "wind", "windy", "sunny", "cloudy"
];

const FORGET_SYNONYMS = ["forget", "forgot", "remove", "clear", "delete"];

function containsKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(k => new RegExp(`\\b${k}\\b`, "i").test(lower));
}

function locationWithForgetLike(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\blocation\b/.test(lower)) return false;
  return FORGET_SYNONYMS.some(s => lower.includes(s));
}

function hereIndicatesWeather(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\bhere\b/.test(lower)) return false;
  return containsKeyword(lower, WEATHER_KEYWORDS);
}

function extractCity(message) {
  // Strip trailing punctuation before matching
  const lower = (message || "").toLowerCase().trim().replace(/[?.!,;:]+$/, '');
  const inMatch = lower.match(/\bin\s+([a-zA-Z\s\-]+)$/);
  if (inMatch) return formatCity(inMatch[1]);
  const forMatch = lower.match(/\bfor\s+([a-zA-Z\s\-]+)$/);
  if (forMatch) return formatCity(forMatch[1]);
  return null;
}

function formatCity(city) {
  return city.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ============================================================
// DIAGNOSTIC / ACCURACY DETECTION
// ============================================================

/**
 * Return a deterministic routing decision for diagnostic/meta questions
 * (routing, accuracy, reliability, explain planner, debug, why did you choose).
 * Returns an array of tool steps or null if no match.
 */
function checkDiagnosticQuestion(message) {
  if (!message) return null;
  const lower = message.toLowerCase().trim();

  // common diagnostic patterns
  const diagPatterns = [
    /\bhow (accurate|reliable|precise)\b/,
    /\b(routing|route|router|planner|classifier|intent|intentions|tool selection)\b/,
    /\b(routing accuracy|accuracy of the routing|how accurate is your routing|how accurate is your planner)\b/,
    /\bwhy did you choose\b/,
    /\bexplain (your|the) (routing|planner|decision|choice)\b/,
    /\bcan you check your routing\b/,
    /\bdebug (the )?(planner|routing)\b/
  ];

  if (diagPatterns.some(rx => rx.test(lower))) {
    // Prefer selfImprovement for explicit "improve" style questions,
    // otherwise use llm for explanation/diagnostic.
    if (/\b(improve|self[- ]?improve|suggest improvement|how can you improve)\b/.test(lower)) {
      return [{ tool: "selfImprovement", input: message, context: {}, reasoning: "certainty_diagnostic_self_improve" }];
    }
    return [{ tool: "llm", input: `Explain planner routing and accuracy for: ${message}`, context: {}, reasoning: "certainty_diagnostic_explain" }];
  }

  return null;
}

// ============================================================
// LLM CLASSIFIER (For single-step plans)
// ============================================================

function extractContextSignals(message) {
  const lower = (message || "").toLowerCase();
  const signals = [];

  if (hasExplicitFilePath(message)) signals.push("CONTAINS_FILE_PATH");
  if (/\b(github|repo|repository)\b/i.test(message)) signals.push("MENTIONS_GITHUB");
  if (/\b(trending|popular|top)\b/i.test(lower)) signals.push("MENTIONS_TRENDING");
  if (/\b(stock|share|ticker)\b/i.test(lower)) signals.push("MENTIONS_FINANCE");
  if (containsKeyword(lower, WEATHER_KEYWORDS)) signals.push("MENTIONS_WEATHER");
  if (/\b(news|headline|article)\b/i.test(lower)) signals.push("MENTIONS_NEWS");
  if (/\b(email|mail)\b/i.test(lower)) signals.push("MENTIONS_EMAIL");
  if (/\b(review|inspect|examine)\b/i.test(lower)) signals.push("MENTIONS_REVIEW");
  if (/\b(improve|improvement|patch)\b/i.test(lower)) signals.push("MENTIONS_SELF_IMPROVEMENT");

  return signals;
}

async function detectIntentWithLLM(message, contextSignals, availableTools = []) {
  const signalText = contextSignals.length > 0
    ? `\nCONTEXT SIGNALS: ${contextSignals.join(", ")}`
    : "";

  const toolsListText = availableTools.length > 0 ? `\nAVAILABLE TOOLS: ${availableTools.join(", ")}` : "";

  const prompt = `You are an intent classifier for an AI agent. Classify the user's message into ONE tool.

${toolsListText}

USER MESSAGE:
"${message}"
${signalText}

CRITICAL RULES:
1. If the user asks about the system's accuracy, reliability, routing, planner, or why a tool was chosen (phrases like "how accurate", "routing accuracy", "why did you choose"), return "llm" (explain) or "selfImprovement" (if the user explicitly asks to improve).
2. "list repos" → github (NOT file)
3. "list D:/..." → file
4. "trending" → githubTrending
5. NEVER use nlp_tool unless explicitly asked for "sentiment" or "analyze text"
6. For improvement requests, prefer "selfImprovement" or the safe improvement plan generator
7. "moltbook" (any mention) → moltbook (site-specific web interaction tool)
8. "browse/visit/navigate [website]" → webBrowser (general web browsing tool)
9. "store/save/remember password/credentials" → moltbook or webBrowser (NOT memorytool)

Respond with ONLY the tool name.`;

  try {
    const response = await llm(prompt);
    if (!response.success || !response.data?.text) {
      return { intent: "llm", reason: "fallback" };
    }

    const text = response.data.text.trim().toLowerCase();
    const intent = text.split("|")[0].trim().replace(/[^a-z_]/g, "");

    console.log("🧠 LLM classified:", intent);

    return { intent, reason: "llm_classified", context: {} };
  } catch (err) {
    console.error("LLM intent error:", err.message);
    return { intent: "llm", reason: "error_fallback" };
  }
}

// ============================================================
// MAIN PLAN FUNCTION - Returns ARRAY of steps
// ============================================================

export async function plan({ message, chatContext = {} }) {
  const trimmed = (message || "").trim();
  const lower = trimmed.toLowerCase();

  console.log("🧠 Planning steps for:", trimmed);

  // Compute available tools once per plan
  const availableTools = listAvailableTools();
  console.log("[planner] availableTools:", availableTools.join(", "));

  // ──────────────────────────────────────────────────────────
  // FILE REVIEW: route to fileReview when files are attached
  // ──────────────────────────────────────────────────────────
  if (chatContext.fileIds && chatContext.fileIds.length > 0) {
    console.log(`[planner] certainty branch: fileReview (${chatContext.fileIds.length} files)`);
    return [{ tool: "fileReview", input: trimmed, context: { fileIds: chatContext.fileIds }, reasoning: "certainty_file_review" }];
  }

  // ──────────────────────────────────────────────────────────
  // DUPLICATE SCANNER: detect duplicate scan requests
  // ──────────────────────────────────────────────────────────
  if (/\b(duplicate|duplication|find\s+duplicate|scan\s+duplicate|duplicate\s+file)/i.test(lower)) {
    console.log("[planner] certainty branch: duplicateScanner");
    // Parse any context from the natural language
    const dupContext = {};
    const pathMatch = trimmed.match(/(?:in|under|at|from)\s+([a-zA-Z]:[\\\/][^\s,]+|[.\/][^\s,]+)/i);
    if (pathMatch) dupContext.path = pathMatch[1];
    const typeMatch = lower.match(/(?:that are|type)\s+(\.\w+|\w+)\s+files?/);
    if (typeMatch) dupContext.type = typeMatch[1];
    const extMatch = lower.match(/\.(txt|js|jsx|ts|tsx|json|css|md|py|html|xml|csv)\b/);
    if (!dupContext.type && extMatch) dupContext.type = extMatch[0];
    const nameMatch = trimmed.match(/(?:named?|called)\s+["']?([^"'\s,]+)["']?/i);
    if (nameMatch) dupContext.name = nameMatch[1];

    return [{ tool: "duplicateScanner", input: trimmed, context: dupContext, reasoning: "certainty_duplicate_scan" }];
  }

  // ──────────────────────────────────────────────────────────
  // DIAGNOSTIC: handle meta/routing/accuracy questions first
  // ──────────────────────────────────────────────────────────
  const diagnosticDecision = checkDiagnosticQuestion(trimmed);
  if (diagnosticDecision) {
    console.log("[planner] certainty branch: diagnostic ->", diagnosticDecision[0].tool);
    return diagnosticDecision;
  }

  // ──────────────────────────────────────────────────────────
  // MULTI-STEP: Improvement Requests (safe plan)
  // ──────────────────────────────────────────────────────────
  if (isImprovementRequest(trimmed)) {
    console.log(`🎯 Detected improvement request - generating 5-step sequence`);
    const planSteps = generateImprovementSteps(trimmed, availableTools);
    console.log("[planner] improvement plan steps:", planSteps.map(s => s.tool).join(" -> "));
    return planSteps;
  }

  // ──────────────────────────────────────────────────────────
  // SINGLE-STEP: Certainty Layer (deterministic short commands)
  // ──────────────────────────────────────────────────────────

  // Math
  if (isMathExpression(trimmed)) {
    console.log("[planner] certainty branch: math");
    return [{ tool: "calculator", input: trimmed, context: {}, reasoning: "certainty_math" }];
  }

  // DateTime
  if (isSimpleDateTime(trimmed)) {
    console.log("[planner] certainty branch: datetime");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_datetime" }];
  }

  // Email confirmation
  if (isSendItCommand(lower)) {
    console.log("[planner] certainty branch: email_confirm");
    return [{ tool: "email_confirm", input: trimmed, context: { action: "send_confirmed", sessionId: chatContext?.sessionId || "default" }, reasoning: "certainty_email_confirm" }];
  }

  // Cancel / discard
  if (isCancelCommand(lower)) {
    console.log("[planner] certainty branch: cancel");
    return [{ tool: "email_confirm", input: trimmed, context: { action: "cancel", sessionId: chatContext?.sessionId || "default" }, reasoning: "certainty_cancel" }];
  }

  // Memory write ("remember my email is X", "remember that X")
  if (isMemoryWriteCommand(lower)) {
    console.log("[planner] certainty branch: memory_write");
    return [{ tool: "memorytool", input: trimmed, context: {}, reasoning: "certainty_memory_write" }];
  }

  // Forget location
  if (locationWithForgetLike(lower)) {
    console.log("[planner] certainty branch: forget_location");
    return [{ tool: "memorytool", input: trimmed, context: { raw: "forget_location" }, reasoning: "certainty_forget_location" }];
  }

  // Weather here
  if (hereIndicatesWeather(lower)) {
    console.log("[planner] certainty branch: here_weather");
    return [{ tool: "weather", input: trimmed, context: { city: "__USE_GEOLOCATION__" }, reasoning: "certainty_here_weather" }];
  }

  // Weather with city (or from memory)
  if (containsKeyword(lower, WEATHER_KEYWORDS)) {
    let extracted = extractCity(trimmed);
    // If no city extracted, check memory for saved location
    if (!extracted) {
      try {
        const memory = await getMemory();
        const profile = memory.profile || {};
        const savedLocation = profile.location || profile.city || null;
        if (savedLocation) {
          extracted = formatCity(savedLocation);
          console.log(`[planner] Using saved location from memory: ${extracted}`);
        }
      } catch (e) {
        console.warn("[planner] Could not read memory for location:", e.message);
      }
    }
    const context = extracted ? { city: extracted } : {};
    console.log("[planner] certainty branch: weather, city:", extracted || "none");
    return [{ tool: "weather", input: trimmed, context, reasoning: "certainty_weather" }];
  }

  // News keywords (before file path to avoid misroute)
  if (/\b(latest|recent|breaking|today'?s)?\s*(news|headlines?|articles?)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: news");
    return [{ tool: "news", input: trimmed, context: {}, reasoning: "certainty_news" }];
  }

  // ──────────────────────────────────────────────────────────
  // CREDENTIAL SAFETY GUARD: prevent passwords from going to memory tool
  // ──────────────────────────────────────────────────────────
  if (/\b(remember|save|store)\b/i.test(lower) && /\b(password|credential|login)\b/i.test(lower)) {
    if (/\bmoltbook\b/i.test(lower)) {
      console.log("[planner] certainty branch: moltbook credential store (safety guard)");
      return [{ tool: "moltbook", input: trimmed, context: { action: "storeCredentials" }, reasoning: "certainty_credential_store" }];
    }
    // For other sites, route to webBrowser credential storage
    console.log("[planner] certainty branch: webBrowser credential store (safety guard)");
    const domainMatch = lower.match(/\b([a-z0-9-]+\.(?:com|org|net|io|dev|app|co))\b/);
    return [{ tool: "webBrowser", input: trimmed, context: { action: "setCredentials", service: domainMatch?.[1] || "default" }, reasoning: "certainty_credential_store" }];
  }

  // ──────────────────────────────────────────────────────────
  // MOLTBOOK: Multi-step registration + verification
  // ──────────────────────────────────────────────────────────
  if (/\bmoltbook\b/i.test(lower) && /\b(register|sign\s*up)\b/i.test(lower) && /\b(verify|verification|confirm)\b/i.test(lower)) {
    console.log("[planner] certainty branch: moltbook register + verify (multi-step)");
    return [
      { tool: "moltbook", input: trimmed, context: { action: "register" }, reasoning: "moltbook_register" },
      { tool: "moltbook", input: "check verification email and click link", context: { action: "verify_email" }, reasoning: "moltbook_verify" },
      { tool: "moltbook", input: "check login status", context: { action: "status" }, reasoning: "moltbook_verify_status" }
    ];
  }

  // ──────────────────────────────────────────────────────────
  // MOLTBOOK: Single-action detection
  // ──────────────────────────────────────────────────────────
  if (/\bmoltbook\b/i.test(lower)) {
    console.log("[planner] certainty branch: moltbook");
    const context = {};
    if (/\b(register|sign\s*up|create\s+account)\b/i.test(lower)) context.action = "register";
    else if (/\b(log\s*in|sign\s*in)\b/i.test(lower)) context.action = "login";
    else if (/\b(log\s*out|sign\s*out)\b/i.test(lower)) context.action = "logout";
    else if (/\b(profile|my\s+account|settings)\b/i.test(lower)) context.action = "profile";
    else if (/\b(search|find|look\s+for)\b/i.test(lower)) context.action = "search";
    else if (/\b(status|session|check)\b/i.test(lower)) context.action = "status";
    else if (/\b(verify|verification)\s*(email)?\b/i.test(lower)) context.action = "verify_email";
    else context.action = "browse";
    return [{ tool: "moltbook", input: trimmed, context, reasoning: "certainty_moltbook" }];
  }

  // ──────────────────────────────────────────────────────────
  // GENERAL WEB BROWSING: domain-like patterns with browse verbs
  // ──────────────────────────────────────────────────────────
  if (/\b(browse|navigate|visit|go\s+to|open)\b/i.test(lower) && /\b[a-z0-9-]+\.(?:com|org|net|io|dev|app|co)\b/i.test(lower)) {
    console.log("[planner] certainty branch: webBrowser");
    return [{ tool: "webBrowser", input: trimmed, context: {}, reasoning: "certainty_web_browse" }];
  }

  // URL detection → webDownload (fetch and read/follow)
  if (/https?:\/\/\S+/i.test(trimmed)) {
    console.log("[planner] certainty branch: url_detected");
    return [{ tool: "webDownload", input: trimmed, context: {}, reasoning: "certainty_url" }];
  }

  // Explicit file path
  if (hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: file_path");
    return [{ tool: "file", input: trimmed, context: {}, reasoning: "certainty_file_path" }];
  }

  // ──────────────────────────────────────────────────────────
  // SINGLE-STEP: LLM Classifier (fallback)
  // ──────────────────────────────────────────────────────────

  const contextSignals = extractContextSignals(trimmed);
  console.log("🧠 Context signals:", contextSignals);

  const detection = await detectIntentWithLLM(trimmed, contextSignals, availableTools);
  console.log("🎯 LLM classified:", detection.intent);

  // Normalize tool name
  const toolMap = {
    'financefundamentals': 'financeFundamentals',
    'nlptool': 'nlp_tool',
    'githubtrendin': 'githubTrending',
    'gitlocal': 'gitLocal',
    'applypatch': 'applyPatch'
  };
  const tool = toolMap[detection.intent] || detection.intent;

  // If the LLM chose a tool that doesn't exist, substitute a safe fallback
  if (!availableTools.includes(tool)) {
    console.warn(`[planner] LLM chose unavailable tool "${tool}". Substituting llm fallback.`);
    return [{
      tool: "llm",
      input: `Fallback: the requested tool "${tool}" is not available. Please handle the user's request: ${trimmed}`,
      context: {},
      reasoning: `fallback_unavailable_${tool}`
    }];
  }

  return [{
    tool,
    input: trimmed,
    context: detection.context || {},
    reasoning: detection.reason
  }];
}
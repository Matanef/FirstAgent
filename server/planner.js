// server/planner.js
// COMPLETE MULTI-STEP PLANNER (patched): diagnostic routing, tool availability checks,
// safe improvement plans (no calls to missing tools), and clearer certainty logging.
import { llm, pickModelForContent } from "./tools/llm.js"; // Add pickModelForContent
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMemory } from "./memory.js";
import { CONFIG } from "./utils/config.js";
import { detectCorrection, logCorrection, buildCorrectionContext } from "./intentDebugger.js";
import { dynamicSkills } from "./executor.js";
import { logRoutingDecision } from "./routes/dashboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Module-level constants (avoid re-creating on every plan() call) ──
const FINANCE_COMPANIES = /\b(tesla|apple|google|alphabet|amazon|microsoft|meta|nvidia|amd|intel|netflix|disney|boeing|ford|paypal|uber|spotify|shopify|check\s*point|checkpoint|fortinet|palo\s*alto|crowdstrike|crowd\s*strike|crowed\s*strike|zscaler|sentinelone|cyberark|jp\s*morgan|goldman\s*sachs|visa|mastercard|pfizer|moderna|coinbase|palantir)\b/i;
const FINANCE_INTENT = /\b(doing|price|worth|trading|performance|value|stock|share|market|up|down|earnings|revenue)\b/i;

// "Why" questions about stocks/markets are RESEARCH questions, not price lookups
// e.g. "why are cybersecurity stocks dropping?" → search, NOT finance
const FINANCE_RESEARCH_QUESTION = /\b(why\s+(did|are|is|do|has|have|were|was)|what\s+caused|what\s+happened|reason|explain)\b.*\b(stock|share|price|market|drop|crash|fall|decline|surge|rally|jump)/i;

// Track last routing decision for user correction feedback
let _lastRoutingDecision = { userMessage: null, tool: null, reasoning: null };

// ============================================================
// UTIL: list available tools (reads server/tools/*.js + dynamic skills)
// ============================================================
// Utility-only modules in server/tools/ that are NOT routable tools.
// These export helper functions used by actual tools — they should NEVER
// appear in the LLM's available tool list or they'll cause hallucinated routing.
const NON_ROUTABLE_MODULES = new Set([
  "emailUtils",      // regex/sentiment helpers for email.js
  "geminiValidator",  // code validation helper for codeTransform.js
  "testGen",          // test generation utility
  "index",            // the tool registry itself
]);

function listAvailableTools(toolsDir = path.resolve(__dirname, "tools")) {
  try {
    // 1. Get standard tools — filter out utility modules that aren't routable
    const files = fs.readdirSync(toolsDir, { withFileTypes: true });
    const coreTools = files
      .filter(f => f.isFile() && f.name.endsWith(".js"))
      .map(f => f.name.replace(/\.js$/, ""))
      .filter(name => !NON_ROUTABLE_MODULES.has(name));

    // 2. Get dynamic skills
    const dynTools = Object.keys(dynamicSkills || {});

    // 3. Combine them and remove any accidental duplicates
    return [...new Set([...coreTools, ...dynTools])];
  } catch (e) {
    console.warn("[planner] listAvailableTools failed:", e?.message || e);
    return Object.keys(dynamicSkills || {});
  }
}

// ============================================================
// IMPROVEMENT REQUEST DETECTION
// ============================================================

// NOTE: Improvement request routing (isImprovementRequest/generateImprovementSteps)
// was removed — now handled by selfEvolve + codeTransform tools directly.

// ============================================================
// CERTAINTY LAYER HELPERS
// ============================================================

function isMathExpression(msg) {
  const trimmed = (msg || "").trim();
  if (!/[0-9]/.test(trimmed)) return false;

  // Reject if the message is clearly natural language (> 60 chars or many words)
  if (trimmed.length > 80) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > 10) return false;

  // Reject if message contains file paths (D:/, C:\, etc.)
  if (/[a-z]:[\\\/]/i.test(trimmed)) return false;

  // Reject if message contains dates
  if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(trimmed)) return false;
  if (/\d{4}-\d{1,2}-\d{1,2}/.test(trimmed)) return false;

  // Reject if message contains email addresses
  if (/[\w.+-]+@[\w.-]+\.\w{2,}/.test(trimmed)) return false;

  // 🚀 NEW GUARD: Reject UUIDs / Hashes (prevents DM IDs from triggering math)
  if (/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(trimmed)) return false;

  // Reject if parentheses contain words
  if (/\([^)]*[a-zA-Z]{2,}[^)]*\)/.test(trimmed)) return false;

  // Only match if the core of the message is mathematical
  if (/\d\s*[+\-*/^]\s*\d/.test(trimmed)) return true;
  if (/\d\s*%\s*(of\s+)?\d/.test(trimmed)) return true;

  return /^\s*[\d\.\,\s()+\-*/^=%]+$/.test(trimmed);
}

// ============================================================
// PERSONAL CONVERSATION DETECTION
// Detects messages that are personal, emotional, reflective, or
// opinion-seeking — NOT tool requests disguised with first-person pronouns.
// ============================================================

// Tool-intent keywords that OVERRIDE personal detection even if pronouns are present.
// "I want to search for..." or "I need the weather" should NOT be personal.
const TOOL_INTENT_WORDS = /\b(search|find|get|fetch|show|list|check|look\s+up|browse|scan|download|generate|create|write|send|compose|draft|schedule|remind|play|open|read|review|analyze|calculate|convert|compare|what(?:'?s| is| are)\s+(?:the|my)\s+(?:weather|stock|email|news|score|task|calendar|inbox|forecast|price|trend)|tell\s+me\s+(?:the|about\s+the)\s+(?:weather|news|stock|score))\b/i;

// Genuine personal/emotional/reflective patterns — requires BOTH a first-person marker
// AND an emotional/reflective signal to fire.
const FIRST_PERSON = /\b(i|i'm|i've|i'll|i'd|my|me|myself)\b/i;
const EMOTIONAL_REFLECTIVE = /\b(feel|feeling|felt|think|thinking|thought|believe|wonder|wondering|worried|worry|anxious|stressed|burned?\s*out|overwhelm|happy|sad|angry|frustrated|confused|excited|proud|afraid|scared|lonely|grateful|thankful|tired|exhausted|motivated|unmotivated|struggle|struggling|cope|coping|dealing\s+with|going\s+through|miss|missed|love|hate|enjoy|bored|curious|conflicted|uncertain|hopeful|hopeless|depressed|inspired|disappointed|nervous|nostalgic|regret|appreciate|vent|venting|opinion|advice|perspective|honest|honestly|what\s+do\s+you\s+think|should\s+i|do\s+you\s+think|how\s+do\s+you\s+feel|what\s+would\s+you|can\s+we\s+talk|let'?s\s+talk|chat\s+about|between\s+us)\b/i;

// Short conversational messages that are inherently personal (no tool intent)
const PURE_CONVERSATIONAL = /^(hey|hi|hello|good\s+morning|good\s+evening|good\s+night|how\s+are\s+you|what'?s\s+up|sup|yo|thanks?|thank\s+you|you'?re?\s+(?:the\s+best|awesome|great|amazing)|nice|cool|lol|haha|wow|oh\s+really|that'?s\s+(?:interesting|cool|great|nice|funny|sad|crazy)|never\s+mind|forget\s+it|ok(?:ay)?|got\s+it|i\s+see|makes?\s+sense|fair\s+enough|good\s+point|true|right|bye|goodbye|see\s+you|brb|be\s+right\s+back|i'?ll?\s+be\s+(?:right\s+)?back|ttyl|talk\s+(?:to\s+you\s+)?later|gotta\s+go|i\s+need\s+to\s+restart\s+you.*|i'?m\s+(?:going\s+to\s+)?restart.*)\s*[.!?]*$/i;

function isPersonalConversation(lower, original) {
  // Pure short greetings/acknowledgments → always personal
  if (PURE_CONVERSATIONAL.test(original.trim())) return true;

  // GUARD: If any tool-intent word is present, this is NOT personal
  // "I want to search for crypto" → tool request, not personal
  if (TOOL_INTENT_WORDS.test(lower)) return false;

  // GUARD: If message contains a file path → likely a code/file operation
  if (/[a-zA-Z]:[\\\/]|\.(?:js|ts|py|css|html|json|md|jsx|tsx)\b/i.test(original)) return false;

  // GUARD: If message contains a URL → likely a web/tool request
  if (/https?:\/\/|www\./i.test(original)) return false;

  // GUARD: If message is very short (< 4 words) and doesn't match pure conversational
  // it's probably a command like "news" or "weather"
  const wordCount = original.trim().split(/\s+/).length;
  if (wordCount <= 2 && !FIRST_PERSON.test(lower)) return false;

  // Core detection: first-person + emotional/reflective signal
  if (FIRST_PERSON.test(lower) && EMOTIONAL_REFLECTIVE.test(lower)) return true;

  // Opinion-seeking without first-person: "what do you think about AI?"
  if (/\b(what\s+do\s+you\s+think|what'?s\s+your\s+(opinion|take|view|thought)|do\s+you\s+(?:think|believe|agree)|how\s+do\s+you\s+feel)\b/i.test(lower)) {
    // But NOT if it's about a tool topic: "what do you think about the stock price?"
    if (TOOL_INTENT_WORDS.test(lower)) return false;
    return true;
  }

  return false;
}

/**
 * Infer which tool to use from a step description (for compound query decomposition)
 */
function inferToolFromText(text) {
  const lower = (text || "").toLowerCase();
  if (/\b(weather|forecast|temperature)\b/.test(lower)) return "weather";
  if (/\b(email|inbox|mail|send\s+an?\s+email)\b/.test(lower)) return "email";
  if (/\b(news|headline|article)\b/.test(lower)) return "news";
  if (/\b(search|look\s+up|find|google)\b/.test(lower)) return "search";
  if (/\b(stock|finance|market|portfolio|price\s+of)\b/.test(lower) &&
      !/\b(why|what\s+caused|reason|explain)\b/.test(lower)) return "finance";
  if (/\b(sport|score|match|fixture|nba|nfl)\b/.test(lower)) return "sports";
  if (/\b(calendar|event|meeting|schedule|appointment)\b/.test(lower)) return "calendar";
  if (/\b(git|commit|branch|github)\b/.test(lower)) return "gitLocal";
  if (/\b(trending|popular\s+repos|scan\s+repos)\b/.test(lower)) return "githubTrending"; 
  if (/\b(task|todo|reminder)\b/.test(lower)) return "tasks";
  if (/\b(write|create|generate)\s+(a\s+)?(file|script)\b/.test(lower)) return "fileWrite";
  if (/\b(youtube|video)\b/.test(lower)) return "youtube";
  if (/\b(play|pause|skip|previous|spotify|music|song|track)\b/.test(lower)) return "spotifyController";
  if (/\b(chart|graph|plot|visualize|diagram)\b/.test(lower)) return "chartGenerator";
  if (/\b(tweet|twitter|x\s+trends?|trending\s+on\s+x)\b/.test(lower)) return "x";
  if (/\b(whatsapp|וואטסאפ|ווטסאפ)\b/.test(lower)) return "whatsapp";
  // "send [person/relation] a message" — route to whatsapp when target is a person/relation, not email
  if (/\b(send)\s+.{1,50}\b(message)\b/i.test(lower) && !/\b(email|mail)\b/.test(lower)) return "whatsapp";
  if (/\b(send)\s+(my\s+|to\s+my\s+)?(mom|dad|mother|father|brother|sister)\b/i.test(lower)) return "whatsapp";
  if (/(?:^|\s)(שלח|תשלח|שלחי)\s+.{0,50}(הודעה|מסרון)/i.test(lower)) return "whatsapp";

  // ── OBSIDIAN KNOWLEDGE OS ──
  if (/\b(obsidian|vault|create\s+note|write\s+note|populate\s+stubs?|reap\s+stubs?)\b/.test(lower)) return "obsidianWriter";
  if (/\b(deep\s+research|thesis|research\s+report|research\s+paper)\b/.test(lower)) return "deepResearch";
  if (/\b(git\s*pulse|code\s+report|engineering\s+review)\b/.test(lower)) return "gitPulse";
  if (/\b(what\s+changed)\b/.test(lower) && /\b(code|repo|commit|git)\b/.test(lower)) return "gitPulse";

  // ── CODE GURU & SYSTEM TOOLS ──
  if (/\b(apply\s*patch|full\s+rewrite|rewrite\s+entire)\b/.test(lower)) return "applyPatch";
  if (/\b(refactor|rewrite|transform|optimize|improve|modify)\b/.test(lower)) return "codeTransform";
  if (/\b(code\s+review|security|performance|quality|audit|smell)\b/.test(lower)) return "codeReview";
  if (/\b(review|inspect|examine)\b/.test(lower)) return "review"; // Fallback general review
  if (/\b(smart\s*evolut|discover\s+new\s+tools?|invent\s+tool)\b/.test(lower)) return "smartEvolution";
  if (/\b(evolve|autonomous|self[- ]?evolve)\b/.test(lower)) return "selfEvolve";
  if (/\b(dependency|graph|circular|dead\s+code)\b/.test(lower)) return "projectGraph";
  if (/\b(index|symbols|class|function\s+list)\b/.test(lower)) return "projectIndex";
  if (/\b(folder|directory|tree|scan\s+folder)\b/.test(lower)) return "folderAccess";
  if (/\b(duplicate)\b/.test(lower)) return "duplicateScanner";

  return "llm"; // fallback
}

function isSimpleDateTime(msg) {
  const lower = (msg || "").toLowerCase().trim();
  return (
    /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
    /^(date|time|day|month|year) (today|now)/.test(lower)
  );
}

/**
 * Detect if the intent is prose/text editing rather than code editing.
 * Returns true when the target is clearly a non-code document or the request
 * uses prose-specific language (e.g., "rewrite this article", "correct grammar").
 */
function isProseIntent(text) {
  const lower = (text || "").toLowerCase();
  // Non-code file extensions — if the only extension mentioned is one of these, it's prose
  const proseExtRe = /\.(md|txt|doc|docx|rtf|pdf|csv|html?)\b/i;
  const codeExtRe = /\.(js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|cs|php|sh|bash|zsh|ps1|sql|vue|svelte|yaml|yml|json|toml|ini|cfg)\b/i;
  const hasProse = proseExtRe.test(text);
  const hasCode = codeExtRe.test(text);
  // If only prose extensions are found (no code extensions), it's prose
  if (hasProse && !hasCode) return true;
  // Prose-specific verbs/nouns that don't apply to code
  if (/\b(grammar|proofread|spell.?check|copy.?edit|copywrite|prose|article|essay|blog\s*post|document|manuscript|hebrew|arabic|translate|translation|rewrite\s+(this|the|my)\s+(text|article|document|guide|post|page|paragraph|chapter|section))\b/i.test(lower)) return true;
  return false;
}

function hasExplicitFilePath(text) {
  if (!text) return false;
  // Absolute paths: D:/..., C:\...
  if (/[a-z]:[\\/]/i.test(text)) return true;
  // Relative paths with directory separator + extension: server/planner.js, ./utils/config.js
  // Must contain an actual path separator to avoid matching "Node.js", "Vue.js" etc.
  if (/[/\\]/.test(text) && /(?:^|\s)\.{0,2}\/?[\w.-]+\/[\w.-]+\.\w{1,5}\b/.test(text)) return true;
  return false;
}

/**
 * Detect if a message contains multiple distinct tool intents connected by conjunctions.
 * Used as a guard on single-tool certainty branches so compound queries fall through
 * to the compound detection patterns or LLM decomposer.
 */
function hasCompoundIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Pattern 1: "... and send/email/mail it/results/me/the ..."
  if (/\band\s+(?:then\s+)?(?:send|email|mail|forward)\s+(?:it|the|me|this|them|results?|summary|that|a)\b/i.test(lower)) return true;

  // Pattern 2: "... and send/email to <address>"
  if (/\band\s+(?:then\s+)?(?:send|email|mail)\b.{0,30}@/i.test(lower)) return true;

  // Pattern 3: review/analyze + and + create/write/generate (both intents present)
  if (/\b(?:review|analyze|inspect|examine|audit)\b/.test(lower) &&
      /\band\s+(?:then\s+)?(?:create|write|generate|make|produce|build)\b/i.test(lower)) return true;

  // Pattern 4: create/write + and + review/send (reversed order)
  if (/\b(?:create|write|generate)\b/.test(lower) &&
      /\band\s+(?:then\s+)?(?:review|analyze|send|email|inspect)\b/i.test(lower)) return true;

  // Pattern 5: explicit chaining words ("then", "finally", "after that", "next", "lastly")
  if (/\b(?:and\s+)?then\s+/i.test(lower) || /;\s*then\s+/i.test(lower)) return true;
  if (/\b(?:finally|lastly|after\s+that|next|afterwards)\s*[,.]?\s+/i.test(lower)) return true;

  // Pattern 5b: multi-step with "Use the LLM/agent/nlp/tool to..." mid-sentence
  if (/\buse\s+(?:the\s+)?(?:llm|agent|ai|nlp)\s+(?:tool\s+)?to\b/i.test(lower)) return true;

  // Pattern 5d: "summarize/analyze" + source tool keyword (news/moltbook/search/github) → compound
  if (/\b(?:summarize|analy[sz]e|break\s*down|explain)\b/i.test(lower) &&
      /\b(?:news|moltbook|search|articles?|headlines?|trending|github|repos?)\b/i.test(lower)) return true;

  // Pattern 5c: multi-tool pipeline keywords (search + categorize/summarize/analyze + save/append/sheet/send/whatsapp)
  if (/\b(?:search|find|get)\b/i.test(lower) &&
      /\b(?:categorize|classify|summarize|analyze|sentiment)\b/i.test(lower) &&
      /\b(?:append|save|write|sheet|spreadsheet|google|send|whatsapp|wa|email)\b/i.test(lower)) return true;

  // Pattern 6: "X and also Y"
  if (/\band\s+also\b/i.test(lower)) return true;

  // Pattern 7: email verb + email keyword + content-tool keyword (any word order)
  // Catches: "send an email with the summary of the news"
  //          "send matan an email with the news"
  //          "compose email with weather forecast"
  //          "sned an email with the news"
  if (/\b(?:send|compose|draft|forward|write|sned)\b/i.test(lower) &&
      /\b(?:email|e-mail|mail)\b/i.test(lower) &&
      /\b(?:news|weather|forecast|stock|score|finance|sport|headline|article)\b/i.test(lower)) return true;

  // Pattern 8: "email me the news/weather/stocks" (implicit compound)
  if (/\b(?:email|mail)\s+(?:me|us|him|her|them)\b/i.test(lower) &&
      /\b(?:news|weather|forecast|stock|score|finance|sport|headline|article)\b/i.test(lower)) return true;

  // Pattern 9: whatsapp + content-tool keyword (any word order)
  // "send a whatsapp with the weather", "whatsapp the news to 0587426393"
  if (/\b(?:whatsapp|ווטסאפ|וואטסאפ)\b/i.test(lower) &&
      /\b(?:news|weather|forecast|stock|score|finance|sport|headline|article)\b/i.test(lower)) return true;

  // Pattern 10: "X and send/whatsapp it to <phone number>"
  // "check weather and send it a whatsapp to 0587426393"
  if (/\band\s+(?:then\s+)?(?:send|whatsapp)\b/i.test(lower) &&
      /(?:\+?\d[\d\s\-\(\)]{6,18}\d)/.test(lower)) return true;

  // Pattern 11: X/twitter + content delivery (email/whatsapp)
  // "get twitter trends and email me", "get x trends and whatsapp to 0587426393"
  if (/\b(?:twitter|tweet|x\s+trends?|trending\s+on\s+x)\b/i.test(lower) &&
      /\b(?:email|whatsapp|send)\b/i.test(lower)) return true;

  // Pattern 12: Comma-separated list of distinct questions ("what is X, what is Y, and what is Z")
  if (/\b(?:what|how|check|show|get|list)\b.*?,.*?\b(?:what|how|check|show|get|list)\b/i.test(lower)) return true;

  return false;
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
    trimmed === "cancle" ||
    trimmed === "cancell" ||
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
  "snow", "snowing", "humidity", "wind", "windy", "sunny", "cloudy",
  "temperature history", "weather history", "weather trend", "seasonal weather",
  "how warm was", "how cold was"
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
  if (!message) return null;
  
  // 1. Initial cleanup: strip punctuation and common temporal "noise"
  let cleaned = message.toLowerCase().trim()
    .replace(/[?.!,;:]+$/, '')
    .replace(/\s+(today|tonight|tomorrow|this\s+week|this\s+weekend|next\s+week|right\s+now|currently|later|soon)\s*$/i, '');

  // 2. The "Greedy" Match: Look for keywords + city name, 
  // but STOP at conjunctions (and, then) or common temporal words.
  const match = cleaned.match(/\b(?:in|at|for|weather|forecast|of)\s+([a-z\s\-]+?)(?:\s+(?:and|then|today|now|right|$))/i);
  
  if (match) {
    return formatCity(match[1]);
  }

  // 3. Fallback: Your original "End of Sentence" logic 
  // (just in case the greedy match missed a specific phrasing)
  const fallbackMatch = cleaned.match(/\b(?:in|for)\s+([a-zA-Z\s\-]+)$/);
  if (fallbackMatch) {
    return formatCity(fallbackMatch[1]);
  }

  return null;
}

function formatCity(city) {
  return city.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ============================================================
// DECLARATIVE ROUTING TABLE
// ============================================================
// Instead of position-dependent if/else chains, this table uses explicit
// priority numbers. Higher priority = wins when multiple rules match.
//
// HOW TO ADD A NEW TOOL:
//   1. Add a rule object to ROUTING_TABLE below
//   2. Set a priority number (see guide)
//   3. Define match() — returns true if this tool should handle the message
//   4. Optionally define guard() — returns true to BLOCK this tool (e.g., compound intent)
//   5. Optionally define context() — returns the context object for the tool
//
// PRIORITY GUIDE:
//   95-99  Confirmations & overrides (send-it, cancel, file attachments)
//   85-94  Narrow-scope skills that beat broader tools (attachmentDownloader, githubScanner)
//   70-84  Standard tools with distinctive patterns (email, weather, calendar, sheets)
//   55-69  Broader tools (finance, sports, youtube, news)
//   40-54  Generic catch-alls (calculator, file, review)
//   20-39  Fallback routing (search, llm for general knowledge)
//
// The system evaluates ALL rules, picks the highest-priority match that
// passes its guard. No more "move this block above that block" surgery.
// ============================================================

const ROUTING_TABLE = [
  // ── TIER 1: Confirmations & overrides (95-99) ──────────────
  {
    tool: "email_confirm",
    priority: 99,
    match: (lower) => isSendItCommand(lower),
    context: (lower, trimmed, ctx) => ({ action: "send_confirmed", sessionId: ctx?.sessionId || "default" }),
    description: "Confirm and send email draft"
  },
  {
    tool: "email_confirm",
    priority: 98,
    match: (lower) => isCancelCommand(lower),
    context: (lower, trimmed, ctx) => ({ action: "cancel", sessionId: ctx?.sessionId || "default" }),
    description: "Cancel/discard email draft"
  },

  // ── TIER 2: Narrow-scope skills (85-94) ────────────────────
  {
    tool: "attachmentDownloader",
    priority: 92,
    match: (lower, trimmed) =>
      /\b(download|save|fetch|get)\b/i.test(lower) &&
      /\battachments?\b/i.test(lower) &&
      /[\w.+-]+@[\w.-]+\.\w{2,}/.test(trimmed) &&
      /\b(since|between|after|before|from\s+\d|starting)\b/i.test(lower),
    description: "Download email attachments by sender and date range"
  },
{
    tool: "llm",
    priority: 85,
    match: (lower) => 
      /\b(what('s| is) your name|who are you|what are you|your identity|tell me about yourself)\b/i.test(lower) ||
      /^(איך קוראים לך|מה השם שלך|מה שמך|מי את|מי אתה)/i.test(lower) ||
      /^\(system:\s*the user asked about your identity/i.test(lower),
    description: "Agent identity questions"
  },
  {
    tool: "moltbook",
    priority: 84,
    match: (lower) =>
      /\bmoltbook\b/i.test(lower) ||
      /\/api\/v\d\/agents?\b/i.test(lower) ||
      /\bsetup[- ]?owner[- ]?email\b/i.test(lower) ||
      // Allows approving/rejecting DMs without explicitly typing "moltbook"
      /\b(dm\s+request|approve\s+dm|reject\s+dm|check\s+dms|my\s+dms)\b/i.test(lower),
    guard: (lower) =>
      /\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate)\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(register|sign\s*up|create\s+account)\b/i.test(lower)) ctx.action = "register";
      else if (/\b(log\s*in|sign\s*in)\b/i.test(lower)) ctx.action = "login";
      else if (/\b(log\s*out|sign\s*out)\b/i.test(lower)) ctx.action = "logout";
      else if (/\b(dm\s+request|pending\s+request|approve\s+dm|reject\s+dm)\b/i.test(lower)) ctx.action = "dm_requests";
      else if (/\b(inbox|messages|conversations|my\s+dms|check\s+dms)\b/i.test(lower)) ctx.action = "dm_inbox";
      else if (/\b(dm|direct\s+message|private\s+message|send\s+dm|send\s+message)\b/i.test(lower)) ctx.action = "dm";
      else if (/\b(update\s+profile|change\s+description|edit\s+profile)\b/i.test(lower)) ctx.action = "updateProfile";
      else if (/\b(view\s+profile|profile\s+of|who\s+is|agent\s+profile)\b/i.test(lower)) ctx.action = "viewProfile";
      else if (/\b(my\s+(\w+\s+)?profile|my\s+account|show\s+profile)\b/i.test(lower)) ctx.action = "profile";
      else if (/\b(comments?\s+(on|for|about)|show\s+comments|read\s+comments|get\s+comments|view\s+comments|moltbook\s+comments)\b/i.test(lower)) ctx.action = "getComments";
      else if (/\b(comment|reply)\b/i.test(lower) && !/\bpost\b/i.test(lower)) ctx.action = "comment";
      else if (/\b(delete\s+post|remove\s+post)\b/i.test(lower)) ctx.action = "deletePost";
      else if (/\b(read\s+post|show\s+post|get\s+post|view\s+post)\b/i.test(lower)) ctx.action = "getPost";
      else if (/\b(post|publish|share|write)\b/i.test(lower)) ctx.action = "post";
      else if (/\b(upvote|downvote|vote)\b/i.test(lower)) ctx.action = "vote";
      else if (/\b(unfollow|unsubscribe)\b/i.test(lower)) ctx.action = "unfollow";
      else if (/\b(subscribe\s+to|join\s+submolt|join\s+community)\b/i.test(lower)) ctx.action = "subscribe";
      else if (/\b(follow)\b/i.test(lower)) ctx.action = "follow";
      else if (/\b(allow|unlock|approve|increase|raise).*(communit|submolt|more\s+communit)/i.test(lower)) ctx.action = "unlockCommunities";
      else if (/\b(create\s+submolt|create\s+community|new\s+submolt)\b/i.test(lower)) ctx.action = "createSubmolt";
      else if (/\b(submolt\s+feed|community\s+feed)\b/i.test(lower)) ctx.action = "submoltFeed";
      else if (/\b(communities?|submolts?)\b/i.test(lower)) ctx.action = "communities";
      else if (/\b(sentiment|mood|vibes?|pulse|atmosphere)\b/i.test(lower)) ctx.action = "sentiment";
      else if (/\b(search|find|look\s+for)\b/i.test(lower)) ctx.action = "search";
      else if (/\b(notification|read\s+all|mark\s+read|clear\s+notification)\b/i.test(lower)) ctx.action = "notifications";
      else if (/\b(home|dashboard)\b/i.test(lower)) ctx.action = "home";
      else if (/\b(feed|browse|timeline)\b/i.test(lower)) ctx.action = "feed";
      else if (/\b(heartbeat|check\s*in|routine|engage)\b/i.test(lower)) ctx.action = "heartbeat";
      else if (/\b(status|session|check)\b/i.test(lower)) ctx.action = "status";
      else if (/\b(set\s*up|setup|configure)\b/i.test(lower) && /\bemail\b/i.test(lower)) ctx.action = "setupEmail";
      else if (/\bsetup[- ]?owner[- ]?email\b/i.test(lower)) ctx.action = "setupEmail";
      else ctx.action = "feed";
      return ctx;
    },
    description: "Moltbook operations and interactions"
  },
  {
    tool: "githubScanner",
    priority: 88,
    match: (lower, trimmed) =>
      /\b(scan\s+github|github\s+scan|analyze\s+github|discover\s+tool|find\s+new\s+tool|github\s+intelligence|repo\s+scan|scan\s+repos?\s+for|github\s+pattern)\b/i.test(lower) ||
      (/\b(scan|analyze|check|review)\b/i.test(lower) && /\b(github|repositor(?:y|ies))\b/i.test(lower) && !hasExplicitFilePath(trimmed)),
    context: (lower) => {
      if (/\btrending|popular|hot\b/i.test(lower)) return { action: "trending" };
      if (/\bdiscover|find/i.test(lower)) return { action: "discover" };
      if (/\bpattern|practice/i.test(lower)) return { action: "patterns" };
      return { action: "scan" };
    },
    description: "Scan GitHub repos for patterns, tool discovery, AI analysis"
  },
  {
    tool: "duplicateScanner",
    priority: 86,
    match: (lower) => /\b(duplicates?|duplication|find\s+duplicates?|scan\s+duplicates?|duplicate\s+files?)\b/i.test(lower),
    context: (lower, trimmed) => {
      const ctx = {};
      const pathMatch = trimmed.match(/(?:in|under|at|from)\s+([a-zA-Z]:[\\\/][^\s,]+|[.\/][^\s,]+)/i);
      if (pathMatch) ctx.path = pathMatch[1];
      const typeMatch = lower.match(/(?:that are|type)\s+(\.\w+|\w+)\s+files?/);
      if (typeMatch) ctx.type = typeMatch[1];
      const extMatch = lower.match(/\.(txt|js|jsx|ts|tsx|json|css|md|py|html|xml|csv)\b/);
      if (!ctx.type && extMatch) ctx.type = extMatch[0];
      const nameMatch = trimmed.match(/(?:named?|called)\s+["']?([^"'\s,]+)["']?/i);
      if (nameMatch) ctx.name = nameMatch[1];
      return ctx;
    },
    description: "Find duplicate files in a directory"
  },

  // ── TIER 3: Standard tools with distinctive patterns (70-84) ──
  {
    tool: "memorytool",
    priority: 82,
    match: (lower) => isMemoryWriteCommand(lower),
    description: "Remember/save user info to memory"
  },
  {
    tool: "memorytool",
    priority: 81,
    match: (lower) => locationWithForgetLike(lower),
    context: () => ({ raw: "forget_location" }),
    description: "Forget saved location from memory"
  },
  {
    tool: "weather",
    priority: 78,
    match: (lower) => hereIndicatesWeather(lower),
    context: () => ({ city: "__USE_GEOLOCATION__" }),
    description: "Weather for current location (geolocation)"
  },
  {
    tool: "weather",
    priority: 75,
    match: (lower) => containsKeyword(lower, WEATHER_KEYWORDS),
    guard: (lower) =>
      /\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate)\b/i.test(lower) ||
      hasCompoundIntent(lower),
    // NOTE: city extraction + memory lookup requires async — handled by wrapper in evaluateRoutingTable
    contextAsync: true,
    description: "Weather forecast with city detection"
  },
  {
    tool: "projectSnapshot",
    priority: 75,
    match: (lower) => /\b(snapshot|show context|file snapshot|project snapshot)\b/i.test(lower),
    description: "Triggers compressed context snapshot generation"
  },
  {
    tool: "sheets",
    priority: 75,
    match: (lower) => /\b(google\s*sheet|spreadsheet|sheet\s*id|batch\s*append)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    context: (lower, trimmed) => {
      const ctx = {};
      if (/\b(read|get|fetch|show|view)\b/i.test(lower)) ctx.action = "read";
      else if (/\b(clear|wipe|empty)\b/i.test(lower)) ctx.action = "clear";
      else ctx.action = "append";
      const sheetIdMatch = lower.match(/(?:sheet\s*id\s*|spreadsheets\/d\/)([a-zA-Z0-9_-]{20,60})/i) || trimmed.match(/\b([a-zA-Z0-9_-]{25,60})\b/);
      if (sheetIdMatch) ctx.spreadsheetId = sheetIdMatch[1];
      return ctx;
    },
    description: "Google Sheets read/append/clear"
  },
  {
    tool: "email",
    priority: 72,
    match: (lower) =>
      /\b(emails?|e-mails?|mails?|inbox|send\s+to|draft\s+(an?\s+)?(emails?|messages?|letters?))\b/i.test(lower),
    guard: (lower, trimmed) =>
      (/\b(download|save|fetch|get)\b/i.test(lower) && /\battachments?\b/i.test(lower) && /\b(since|between|after|before|starting)\b/i.test(lower)) || // attachment download
      isSendItCommand(lower) ||
      hasCompoundIntent(lower) ||
      /\/api\/v\d\/agents?\b/i.test(lower) ||
      (/\b(set\s*up|setup|configure)\b/i.test(lower) && /\b(moltbook|owner[- ]?email)\b/i.test(lower)) ||
      // Guard: "add contact ... email: X" is contact management, not email composition
      (/\b(add|save|update|edit|remove|delete)\s+(an?\s+)?(contact|alias|nickname)\b/i.test(lower)) ||
      // Guard: "inspect/review email.js" is a code review, not email composition
      (hasExplicitFilePath(trimmed || lower) && /\b(inspect|review|audit|check|security|analyz|vulnerabilit|bug|issue|improv)\b/i.test(lower)) ||
      // Guard: "what's John's email?" is a contact lookup, not email composition
      /\b\w+'s\s+(email|phone|number)\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(check|read|browse|inbox|list|show|go\s+over|latest|recent|unread)\b/i.test(lower)) ctx.action = "browse";
      else if (/\b(delete|trash|remove)\b/i.test(lower)) ctx.action = "delete";
      else if (/\b(attachment|download)\b/i.test(lower)) ctx.action = "downloadAttachment";
      return ctx;
    },
    description: "Email compose, browse, or delete"
  },
  {
    tool: "whatsapp",
    priority: 72,
    match: (lower, trimmed) =>
      /\bsend\b/i.test(lower) &&
      /(?:\+?\d[\d\s\-()]{6,18}\d)/.test(trimmed) &&
      !/\b(email|e-mail|mail)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower) || /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower),
    description: "WhatsApp — phone number detected with send command"
  },
  {
    tool: "whatsapp",
    priority: 70,
    match: (lower) =>
      (/\b(whatsapp)\b/i.test(lower) || /(?:^|\s)(ווטסאפ|וואטסאפ)(?:\s|$)/.test(lower)) &&
      (/\b(send|bulk|mass|message)\b/i.test(lower) || /(?:^|\s)(שלח|תשלח|שלחי|קבוצת|הודעה)(?:\s|$)/.test(lower)),
    guard: (lower) => hasCompoundIntent(lower) || /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower),
    description: "WhatsApp — explicit keyword with send intent"
  },
  {
    tool: "whatsapp",
    priority: 68,
    match: (lower) =>
      // "send my mom/dad a message", "send shirly a welcoming message"
      (/\b(send)\s+(my\s+|to\s+my\s+)?(mom|dad|mother|father|brother|sister)\b/i.test(lower) ||
       /(?:^|\s)(שלח|תשלח|שלחי)\s+(ל)?(אמא|אימא|אבא|אחי|אחות)/i.test(lower) ||
       /\b(send)\s+\w+\s+a\s+\w+\s+message\b/i.test(lower)) &&
      !/\b(email|e-mail|mail)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower) || /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower),
    description: "WhatsApp — send message to person/relation by name"
  },
  {
    tool: "githubTrending",
    priority: 74,
    match: (lower) =>
      /\b(trending|popular|top)\b/i.test(lower) &&
      /\b(repo|repository|github|project|open\s*source)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    description: "Trending GitHub repositories"
  },
  {
    tool: "gitLocal",
    priority: 73,
    match: (lower) => /\b(git\s+(status|log|diff|add|commit|branch|checkout|stash|push|pull|reset))\b/i.test(lower),
    description: "Local git commands (status, log, diff, etc.)"
  },
  {
    tool: "calendar",
    priority: 71,
    match: (lower, trimmed) =>
      (/\b(extract|export|excel|xlsx|spreadsheet)\b/i.test(lower) ||
       /(?:חלץ|ייצא|אקסל|סרוק|לאקסל|ייצוא)/u.test(trimmed)) &&
      /\b(calendar|events?|לוח|אירוע|יומן)\b/iu.test(trimmed),
    context: () => ({ action: "extract" }),
    description: "Calendar extract/export to spreadsheet"
  },
  {
    tool: "calendar",
    priority: 70,
    match: (lower) =>
      /\b(calendar|meeting|appointment|schedule\s+(a|an|the)|set\s+(a|an)\s+(meeting|call|event|appointment)|add\s+to\s+(my\s+)?calendar|my\s+calendar|book\s+(a|an)\s+(room|meeting|call|appointment|dentist|doctor)|what\s+events?\b|my\s+events|am\s+i\s+(free|busy|available)|free\s+(time|slot|tomorrow|today|this)|availab(le|ility)\s+(today|tomorrow|this|next))\b/i.test(lower),
    guard: (lower) =>
      /\b(score|match|game|league|football|soccer|basketball|nba|nfl|sports?\s+events?)\b/i.test(lower) ||
      // Guard: recurring/automation keywords → scheduler, not calendar
      /\b(every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate)\b/i.test(lower) ||
      // Guard: "schedule a task/whatsapp/email" is not a calendar event
      /\bschedule\s+(a\s+)?(task|whatsapp|message|email|check|report|scan)\b/i.test(lower),
    description: "Calendar — meetings, events, availability"
  },

  // ── Obsidian Knowledge OS ──────────────────────────────────
  {
    tool: "obsidianWriter",
    priority: 74,
    match: (lower) =>
      /\b(obsidian|vault)\b/i.test(lower) ||
      (/\b(create|write|make|new)\b/i.test(lower) && /\b(note|canvas)\b/i.test(lower)) ||
      /\b(populate|fill|reap|clean|prune|delete)\s+(\w+\s+)?(stubs?|empty\s+notes?)\b/i.test(lower) ||
      /\b(append\s+to\s+note|read\s+note|list\s+notes?)\b/i.test(lower),
    guard: (lower) =>
      !hasCompoundIntent(lower) ? false :
      // Allow compound if BOTH parts involve obsidian
      /\b(obsidian|vault|note|canvas)\b/i.test(lower) ? false : true,
    description: "Obsidian vault — create/edit notes, canvas, stubs"
  },
  {
    tool: "gitPulse",
    priority: 67,
    match: (lower) =>
      /\b(git\s*pulse|code\s+report|engineering\s+review)\b/i.test(lower) ||
      (/\b(what\s+changed|what'?s\s+changed|what\s+happened)\b/i.test(lower) && /\b(code|repo|commit|git|today|this\s+week|yesterday|last\s+\d+\s+days?)\b/i.test(lower)),
    guard: (lower) =>
      // Simple git commands → let gitLocal handle those
      /\b(git\s+(add|commit|push|pull|checkout|branch|merge|stash|rebase|reset|status|log|diff|clone|init|fetch|tag|remote))\b/i.test(lower) &&
      !/\b(report|review|analysis|pulse|summary|overview)\b/i.test(lower),
    description: "Git Pulse — commit analysis, impact reports, Mermaid diagrams"
  },
{
    tool: "deepResearch",
    priority: 66,
    match: (lower) =>
      /\[depth:(article|indepth|in-depth|research|thesis)\]/i.test(lower) || // UI depth bar
      /\b(deep\s+research|thesis|research\s+report|research\s+paper)\b/i.test(lower) ||
      (/\b(comprehensive|thorough|exhaustive|in-?depth)\b/i.test(lower) && /\b(research|analysis|study|investigation|breakdown)\b/i.test(lower)) ||
      /^(?:please\s+|can\s+you\s+)?research\b/i.test(lower) || // Catches commands starting with "Research..."
      /(?:^|\s)(תזה|דוקטורט|עבודת\s+גמר|מחקר\s+מעמיק)(\s|$)/.test(lower), // Hebrew thesis/research keywords
    guard: (lower) =>
      (hasCompoundIntent(lower) && !/\b(research|thesis)\b/i.test(lower) && !/\[depth:/i.test(lower)) ||
      // Introspection about our own code that happens to mention "thesis/research" (e.g. the thesisSynthesizer
      // skill) must NOT trigger a research run. Bypass when the user is asking a code-config question.
      (/\b(where|how)\s+(do\s+(i|we)|can\s+(i|we)|to)\s+(set|configure|change|update|find|modify|edit|adjust|tweak|override)\b/i.test(lower) &&
       /\b(skill|tool|module|agent|pipeline|planner|executor|tier|prompt|config|setting|variable|function|class|route|router|manifest|budget|threshold|timeout|param(?:eter)?|synthesizer|harvester|analyzer|writer|bootstrapper|matcher|extractor|detector)\b/i.test(lower)),
    description: "Deep Research — recursive research engine with query expansion"
  },

  // ── TIER 4: Broader tools (55-69) ─────────────────────────
  {
    tool: "news",
    priority: 65,
    match: (lower) =>
      /\b(latest|recent|breaking|today'?s)?\s*(news|headlines?|articles?)\b/i.test(lower) ||
      /\bwhat'?s\s+(happening|going\s+on|new)\b/i.test(lower),
    guard: (lower, trimmed) =>
      hasExplicitFilePath(trimmed) ||
      /\bmoltbook\b/i.test(lower) ||
      hasCompoundIntent(lower) ||
      /\b(try\s+again|the\s+purpose|more\s+.{0,20}\s+like|give\s+(your\s*self|me)|as\s+a\s+.{0,30}\s+reporter|style|idea|concept|theme|approach|username|name\s+(your|the)|rename|rebrand)\b/i.test(lower) ||
      /\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily|weekly|recurring|cron|automate)\b/i.test(lower) ||
      isPersonalConversation(lower, trimmed),
    description: "News and headlines"
  },
  {
    tool: "finance",
    priority: 63,
    match: (lower, trimmed) =>
      (/\b(stocks?|share\s+price|ticker|market|portfolio|invest|dividend|earnings|S&P\s*500|nasdaq|dow\s+jones|trading|IPO|stock\s+price)\b/i.test(lower) ||
       (FINANCE_COMPANIES.test(lower) && FINANCE_INTENT.test(lower))),
    guard: (lower) =>
      hasCompoundIntent(lower) || FINANCE_RESEARCH_QUESTION.test(lower) ||
      // Yield to financeFundamentals for fundamentals-specific queries
      /\b(fundamentals?|P\/E|p\/e|pe\s+ratio|balance\s*sheet|income\s+statement|cash\s*flow|market\s*cap|revenue|quarterly|annual\s+report)\b/i.test(lower),
    context: (lower, trimmed) => {
      // Research questions without specific company → route to search instead
      const hasSpecificCompany = FINANCE_COMPANIES.test(lower) || /\b[A-Z]{2,5}\b/.test(trimmed);
      const isExplanatoryQ = /\b(why|what\s+caused|what\s+happened|reason)\b/i.test(lower);
      if (isExplanatoryQ && !hasSpecificCompany) return { __redirectTool: "search" };
      return {};
    },
    description: "Stock prices, market data, ticker lookups"
  },
  {
    tool: "financeFundamentals",
    priority: 62,
    match: (lower) =>
      /\b(fundamentals?|P\/E|pe\s+ratio|balance\s*sheet|income\s+statement|cash\s*flow|market\s*cap|quarterly|annual\s+report|revenue|earnings|eps|dividend\s+yield|beta)\b/i.test(lower) ||
      (FINANCE_COMPANIES.test(lower) && /\b(fundamentals?|financials?|report|analysis|revenue|earnings|market\s*cap)\b/i.test(lower)),
    description: "Financial fundamentals, P/E ratios, balance sheets, market cap, revenue"
  },
  {
    tool: "sports",
    priority: 60,
    match: (lower) =>
      /\b(score|match|game|league|team|player|football|soccer|basketball|nba|nfl|premier\s+league|champion|fixture|standings?|table)\b/i.test(lower) ||
      (/\b(play\s+next|next\s+(match|game|fixture)|when\s+does?\s+\w+\s+play)\b/i.test(lower) && /\b(arsenal|chelsea|liverpool|tottenham|spurs|manchester|man\s+(utd?|city)|barcelona|real\s+madrid|juventus|bayern|lakers|celtics|warriors|yankees|cowboys|patriots)\b/i.test(lower)),
    guard: (lower, trimmed) =>
      hasExplicitFilePath(trimmed) ||
      /\b(meeting|calendar|appointment|set\s+a|book\s+a|with\s+the\s+team)\b/i.test(lower) ||
      hasCompoundIntent(lower),
    description: "Sports scores, matches, leagues, fixtures"
  },
  {
    tool: "x",
    priority: 60,
    match: (lower) =>
      /\b(tweet|twitter|trending\s+on\s+x|x\s+trends?|twitter\s+trends?|tweets?\s+(about|from|by)|top\s+tweets?|x\s+posts?|complaint|pain\s*point|post\s+(on|to)\s+(x|twitter))\b/i.test(lower),
    guard: (lower, trimmed) => {
      const isScheduling = /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower);
      const isMultiToolChain = /\b(google\s*sheet|spreadsheet|append|aggregate|categorize\s+.*(save|write|sheet)|save\s+to\s+(sheet|sheets))\b/i.test(lower);
      const isMetaQ = /\b(why\s+did\s+you|what\s+tool|which\s+tool|how\s+does\s+(this|the)\s+tool|explain\s+(this|the)\s+tool)\b/i.test(lower);
      return isScheduling || isMultiToolChain || isMetaQ || hasCompoundIntent(lower) || isPersonalConversation(lower, trimmed);
    },
    context: (lower) => {
      const ctx = {};
      if (/\b(trends?|trending|popular|hot)\b/i.test(lower)) ctx.action = "trends";
      else if (/\b(sentiment|analyze|analysis|opinion|mood)\b/i.test(lower)) ctx.action = "analyze";
      else if (/\b(post|publish|compose)\s+(on|to)\s+(x|twitter)\b/i.test(lower)) ctx.action = "post";
      else if (/\b(complaint|pain\s*point|frustrat|looking\s+for\s+(a\s+)?better|advanced\s+search)\b/i.test(lower)) ctx.action = "leadgen";
      else ctx.action = "search";
      const countryMatch = lower.match(/\bin\s+(?:the\s+)?(israel|uk|united\s+kingdom|britain|us|usa|united\s+states|america|canada|brazil|mexico|france|germany|spain|italy|netherlands|sweden|turkey|russia|japan|india|australia|south\s+korea|korea|singapore|indonesia|philippines|thailand|south\s+africa|nigeria|egypt|kenya|jerusalem|tel\s*aviv)\b/i);
      if (countryMatch) ctx.country = countryMatch[1].toLowerCase().replace(/\s+/g, " ");
      else if (/\b(israel|jerusalem|tel\s*aviv|ישראל)\b/i.test(lower)) ctx.country = "israel";
      return ctx;
    },
    description: "X/Twitter — trends, search, post, lead gen, sentiment"
  },
{
    tool: "spotifyController",
    priority: 58,
    match: (lower) => /\b(play|pause|skip|previous|spotify|music|song|track)\b/i.test(lower),
    guard: (lower) =>
      hasCompoundIntent(lower) ||
      // Guard: sports context — "when does Arsenal play next" is NOT spotify
      /\b(arsenal|chelsea|liverpool|tottenham|spurs|manchester|man\s+(utd?|city)|barcelona|real\s+madrid|juventus|bayern|lakers|celtics|warriors|yankees|cowboys|patriots|score|match|game|league|fixture|standings?|nba|nfl|premier\s+league)\b/i.test(lower) ||
      // Guard: tech/UI/chat/video context — "previous prompt", "play youtube video", "skip this step"
      /\b(prompt|message|input|terminal|button|feature|step|youtube|video|movie)\b/i.test(lower),
    description: "Spotify playback control"
  },
  {
    tool: "youtube",
    priority: 57,
    match: (lower) => /\b(youtube|video|watch|tutorial\s+video|how\s+to\s+video)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    description: "YouTube video search"
  },
  {
    tool: "github",
    priority: 56,
    match: (lower) =>
      /\b(github|repo|repository|pull\s+requests?|PR|commit|merge|fork)\b/i.test(lower) ||
      (/\b(issues?|branch)\b/i.test(lower) && /\b(github|repo|pr|open|close|assign|label|milestone|merge|checkout)\b/i.test(lower)),
    guard: (lower, trimmed) => hasExplicitFilePath(trimmed) || hasCompoundIntent(lower),
    description: "GitHub repos, issues, PRs, commits"
  },
  {
    tool: "nlp_tool",
    priority: 55,
    match: (lower) => /\b(sentiment|analyze\s+text|text\s+analysis|classify\s+text|extract\s+entities|named\s+entities|NER)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    description: "NLP text analysis, sentiment, entity extraction"
  },

  // ── TIER 5: Catch-all tools (40-54) ───────────────────────
  {
    tool: "shopping",
    priority: 54,
    match: (lower) =>
      /\b(buy|shop|price|product|amazon|order|purchase|deal|discount|coupon)\b/i.test(lower) ||
      (/\b(best|top|cheapest|affordable)\s+\w+\s*(for|under|around|headphone|keyboard|laptop|phone|tablet|monitor|mouse|chair|camera|speaker|earbuds)\b/i.test(lower)) ||
      (/\bwhat\s+are\s+the\s+best\s+\w+/i.test(lower) && /\b(wireless|bluetooth|gaming|mechanical|ergonomic|portable|budget)\b/i.test(lower)),
    guard: (lower) =>
      /\b(stock|share|invest|market|ticker|cybersecurity|crypto|bitcoin|earnings)\b/i.test(lower) ||
      /\bprice\s*(drop|drops|dropped|crash|fell|decline|surge|rally|increase|decrease)\b/i.test(lower) ||
      // Guard: "add task buy groceries" is a todo, not a shopping request
      /\b(add\s+task|todo|to-do|task\s+list|reminder|checklist)\b/i.test(lower),
    description: "Shopping — product search, price comparisons, deals"
  },
  {
    tool: "chartGenerator",
    priority: 53,
    match: (lower) => /\b(chart|graph|plot|visualize|diagram|draw\s+a?\s*(bar|line|pie|scatter))\b/i.test(lower),
    guard: (lower) => /\b(github|dependency|project)\b/i.test(lower),
    description: "Chart/graph generation and visualization"
  },
  {
    tool: "calculator",
    priority: 52,
    match: (lower) => isMathExpression(lower),
    description: "Math expression evaluation"
  },
  {
    tool: "calculator",
    priority: 51,
    match: (lower) => /\b(calculate|compute|solve|what\s+is\s+\d|how\s+much\s+is|convert\s+\d|percentage\s+of)\b/i.test(lower),
    description: "Calculator — explicit keywords"
  },
  {
    tool: "fileWrite",
    priority: 49,
    match: (lower, trimmed) =>
      /\b(write|create|generate|make)\s+(a\s+)?(new\s+)?(file|script|module|component|document|code|program|class|function)\b/i.test(lower) ||
      /\b(save\s+to|write\s+to|create\s+file|new\s+file)\b/i.test(lower) ||
      (/\b(write|create|generate)\b/i.test(lower) && hasExplicitFilePath(trimmed)),
    guard: (lower) =>
      hasCompoundIntent(lower) ||
      // Exclude prose editing requests — those need the certainty branch for chunked mode
      (isProseIntent(lower) && /\b(rewrite|correct|edit|improve|translate|proofread|fix|grammar|copywrite)\b/i.test(lower)),
    description: "File write/create — generate new files"
  },
  {
    tool: "llm",
    priority: 48,
    match: (lower) => isSimpleDateTime(lower),
    description: "Date/time questions"
  },
  {
    tool: "workflow",
    priority: 47,
    match: (lower) =>
      /\b(run|execute|start|create|list|show|delete|remove)\s+(the\s+)?(a\s+)?(my\s+)?workflow/i.test(lower) ||
      /\bworkflow\s+(named?|called)\b/i.test(lower) ||
      /\b(morning\s+briefing|market\s+check|code\s+review\s+cycle)\b/i.test(lower),
    description: "Workflow management — run, create, list saved workflows"
  },
  {
    tool: "scheduler",
    priority: 47,
    match: (lower) =>
      /\b(schedules?|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate|set\s+up\s+a?\s*recurring|remind\s+me\s+(to|about)\s+.+\s+(every|at\s+\d|in\s+\d))\b/i.test(lower),
    guard: (lower) =>
      /\b(add\s+task|my\s+tasks|todo|to-do|checklist)\b/i.test(lower) ||
      /\b(performance\s+report|weekly\s+report|generate\s+.*report|summary\s+report|diagnostic\s+report)\b/i.test(lower) ||
      /\bworkflow\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(list|show|view|my)\s*(schedules?|recurring)/i.test(lower)) ctx.action = "list";
      else if (/\b(cancel|stop|remove|delete)\s*(schedules?|timer|recurring)/i.test(lower)) ctx.action = "cancel";
      else if (/\b(pause|disable)\b/i.test(lower)) ctx.action = "pause";
      else if (/\b(resume|enable)\b/i.test(lower)) ctx.action = "resume";
      return ctx;
    },
    description: "Scheduler — recurring tasks, cron jobs, automation"
  },
  {
    tool: "tasks",
    priority: 46,
    match: (lower) => /\b(todo|task|reminder|add\s+task|my\s+tasks|to-do|checklist|pending\s+tasks|task\s+list|show\s+tasks)\b/i.test(lower),
    guard: (lower) => /\b(github|repo|commit|issue|pull\s+request)\b/i.test(lower),
    description: "Task and todo management"
  },
  {
    tool: "packageManager",
    priority: 50,
    match: (lower) =>
      /\b(npm\s+(install|uninstall|list|remove|update|info|outdated)|install\s+(package|[@a-z][\w\/-]*)|uninstall\s+(package|[@a-z][\w\/-]*)|remove\s+(the\s+)?(unused\s+)?package|list\s+(\w+\s+)?packages|update\s+(all\s+)?packages|package\s+manager|what\s+version\s+of\b|which\s+packages|installed\s+packages|outdated\s+packages|is\s+[@a-z][\w\/-]*\s+installed)\b/i.test(lower),
    guard: (lower) => /\b(amazon|buy|shop|order)\b/i.test(lower),
    context: (lower, trimmed) => {
      const ctx = {};
      // Determine action
      if (/\binstall\b/i.test(lower) && !/\binstalled\b/i.test(lower)) ctx.action = "install";
      else if (/\buninstall|remove\b/i.test(lower)) ctx.action = "uninstall";
      else if (/\boutdated\b/i.test(lower)) ctx.action = "outdated";
      else if (/\bupdate\b/i.test(lower)) ctx.action = "update";
      else ctx.action = "list";
      // Extract package name from action commands: "install axios", "uninstall lodash"
      const actionMatch = trimmed.match(/(?:install|uninstall|remove|update)\s+([@a-z][\w\/-]*)/i);
      if (actionMatch) { ctx.package = actionMatch[1]; return ctx; }
      // Extract from "what version of X", "check X"
      const versionMatch = trimmed.match(/(?:what\s+version\s+(?:of\s+)?|check\s+)([@a-z][\w\/-]*)/i);
      if (versionMatch) { ctx.package = versionMatch[1]; return ctx; }
      // Extract from "is X installed", "version of X"
      const isMatch = trimmed.match(/\bis\s+([@a-z][\w\/-]*)\s+installed\b/i);
      if (isMatch) { ctx.package = isMatch[1]; return ctx; }
      const ofMatch = trimmed.match(/version\s+of\s+([@a-z][\w\/-]*)/i);
      if (ofMatch) { ctx.package = ofMatch[1]; return ctx; }
      return ctx;
    },
    validate: (ctx) => {
      // Reject if extracted package name is a stopword (regex captured noise)
      const PACKAGE_STOPWORDS = new Set([
        "the", "a", "an", "all", "my", "our", "installed", "available", "used",
        "packages", "package", "version", "versions", "latest", "current",
        "outdated", "updated", "listed", "check", "checked"
      ]);
      if (ctx.package && PACKAGE_STOPWORDS.has(ctx.package.toLowerCase())) {
        ctx.package = undefined; // Clear garbage, let tool run without filter
      }
      // install/uninstall without a package name is nonsensical
      if ((ctx.action === "install" || ctx.action === "uninstall") && !ctx.package) return false;
      return true;
    },
    description: "NPM package management — install, uninstall, list, update, version queries"
  },
  {
    tool: "contacts",
    priority: 46,
    match: (lower) =>
      /\b(contacts?|address\s*book|phone\s*(number|book)|my\s+contacts|add\s+contact|find\s+contact|who\s+is\s+\w+'\s*s?\s*(number|email|phone))\b/i.test(lower) ||
      /\b(add|remove|delete|set)\s+(an?\s+)?(alias|nickname|aka)\b/i.test(lower),
    guard: (lower) => /\b(github|email\s+(to|about|regarding))\b/i.test(lower),
    description: "Contacts management"
  },
  {
    tool: "documentQA",
    priority: 45,
    match: (lower) => /\b(load\s+document|index\s+(this\s+)?document|knowledge\s+base|query\s+(the\s+)?document|ask\s+(the\s+)?document|document\s+qa|search\s+(in|within)\s+(the\s+)?document)\b/i.test(lower),
    description: "Document QA — load and query knowledge base"
  },
  {
    tool: "mcpBridge",
    priority: 44,
    match: (lower) =>
      /\b(mcp|sqlite|postgres)\b/i.test(lower) &&
      /\b(list|show|call|run|use|ask|connect|disconnect|close|tools?|servers?|bridge)\b/i.test(lower),
    guard: (lower) => /\b(github|youtube)\b/i.test(lower) && !/\bmcp\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(list|show|what|which|available)\b/i.test(lower) && /\bservers?\b/i.test(lower)) ctx.action = "list_servers";
      else if (/\b(list|show|what|which)\b/i.test(lower) && /\btools?\b/i.test(lower)) ctx.action = "list_tools";
      else if (/\b(disconnect|close|stop|kill)\b/i.test(lower)) ctx.action = "disconnect";
      else if (/\b(call|run|execute|use|invoke|ask)\b/i.test(lower)) ctx.action = "call_tool";
      // Extract server name from known MCP servers
      const serverMatch = lower.match(/\b(sqlite|github|postgres|youtube)\b/i);
      if (serverMatch) ctx.server = serverMatch[1].toLowerCase();
      // Extract tool name for call_tool: "call read_query on sqlite"
      if (ctx.action === "call_tool") {
        const toolMatch = lower.match(/\b(?:call|run|execute|use|invoke)\s+(\w+)/i);
        if (toolMatch) ctx.toolName = toolMatch[1];
      }
      return ctx;
    },
    description: "MCP Bridge — Model Context Protocol server interactions"
  },
  {
    tool: "memorytool",
    priority: 42,
    match: (lower) =>
      /\b(what do you (know|remember)|my\s+(name|email|location|contacts?|preferences?)|who\s+am\s+i)\b/i.test(lower),
    guard: (lower) => /\b(password|credential)\b/i.test(lower),
    description: "Memory read — recall stored user info"
  },
  {
    tool: "lotrJokes",
    priority: 40,
    match: (lower) =>
      /\b(lotr|lord\s+of\s+the\s+rings?|hobbit|gandalf|frodo|aragorn|sauron|mordor)\b/i.test(lower) &&
      /\b(joke|funny|humor|laugh|tell\s+me)\b/i.test(lower),
    description: "Lord of the Rings jokes"
  },

  // ── TIER 6: Fallback (20-39) ──────────────────────────────
  {
    tool: "llm",
    priority: 35,
    match: (lower, trimmed) => {
      // Hebrew/Arabic conversational catch-all: if the text is predominantly non-Latin,
      // route to llm instead of letting the tiny intent decomposer (which can't read Hebrew) hallucinate.
      // Only fires when NO higher-priority tool matched.
      const hebrew = (trimmed.match(/[\u0590-\u05FF]/g) || []).length;
      const arabic = (trimmed.match(/[\u0600-\u06FF]/g) || []).length;
      const latin = (trimmed.match(/[a-zA-Z]/g) || []).length;
      return (hebrew + arabic) > 3 && (hebrew + arabic) > latin;
    },
    guard: (lower) =>
      // Don't catch tool-specific Hebrew commands (whatsapp, send, etc.) — those have dedicated routes
      // Note: \b doesn't work with Hebrew chars, so use lookahead/behind or just substring match
      /\b(whatsapp)\b/i.test(lower) || /(וואטסאפ|ווטסאפ)/.test(lower) ||
      /(^|\s)(שלח|תשלח|שלחי)(\s|$)/.test(lower),
    description: "Hebrew/Arabic conversational — route to LLM (bypass tiny decomposer)"
  },
{
    tool: "search",
    priority: 30,
    match: (lower) =>
      /\b(what is|what are|who is|who was|who were|when did|where is|how many|how does|why do|why did|why are|why is|define|meaning of|history of|tell\s+me\s+about|explain\s+\w+|search\s+for(?!\s+\w+\s+on\s+(?:x|twitter)))\b/i.test(lower) ||
      // Match "[country/entity] head of state/president/prime minister" patterns (no question word needed)
      /\b(head\s+of\s+state|president\s+of|prime\s+minister\s+of|chancellor\s+of|king\s+of|queen\s+of)\b/i.test(lower) ||
      /\w+('s|s)\s+(president|prime\s+minister|ruler|head\s+of\s+state|chancellor|king|queen)\b/i.test(lower),
    guard: (lower, trimmed) =>
      isMathExpression(trimmed) || hasExplicitFilePath(trimmed) ||
      hasCompoundIntent(lower) ||
      /\b(weather|email|task|todo|file|github|score|game|match|league|calendar|meeting)\b/i.test(lower) ||
      /\b(your\s+name|who\s+are\s+you|what\s+are\s+you|your\s+identity)\b/i.test(lower) ||
      /\b(your\s+(opinion|view|take|thoughts?)|what\s+do\s+you\s+think|do\s+you\s+(like|think|feel|believe))\b/i.test(lower) ||
      /^(איך קוראים לך|מה השם שלך|מה שמך|מי את|מי אתה)/i.test(lower) ||
      lower.length <= 10,
    description: "General knowledge — search fallback"
  },
];

// ── ROUTING TABLE EVALUATOR ──────────────────────────────────
/**
 * Evaluate all rules in the routing table and return the highest-priority match.
 * Returns a plan step array or null if no rule matches.
 */
async function evaluateRoutingTable(lower, trimmed, chatContext) {
  // Find all matching rules (pass match, fail guard)
  const candidates = ROUTING_TABLE.filter(rule => {
    try {
      if (!rule.match(lower, trimmed, chatContext)) return false;
      if (rule.guard && rule.guard(lower, trimmed, chatContext)) return false;
      return true;
    } catch (e) {
      console.warn(`[planner] Routing rule error for "${rule.tool}":`, e.message);
      return false;
    }
  });

  if (candidates.length === 0) return null;

  // Sort by priority descending — highest wins
  candidates.sort((a, b) => b.priority - a.priority);

  // Try candidates in priority order — if a validate() hook rejects,
  // fall through to the next candidate instead of sending garbage context.
  for (const winner of candidates) {
    // Build context
    let ctx = {};
    if (winner.contextAsync && winner.tool === "weather") {
      // Special async handling for weather city extraction + memory lookup
      let extracted = extractCity(trimmed);
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
      ctx = extracted ? { city: extracted } : {};
    } else if (winner.context) {
      ctx = winner.context(lower, trimmed, chatContext || {});
    }

    // Validate extracted context — if the tool rejects it, try next candidate
    if (winner.validate) {
      try {
        if (!winner.validate(ctx, lower, trimmed)) {
          console.log(`[planner] routing table → ${winner.tool} REJECTED by validate (priority ${winner.priority}), trying next candidate`);
          continue;
        }
      } catch (e) {
        console.warn(`[planner] validate error for "${winner.tool}":`, e.message);
        continue;
      }
    }

    // Handle finance → search redirect
    if (ctx.__redirectTool) {
      const redirectTool = ctx.__redirectTool;
      delete ctx.__redirectTool;
      console.log(`[planner] routing table → ${winner.tool} redirected to ${redirectTool} (priority ${winner.priority})`);
      logRoutingDecision(trimmed, redirectTool, winner.priority, `routing_table_${winner.tool}_redirect`);
      return [{ tool: redirectTool, input: trimmed, context: ctx, reasoning: `routing_table_${winner.tool}_redirect` }];
    }

    console.log(`[planner] routing table → ${winner.tool} (priority ${winner.priority}, ${candidates.length} candidate${candidates.length > 1 ? "s" : ""})`);
    logRoutingDecision(trimmed, winner.tool, winner.priority, `routing_table_${winner.tool}`);
    return [{ tool: winner.tool, input: trimmed, context: ctx, reasoning: `routing_table_${winner.tool}` }];
  }

  // All candidates rejected by validate — no match
  console.log(`[planner] routing table → all ${candidates.length} candidates rejected by validate`);
  return null;
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

  // Guard: "review/inspect/examine/audit your planner" is a code review, not a diagnostic question
  if (/\b(review|inspect|examine|audit|analyze)\s+(your|the|my)\b/i.test(lower)) return null;

  // Accuracy/reliability questions → route to selfImprovement for actionable diagnostics
  if (/\b(how\s+(accurate|reliable|precise)|routing\s+accuracy|accuracy\s+of|how\s+accurate\s+is\s+your)\b/i.test(lower)) {
    console.log("[planner] certainty branch: diagnostic → selfImprovement");
    return [{ tool: "selfImprovement", input: message, context: {}, reasoning: "certainty_diagnostic_self_improve" }];
  }

  // Explanatory diagnostic patterns → LLM
  const diagPatterns = [
    /\bwhy did you choose\b/,
    /\bexplain (your|the) (routing|planner|decision|choice)\b/,
    /\bcan you check your routing\b/,
    /\bdebug (the )?(planner|routing)\b/
  ];

  // Only treat "planner" as diagnostic if preceded by "your" or "the"
  const isDiagnosticPlannerWord =
    /\b(your|the)\s+planner\b/i.test(message);

  if (
    diagPatterns.some(rx => rx.test(lower)) ||
    isDiagnosticPlannerWord
  ) {
    console.log("[planner] certainty branch: diagnostic");
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
  if (/\b(stocks?|shares?|ticker)\b/i.test(lower)) signals.push("MENTIONS_FINANCE");
  if (containsKeyword(lower, WEATHER_KEYWORDS)) signals.push("MENTIONS_WEATHER");
  if (/\b(news|headline|article)\b/i.test(lower)) signals.push("MENTIONS_NEWS");
  if (/\b(email|mail)\b/i.test(lower)) signals.push("MENTIONS_EMAIL");
  if (/\b(review|inspect|examine)\b/i.test(lower)) signals.push("MENTIONS_REVIEW");
  if (/\b(improve|improvement|patch)\b/i.test(lower)) signals.push("MENTIONS_SELF_IMPROVEMENT");

  return signals;
}

async function detectIntentWithLLM(message, contextSignals, availableTools = [], signal) {
  // Strip the WhatsApp Persona injection so it doesn't confuse the classifier
  const cleanMessage = (message || "").replace(/^\(System:[^)]+\)\s*/i, "");

  const modelOverride = pickModelForContent(cleanMessage);
  const modelToUse = modelOverride || "qwen2.5:1.5b-instruct";

  const signalText = contextSignals.length > 0
    ? `\nCONTEXT SIGNALS: ${contextSignals.join(", ")}`
    : "";

  const toolsListText = availableTools.length > 0 ? `\nAVAILABLE TOOLS: ${availableTools.join(", ")}` : "";

  const prompt = `You are an intent classifier for an AI agent. Classify the user's message into ONE tool.
${toolsListText}

USER MESSAGE:
"${cleanMessage}"
${signalText}

EXAMPLES (correct routing):
- "hey, how do you feel?" → llm
- "what's 15% of 230?" → calculator
- "weather in Paris" → weather
- "latest news about AI" → news
- "search for React tutorials" → search
- "search for the latest developments in quantum computing" → search (NOT x — this is a web search, not a Twitter search)
- "who was Rommel?" → search (NOT x — this is a knowledge question)
- "who was Napoleon Bonaparte?" → search
- "search for the latest research on language models" → search (NOT x)
- "where in the codebase do I change the budget" → codeRag
- "search the code for the email sending logic" → codeRag
- "email John saying meeting at 3pm" → email
- "list repos" → github
- "list D:/projects" → file
- "trending repos" → githubTrending
- "review server/planner.js" → review
- "remember my name is Alex" → memorytool
- "login to moltbook" → moltbook
- "browse example.com" → webBrowser
- "git status" → gitLocal
- "find duplicate files in D:/test" → duplicateScanner
- "how accurate is your routing?" → selfImprovement
- "what can you do?" → llm
- "tell me a joke" → llm
- "analyze the sentiment of this text" → nlp_tool
- "youtube tutorials about node.js" → youtube
- "store my moltbook password" → moltbook
- "schedule weather check every 30 minutes" → scheduler
- "remind me to check emails at 9am" → scheduler
- "list my schedules" → scheduler
- "show me the folder structure of D:/project" → folderAccess
- "code review D:/project/server" → codeReview (runs syntax+ESLint validation THEN LLM analysis)
- "security audit of my server code" → codeReview
- "validate my code / check for errors" → codeReview (NOT a separate debugger — codeReview includes automated validation)
- "refactor D:/project/utils.js" → codeTransform (applies surgical code fixes)
- "add error handling to server.js" → codeTransform
- "fix the bug in server.js" → codeTransform (codeTransform handles bug fixes)
- "list mcp servers" → mcpBridge
- "list tools on sqlite mcp" → mcpBridge
- "call read_query on sqlite mcp" → mcpBridge
- "show dependency graph" → projectGraph
- "find circular dependencies" → projectGraph
- "index the project" → projectIndex
- "find the handleRequest function" → projectIndex
- "scan github for new tools" → githubScanner
- "discover tools for web scraping" → githubScanner
- "evolve yourself" → selfEvolve
- "improve your own code" → selfEvolve
- "scan github and upgrade your tools" → selfEvolve
- "trending on X" → x
- "search tweets about AI" → x
- "twitter trends in Israel" → x
- "send a whatsapp to 0587426393 saying hello" → whatsapp
- "search X for complaints about Shopify" → x (leadgen search)
- "post on X: my hot take about AI" → x (tweet posting)
- "append data to my google sheet" → sheets
- "read from spreadsheet 1BxiMVs0XRA5" → sheets

NEGATIVE EXAMPLES (common mistakes to avoid):
- "how are you" → llm (NOT selfImprovement, NOT weather, NOT lotrJokes)
- "let's talk about the situation" → llm (NOT lotrJokes, NOT any other tool)
- "what should I do about X?" → llm (NOT lotrJokes)
- "tell me a joke" → llm (NOT lotrJokes — lotrJokes is ONLY for explicit LOTR jokes)
- "how accurate is your routing" → selfImprovement (NOT calculator, NOT weather)
- "search for latest research on AI" → search (NOT x — "search for X" is a web search, NOT a Twitter search)
- "who was Rommel" → search (NOT x — knowledge questions go to search)
- "what issues have you detected?" → selfImprovement (NOT llm)
- "generate a weekly performance report" → selfImprovement (NOT systemMonitor)
- "how can you improve your tool selection?" → selfImprovement
- "what's the weather like" → weather (NOT llm)
- "tell me about stocks" → finance (NOT search, NOT financeFundamentals)
- "show me their stocks" → finance (NOT financeFundamentals)
- "stock prices of X Y Z" → finance (NOT financeFundamentals)
- "compare stocks" → finance (NOT financeFundamentals)
- "why are cybersecurity stocks dropping?" → search (NOT finance — this is a research question)
- "why did CHKP stock price drop?" → search (NOT finance — asking for reasons, not price data)
- "search for why stock prices dropped" → search (NOT finance, NOT shopping)
- "what caused the market crash?" → search (NOT finance — explanatory question)
- "P/E ratio and fundamentals of Apple" → financeFundamentals (NOT finance)
- "what do you know about me" → memorytool (NOT search)
- "schedule a task every hour" → scheduler (NOT tasks)
- "refactor my code" → codeTransform (NOT review, NOT file)
- "security review" → codeReview (NOT review)
- "validate/lint/check my code for errors" → codeReview (NOT a separate debugger tool — codeReview runs automated syntax+ESLint checks)
- "fix the bug in X.js" → codeTransform (codeTransform is the fix/debug tool)
- "show project structure" → folderAccess (NOT file)
- "improve yourself" → selfEvolve (NOT selfImprovement)
- "scan github for patterns" → githubScanner (NOT github, NOT githubTrending)
- "just checking a new feature, let's test it" → llm (NOT codeSandbox)
- "testing the chat input" → llm (NOT codeSandbox)

RULES:
1. Casual conversation, greetings, opinions, explanations → llm
2. "list repos" → github (NOT file)
3. "list D:/..." → file
4. NEVER use nlp_tool unless explicitly asked for "sentiment" or "analyze text"
5. "moltbook" → moltbook
6. "browse/visit [website]" → webBrowser
7. "store/save password/credentials" → moltbook or webBrowser (NOT memorytool)
8. When unsure, return "llm" (the safest fallback). NEVER return lotrJokes unless the user explicitly asks for a "Lord of the Rings joke"
17. CRITICAL: "search for X" or "search the latest X" → search (web search). ONLY use "x" when user explicitly says "X", "Twitter", "tweets", "trending on X", or "post on X". General knowledge questions like "who was X?", "search for X developments", "latest research on X" → search (NOT x)
9. "refactor/optimize/rewrite/fix/debug code" → codeTransform (NOT review). codeTransform is the tool for applying code fixes and transformations.
10. "code review/security review/audit/validate/lint/check for errors" → codeReview (NOT review). codeReview runs automated syntax+ESLint validation AND LLM analysis. There is NO separate debugger or validator tool — codeReview covers that.
11. "folder structure/tree/scan directory" → folderAccess (NOT file)
12. "dependency graph/circular deps/dead code" → projectGraph
13. "evolve yourself/improve your code" → selfEvolve (NOT selfImprovement)
14. "stock/stocks/stock price/compare stocks" → finance. ONLY use financeFundamentals for explicit fundamentals requests (P/E, balance sheet, market cap analysis, EPS, dividends)
15. "why did stocks drop/crash/fall" or "what caused the price drop" → search. These are RESEARCH questions needing web search, NOT finance price lookups
16. "search for price drops" or "search for why stock fell" → search (NOT shopping — "price" in financial context is NOT a shopping query)
17. CRITICAL: "search for X" or "search the latest X" → search (web search). ONLY use "x" when user explicitly says "X", "Twitter", "tweets", "trending on X", or "post on X". General knowledge questions like "who was X?", "search for X developments", "latest research on X" → search (NOT x)
18. "codeSandbox" is ONLY for explicitly executing isolated scripts (Python/Node). Do NOT use it for conversation, testing the chat UI, or general "let's check it" statements.

Respond with ONLY the tool name (one word, no explanation).`;

try {
    const response = await llm(prompt, { 
      model: modelToUse, // <--- NOW DYNAMIC
      timeoutMs: 30000,
      signal 
    });
    if (!response.success || !response.data?.text) {
      return { intent: "llm", reason: "fallback" };
    }

    const text = response.data.text.trim().toLowerCase();
    let intent = text.split("|")[0].trim().replace(/[^a-z_]/g, "");

    // Hard guard: lotrJokes should ONLY be used when explicitly requested
    if (intent === "lotrjokes" && !/\b(lotr|lord\s+of\s+the\s+rings|hobbit|gandalf|frodo)\b/i.test(message)) {
      console.log("🧠 LLM classified lotrJokes but user didn't ask for LOTR → overriding to llm");
      intent = "llm";
    }

    console.log("🧠 LLM classified:", intent);

    return { intent, reason: "llm_classified", context: {} };
  } catch (err) {
    console.error("LLM intent error:", err.message);
    return { intent: "llm", reason: "error_fallback" };
  }
}

// ============================================================
// MULTI-STEP INTENT DECOMPOSER (Sequential Logic Engine)
// ============================================================

/**
 * Parse LLM output into a validated array of step objects.
 * Handles code fences, single-object responses, and embedded JSON.
 */
function tryParseStepsJSON(text) {
  if (!text) return null;

  // Strip markdown code fences if present
  let cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  // Try to extract JSON array if surrounded by other text
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    cleaned = arrayMatch[0];
  }

  try {
    const parsed = JSON.parse(cleaned);

    // Must be an array
    if (!Array.isArray(parsed)) {
      // If it's a single object with tool field, wrap it
      if (parsed && typeof parsed === "object" && parsed.tool) {
        return [parsed];
      }
      return null;
    }

    // Validate each step has required fields
    const validSteps = parsed
      .filter(step => step && typeof step === "object" && typeof step.tool === "string")
      .map(step => ({
        tool: step.tool.trim().toLowerCase(),
        input: step.input || "",
        reasoning: step.reasoning || "llm_decomposed"
      }))
      .slice(0, 5); // enforce max 5 steps

    return validSteps.length > 0 ? validSteps : null;
  } catch (e) {
    return null;
  }
}

/**
 * Handle compound (multi-step) intents by running the LLM decomposer directly.
 * This is called early in the plan() function when hasCompoundIntent() returns true,
 * BEFORE certainty branches — so arbitrary tool combinations (X→NLP→WhatsApp,
 * moltbook→LLM→email, etc.) work without hardcoding every permutation.
 *
 * Returns a resolved step array, or null if decomposition fails.
 */
async function handleCompoundIntent(trimmed, lower, chatContext = {}, signal) {
  const availableTools = listAvailableTools();
  const contextSignals = extractContextSignals(trimmed);
  console.log("[planner] handleCompoundIntent: attempting LLM decomposition...");

  const decomposedSteps = await decomposeIntentWithLLM(trimmed, contextSignals, availableTools, signal);

  if (decomposedSteps && decomposedSteps.length > 1) {
    // Resolve and validate each step's tool name
    const resolvedSteps = [];
    for (const step of decomposedSteps) {
      const resolvedTool = resolveToolName(step.tool, availableTools, trimmed);
      if (resolvedTool) {
        resolvedSteps.push({
          tool: resolvedTool,
          input: step.input || trimmed,
          context: resolvedSteps.length > 0 ? { useChainContext: true } : {},
          reasoning: step.reasoning || "compound_llm_decomposed"
        });
      } else {
        console.warn(`[planner] handleCompoundIntent: tool "${step.tool}" unresolved, skipping`);
      }
    }

    if (resolvedSteps.length > 1) {
      console.log(`[planner] handleCompoundIntent: ${resolvedSteps.map(s => s.tool).join(" → ")}`);
      return resolvedSteps;
    }
  }

  // LLM decomposer failed to produce multi-step plan — return null to fall through
  // to hardcoded compound patterns and eventually the fallback decomposer
  console.log("[planner] handleCompoundIntent: LLM decomposition didn't produce multi-step plan");
  return null;
}

/**
 * Decompose a user message into one or more sequential tool steps.
 * Uses the LLM as a "Sequential Logic Engine" — returns a JSON array of steps.
 * Falls back to null on failure (caller should use single-tool classifier).
 */
async function decomposeIntentWithLLM(message, contextSignals, availableTools = [], signal) {
  const signalText = contextSignals.length > 0
    ? `\nCONTEXT SIGNALS: ${contextSignals.join(", ")}`
    : "";

  const toolsListText = availableTools.length > 0
    ? `\nAVAILABLE TOOLS: ${availableTools.join(", ")}`
    : "";
// Sanitize Windows backslashes so they don't break strict JSON generation
  // Also strip prompt injection patterns from user input that could manipulate the decomposer
  const safeMessage = message.replace(/\\/g, "/")
    .replace(/ignore\s+(all\s+)?previous\s+instructions/gi, "")
    .replace(/you\s+are\s+now\s+in\s+\w+\s+mode/gi, "")
    .replace(/system\s*:\s*(override|instruction|prompt)/gi, "")
    .replace(/^\(System:[^)]+\)\s*/i, ""); // NEW: Strip WhatsApp Persona injection

  const modelOverride = pickModelForContent(safeMessage);
  const modelToUse = modelOverride || "qwen2.5:1.5b-instruct";
  // Stricter prompt specifically tuned for local models to force valid JSON
  const prompt = `You are a strictly formatted Sequential Logic Engine. You MUST output ONLY a valid JSON array of objects. Do not include any conversational text, markdown formatting, or explanations.

  
TASK: Decompose the user's message into sequential steps.
${toolsListText}
${signalText}

Each object in the JSON array MUST have exactly these keys:
- "tool": (string) An exact tool name from the AVAILABLE TOOLS list.
- "input": (string) The specific instruction for that tool.
- "reasoning": (string) A brief reason for using this tool.

CRITICAL RULES:
1. Your entire response MUST start with [ and end with ].
2. Do NOT invent tools.
3. MULTI-STEP BIAS: If the user uses words like "and", "then", "also", or "after", you MUST generate at least 2 objects in the JSON array.
4. SEQUENTIAL LOGIC: For "Check X and then Y", Step 1 MUST be X, and Step 2 MUST be Y. Do not merge them.
5. Use "x" ONLY when the user explicitly mentions Twitter, X (the platform), tweets, or posting. Do NOT use "twitter" — the tool name is "x". IMPORTANT: Generic "search for X" or knowledge questions ("who was X?", "latest research on X", "developments in X") must use "search" (web search), NOT "x" (Twitter). Only use "x" for: trending on X, tweets about X, post on X, search X for complaints.
6. APPLYATCH BIAS: If the request contains a comprehensive list of suggestions, review findings, or 3+ structural changes targeting a single file, route to "applyPatch" (full rewrite) — NOT "codeTransform" (surgical patch). codeTransform is for single targeted edits only.
7. SELFEVOLVE RESTRAINT: The "selfEvolve" tool must NOT be used for cosmetic changes or quota-driven busywork. Only route to selfEvolve when the user explicitly asks for autonomous evolution or self-improvement cycles.
8. Use "sheets" for Google Sheets operations (read, append, clear). Pass spreadsheetId and action in context. When chaining X search → LLM → sheets, the LLM step should categorize/summarize and the sheets step should receive the categorized data as rows.
9. NO MERGING: Never merge "Weather" and "News" into one step. They use different tools. Output two separate objects.
10. TOOL NAMES: Use exactly "weather" and "news". Do not use "codeReview" unless the user provides a code file path.
11. AIR QUALITY: Requests for "air quality" or "pollution" must always use the "weather" tool.
12. EXTRACTION: When using the "weather" tool, you MUST extract the city name and include it in the "input" field (e.g., {"tool": "weather", "input": "Givatayim"}).
13. ZERO-SHOT RESPONSIBILITY: Do not assume another system will catch the second half. If you see two actions, you MUST return two JSON objects. Failure to do so results in logic breakdown.
EXAMPLE INPUT:
"review D:/project/news.js and create a fixed version at E:/testFolder/"
EXAMPLE OUTPUT:
[
  {"tool": "codeReview", "input": "review D:/project/news.js", "reasoning": "Analyze the source file for improvements"},
  {"tool": "fileWrite", "input": "create fixed news.js at E:/testFolder/", "reasoning": "Save the generated code to the new location"}
]

EXAMPLE INPUT:
"Search X for complaints about Shopify, categorize them, and save to my sheet 1BxiMVs0XRA5"
EXAMPLE OUTPUT:
[
  {"tool": "x", "input": "search X for complaints about Shopify", "reasoning": "Find complaint tweets using lead-gen search"},
  {"tool": "llm", "input": "Categorize each complaint into Pricing, Support, or Downtime. Return JSON array of [username, summary, category] rows", "reasoning": "LLM categorizes the raw tweet data"},
  {"tool": "sheets", "input": "batch append categorized complaints to sheet 1BxiMVs0XRA5", "reasoning": "Write categorized data to Google Sheets"}
]

EXAMPLE INPUT:
"post on X: Just launched my new project, check it out!"
EXAMPLE OUTPUT:
[
  {"tool": "x", "input": "post on X: Just launched my new project, check it out!", "reasoning": "Post a tweet to the user's X account"}
]

EXAMPLE INPUT:
"search X for One Piece, use the nlp tool to analyze the sentiment and send it to whatsapp 0587426393"
EXAMPLE OUTPUT:
[
  {"tool": "x", "input": "search X for One Piece", "reasoning": "Search tweets about One Piece"},
  {"tool": "nlp_tool", "input": "analyze sentiment of these tweets about One Piece", "reasoning": "Run sentiment analysis on the search results"},
  {"tool": "whatsapp", "input": "send the sentiment analysis to whatsapp 0587426393", "reasoning": "Send the analysis results via WhatsApp"}
]

EXAMPLE INPUT:
"check moltbook feed, summarize the top posts and email it to me"
EXAMPLE OUTPUT:
[
  {"tool": "moltbook", "input": "show moltbook feed", "reasoning": "Fetch the moltbook feed posts"},
  {"tool": "llm", "input": "Summarize the top posts from this feed into a concise email-friendly format", "reasoning": "Summarize the feed data"},
  {"tool": "email", "input": "email me the moltbook feed summary", "reasoning": "Send the summary via email"}
]
EXAMPLE INPUT:
"where in the codebase do I change the budget"
EXAMPLE OUTPUT:
[
  {"tool": "codeRag", "input": "where in the codebase do I change the budget", "reasoning": "Semantic search across the codebase to find the configuration"}
]

USER MESSAGE:
"${safeMessage}"
${await buildCorrectionContext()}
OUTPUT ONLY THE JSON ARRAY:`;

try {
    const response = await llm(prompt, { 
      model: modelToUse, // <--- NOW DYNAMIC
      timeoutMs: 90000, 
      format: "json",
      signal
    });
    if (!response.success || !response.data?.text) {
      console.warn("[planner] decomposeIntentWithLLM: LLM returned no text, falling back");
      return null;
    }

    const rawText = response.data.text.trim();
    const parsed = tryParseStepsJSON(rawText);

    if (parsed && parsed.length > 0) {
      console.log(`[planner] LLM decomposed into ${parsed.length} step(s):`,
        parsed.map(s => s.tool).join(" -> "));
      return parsed;
    }

    // RETRY: If first parse failed, ask LLM to fix its output with strict rules
    console.warn("[planner] decomposeIntentWithLLM: first parse failed, retrying");
    const retryPrompt = `Your previous response was not valid JSON. Return ONLY a JSON array of step objects starting with [ and ending with ].
Each object must have "tool", "input", and "reasoning" keys.
Previous response: ${rawText.slice(0, 500)}

Return valid JSON array only:`;

    const retryResponse = await llm(retryPrompt, { 
      timeoutMs: 60000, 
      format: "json",
      signal 
    });
    if (retryResponse.success && retryResponse.data?.text) {
      const retryParsed = tryParseStepsJSON(retryResponse.data.text.trim());
      if (retryParsed && retryParsed.length > 0) {
        console.log(`[planner] LLM retry decomposed into ${retryParsed.length} step(s)`);
        return retryParsed;
      }
    }

    console.warn("[planner] decomposeIntentWithLLM: retry also failed");
    return null;
  } catch (err) {
    console.error("[planner] decomposeIntentWithLLM error:", err.message);
    return null;
  }
}

/**
 * Resolve a raw tool name (from LLM output) to a valid tool in the registry.
 * Handles aliases, case-insensitive matching, and partial matches.
 */
function resolveToolName(rawIntent, availableTools, originalMessage = "") {
  const aliasMap = {
    'nlptool': 'nlp_tool',
    'nlp': 'nlp_tool',
    'memory': 'memorytool',
    'memorytool': 'memorytool',
    'lotr': 'lotrJokes',
    'lotrjokes': 'lotrJokes',
    'webbrowser': 'webBrowser',
    'web_browser': 'webBrowser',
    'web': 'webBrowser',
    'summarize': 'llm',
    'summarise': 'llm',
    'summary': 'llm',
    'chat': 'llm',
    'conversation': 'llm',
    'twitter': 'x',
    'tweets': 'x',
    'xtrends': 'x',
    'xtwitter': 'x',
    'googlesheets': 'sheets',
    'google_sheets': 'sheets',
    'spreadsheet': 'sheets',
    'gsheets': 'sheets',
    'reviewcode': 'codeReview',
    'searchcode': 'codeRag',
    'coderag': 'codeRag',
  };

  let cleaned = (rawIntent || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");

  // Step 1: Check alias map
  let tool = aliasMap[cleaned] || null;

  // Step 2: Case-insensitive exact match
  if (!tool) {
    tool = availableTools.find(t => t.toLowerCase() === cleaned) || null;
  }

  // Step 3: Partial match (LLM sometimes truncates)
  if (!tool) {
    tool = availableTools.find(t => t.toLowerCase().startsWith(cleaned) && cleaned.length >= 4) || null;
    if (tool) {
      console.log(`[planner] resolveToolName: partial match "${cleaned}" -> "${tool}"`);
    }
  }
  // 🛑 THE HARD GUARD: Apply to all resolved tools
  if (tool === "lotrJokes" && originalMessage && !/\b(lotr|lord\s+of\s+the\s+rings|hobbit|gandalf|frodo)\b/i.test(originalMessage)) {
    console.log("🧠 Decomposer hallucinated lotrJokes. Overriding to llm.");
    return "llm"; 
  }
  if (tool === "codeSandbox" && originalMessage && !/\b(run|execute|compile|script|sandbox|python|node)\b/i.test(originalMessage)) {
    console.log("🧠 Decomposer hallucinated codeSandbox for a chat/test message. Overriding to llm.");
    return "llm";
  }

  return tool;
}

// ============================================================
// MAIN PLAN FUNCTION - Returns ARRAY of steps
// ============================================================

export async function plan({ message, chatContext = {}, signal }) {
  const result = await _planInternal({ message, chatContext, signal });

  // --- RE-INJECT SYSTEM WRAPPER (only for LLM-facing tools) ---
  // The system persona wrapper is for LLM synthesis — tools like search, weather,
  // finance, etc. would break if they receive "(System: You are Lanou...)" as input.
  const systemMatch = (message || "").trim().match(/^(\(System:[^)]+\)\s*)/i);
  // Tools that process text through LLM and benefit from persona context
  const LLM_FACING_TOOLS = new Set(["llm", "news", "moltbook", "nlp", "review", "codeReview", "fileReview"]);
  if (systemMatch && Array.isArray(result)) {
    for (let step of result) {
      // Defensively coerce input to string — LLM decomposer sometimes returns objects
      if (step.input && typeof step.input !== "string") {
        step.input = typeof step.input === "object" ? JSON.stringify(step.input) : String(step.input);
      }
      // Only inject system wrapper for tools that use LLM internally and need persona
      if (step.input && typeof step.input === "string" && !step.input.startsWith("(System:") && LLM_FACING_TOOLS.has(step.tool)) {
        step.input = systemMatch[1] + step.input;
      }
    }
  }

  // --- FINAL CONTEXT BRIDGE ---
  // Ensure the city is extracted even if the brain/regex missed it
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i++) {
      if (result[i].tool === "weather" && !result[i].context?.city) {
        // Initialize context if it's missing
        if (!result[i].context) result[i].context = {};
        
        // Try extracting from the specific step input first
        const extractedCity = extractCity(result[i].input);
        if (extractedCity) {
          console.log(`[planner] 🌉 Bridge: Extracted "${extractedCity}" from step input`);
          result[i].context.city = extractedCity;
        } else {
          // Fallback: try extracting from the original full message
          const globalCity = extractCity(message);
          if (globalCity) {
            console.log(`[planner] 🌉 Bridge: Extracted "${globalCity}" from global message`);
            result[i].context.city = globalCity;
          }
        }
      }
    }
  }

  // Track the routing decision for user correction feedback
  if (result && result.length > 0 && !result[0]?.context?.correctionLogged) {
    _lastRoutingDecision = {
      userMessage: (message || "").trim().substring(0, 200),
      tool: result.map(s => s.tool).join(" → "),
      reasoning: result[0]?.reasoning || "unknown",
    };
  }

  return result;
}

async function _planInternal({ message, chatContext = {}, signal }) {
const rawMessage = (message || "").trim();
  
  // --- NEW: STRIP SYSTEM WRAPPER FOR ROUTING ---
  // We remove the (System: ...) injection here so words like "Summarize" 
  // in the persona don't trigger false positives in our compound regex patterns.
  const systemMatch = rawMessage.match(/^(\(System:[^)]+\)\s*)([\s\S]*)$/i);
  const trimmed = systemMatch ? systemMatch[2].trim() : rawMessage;
  const lower = trimmed.toLowerCase();

  console.log("🧠 Planning steps for:", trimmed);

  // ── USER CORRECTION DETECTION ──
  // If user says "you chose the wrong tool" or "use X instead", log it and respond
  const correction = detectCorrection(trimmed);
  if (correction) {
    console.log(`[planner] 📝 User correction detected: ${correction.type}`);
    const loggedEntry = await logCorrection(correction, {
      previousUserMessage: _lastRoutingDecision.userMessage,
      previousToolUsed: _lastRoutingDecision.tool,
      previousReasoning: _lastRoutingDecision.reasoning,
    });

    // If user specified the correct tool ("use X instead", "should have been X")
    if (correction.correctTool) {
      const resolved = resolveToolName(correction.correctTool, listAvailableTools());
      if (resolved) {
        console.log(`[planner] 📝 User correction: re-routing to "${resolved}" for previous message`);
        return [{ tool: "llm", input: `The user corrected my routing. They said I should have used the "${resolved}" tool instead of "${_lastRoutingDecision.tool || "unknown"}" for their previous request: "${_lastRoutingDecision.userMessage || "unknown"}". Acknowledge the correction, explain that I've logged this feedback and will route to "${resolved}" next time for similar requests. Be brief and friendly.`, context: { correctionLogged: true, correctTool: resolved, previousTool: _lastRoutingDecision.tool }, reasoning: "user_correction_acknowledged" }];
      }
    }

    // If just a "wrong tool" without specifying the right one, or an inquiry
    if (correction.type === "inquiry") {
      return [{ tool: "llm", input: `The user asked why I chose the "${_lastRoutingDecision.tool || "unknown"}" tool for their message: "${_lastRoutingDecision.userMessage || "unknown"}". My reasoning was: "${_lastRoutingDecision.reasoning || "not recorded"}". Explain in a helpful way why this tool was selected, and if they think it was wrong, they can say "use X instead" or "that should have been X" and I'll log the correction for future improvement.`, context: {}, reasoning: "user_routing_inquiry" }];
    }

    return [{ tool: "llm", input: `The user said I chose the wrong tool. Previous message: "${_lastRoutingDecision.userMessage || "unknown"}", tool used: "${_lastRoutingDecision.tool || "unknown"}". Acknowledge the mistake, apologize briefly, and ask which tool they would have preferred. Mention they can say "use X instead" or "should have been X" and I'll remember for next time. Be concise.`, context: { correctionLogged: true }, reasoning: "user_correction_wrong_tool" }];
  }

  // ── NEW GUARD: Detect Scheduling Intents First ──
  // Prevents "schedule self evolve" from triggering an immediate cycle
  const isSchedulingIntent = /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower);

  // ── GLOBAL COMPOUND INTENT EARLY-EXIT ──
  // If this is clearly a multi-step request, skip ALL certainty branches and go
  // straight to compound patterns + LLM decomposer. This prevents single-tool
  // certainty branches from grabbing compound requests (e.g., NLP grabbing
  // "search X for topic, analyze sentiment, send to whatsapp").
  if (!isSchedulingIntent && hasCompoundIntent(lower)) {
    console.log("[planner] ⚡ Global compound intent detected — routing to compound handler");
    const compoundResult = await handleCompoundIntent(trimmed, lower, chatContext, signal);
    if (compoundResult) return compoundResult;
    console.log("[planner] ⚡ Compound handler returned null, falling through to certainty branches");
  }

// ── REFINED TECHNICAL OVERRIDE ──
  // 1. SELF-EVOLVE: Active code modification / Autonomous growth
  // Triggers ONLY on explicit "evolve" commands or "force run" on a file.
  // GUARD: Do NOT trigger if the user explicitly asks for codeTransform or fileWrite
if (
    !isSchedulingIntent &&
    !/\b(codetransform|filewrite|filereview)\b/i.test(lower) && (
      /\b(self[- ]?evolve|evolution[- ]?cycle)\b/i.test(lower) || 
      (/\.js\b/.test(lower) && /\b(specifically|force\s+run|evolve)\b/i.test(lower))
    )
  ) {
    console.log("[planner] technical override: forcing selfEvolve tool");
    const evolveContext = {};
    if (/\b(dry.?run|preview|plan)\b/i.test(lower)) evolveContext.action = "dryrun";
    else evolveContext.action = "run";
    
    return [{ 
      tool: "selfEvolve", 
      input: trimmed, 
      context: evolveContext, 
      reasoning: "technical_intent_evolve" 
    }];
  }

  // 2. SELF-IMPROVEMENT: Reporting, Accuracy, Telemetry Audit, and Diagnostics
  // Triggers for "how accurate", "telemetry", "what have you improved lately", "what issues detected", etc.
  if (
    /\b(accuracy|telemetry|misrouting|routing\s+report|what\s+have\s+you\s+improved|recent\s+changes|issues?\s+(?:have\s+you\s+)?detected|(?:weekly|daily|performance)\s+report|how\s+can\s+you\s+improve|improve\s+your\s+(?:tool|routing)|tool\s+selection)\b/i.test(lower)
  ) {
    console.log("[planner] technical override: forcing selfImprovement tool");
    return [{ tool: "selfImprovement", input: trimmed, context: {}, reasoning: "technical_intent_audit" }];
  }

    // ──────────────────────────────────────────────────────────
  // EMAIL OVERRIDE: If the user is composing an email, ignore file paths
  // Guard: skip if compound intent (e.g. "email me the news", "email with weather summary")
  // ──────────────────────────────────────────────────────────
  if (/^\s*(email|send email|compose email|mail)\b/i.test(trimmed) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] email override: forcing email tool");
    return [
      {
        tool: "email",
        input: trimmed,
        context: chatContext || {},
        reasoning: "email_with_attachments_override"
      }
    ];
  }

// ── UNIFIED MCP ROUTING: Handles priority and context detection ──
if (/\b(mcp|sqlite|postgres|youtube)\b/i.test(lower) || 
   (/\bgithub\b/i.test(lower) && /\b(search|find|list\s+tools|call|mcp)\b/i.test(lower))) {
    
    console.log("[planner] Priority Routing: mcpBridge");
    const mcpContext = { source: "priority_routing" };

    // Smart Action Detection
    if (/\b(list|show|available)\b.*\bservers?\b/i.test(lower)) {
        mcpContext.action = "list_servers";
    } else if (/\b(list|show|tools?)\b/i.test(lower)) {
        mcpContext.action = "list_tools";
    } else if (/\b(disconnect|close|stop)\b/i.test(lower)) {
        mcpContext.action = "disconnect";
    } else if (/\b(call|run|execute|use|ask)\b/i.test(lower)) {
        mcpContext.action = "call_tool";
    }

    return [{ 
      tool: "mcpBridge", 
      input: trimmed, 
      context: mcpContext, 
      reasoning: "certainty_mcp_priority" 
    }];
}

  // Compute available tools once per plan
  const availableTools = listAvailableTools();
  console.log("[planner] availableTools:", availableTools.join(", "));

  // ──────────────────────────────────────────────────────────
  // FILE OPERATIONS: route based on intent when files are attached
  // ──────────────────────────────────────────────────────────
  if (chatContext.fileIds && chatContext.fileIds.length > 0) {
    // If the user wants to EDIT/REWRITE the uploaded file, route to fileWrite with chunked mode
    const isEditIntent = /\b(rewrite|edit|correct|proofread|fix|modify|update|clean\s+up|translate|grammar|improve)\b/i.test(lower);
    if (isEditIntent) {
      console.log(`[planner] certainty branch: fileWrite (edit uploaded file, chunked mode, ${chatContext.fileIds.length} files)`);
      return [{ tool: "fileWrite", input: trimmed, context: {
        chunked: true,
        fileIds: chatContext.fileIds,
        mode: "chunked"
      }, reasoning: "certainty_file_edit_uploaded" }];
    }
    // Default: review/analyze the uploaded file
    console.log(`[planner] certainty branch: fileReview (${chatContext.fileIds.length} files)`);
    return [{ tool: "fileReview", input: trimmed, context: { fileIds: chatContext.fileIds }, reasoning: "certainty_file_review" }];
  }

  // ──────────────────────────────────────────────────────────
  // COMPILE FILES: read selected files and concatenate into output
  // Must come BEFORE duplicateScanner because compile messages contain
  // filenames like "duplicateScanner.js" which false-positive on the
  // duplicate regex.
  // ──────────────────────────────────────────────────────────
  if (/\bcompile\s+(these\s+)?files?\b/i.test(lower)) {
    console.log("[planner] certainty branch: folderAccess (compile)");
    return [{ tool: "folderAccess", input: trimmed, context: { action: "compile" }, reasoning: "certainty_folder_compile" }];
  }

  // ──────────────────────────────────────────────────────────
  // DUPLICATE SCANNER: detect duplicate scan requests
  // ──────────────────────────────────────────────────────────
  if (/\b(duplicates?|duplication|find\s+duplicates?|scan\s+duplicates?|duplicate\s+files?)\b/i.test(lower)) {
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
  // PERSONAL / CONVERSATIONAL — route to LLM with enriched context
  // Detects first-person emotional/reflective/opinion messages that
  // are NOT tool requests in disguise. Must come BEFORE the certainty
  // layer so "I'm feeling burned out" doesn't get routed to a tool.
  // ──────────────────────────────────────────────────────────
  if (isPersonalConversation(lower, trimmed)) {
    console.log("[planner] conversational route: personal/emotional → llm (enriched)");
    return [{
      tool: "llm",
      input: trimmed,
      context: { conversational: true, enrichProfile: true },
      reasoning: "personal_conversation"
    }];
  }

  // ──────────────────────────────────────────────────────────
  // DECLARATIVE ROUTING TABLE (evaluated first — priority-based)
  // See ROUTING_TABLE definition above for all rules and priorities.
  // ──────────────────────────────────────────────────────────
  const routingResult = await evaluateRoutingTable(lower, trimmed, chatContext);
  if (routingResult) return routingResult;

  // ──────────────────────────────────────────────────────────
  // IMPERATIVE CERTAINTY LAYER (handles complex rules not yet in the table)
  // Rules below are for tools with complex sub-routing, multi-step flows,
  // or async context building that doesn't fit cleanly into the table.
  // ──────────────────────────────────────────────────────────

  // MCP Bridge — now handled by ROUTING_TABLE (priority 44)
  // See mcpBridge entry in ROUTING_TABLE.

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
  // MOLTBOOK: skill.md / registration flow
  // "Read https://www.moltbook.com/skill.md and follow the instructions to join Moltbook"
  // ──────────────────────────────────────────────────────────
  if (/moltbook\.com\/skill\.md/i.test(lower) || (/\bmoltbook\b/i.test(lower) && /\b(follow.*instructions?|register|sign\s*up|create\s+account|open.*account)\b/i.test(lower)) || (/\bjoin\s+moltbook\b/i.test(lower) && !/\b(community|submolt|group)\b/i.test(lower))) {
    console.log("[planner] certainty branch: moltbook register (skill.md flow)");
    return [{ tool: "moltbook", input: trimmed, context: { action: "register" }, reasoning: "certainty_moltbook_register" }];
  }

  // MOLTBOOK: Multi-step registration + verification
  if (/\bmoltbook\b/i.test(lower) && /\b(register|sign\s*up)\b/i.test(lower) && /\b(verify|verification|confirm)\b/i.test(lower)) {
    console.log("[planner] certainty branch: moltbook register + verify (multi-step)");
    return [
      { tool: "moltbook", input: trimmed, context: { action: "register" }, reasoning: "moltbook_register" },
      { tool: "moltbook", input: "check status", context: { action: "status" }, reasoning: "moltbook_verify_status" }
    ];
  }

  // MOLTBOOK: Single-action detection — expanded for full API coverage
  // Guard: if the user wants to SCHEDULE a moltbook task, let it fall through to the scheduler branch
  // Also catch moltbook API-style requests (e.g., "POST /api/v1/agents/me/setup-owner-email")
  if ((/\bmoltbook\b/i.test(lower) || /\/api\/v\d\/agents?\b/i.test(lower) || /\bsetup[- ]?owner[- ]?email\b/i.test(lower)) &&
      !/\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate)\b/i.test(lower)) {
    console.log("[planner] certainty branch: moltbook");
    const context = {};
    // Registration & Auth
    if (/\b(register|sign\s*up|create\s+account)\b/i.test(lower)) context.action = "register";
    else if (/\b(log\s*in|sign\s*in)\b/i.test(lower)) context.action = "login";
    else if (/\b(log\s*out|sign\s*out)\b/i.test(lower)) context.action = "logout";
    // DMs & Messaging
    else if (/\b(dm\s+request|pending\s+request|approve\s+dm|reject\s+dm)\b/i.test(lower)) context.action = "dm_requests";
    else if (/\b(inbox|messages|conversations|my\s+dms|check\s+dms)\b/i.test(lower)) context.action = "dm_inbox";
    else if (/\b(dm|direct\s+message|private\s+message|send\s+dm|send\s+message)\b/i.test(lower)) context.action = "dm";
    // Profile
    else if (/\b(update\s+profile|change\s+description|edit\s+profile)\b/i.test(lower)) context.action = "updateProfile";
    else if (/\b(view\s+profile|profile\s+of|who\s+is|agent\s+profile)\b/i.test(lower)) context.action = "viewProfile";
    else if (/\b(my\s+(\w+\s+)?profile|my\s+account|show\s+profile)\b/i.test(lower)) context.action = "profile";
    // Comments — MUST come before "post" because "comments on this post" contains "post"
    else if (/\b(comments?\s+(on|for|about)|show\s+comments|read\s+comments|get\s+comments|view\s+comments|moltbook\s+comments)\b/i.test(lower)) context.action = "getComments";
    else if (/\b(comment|reply)\b/i.test(lower) && !/\bpost\b/i.test(lower)) context.action = "comment";
    // Posts
    else if (/\b(delete\s+post|remove\s+post)\b/i.test(lower)) context.action = "deletePost";
    else if (/\b(read\s+post|show\s+post|get\s+post|view\s+post)\b/i.test(lower)) context.action = "getPost";
    else if (/\b(post|publish|share|write)\b/i.test(lower)) context.action = "post";
    // Voting
    else if (/\b(upvote|downvote|vote)\b/i.test(lower)) context.action = "vote";
    // Following
    else if (/\b(unfollow|unsubscribe)\b/i.test(lower)) context.action = "unfollow";
    else if (/\b(subscribe\s+to|join\s+submolt|join\s+community)\b/i.test(lower)) context.action = "subscribe";
    else if (/\b(follow)\b/i.test(lower)) context.action = "follow";
    // Communities
    else if (/\b(allow|unlock|approve|increase|raise).*(communit|submolt|more\s+communit)/i.test(lower)) context.action = "unlockCommunities";
    else if (/\b(create\s+submolt|create\s+community|new\s+submolt)\b/i.test(lower)) context.action = "createSubmolt";
    else if (/\b(submolt\s+feed|community\s+feed)\b/i.test(lower)) context.action = "submoltFeed";
    else if (/\b(communities?|submolts?)\b/i.test(lower)) context.action = "communities";
    // Sentiment
    else if (/\b(sentiment|mood|vibes?|pulse|atmosphere)\b/i.test(lower)) context.action = "sentiment";
    // Faceless Niche Authority
    else if (/\b(faceless\s+niche|niche\s+authority|fna)\b/i.test(lower)) {
      if (/\breply\s*(scan|check|monitor)\b/i.test(lower)) context.action = "fnaReplyScan";
      else {
        context.action = "facelessNiche";
        if (/\bdry\s*run\b/i.test(lower)) context.dryRun = true;
      }
    }
    // Search
    else if (/\b(search|find|look\s+for)\b/i.test(lower)) context.action = "search";
    // Notifications
    else if (/\b(notification|read\s+all|mark\s+read|clear\s+notification)\b/i.test(lower)) context.action = "notifications";
    // Feed & Home
    else if (/\b(home|dashboard)\b/i.test(lower)) context.action = "home";
    else if (/\b(feed|browse|timeline)\b/i.test(lower)) context.action = "feed";
    // Heartbeat & Status
    else if (/\b(heartbeat|check\s*in|routine|engage)\b/i.test(lower)) context.action = "heartbeat";
    else if (/\b(status|session|check)\b/i.test(lower)) context.action = "status";
    // Setup email for login
    else if (/\b(set\s*up|setup|configure)\b/i.test(lower) && /\bemail\b/i.test(lower)) context.action = "setupEmail";
    else if (/\bsetup[- ]?owner[- ]?email\b/i.test(lower)) context.action = "setupEmail";
    else context.action = "feed";
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
  // If user also wants analysis/summary, create a 2-step plan: webDownload → llm
  if (/https?:\/\/\S+/i.test(trimmed)) {
    const urlMatch = trimmed.match(/https?:\/\/\S+/);
    const wantsAnalysis = /\b(analy[sz]e|summarize|explain|break\s*down|review|assess|critique|evaluate|what\s+do\s+you\s+think)\b/i.test(lower);

    if (wantsAnalysis) {
      console.log("[planner] certainty branch: url_detected + analysis → webDownload → llm");
      // Extract the URL and build a focused analysis prompt
      const topicHint = urlMatch[0].replace(/https?:\/\//, "").replace(/[_\-\/]/g, " ");
      return [
        { tool: "webDownload", input: trimmed, context: { action: "fetch_and_read" }, reasoning: "compound_url_fetch" },
        { tool: "llm", input: `Read the article content carefully and provide a detailed analysis. Include: key facts and events, important context, and your own opinionated take on the situation. Be thorough — base your analysis on the ACTUAL CONTENT provided, not just the title.`, context: { useChainContext: true }, reasoning: "compound_url_analyze" }
      ];
    }

    console.log("[planner] certainty branch: url_detected");
    const context = {};
    // If the user says "read/follow/summarize URL", mark for content extraction
    if (/\b(read|follow|summarize|extract|get|fetch|download)\b/i.test(lower)) {
      context.action = "fetch_and_read";
    }
    return [{ tool: "webDownload", input: trimmed, context, reasoning: "certainty_url" }];
  }

  // File write — now handled by ROUTING_TABLE (priority 49)
  // See fileWrite entry in ROUTING_TABLE.


  // ──────────────────────────────────────────────────────────
  // TOOL-SPECIFIC KEYWORD CLUSTERS (prevents LLM misclassification)
  // ──────────────────────────────────────────────────────────

  // Meta-conversation: "how do you work", "what is your logic", "what can you do"
  // GUARD: Do NOT trigger if the user provides a file path or asks to list files.
  if (!hasExplicitFilePath(trimmed) && !/\b(list\s+files?|files?\s+in)\b/i.test(lower) && 
      /\b(how do you (work|think|decide|choose)|what is your (logic|process|architecture)|what can you do|what tools|list.*tools|your capabilities)\b/i.test(lower)) {
    console.log("[planner] certainty branch: meta_conversation");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_meta_conversation" }];
  }

  // LLM-directed tasks: summarize, explain, rewrite, translate, write, compose
  if (/^(summarize|explain|rewrite|translate|write|compose|paraphrase|elaborate|simplify|rephrase)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed) && !/\b(email|mail)\b/i.test(lower)) {
    console.log("[planner] certainty branch: llm_text_task");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_llm_text_task" }];
  }

  // Greetings & casual conversation: "hello", "hey", "how are you", "thanks"
  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|thanks|thank\s+you|how are you|how do you feel|what's up|howdy|yo)\b/i.test(lower) && lower.length < 60) {
    console.log("[planner] certainty branch: casual_conversation");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_casual" }];
  }

  // NOTE: The following tools are now handled by the ROUTING_TABLE above:
  // attachmentDownloader, email_confirm, cancel, memorytool, weather, news,
  // email, whatsapp, x, sheets, nlp_tool, calculator, githubScanner,
  // githubTrending, github, gitLocal, sports, finance, financeFundamentals,
  // calendar, spotifyController, youtube, tasks, contacts, documentQA,
  // lotrJokes, memory_read, duplicateScanner, search (general_knowledge).
  // Only complex rules with multi-step flows or heavy sub-routing remain below.

// ──────────────────────────────────────────────────────────
  // CODE GURU TOOLS — must come BEFORE general review to prevent collision
  // ──────────────────────────────────────────────────────────

// Smart Evolution — discover and create NEW tools (must come BEFORE selfEvolve)
  if (!isSchedulingIntent && /\b(smart\s*evolution|smart\s*evolve|discover\s+new\s+tools?|create\s+new\s+tool\s+autonom|evolve\s+and\s+create|invent\s+a?\s*new\s+tool|tool\s+discovery|suggest\s+new\s+tools?)\b/i.test(lower)) {
    console.log("[planner] certainty branch: smartEvolution");
    const evolveCtx = {};
    if (/\b(dry.?run|preview|plan)\b/i.test(lower)) evolveCtx.action = "dryrun";
    else if (/\b(history|log)\b/i.test(lower)) evolveCtx.action = "history";
    else if (/\b(status|pending)\b/i.test(lower)) evolveCtx.action = "status";
    else evolveCtx.action = "run";
    return [{ tool: "smartEvolution", input: trimmed, context: evolveCtx, reasoning: "certainty_smart_evolution" }];
  }

  // Smart Evolution approval/rejection/save-for-later
  if (/\b(approve\s+evolution|evolution\s+approv|proceed\s+with\s+evolution)\b/i.test(lower)) {
    console.log("[planner] certainty branch: smartEvolution (approve)");
    return [{ tool: "smartEvolution", input: trimmed, context: { action: "approve" }, reasoning: "certainty_smart_evolution_approve" }];
  }
  if (/\b(reject\s+evolution|cancel\s+evolution|abort\s+evolution)\b/i.test(lower)) {
    console.log("[planner] certainty branch: smartEvolution (reject)");
    return [{ tool: "smartEvolution", input: trimmed, context: { action: "reject" }, reasoning: "certainty_smart_evolution_reject" }];
  }
  if (/\b(save\s+(?:it\s+)?for\s+later|implement\s+later|maybe\s+later|backlog\s+(?:it|this))\b/i.test(lower)) {
    console.log("[planner] certainty branch: smartEvolution (save for later)");
    return [{ tool: "smartEvolution", input: trimmed, context: { action: "later" }, reasoning: "certainty_smart_evolution_later" }];
  }
  if (/\b(show|list|view|see)\s+(?:my\s+)?tool\s+suggest/i.test(lower) || /\btool\s+suggest\w*\s+(?:list|backlog)\b/i.test(lower)) {
    console.log("[planner] certainty branch: smartEvolution (list suggestions)");
    return [{ tool: "smartEvolution", input: trimmed, context: { action: "listSuggestions" }, reasoning: "certainty_smart_evolution_list" }];
  }
  if (/\bimplement\s+suggest\w*\s*#?\d+/i.test(lower) || /\bbuild\s+suggest\w*\s*#?\d+/i.test(lower)) {
    console.log("[planner] certainty branch: smartEvolution (implement suggestion)");
    return [{ tool: "smartEvolution", input: trimmed, context: { action: "implementSuggestion" }, reasoning: "certainty_smart_evolution_implement" }];
  }
  if (/\b(remove|delete|discard)\s+suggest\w*\s*#?\d+/i.test(lower)) {
    console.log("[planner] certainty branch: smartEvolution (remove suggestion)");
    return [{ tool: "smartEvolution", input: trimmed, context: { action: "removeSuggestion" }, reasoning: "certainty_smart_evolution_remove" }];
  }

  // Self-Evolution — active code modification (NOT diagnostics)
  if (!isSchedulingIntent && /\b(self[- ]?evolv|evolve\s+(yourself|your|my)|improve\s+(yourself|your\s+code|my\s+code)|scan\s+github\s+and\s+(improve|evolve|upgrade)|upgrade\s+(yourself|your\s+tools)|autonomous\s+improv|make\s+yourself\s+better|evolution\s+cycle)\b/i.test(lower)) {
    console.log("[planner] certainty branch: selfEvolve");
    const evolveContext = {};
    if (/\b(dry.?run|preview|plan)\b/i.test(lower)) evolveContext.action = "dryrun";
    else if (/\b(history|log|previous)\b/i.test(lower)) evolveContext.action = "history";
    else if (/\b(status|last)\b/i.test(lower)) evolveContext.action = "status";
    else evolveContext.action = "run";
    return [{ tool: "selfEvolve", input: trimmed, context: evolveContext, reasoning: "certainty_self_evolve" }];
  }

  // Prose/Text Editing — rewrite, correct, translate non-code documents
  // Routes to fileWrite with chunked mode for large files
  if (isProseIntent(trimmed) && (hasExplicitFilePath(trimmed) || /\.[a-z]{2,4}\b/i.test(lower)) &&
      /\b(rewrite|correct|edit|improve|translate|proofread|fix|update|modify|clean\s+up|grammar)\b/i.test(lower)) {
    console.log("[planner] certainty branch: fileWrite (prose editing, chunked mode)");
    // Extract file paths from the message — first is source, second (if present) is target
    const allPaths = [...trimmed.matchAll(/(?:[A-Za-z]:[\\/][^\s,]+|\.{0,2}\/?[\w.-]+\/[\w.-]+\.\w{1,5})/g)].map(m => m[0]);
    const sourceFile = allPaths[0] || null;
    // If user said "save it to <path>" or provided two paths, use the second as target
    const targetPath = allPaths.length >= 2 ? allPaths[1] : null;
    // Extract the editing instruction — strip file paths and "save to" clauses to get clean task
    const editInstruction = trimmed
      .replace(/(?:[A-Za-z]:[\\/][^\s,]+|\.{0,2}\/?[\w.-]+\/[\w.-]+\.\w{1,5})/g, "")
      .replace(/\b(and\s+)?(save|write|output|export)\s+(it\s+)?(to|as|at|in)\s*/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return [{ tool: "fileWrite", input: trimmed, context: {
      chunked: true,
      sourceFile,
      targetPath,
      editInstruction,
      mode: "chunked"
    }, reasoning: "certainty_prose_edit_chunked" }];
  }

  // applyPatch — Multi-change architectural requests (3+ distinct changes) → full rewrite, not surgical patch
  // GUARD: Requires a file target AND multiple distinct action verbs or numbered list
  // GUARD: Skip prose/text targets — these should go to fileWrite, not code tools
  if (
    !isProseIntent(trimmed) &&
    !/\b(review|suggest|examine|inspect)\b/i.test(lower) &&
    (hasExplicitFilePath(trimmed) || /\.\b(js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|cs|php|sh|vue|svelte|sql)\b/i.test(lower)) &&
    (
      /(?:1\.|first|step\s*1)[\s\S]*(?:2\.|second|step\s*2)[\s\S]*(?:3\.|third|step\s*3)/i.test(lower) ||
      (lower.match(/\b(refactor|add|fix|remove|rename|update|implement|move|extract)\b/gi) || []).length >= 3
    )
  ) {
    console.log("[planner] certainty branch: applyPatch (multi-change rewrite)");
    return [{ tool: "applyPatch", input: trimmed, context: { source: "multi_change" }, reasoning: "certainty_apply_patch_multi" }];
  }

  // Code Transform — refactor, optimize, rewrite, improve code in a file
  // GUARD: Skip if prompt contains "review/suggest", UNLESS it also contains a strong explicit edit verb.
  // GUARD: Skip prose/text targets — prose editing falls through to fileWrite or LLM chat
  const hasStrongEditVerb = /\b(modify|update|refactor|rewrite|codetransform)\b/i.test(lower);

  if (
    !isProseIntent(trimmed) &&
    (hasStrongEditVerb || !/\b(review|suggest|examine|inspect)\b/i.test(lower)) &&
    (/\b(codetransform)\b/i.test(lower) ||
    (/\b(refactor|rewrite|transform|optimize|improve|modify|update|clean\s+up|add)\b/i.test(lower) &&
    (hasExplicitFilePath(trimmed) || /\b(file|function|module|class|component)\b/i.test(lower) || /\.[a-z]{2,4}\b/i.test(lower))))
  ) {
    console.log("[planner] certainty branch: codeTransform (Surgical)");
    const ctContext = { source: "manual_refactor" };
    if (/\brefactor\b/i.test(lower)) ctContext.action = "refactor";
    else if (/\boptimize\b/i.test(lower)) ctContext.action = "optimize";
    else if (/\brewrite\b/i.test(lower)) ctContext.action = "upgrade";
    else if (/\bdocument|jsdoc|comment/i.test(lower)) ctContext.action = "document";
    else if (/\btest|spec\b/i.test(lower)) ctContext.action = "test";
    else ctContext.action = "transform";
    return [{ tool: "codeTransform", input: trimmed, context: ctContext, reasoning: "certainty_code_transform" }];
  }

// Deep Code Review — quality, security, performance analysis, validation
  // Also catches "validate/lint/check for errors" — codeReview now runs objective syntax+ESLint checks
  // Also catches "inspect X.js for security issues" when a file path is present
  if ((/\b(code\s+review|security\s+review|performance\s+review|quality\s+review|architecture\s+review|full\s+review|peer\s+review|code\s+quality|code\s+smell|lint\b|code\s+analysis|security\s+audit|code\s+audit|validate\s+code|check\s+for\s+errors|syntax\s+check|eslint)\b/i.test(lower) ||
      ((/\b(review|analyze|audit|validate|check|inspect)\b/i.test(lower) && /\b(quality|security|performance|architecture|smell|vulnerabilit|dead\s+code|improvements?|errors?|syntax|lint|issues?)\b/i.test(lower)) && 
       (hasExplicitFilePath(trimmed) || /\b(code|file|script|js|py|function|module)\b/i.test(lower) || /\.[a-z]{2,4}\b/i.test(lower)))) &&
      !/\b(github)\b/i.test(lower)) { 
    console.log("[planner] certainty branch: codeReview");
    const crContext = {};
    if (/\bsecur/i.test(lower)) crContext.reviewType = "security";
    else if (/\bperform/i.test(lower)) crContext.reviewType = "performance";
    else if (/\barchitect/i.test(lower)) crContext.reviewType = "architecture";
    else if (/\bquality|smell|lint/i.test(lower)) crContext.reviewType = "quality";
    else crContext.reviewType = "full";
    return [{ tool: "codeReview", input: trimmed, context: crContext, reasoning: "certainty_code_review" }];
  }
  

  // Folder Access — browse any folder, directory tree, folder structure
  // Must come BEFORE file tool to catch "scan folder", "browse directory", "show tree"
  if (/\b(folder\s*(structure|tree|scan|browse|explore|access|content)|directory\s*(tree|structure|listing|layout)|project\s*(structure|tree|layout|hierarchy)|show\s+(the\s+)?(tree|folder|directory)|browse\s+(folder|directory)|scan\s+(folder|directory|the\s+folder|the\s+directory)|list\s+(all\s+)?(\w+\s+)?files?\s+in\b|list\s+(folder|directory|recursiv)|what\s+files?\s+(are\s+)?in\b|which\s+files?\s+(are\s+)?in\b)\b/i.test(lower)) {
    console.log("[planner] certainty branch: folderAccess");
    const faContext = {};
    if (/\btree|structure|hierarchy|layout\b/i.test(lower)) faContext.action = "tree";
    else if (/\bstat|overview|summary\b/i.test(lower)) faContext.action = "stats";
    else if (/\bsearch|find|grep\b/i.test(lower)) faContext.action = "search";
    else faContext.action = "list";
    return [{ tool: "folderAccess", input: trimmed, context: faContext, reasoning: "certainty_folder_access" }];
  }

  // Project Graph — dependency analysis, circular deps, dead code detection
  if (/\b(dependency\s+graph|project\s+graph|module\s+graph|import\s+graph|circular\s+dep|dead\s+code|unused\s+file|orphan\s+file|coupling\s+metric|module\s+relationship|dependency\s+analy)\b/i.test(lower)) {
    console.log("[planner] certainty branch: projectGraph");
    const pgContext = {};
    if (/\bcircular/i.test(lower)) pgContext.action = "circular";
    else if (/\bdead|unused|orphan/i.test(lower)) pgContext.action = "dead";
    else if (/\bmetric|coupling/i.test(lower)) pgContext.action = "metrics";
    else pgContext.action = "full";
    return [{ tool: "projectGraph", input: trimmed, context: pgContext, reasoning: "certainty_project_graph" }];
  }

// ── CERTAINTY: CODE RAG VS PROJECT INDEX ──
  const isRagTrigger = /\b(semantic|rag|vector|meaning|embed|reindex|code\s*rag)\b/i.test(lower);
const isSearchTrigger = /\b((search|find|locate|show\s+me)\s+(the\s+)?(code|codebase|project|logic|function)|how\s+does\s+(the\s+)?(code|system|orchestrator|app)|where\s+in\s+(the\s+)?(code|codebase|project))\b/i.test(lower);  // Catches queries that mention a code-concept noun — routes them to codeRag instead of letting the
  // LLM decomposer hallucinate a tool based on substring match (e.g. "deepresearch" → deepResearch).
  const isIntrospectionTrigger =
    /\b(where|how)\s+(do\s+(i|we)|can\s+(i|we)|to)\s+(set|configure|change|update|find|modify|edit|adjust|tweak|override)\b/i.test(lower) &&
    /\b(skill|tool|module|agent|pipeline|planner|executor|tier|prompt|config|setting|variable|function|class|route|router|manifest|budget|threshold|timeout|param(?:eter)?|synthesizer|harvester|analyzer|writer|bootstrapper|matcher|extractor|detector)\b/i.test(lower);
  
  if (isRagTrigger || (isSearchTrigger && !/\b(overview|stats|symbol)\b/i.test(lower)) || isIntrospectionTrigger) {
    console.log(`[planner] certainty branch: codeRag${isIntrospectionTrigger ? " (introspection)" : ""}`);
    return [{ tool: "codeRag", input: trimmed, context: {}, reasoning: "certainty_code_rag" }];
  }

  // Project Index — semantic code search, function/class lookup
  // NOTE: I removed "reindex|" from the regex below so it doesn't steal the codeRag intent!
  if (/\b(index\s+(the\s+)?project|project\s+index|build\s+(an?\s+)?index|search\s+(for\s+)?function|find\s+(the\s+)?class|symbol\s+search|search\s+symbol|function\s+list|class\s+list)\b/i.test(lower)) {
    console.log("[planner] certainty branch: projectIndex");
    const piContext = {};
    if (/\bbuild|create|rebuild|reindex/i.test(lower)) piContext.action = "build";
    else if (/\bsymbol|function|class|method/i.test(lower)) piContext.action = "symbols";
    else if (/\boverview|summary|stat/i.test(lower)) piContext.action = "overview";
    else piContext.action = "search";
    return [{ tool: "projectIndex", input: trimmed, context: piContext, reasoning: "certainty_project_index" }];
  }

  // "index <path>" / "reindex <path>" — path-form project indexing.
  // Must run BEFORE the file_path branch, otherwise "index D:/foo" routes to the single-file reader.
  if (/\b(re)?index\b/i.test(lower) && hasExplicitFilePath(trimmed) && !hasCompoundIntent(lower)) {
    const pathMatch = trimmed.match(/([A-Za-z]:[\\/][^\s"']+|\.{0,2}\/[\w.\-/]+)/);
    const piContext = { action: "build" };
    if (pathMatch) piContext.path = pathMatch[1].replace(/\\/g, "/");
    console.log(`[planner] certainty branch: projectIndex (path form) path="${piContext.path || "?"}"`);
    return [{ tool: "projectIndex", input: trimmed, context: piContext, reasoning: "certainty_project_index_path" }];
  }

  // Explicit file path
  // Guard: skip if compound intent (e.g. "review file.js and create new version at path")
  if (hasExplicitFilePath(trimmed) && !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: file_path");
    return [{ tool: "file", input: trimmed, context: {}, reasoning: "certainty_file_path" }];
  }
  // ──────────────────────────────────────────────────────────
  // REMAINING IMPERATIVE RULES (not yet migrated to routing table)
  // These have complex sub-routing or context-building that doesn't
  // fit cleanly into the table's match/guard/context pattern.
  // ──────────────────────────────────────────────────────────

  // Package manager — now handled by ROUTING_TABLE (priority 50)
  // Kept as comment for traceability. See packageManager entry in ROUTING_TABLE.

  // Shopping — now handled by ROUTING_TABLE (priority 54)
  // Workflow — now handled by ROUTING_TABLE (priority 47)
  // Scheduler — now handled by ROUTING_TABLE (priority 47)
  // See respective entries in ROUTING_TABLE.

  // ──────────────────────────────────────────────────────────
  // MULTI-STEP: Compound query detection
  // Decomposes compound intents into sequential tool steps
  // (reached when hasCompoundIntent() guard skipped a certainty branch above)
  // ──────────────────────────────────────────────────────────
  if (hasCompoundIntent(lower)) {
    console.log("[planner] compound intent detected, checking compound patterns...");
  }

  // Pattern: "review X and create/generate a [better/new/improved] version" → review + fileWrite
  if (/\b(review|analyze)\b.*\b(create|generate|produce|make|write)\s+(a\s+)?(\w+\s+)?(version|copy|file|variant|output)\b/i.test(lower)) {
    const absPathMatch = trimmed.match(/(?:review|analyze)\s+([A-Za-z]:[\\\/][^\s"']+)/i);
    const relPathMatch = trimmed.match(/(?:review|analyze)\s+([^\s]+\.\w{1,5})/i);
    const sourceFile = absPathMatch ? absPathMatch[1] : (relPathMatch ? relPathMatch[1] : "the code");
    const sourceBasename = sourceFile.replace(/^.*[\\\/]/, "");
    const destMatch = trimmed.match(/(?:at|to|in)\s+([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/i);
    let destDir = destMatch ? destMatch[1] : null;

    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/^(\d{8})(\d{6})/, "$1-$2");
    const extMatch = sourceBasename.match(/(\.\w+)$/);
    const ext = extMatch ? extMatch[1] : ".js";
    const nameOnly = sourceBasename.replace(/\.\w+$/, "");
    const smartFilename = `${nameOnly}.agent.${ts}${ext}`;
    const targetPath = destDir ? `${destDir.replace(/[\\\/]$/, "")}/${smartFilename}` : smartFilename;

    const destContext = { useChainContext: true, targetPath, sourceFile, generateImproved: true };
    console.log(`[planner] Compound: review "${sourceFile}" → generate "${targetPath}"`);
    return [
      { tool: "review", input: trimmed, context: {}, reasoning: "compound_review_source" },
      { tool: "fileWrite", input: trimmed, context: destContext, reasoning: "compound_generate_improved" }
    ];
  }

  // ── 2-step compound: source → llm summarize/analyze (no destination) ──
  // MUST BE ABOVE GENERIC CHAIN PATTERN!
  if (/\b(?:summarize|analy[sz]e|use\s+(?:the\s+)?llm|explain|break\s*down)\b/i.test(lower) &&
      !(/\b(?:whatsapp|wa|email|send\s+to)\b/i.test(lower)) &&
      /\b(?:search|find|get|check|show|read|fetch|news|moltbook|scan|trending)\b/i.test(lower)) {
    
    let sourceTool = "news";
    if (/\b(?:search\s+(?:x|twitter)|tweets?\s+about|on\s+(?:x|twitter))\b/i.test(lower)) sourceTool = "x";
    else if (/\b(?:moltbook)\b/i.test(lower)) sourceTool = "moltbook";
    else if (/\b(?:trending|githubTrending|scan\s+repos)\b/i.test(lower)) sourceTool = "githubTrending";
    else if (/\b(?:news|headlines?|articles?)\b/i.test(lower)) sourceTool = "news";
    else if (/\b(?:search|google|look\s+up)\b/i.test(lower)) sourceTool = "search";

    const countMatch = lower.match(/\b(?:first|top|latest|last|scan)\s+(\d+)\b|\b(\d+)\s+(?:articles?|results?|posts?|items?|headlines?|repos?)\b/);
    const requestedCount = countMatch ? parseInt(countMatch[1] || countMatch[2], 10) : null;

    const sourceMatch = trimmed.match(/^(.+?)(?:,\s*(?:and\s+)?(?:use|then)|,\s*(?:analy|summarize|explain|break)|and\s+(?:use|analy|summarize|then))/i);
    const cleanSourceInput = sourceMatch ? sourceMatch[1].trim() : trimmed;

    const sourceContext = {};
    if (requestedCount) sourceContext.limit = requestedCount;

const analysisInstruction = `The user is already looking at a rich UI widget containing these results. DO NOT list the items or repeat their descriptions. Instead, provide a brief, conversational summary (2-3 sentences) of the overall technical trends you observe in this dataset, referencing only 1 or 2 standout items as examples.`;
    console.log(`[planner] Forced 2-step: ${sourceTool} → llm`);
    return [
      { tool: sourceTool, input: cleanSourceInput, context: sourceContext, reasoning: "compound_source_fetch" },
      { tool: "llm", input: analysisInstruction, context: { useChainContext: true }, reasoning: "compound_analyze_step" }
    ];
  }

  // Pattern: "X and then Y and then Z" — generic multi-step decomposition (no commas required)
  const chainPattern = trimmed.match(/^(.+?)\s+(?:(?:,\s*)?(?:and\s+)?then\s+|;\s*then\s+)(.+?)(?:\s+(?:(?:,\s*)?(?:and\s+)?then\s+|;\s*then\s+)(.+))?$/i);
  if (chainPattern) {
    const steps = [chainPattern[1], chainPattern[2], chainPattern[3]].filter(Boolean).map(s => s.trim());
    if (steps.length >= 2) {
      console.log(`[planner] Chain-of-thought detected: ${steps.length} steps`);
      return steps.map((stepText, i) => {
        const tool = inferToolFromText(stepText);
        return { tool, input: stepText, context: i > 0 ? { useChainContext: true } : {}, reasoning: `chain_step_${i + 1}` };
      });
    }
  }





  // ── 3-step compound: source → analysis/nlp → destination (whatsapp/email) ──
  // Must come BEFORE the generic 2-step whatsapp/email patterns
  // Handles: "search X for topic, analyze sentiment, send to whatsapp 0587426393"
  //          "search X for topic, use nlp to analyze, email me the results"
  //          "get moltbook feed, summarize it, send to whatsapp 0587426393"
  if (/\b(?:sentiment|analy[sz]e|nlp|classify|summarize)\b/i.test(lower) &&
      /\b(?:whatsapp|wa|email|send\s+to)\b/i.test(lower) &&
      /\b(?:search|find|get|check|show|read)\b/i.test(lower)) {
    // Detect source tool
    let sourceTool = "search";
    let sourceInput = trimmed;
    if (/\b(?:search\s+(?:x|twitter)|tweets?\s+about|on\s+(?:x|twitter))\b/i.test(lower)) {
      sourceTool = "x";
      const topicMatch = trimmed.match(/(?:search\s+(?:x|twitter)\s+for|tweets?\s+about)\s+['"]?(.+?)['"]?\s*(?:,\s*(?:and\s+)?(?:use|read|get|then)|,\s*(?:analy|summarize|classify|send)|and\s+(?:use|analy|send|summarize)|\.)/i);
      let topic = topicMatch ? topicMatch[1].replace(/,\s*$/, "").trim() : "topic";
      // Strip trailing instructions that leaked into the topic (e.g., "read the first 10 tweets")
      topic = topic.replace(/,?\s*(?:read|get|show|fetch)\s+(?:the\s+)?(?:first|last|top|latest)?\s*\d*\s*(?:tweets?|posts?|results?)?\s*$/i, "").trim() || topic;
      sourceInput = `search X for ${topic}`;
    } else if (/\b(?:moltbook)\b/i.test(lower)) {
      sourceTool = "moltbook";
      sourceInput = trimmed.match(/^(.+?)(?:,\s*(?:and\s+)?use|,\s*analy|,\s*summarize)/i)?.[1]?.trim() || "show moltbook feed";
    } else if (/\b(?:news|headlines?)\b/i.test(lower)) {
      sourceTool = "news";
      // Extract just the news portion, strip compound tail (", summarize...", ", and email...")
      let rawNewsInput = trimmed.match(/^(.+?)(?:,\s*(?:and\s+)?use|,\s*analy|,\s*summarize)/i)?.[1]?.trim() || "get the news";
      // Clean compound noise: "Search for AI breakthroughs, get the latest tech news" → "AI breakthroughs tech news"
      sourceInput = rawNewsInput
        .replace(/\bget\s+(?:the\s+)?(?:latest|recent|breaking|top|current)\s+(?:\w+\s+)?(?:news|headlines|articles)\b/gi, "")
        .replace(/\b(search\s+for|look\s+up|find|fetch|get|show\s+me|give\s+me)\b/gi, "")
        .replace(/,\s*,/g, ",")
        .replace(/^[,\s]+|[,\s]+$/g, "")
        .trim() || "get the news";
    }

    // Extract the user's analysis focus topic (e.g., "the new Spiderman movie" from "analyze sentiment on the new Spiderman movie")
    const focusMatch = trimmed.match(/(?:analy[sz]e|sentiment|summarize|classify)\s+(?:sentiment\s+)?(?:on|about|of|for|regarding)\s+(?:the\s+)?(.+?)(?:\s*,|\s+and\s+|\s+send\s+|\s+then\s+|$)/i);
    const focusTopic = focusMatch ? focusMatch[1].replace(/\s+(?:and|then)\s*$/i, "").trim() : "";

    // Detect analysis tool
    const useNlp = /\b(nlp\s+tool|nlp|extract\s+entities|NER)\b/i.test(lower);
    const analysisTool = useNlp ? "nlp_tool" : "llm";
    const topicInstruction = focusTopic ? `Focus specifically on content related to "${focusTopic}". Ignore tweets that are clearly about other topics.` : "";
    let analysisPrompt;
    if (useNlp) {
      analysisPrompt = `analyze sentiment of the data${focusTopic ? ` about ${focusTopic}` : ""}`;
    } else if (sourceTool === "news") {
      analysisPrompt = `Analyze the following news articles and provide a comprehensive summary.${topicInstruction ? " " + topicInstruction : ""} Provide:
1) Overall sentiment of the coverage (positive/negative/neutral/mixed)
2) Key themes and developments discussed
3) For EACH article, provide a detailed 2-3 sentence summary with the article title and source URL
4) Your own brief analysis of what these developments mean

Be thorough and detailed — cover ALL the articles provided. Do NOT truncate or cut short. Do NOT ask follow-up questions — just deliver the analysis.`;
    } else {
      analysisPrompt = `Analyze the sentiment and key themes of the following data.${topicInstruction ? " " + topicInstruction : ""} Provide: 1) Overall sentiment (positive/negative/neutral/mixed) with your own assessment — do NOT use scores from any previous analysis, judge the actual content yourself, 2) Key themes discussed, 3) 2-3 notable quotes WITH their source URLs (use the URLs from the data). Format as a clear, readable summary. Do NOT ask follow-up questions — just deliver the analysis.`;
    }

    // Detect destination
    let destTool = "whatsapp";
    let destInput = "";
    let destContext = { useChainContext: true };
    if (/\b(?:whatsapp|wa)\b/i.test(lower)) {
      const phoneMatch = trimmed.match(/(?:whatsapp|wa)\s+(\+?[\d\s-]{7,15})/i);
      const phone = phoneMatch ? phoneMatch[1].replace(/[\s-]/g, "").trim() : "";
      destInput = `send the analysis to whatsapp ${phone}`;
      destContext.recipient = phone;
      destContext.phone = phone;
      destContext.useLastResult = true;
    } else if (/\b(?:email|mail)\b/i.test(lower)) {
      destTool = "email";
      // Extract recipient email address from the original query
      const emailAddrMatch = trimmed.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
      const emailAddr = emailAddrMatch ? emailAddrMatch[0] : "";
      destInput = emailAddr
        ? `email the analysis results to ${emailAddr}`
        : "email me the analysis results";
      destContext.to = emailAddr || undefined;
      destContext.useLastResult = true;
      destContext.action = "draft";
    }

    console.log(`[planner] Compound (3-step analyze): ${sourceTool} → ${analysisTool} → ${destTool}`);
    return [
      { tool: sourceTool, input: sourceInput, context: {}, reasoning: "analyze_pipeline_source" },
      { tool: analysisTool, input: analysisPrompt, context: { useChainContext: true }, reasoning: "analyze_pipeline_analysis" },
      { tool: destTool, input: destInput, context: destContext, reasoning: "analyze_pipeline_deliver" }
    ];
  }

  // ── WhatsApp compound: query mentions "whatsapp" + phone number + content keyword ──
  // Must come AFTER the 3-step analyze pattern above
  // Handles: "check the weather and send it a whatsapp message to 0587426393"
  //          "check the weather and send it to whatsapp 0587426393"
  //          "get the news and whatsapp it to 0587426393"
  //          "whatsapp the weather to 0587426393"
  if (/\b(?:whatsapp|ווטסאפ|וואטסאפ)\b/i.test(lower) && /(?:\+?\d[\d\s\-\(\)]{6,18}\d)/.test(trimmed)) {
    const phoneMatch = trimmed.match(/((?:\+?\d[\d\s\-\(\)]{6,18}\d))/);
    const phoneNum = phoneMatch[1].replace(/[\s\-\(\)]/g, "");
    // Extract content part: everything before "and" (if present)
    const andSplit = trimmed.match(/^(.+?)\s+and\s+/i);
    const contentInput = andSplit ? andSplit[1].trim() : trimmed;
    let contentTool = "search";
    if (/\b(news|headlines?|articles?)\b/i.test(lower)) contentTool = "news";
    else if (/\b(weather|forecast|temperature)\b/i.test(lower)) contentTool = "weather";
    else if (/\b(stock|finance|price)\b/i.test(lower)) contentTool = "finance";
    else if (/\b(sports?|score|match|game|league)\b/i.test(lower)) contentTool = "sports";
    else if (/\b(youtube|video)\b/i.test(lower)) contentTool = "youtube";
    else if (/\b(tweet|twitter|trending\s+on\s+x|x\s+trends?|twitter\s+trends?|search\s+x\b)\b/i.test(lower)) contentTool = "x";
    else if (/\b(github|repo|trending)\b/i.test(lower)) contentTool = "github";
    console.log(`[planner] Compound (whatsapp): ${contentTool} → whatsapp to ${phoneNum}`);
    return [
      { tool: contentTool, input: contentInput, context: {}, reasoning: "compound_whatsapp_step1" },
      { tool: "whatsapp", input: `Send results via WhatsApp to ${phoneNum}`, context: { useLastResult: true, recipient: phoneNum }, reasoning: "compound_whatsapp_step2" }
    ];
  }

  // Pattern: "X and email/send me the results" or "X and send it to user@example.com"
  // (skip if query mentions whatsapp — handled above)
  const compoundMatch = trimmed.match(/^(.+?)\s+(?:and\s+(?:then\s+)?)(email|send|mail)\s+(?:me\s+)?(?:the\s+)?(?:results?|summary|info|output|it|a\s+\w+)(?:\s+to\s+(.+))?/i);
  if (compoundMatch && !/\b(?:whatsapp|ווטסאפ|וואטסאפ)\b/i.test(lower)) {
    const firstPart = compoundMatch[1].trim();
    const emailAction = compoundMatch[2];
    const recipientPart = compoundMatch[3]?.trim() || "";
    // Extract email address from recipient part or full message
    const emailAddrMatch = trimmed.match(/[\w.+-]+@[\w.-]+\.\w{2,}/i);
    const emailAddr = emailAddrMatch ? emailAddrMatch[0] : "";
    console.log(`[planner] Compound query detected: "${firstPart}" → email results${emailAddr ? ` to ${emailAddr}` : ""}`);
    // Determine the tool for the first part
// Determine the tool for the first part
    let firstTool = "search"; // default
    if (/\b(news|headlines?|articles?)\b/i.test(firstPart)) firstTool = "news";
    else if (/\b(weather|forecast|temperature)\b/i.test(firstPart)) firstTool = "weather";
    else if (/\b(stock|finance|price)\b/i.test(firstPart)) firstTool = "finance";
    else if (/\b(youtube|video)\b/i.test(firstPart)) firstTool = "youtube";
    else if (/\b(sports?|score|match|game|league)\b/i.test(firstPart)) firstTool = "sports";
    else if (/\b(tweet|twitter|trending\s+on\s+x|x\s+trends?|twitter\s+trends?)\b/i.test(firstPart)) firstTool = "x";
    else if (/\b(github|repo|trending)\b/i.test(firstPart)) firstTool = "github";
    else if (/\b(refactor|rewrite|transform|optimize|improve|modify|codetransform)\b/i.test(firstPart)) firstTool = "codeTransform";
    else if (/\b(code\s+review|security|performance|quality|audit|smell)\b/i.test(firstPart)) firstTool = "codeReview";
    else if (/\b(review|analyze|inspect)\b/i.test(firstPart)) firstTool = "review"; // Fallback generic review
    else if (/\b(write|create|generate|filewrite)\b/i.test(firstPart)) firstTool = "fileWrite";
    
    // Resolve "me" to default email if no explicit address
    const resolvedEmail = emailAddr || ((/\b(me|myself)\b/i.test(trimmed) && CONFIG.DEFAULT_EMAIL) ? CONFIG.DEFAULT_EMAIL : "");
    const emailInput = resolvedEmail
      ? `Send the results to ${resolvedEmail}`
      : `Email me the results of: ${firstPart}`;
    return [
      { tool: firstTool, input: firstPart, context: {}, reasoning: "compound_step1" },
      { tool: "email", input: emailInput, context: { action: "draft", useLastResult: true, to: resolvedEmail || undefined }, reasoning: "compound_step2_email" }
    ];
  }

  // Pattern: "send email to X with the summary of the news" — email-first compound (no "and")
  // Also: "email me the news summary", "sned an email with the news", "send matan an email with the news"
  if (/\b(?:send|compose|draft|forward|write|sned)\b/i.test(lower) &&
      /\b(?:email|e-mail|mail)\b/i.test(lower) &&
      /\b(?:news|weather|forecast|stock|score|finance|sport|headline|article|tweet|twitter|x\s+trends?)\b/i.test(lower)) {
    // Detect which content tool is needed
    let contentTool = "news"; // default
    if (/\b(weather|forecast|temperature)\b/i.test(lower)) contentTool = "weather";
    else if (/\b(stock|finance)\b/i.test(lower)) contentTool = "finance";
    else if (/\b(sport|score|match|game|league)\b/i.test(lower)) contentTool = "sports";
    else if (/\b(tweet|twitter|x\s+trends?)\b/i.test(lower)) contentTool = "x";
    // Extract email address
    const emailAddrMatch = trimmed.match(/[\w.+-]+@[\w.-]+\.\w{2,}/i);
    const emailAddr = emailAddrMatch ? emailAddrMatch[0] : "";
    const emailInput = emailAddr
      ? `Send the results to ${emailAddr}`
      : "Email me the results";
    console.log(`[planner] Compound (email-first): ${contentTool} → email${emailAddr ? ` to ${emailAddr}` : ""}`);
    return [
      { tool: contentTool, input: `latest ${contentTool}`, context: {}, reasoning: "compound_email_first_step1" },
      { tool: "email", input: emailInput, context: { action: "draft", useLastResult: true, to: emailAddr || undefined }, reasoning: "compound_email_first_step2" }
    ];
  }

  // Pattern: "email me the news/weather/scores" — starts with "email" (no send verb)
  if (/\b(?:email|mail)\s+(?:me|us|him|her|them)\b/i.test(lower) &&
      /\b(?:news|weather|forecast|stock|score|finance|sport|headline|article|tweet|twitter|x\s+trends?)\b/i.test(lower)) {
    let contentTool = "news";
    if (/\b(weather|forecast|temperature)\b/i.test(lower)) contentTool = "weather";
    else if (/\b(stock|finance)\b/i.test(lower)) contentTool = "finance";
    else if (/\b(sport|score|match|game|league)\b/i.test(lower)) contentTool = "sports";
    else if (/\b(tweet|twitter|x\s+trends?)\b/i.test(lower)) contentTool = "x";
    console.log(`[planner] Compound (email-me): ${contentTool} → email`);
    return [
      { tool: contentTool, input: `latest ${contentTool}`, context: {}, reasoning: "compound_email_me_step1" },
      { tool: "email", input: "Email me the results", context: { action: "draft", useLastResult: true }, reasoning: "compound_email_me_step2" }
    ];
  }

  // Pattern: X search/leadgen → LLM categorize → Sheets append (lead gen pipeline)
  // "Search X for complaints about Netflix, categorize them, save to sheet 1BxiMVs..."
  if (/\b(?:search\s+(?:x|twitter)|tweet|complaint|pain\s*point)\b/i.test(lower) &&
      /\b(?:categorize|classify|summarize|analyze)\b/i.test(lower) &&
      /\b(?:sheet|spreadsheet|google)\b/i.test(lower)) {
    // Extract the search topic (strip "complaints about" prefix — we re-add it in the step input)
    const topicMatch = trimmed.match(/(?:complaints?\s+about|search\s+(?:x|twitter)\s+for)\s+['"]?(.+?)['"]?\s*(?:,\s*(?:and\s+)?use|,\s*categorize|and\s+(?:use|categorize|save)|\.|\s+exclude)/i);
    let topic = topicMatch ? topicMatch[1].trim() : trimmed.split(/[.,]/)[0];
    // If topic already starts with "complaints about", strip it to avoid doubling
    topic = topic.replace(/^complaints?\s+about\s+/i, "").replace(/,\s*$/, "").trim();
    // Extract sheet ID — support "Google Sheets <ID>", "sheet <ID>", URL, or bare long alphanumeric
    const sheetIdMatch = trimmed.match(/(?:sheets?|spreadsheets?|spreadsheets\/d\/)\s*([a-zA-Z0-9_-]{20,60})/i) || trimmed.match(/\b([a-zA-Z0-9_-]{25,60})\b/);
    const sheetId = sheetIdMatch ? sheetIdMatch[1] : null;
    // Extract categories
    const catMatch = trimmed.match(/(?:categorize|classify)\s+(?:each\s+)?(?:complaint|tweet|result)?\s*(?:into|as|by)\s+['"]?(.+?)['"]?\s*(?:,\s*and\s+write|,\s*and\s+append|\.\s*Finally)/i);
    const categories = catMatch ? catMatch[1].trim() : "relevant categories";

    console.log(`[planner] Compound (lead-gen pipeline): x → llm → sheets | topic="${topic}" sheet=${sheetId || "none"}`);
    return [
      { tool: "x", input: `search X for complaints about ${topic}, exclude retweets`, context: { action: "leadgen" }, reasoning: "leadgen_pipeline_search" },
      { tool: "llm", input: `Categorize each tweet into ${categories}. For each tweet, include the poster's display name (NOT their @handle), a 1-sentence summary, the category, and the tweet URL. Return ONLY a JSON array of arrays where the FIRST row is the header: [["Name", "Summary", "Category", "Tweet URL"], ["Display Name", "summary sentence", "Category", "https://x.com/..."], ...]. No markdown, no explanation — just the JSON array.`, context: { useChainContext: true }, reasoning: "leadgen_pipeline_categorize" },
      { tool: "sheets", input: `batch append categorized results to sheet ${sheetId || "SHEET_ID_NEEDED"}`, context: { useChainContext: true, action: "append", spreadsheetId: sheetId, range: "Sheet1!A:D" }, reasoning: "leadgen_pipeline_append" }
    ];
  }



  // ──────────────────────────────────────────────────────────
  // MULTI-STEP: LLM Intent Decomposer (fallback — reached for ambiguous queries)
  // Uses Sequential Logic Engine to decompose into 1+ tool steps
  // ──────────────────────────────────────────────────────────

  const contextSignals = extractContextSignals(trimmed);
  console.log("[planner] Context signals:", contextSignals);

  // Try multi-step decomposition first
  const decomposedSteps = await decomposeIntentWithLLM(trimmed, contextSignals, availableTools);

  if (decomposedSteps && decomposedSteps.length > 0) {
    // Resolve and validate each step's tool name
    const resolvedSteps = [];
    for (const step of decomposedSteps) {
      const resolvedTool = resolveToolName(step.tool, availableTools);
      if (resolvedTool) {
        resolvedSteps.push({
          tool: resolvedTool,
          input: step.input || trimmed,
          context: resolvedSteps.length > 0 ? { useChainContext: true } : {},
          reasoning: step.reasoning || "llm_decomposed"
        });
      } else {
        console.warn(`[planner] Decomposed step tool "${step.tool}" unresolved, skipping`);
        // If the unresolvable tool is the ONLY step, don't skip — use llm fallback
        if (decomposedSteps.length === 1) {
          resolvedSteps.push({
            tool: "llm",
            input: step.input || trimmed,
            context: {},
            reasoning: `fallback_unresolved_${step.tool}`
          });
        }
      }
    }

      if (resolvedSteps.length > 0) {
      
      // --- BEGIN NEW CHAIN LINKING LOGIC ---
      // Auto-detect if we are doing a review -> rewrite chain
      for (let i = 1; i < resolvedSteps.length; i++) {
        const currentTool = resolvedSteps[i].tool;
        const previousTool = resolvedSteps[i-1].tool;

        if (currentTool === "fileWrite" && (previousTool === "codeReview" || previousTool === "review")) {
          // Force the fileWrite tool into "improvement mode"
          resolvedSteps[i].context.generateImproved = true;
          
          // Grab the exact D:/... path from Step 1's input so Step 2 knows what to read
          const pathMatch = resolvedSteps[i-1].input.match(/([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/);
          if (pathMatch) {
            resolvedSteps[i].context.sourceFile = pathMatch[1];
          }
        }
      }
      // --- END NEW CHAIN LINKING LOGIC ---

      console.log(`[planner] Decomposed plan: ${resolvedSteps.map(s => s.tool).join(" -> ")}`);
      return resolvedSteps;
    }
  }

  // SAFETY NET: If decomposition failed entirely, fall back to single-tool classifier
  console.warn("[planner] Decomposition failed, falling back to single-tool classifier");
  const detection = await detectIntentWithLLM(trimmed, contextSignals, availableTools, signal);
  console.log("[planner] Single-tool fallback classified:", detection.intent);

  const tool = resolveToolName(detection.intent, availableTools, trimmed);

  if (!tool || !availableTools.includes(tool)) {
    const rawIntent = detection.intent || "unknown";
    console.warn(`[planner] Fallback tool "${rawIntent}" not available. Using llm.`);
    return [{
      tool: "llm",
      input: trimmed,
      context: {},
      reasoning: `fallback_unavailable_${rawIntent}`
    }];
  }

  console.log(`[planner] Tool resolved: "${detection.intent}" → "${tool}"`);
  return [{
    tool,
    input: trimmed,
    context: detection.context || {},
    reasoning: detection.reason
  }];
}

// ============================================================
// TEST EXPORTS — used by server/tests/routing.test.js
// ============================================================
export { ROUTING_TABLE };
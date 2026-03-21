// server/planner.js
// COMPLETE MULTI-STEP PLANNER (patched): diagnostic routing, tool availability checks,
// safe improvement plans (no calls to missing tools), and clearer certainty logging.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { llm } from "./tools/llm.js";
import { getMemory } from "./memory.js";
import { CONFIG } from "./utils/config.js";
import { detectCorrection, logCorrection, buildCorrectionContext } from "./intentDebugger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Module-level constants (avoid re-creating on every plan() call) ──
const FINANCE_COMPANIES = /\b(tesla|apple|google|alphabet|amazon|microsoft|meta|nvidia|amd|intel|netflix|disney|boeing|ford|paypal|uber|spotify|shopify)\b/i;
const FINANCE_INTENT = /\b(doing|price|worth|trading|performance|value|stock|share|market|up|down|earnings|revenue)\b/i;

// Track last routing decision for user correction feedback
let _lastRoutingDecision = { userMessage: null, tool: null, reasoning: null };

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

  // Reject if parentheses contain words (natural language, not math)
  // e.g., "(about 100 words)" → reject; "(100 + 50)" → accept
  if (/\([^)]*[a-zA-Z]{2,}[^)]*\)/.test(trimmed)) return false;

  // Only match if the core of the message is mathematical
  // Must have a math operator adjacent to or between numbers
  if (/\d\s*[+\-*/^]\s*\d/.test(trimmed)) return true;
  if (/\d\s*%\s*(of\s+)?\d/.test(trimmed)) return true;

  // Pure numeric expression: "15 * (3 + 2)"
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
  if (/\b(stock|finance|market|portfolio|price\s+of)\b/.test(lower)) return "finance";
  if (/\b(sport|score|match|fixture|nba|nfl)\b/.test(lower)) return "sports";
  if (/\b(calendar|event|meeting|schedule|appointment)\b/.test(lower)) return "calendar";
  if (/\b(search|look\s+up|find|google)\b/.test(lower)) return "search";
  if (/\b(git|commit|branch|github)\b/.test(lower)) return "gitLocal";
  if (/\b(task|todo|reminder)\b/.test(lower)) return "tasks";
  if (/\b(write|create|generate)\s+(a\s+)?(file|script)\b/.test(lower)) return "fileWrite";
  if (/\b(trending|popular\s+repos)\b/.test(lower)) return "githubTrending";
  if (/\b(youtube|video)\b/.test(lower)) return "youtube";
  if (/\b(tweet|twitter|x\s+trends?|trending\s+on\s+x)\b/.test(lower)) return "x";
  if (/\b(whatsapp|וואטסאפ|ווטסאפ)\b/.test(lower)) return "whatsapp";

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

  // Pattern 5d: "summarize/analyze" + source tool keyword (news/moltbook/search) → compound
  if (/\b(?:summarize|analy[sz]e|break\s*down|explain)\b/i.test(lower) &&
      /\b(?:news|moltbook|search|articles?|headlines?)\b/i.test(lower)) return true;

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
  // Strip temporal words from the end before extracting city
  const cleaned = lower.replace(/\s+(today|tonight|tomorrow|this\s+week|this\s+weekend|next\s+week|right\s+now|currently|later|soon)\s*$/i, '');
  const inMatch = cleaned.match(/\bin\s+([a-zA-Z\s\-]+)$/);
  if (inMatch) return formatCity(inMatch[1]);
  const forMatch = cleaned.match(/\bfor\s+([a-zA-Z\s\-]+)$/);
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

EXAMPLES (correct routing):
- "hey, how do you feel?" → llm
- "what's 15% of 230?" → calculator
- "weather in Paris" → weather
- "latest news about AI" → news
- "search for React tutorials" → search
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
- "code review D:/project/server" → codeReview
- "security audit of my server code" → codeReview
- "refactor D:/project/utils.js" → codeTransform
- "add error handling to server.js" → codeTransform
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
- "what's the weather like" → weather (NOT llm)
- "tell me about stocks" → finance (NOT search)
- "what do you know about me" → memorytool (NOT search)
- "schedule a task every hour" → scheduler (NOT tasks)
- "refactor my code" → codeTransform (NOT review, NOT file)
- "security review" → codeReview (NOT review)
- "show project structure" → folderAccess (NOT file)
- "improve yourself" → selfEvolve (NOT selfImprovement)
- "scan github for patterns" → githubScanner (NOT github, NOT githubTrending)

RULES:
1. Casual conversation, greetings, opinions, explanations → llm
2. "list repos" → github (NOT file)
3. "list D:/..." → file
4. NEVER use nlp_tool unless explicitly asked for "sentiment" or "analyze text"
5. "moltbook" → moltbook
6. "browse/visit [website]" → webBrowser
7. "store/save password/credentials" → moltbook or webBrowser (NOT memorytool)
8. When unsure, return "llm" (the safest fallback). NEVER return lotrJokes unless the user explicitly asks for a "Lord of the Rings joke"
9. "refactor/optimize/rewrite code" → codeTransform (NOT review)
10. "code review/security review/audit" → codeReview (NOT review)
11. "folder structure/tree/scan directory" → folderAccess (NOT file)
12. "dependency graph/circular deps/dead code" → projectGraph
13. "evolve yourself/improve your code" → selfEvolve (NOT selfImprovement)

Respond with ONLY the tool name (one word, no explanation).`;

  try {
    const response = await llm(prompt);
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
async function handleCompoundIntent(trimmed, lower, chatContext = {}) {
  const availableTools = listAvailableTools();
  const contextSignals = extractContextSignals(trimmed);
  console.log("[planner] handleCompoundIntent: attempting LLM decomposition...");

  const decomposedSteps = await decomposeIntentWithLLM(trimmed, contextSignals, availableTools);

  if (decomposedSteps && decomposedSteps.length > 1) {
    // Resolve and validate each step's tool name
    const resolvedSteps = [];
    for (const step of decomposedSteps) {
      const resolvedTool = resolveToolName(step.tool, availableTools);
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
async function decomposeIntentWithLLM(message, contextSignals, availableTools = []) {
  const signalText = contextSignals.length > 0
    ? `\nCONTEXT SIGNALS: ${contextSignals.join(", ")}`
    : "";

  const toolsListText = availableTools.length > 0
    ? `\nAVAILABLE TOOLS: ${availableTools.join(", ")}`
    : "";
  // Sanitize Windows backslashes so they don't break strict JSON generation
  const safeMessage = message.replace(/\\/g, "/");
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
3. If multiple actions are requested, order them logically (e.g., read first, then write).
4. Do NOT use the "documentQA" tool unless the user explicitly asks to "load a document", search the "knowledge base", or query "indexed files". It is NOT for code review.
5. Use "x" for Twitter/X trends, tweet search, tweet sentiment analysis, lead generation search, and posting tweets. Do NOT use "twitter" — the tool name is "x". For lead-gen/complaint searches, pass action "leadgen" in context.
6. APPLYATCH BIAS: If the request contains a comprehensive list of suggestions, review findings, or 3+ structural changes targeting a single file, route to "applyPatch" (full rewrite) — NOT "codeTransform" (surgical patch). codeTransform is for single targeted edits only.
7. SELFEVOLVE RESTRAINT: The "selfEvolve" tool must NOT be used for cosmetic changes or quota-driven busywork. Only route to selfEvolve when the user explicitly asks for autonomous evolution or self-improvement cycles.
8. Use "sheets" for Google Sheets operations (read, append, clear). Pass spreadsheetId and action in context. When chaining X search → LLM → sheets, the LLM step should categorize/summarize and the sheets step should receive the categorized data as rows.

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

USER MESSAGE:
"${safeMessage}"
${await buildCorrectionContext()}
OUTPUT ONLY THE JSON ARRAY:`;

  try {
    const response = await llm(prompt, { 
      timeoutMs: 90000, // Give it 90 seconds to think
      format: "json"    // Force strict JSON output!
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
      format: "json" 
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
function resolveToolName(rawIntent, availableTools) {
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

  return tool;
}

// ============================================================
// MAIN PLAN FUNCTION - Returns ARRAY of steps
// ============================================================

export async function plan({ message, chatContext = {} }) {
  const result = await _planInternal({ message, chatContext });

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

async function _planInternal({ message, chatContext = {} }) {
  const trimmed = (message || "").trim();
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
    const compoundResult = await handleCompoundIntent(trimmed, lower, chatContext);
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

  // 2. SELF-IMPROVEMENT: Reporting, Accuracy, and Telemetry Audit
  // Triggers for "how accurate", "telemetry", "what have you improved lately".
  if (
    /\b(accuracy|telemetry|misrouting|routing\s+report|what\s+have\s+you\s+improved|recent\s+changes)\b/i.test(lower)
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
  // Guard: skip if this is a scheduling/recurring request or a compound query
  if (containsKeyword(lower, WEATHER_KEYWORDS) &&
      !/\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate|book\s+.+\s+every)\b/i.test(lower) &&
      !hasCompoundIntent(lower)) {
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

  // News keywords (before file path and sports to avoid misroute)
  // Guard: skip if this is a moltbook notification, compound query, or conversational/meta message
  // "try again with the news idea" or "give yourself a headlines reporter username" should NOT route here
  const isNewsConversational = /\b(try\s+again|the\s+purpose|more\s+.{0,20}\s+like|give\s+(your\s*self|me)|as\s+a\s+.{0,30}\s+reporter|style|idea|concept|theme|approach|username|name\s+(your|the)|rename|rebrand)\b/i.test(lower);
  if ((/\b(latest|recent|breaking|today'?s)?\s*(news|headlines?|articles?)\b/i.test(lower) ||
       /\bwhat'?s\s+(happening|going\s+on|new)\b/i.test(lower)) &&
      !hasExplicitFilePath(trimmed) &&
      !/\bmoltbook\b/i.test(lower) &&
      !hasCompoundIntent(lower) &&
      !isNewsConversational &&
      !isPersonalConversation(lower, trimmed)) {
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
  if (/\bmoltbook\b/i.test(lower) &&
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

  // File write/create — must come BEFORE explicit file path (which routes to read-only file tool)
  // Guard: skip if compound intent detected (e.g. "review X and create a better version")
  if ((/\b(write|create|generate|make)\s+(a\s+)?(new\s+)?(file|script|module|component|document|code|program|class|function)\b/i.test(lower) ||
      /\b(save\s+to|write\s+to|create\s+file|new\s+file)\b/i.test(lower) ||
      (/\b(write|create|generate)\b/i.test(lower) && hasExplicitFilePath(trimmed))) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: fileWrite");
    return [{ tool: "fileWrite", input: trimmed, context: {}, reasoning: "certainty_file_write" }];
  }


  // ──────────────────────────────────────────────────────────
  // TOOL-SPECIFIC KEYWORD CLUSTERS (prevents LLM misclassification)
  // ──────────────────────────────────────────────────────────

  // Meta-conversation: "how do you work", "what is your logic", "what can you do"
  if (/\b(how do you (work|think|decide|choose)|what is your (logic|process|architecture)|what can you do|what tools|list.*tools|your capabilities)\b/i.test(lower)) {
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

  // "Send <phone_number> <message>" without WhatsApp keyword → route to whatsapp
  // Must come BEFORE email to prevent "send 0587426393 hello" → email
  if (/\bsend\b/i.test(lower) &&
      /(?:\+?\d[\d\s\-()]{6,18}\d)/.test(trimmed) &&
      !/\b(email|e-mail|mail)\b/i.test(lower) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: whatsapp (phone number detected)");
    return [{ tool: "whatsapp", input: trimmed, context: {}, reasoning: "certainty_whatsapp_phone" }];
  }

  // Email keywords: compose, browse/read, or draft
  // Guard: skip if compound intent (e.g. "send email with summary of the news")
  if (/\b(email|e-mail|mail|inbox|send\s+to|draft\s+(an?\s+)?(email|message|letter))\b/i.test(lower) &&
      !isSendItCommand(lower) &&
      !hasCompoundIntent(lower)) {
    const emailContext = {};
    if (/\b(check|read|browse|inbox|list|show|go\s+over|latest|recent|unread)\b/i.test(lower)) {
      emailContext.action = "browse";
    } else if (/\b(delete|trash|remove)\b/i.test(lower)) {
      emailContext.action = "delete";
    } else if (/\b(attachment|download)\b/i.test(lower)) {
      emailContext.action = "downloadAttachment";
    }
    console.log("[planner] certainty branch: email" + (emailContext.action ? ` (${emailContext.action})` : ""));
    return [{ tool: "email", input: trimmed, context: emailContext, reasoning: "certainty_email" }];
  }

  // X (Twitter) — trends, tweet search, tweet sentiment analysis, lead gen, post
  // Guard: skip if scheduling intent, compound intent, multi-tool chain, or conversational/meta question
  const isMultiToolChain = /\b(google\s*sheet|spreadsheet|append|aggregate|categorize\s+.*(save|write|sheet)|save\s+to\s+(sheet|sheets))\b/i.test(lower);
  // Meta-questions about the tool itself: "why did you use this tool?", "what tool is this?"
  const isXMetaQuestion = /\b(why\s+did\s+you|what\s+tool|which\s+tool|how\s+does\s+(this|the)\s+tool|explain\s+(this|the)\s+tool|what\s+is\s+this\s+tool)\b/i.test(lower);
  if (!isSchedulingIntent && !isMultiToolChain && !isXMetaQuestion &&
      /\b(tweet|twitter|trending\s+on\s+x|x\s+trends?|twitter\s+trends?|tweets?\s+(about|from|by)|top\s+tweets?|x\s+posts?|complaint|pain\s*point|post\s+(on|to)\s+(x|twitter))\b/i.test(lower) &&
      !hasCompoundIntent(lower) &&
      !isPersonalConversation(lower, trimmed)) {
    console.log("[planner] certainty branch: x");
    const xContext = {};
    if (/\b(trends?|trending|popular|hot)\b/i.test(lower)) xContext.action = "trends";
    else if (/\b(sentiment|analyze|analysis|opinion|mood)\b/i.test(lower)) xContext.action = "analyze";
    else if (/\b(post|publish|compose)\s+(on|to)\s+(x|twitter)\b/i.test(lower)) xContext.action = "post";
    else if (/\b(complaint|pain\s*point|frustrat|looking\s+for\s+(a\s+)?better|advanced\s+search)\b/i.test(lower)) xContext.action = "leadgen";
    else xContext.action = "search";
    // Detect country/region for trends (x.js has full WOEID map, just pass the key)
    const countryMatch = lower.match(/\bin\s+(?:the\s+)?(israel|uk|united\s+kingdom|britain|us|usa|united\s+states|america|canada|brazil|mexico|france|germany|spain|italy|netherlands|sweden|turkey|russia|japan|india|australia|south\s+korea|korea|singapore|indonesia|philippines|thailand|south\s+africa|nigeria|egypt|kenya|jerusalem|tel\s*aviv)\b/i);
    if (countryMatch) {
      xContext.country = countryMatch[1].toLowerCase().replace(/\s+/g, " ");
    } else if (/\b(israel|jerusalem|tel\s*aviv|ישראל)\b/i.test(lower)) {
      xContext.country = "israel";
    }
    return [{ tool: "x", input: trimmed, context: xContext, reasoning: "certainty_x" }];
  }

  // Google Sheets — read, append, clear
  if (/\b(google\s*sheet|spreadsheet|sheet\s*id|batch\s*append)\b/i.test(lower) && !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: sheets");
    const sheetsContext = {};
    if (/\b(read|get|fetch|show|view)\b/i.test(lower)) sheetsContext.action = "read";
    else if (/\b(clear|wipe|empty)\b/i.test(lower)) sheetsContext.action = "clear";
    else sheetsContext.action = "append";
    // Extract sheet ID
    const sheetIdMatch = lower.match(/(?:sheet\s*id\s*|spreadsheets\/d\/)([a-zA-Z0-9_-]{20,60})/i) || trimmed.match(/\b([a-zA-Z0-9_-]{25,60})\b/);
    if (sheetIdMatch) sheetsContext.spreadsheetId = sheetIdMatch[1];
    return [{ tool: "sheets", input: trimmed, context: sheetsContext, reasoning: "certainty_sheets" }];
  }

  // WhatsApp — send single or bulk messages
  if (/\b(whatsapp|ווטסאפ|וואטסאפ)\b/i.test(lower) &&
      /\b(send|שלח|bulk|mass|קבוצת|message|הודעה)\b/i.test(lower) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: whatsapp");
    return [{ tool: "whatsapp", input: trimmed, context: {}, reasoning: "certainty_whatsapp" }];
  }

  // NLP / text analysis keywords
  // Guard: skip if compound intent detected (e.g. "search X for topic, analyze sentiment, send to whatsapp")
  if (/\b(sentiment|analyze\s+text|text\s+analysis|classify\s+text|extract\s+entities|named\s+entities|NER)\b/i.test(lower) && !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: nlp_tool");
    return [{ tool: "nlp_tool", input: trimmed, context: {}, reasoning: "certainty_nlp" }];
  }

  // Calculator keywords (beyond math expressions)
  if (/\b(calculate|compute|solve|what\s+is\s+\d|how\s+much\s+is|convert\s+\d|percentage\s+of)\b/i.test(lower)) {
    console.log("[planner] certainty branch: calculator");
    return [{ tool: "calculator", input: trimmed, context: {}, reasoning: "certainty_calculator_keyword" }];
  }

// ──────────────────────────────────────────────────────────
  // CODE GURU TOOLS — must come BEFORE general review to prevent collision
  // ──────────────────────────────────────────────────────────

// Smart Evolution — discover and create NEW tools (must come BEFORE selfEvolve)
  if (!isSchedulingIntent && /\b(smart\s*evolut|discover\s+new\s+tools?|create\s+new\s+tool\s+autonom|evolve\s+and\s+create|invent\s+a?\s*new\s+tool|tool\s+discovery|suggest\s+new\s+tools?)\b/i.test(lower)) {
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

  // applyPatch — Multi-change architectural requests (3+ distinct changes) → full rewrite, not surgical patch
  // GUARD: Requires a file target AND multiple distinct action verbs or numbered list
  if (
    !/\b(review|suggest|examine|inspect)\b/i.test(lower) &&
    (hasExplicitFilePath(trimmed) || /\.[a-z]{2,4}\b/i.test(lower)) &&
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
  const hasStrongEditVerb = /\b(modify|update|refactor|rewrite|codetransform)\b/i.test(lower);
  
  if (
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

  // Deep Code Review — quality, security, performance analysis
  // Expanded to explicitly catch "review... suggest improvement"
  if (/\b(code\s+review|security\s+review|performance\s+review|quality\s+review|architecture\s+review|full\s+review|peer\s+review|code\s+quality|code\s+smell|lint|code\s+analysis|security\s+audit|code\s+audit)\b/i.test(lower) ||
      (/\b(review|analyze|audit)\b/i.test(lower) && /\b(quality|security|performance|architecture|smell|vulnerabilit|dead\s+code|improvements?)\b/i.test(lower))) {
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

  // Project Index — semantic code search, function/class lookup
  if (/\b(index\s+(the\s+)?project|project\s+index|build\s+(an?\s+)?index|reindex|search\s+(for\s+)?function|find\s+(the\s+)?class|symbol\s+search|search\s+symbol|function\s+list|class\s+list)\b/i.test(lower)) {
    console.log("[planner] certainty branch: projectIndex");
    const piContext = {};
    if (/\bbuild|create|rebuild|reindex/i.test(lower)) piContext.action = "build";
    else if (/\bsymbol|function|class|method/i.test(lower)) piContext.action = "symbols";
    else if (/\boverview|summary|stat/i.test(lower)) piContext.action = "overview";
    else piContext.action = "search";
    return [{ tool: "projectIndex", input: trimmed, context: piContext, reasoning: "certainty_project_index" }];
  }

  // GitHub Scanner — scan repos for patterns, tool discovery, AI analysis
  // Must come BEFORE githubTrending to catch "scan github for improvements"
  if (/\b(scan\s+github|github\s+scan|analyze\s+github|discover\s+tool|find\s+new\s+tool|github\s+intelligence|repo\s+scan|scan\s+repos?\s+for|github\s+pattern)\b/i.test(lower)) {
    console.log("[planner] certainty branch: githubScanner");
    const gsContext = {};
    if (/\btrending|popular|hot\b/i.test(lower)) gsContext.action = "trending";
    else if (/\bdiscover|find/i.test(lower)) gsContext.action = "discover";
    else if (/\bpattern|practice/i.test(lower)) gsContext.action = "patterns";
    else gsContext.action = "scan";
    return [{ tool: "githubScanner", input: trimmed, context: gsContext, reasoning: "certainty_github_scanner" }];
  }
  // Explicit file path
  // Guard: skip if compound intent (e.g. "review file.js and create new version at path")
  if (hasExplicitFilePath(trimmed) && !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: file_path");
    return [{ tool: "file", input: trimmed, context: {}, reasoning: "certainty_file_path" }];
  }
  // ──────────────────────────────────────────────────────────
  // ORIGINAL TOOL ROUTING CONTINUES BELOW
  // ──────────────────────────────────────────────────────────

  // Code review keywords — expanded to catch "tool", "implementation", "flow", "logic"
  // Must come BEFORE finance/sports/github to prevent "examine the search tool" → search
  // Guard: skip if compound intent detected (e.g. "review X and create new version")
  if ((/\b(review|inspect|examine|audit|analyze)\s+(this\s+)?(code|file|function|module|script|tool|implementation|flow|logic)\b/i.test(lower) ||
      (/\b(review|inspect|examine|audit|analyze)\b/i.test(lower) && hasExplicitFilePath(trimmed))) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: review");
    return [{ tool: "review", input: trimmed, context: {}, reasoning: "certainty_review" }];
  }

  // Finance keywords — with company name → ticker resolution
  // FINANCE_COMPANIES and FINANCE_INTENT are now module-level constants (top of file)
  // Guard: skip if compound intent detected (e.g. "get stock prices and email me")
  if ((/\b(stock|share\s+price|ticker|market|portfolio|invest|dividend|earnings|S&P\s*500|nasdaq|dow\s+jones|trading|IPO)\b/i.test(lower) ||
      (FINANCE_COMPANIES.test(lower) && FINANCE_INTENT.test(lower))) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: finance");
    return [{ tool: "finance", input: trimmed, context: {}, reasoning: "certainty_finance" }];
  }

  // Financial fundamentals — must come AFTER general finance
  if (/\b(fundamentals?|P\/E|balance\s*sheet|income\s+statement|cash\s*flow|market\s*cap|quarterly|annual\s+report)\b/i.test(lower) ||
      (FINANCE_COMPANIES.test(lower) && /\b(fundamentals?|financials?|report|analysis)\b/i.test(lower))) {
    console.log("[planner] certainty branch: financeFundamentals");
    return [{ tool: "financeFundamentals", input: trimmed, context: {}, reasoning: "certainty_fundamentals" }];
  }

  // Calendar extract/export — bilingual (English + Hebrew)
  // Must come BEFORE general calendar branch
  if ((/\b(extract|export|excel|xlsx|spreadsheet)\b/i.test(lower) ||
       /(?:חלץ|ייצא|אקסל|סרוק|לאקסל|ייצוא)/u.test(trimmed)) &&
      /\b(calendar|events?|לוח|אירוע|יומן)\b/iu.test(trimmed)) {
    console.log("[planner] certainty branch: calendar extract");
    return [{ tool: "calendar", input: trimmed, context: { action: "extract" }, reasoning: "certainty_calendar_extract" }];
  }

  // Calendar keywords — must come BEFORE sports to prevent "meeting with team" → sports
  if (/\b(calendar|meeting|appointment|schedule\s+(a|an|the)|set\s+(a|an)\s+(meeting|call|event|appointment)|add\s+to\s+(my\s+)?calendar|my\s+calendar|book\s+(a|an)\s+(room|meeting|call|appointment|dentist|doctor)|what\s+events?\b|my\s+events|am\s+i\s+(free|busy|available)|free\s+(time|slot|tomorrow|today|this)|availab(le|ility)\s+(today|tomorrow|this|next))\b/i.test(lower) &&
      !/\b(score|match|game|league|football|soccer|basketball|nba|nfl|sports?\s+events?)\b/i.test(lower)) {
    console.log("[planner] certainty branch: calendar");
    return [{ tool: "calendar", input: trimmed, context: {}, reasoning: "certainty_calendar" }];
  }

  // Sports keywords — with calendar guard to prevent "meeting with the team" → sports
  // Guard: skip if compound intent detected (e.g. "get scores and email me")
  if (/\b(score|match|game|league|team|player|football|soccer|basketball|nba|nfl|premier\s+league|champion)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed) &&
      !/\b(meeting|calendar|appointment|set\s+a|book\s+a|with\s+the\s+team)\b/i.test(lower) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: sports");
    return [{ tool: "sports", input: trimmed, context: {}, reasoning: "certainty_sports" }];
  }

  // YouTube keywords
  // Guard: skip if compound intent detected (e.g. "find a video and email me the link")
  if (/\b(youtube|video|watch|tutorial\s+video|how\s+to\s+video)\b/i.test(lower) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: youtube");
    return [{ tool: "youtube", input: trimmed, context: {}, reasoning: "certainty_youtube" }];
  }

  // GitHub Trending — must come BEFORE general github
  // Guard: skip if compound intent detected (e.g. "search trending repos and send to whatsapp")
  if (/\b(trending|popular|top)\b/i.test(lower) && /\b(repo|repository|github|project|open\s*source)\b/i.test(lower) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: githubTrending");
    return [{ tool: "githubTrending", input: trimmed, context: {}, reasoning: "certainty_github_trending" }];
  }

  // GitHub keywords
  // Guard: "issue" alone is too generic — require GitHub context or plural "issues"
  // Guard: skip if compound intent detected (e.g. "check github issues and email me")
  const isGithubIntent = /\b(github|repo|repository|pull\s+requests?|PR|commit|merge|fork)\b/i.test(lower) ||
    /\b(issues?|branch)\b/i.test(lower) && /\b(github|repo|pr|open|close|assign|label|milestone|merge|checkout)\b/i.test(lower);
  if (isGithubIntent &&
      !hasExplicitFilePath(trimmed) &&
      !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: github");
    return [{ tool: "github", input: trimmed, context: {}, reasoning: "certainty_github" }];
  }

  // Git local keywords
  if (/\b(git\s+(status|log|diff|add|commit|branch|checkout|stash|push|pull|reset))\b/i.test(lower)) {
    console.log("[planner] certainty branch: gitLocal");
    return [{ tool: "gitLocal", input: trimmed, context: {}, reasoning: "certainty_git_local" }];
  }

  // Package manager keywords — expanded to catch bare "install axios", "update all packages", etc.
  if (/\b(npm\s+(install|uninstall|list|remove|update|info|outdated)|install\s+(package|[@a-z][\w\/-]*)|uninstall\s+(package|[@a-z][\w\/-]*)|remove\s+(the\s+)?(unused\s+)?package|list\s+(\w+\s+)?packages|update\s+(all\s+)?packages|package\s+manager|what\s+version\s+of\s+\w+\s+is\s+installed|which\s+packages|installed\s+packages|outdated\s+packages)\b/i.test(lower) &&
      !/\b(amazon|buy|shop|order)\b/i.test(lower)) {
    const pkgContext = {};
    if (/\binstall\b/i.test(lower)) pkgContext.action = "install";
    else if (/\buninstall|remove\b/i.test(lower)) pkgContext.action = "uninstall";
    else if (/\boutdated\b/i.test(lower)) pkgContext.action = "outdated";
    else if (/\bupdate\b/i.test(lower)) pkgContext.action = "update";
    else if (/\blist|show|installed|what\s+version|which\b/i.test(lower)) pkgContext.action = "list";
    const pkgMatch = trimmed.match(/(?:install|uninstall|remove|update)\s+([@a-z][\w\/-]*)/i);
    if (pkgMatch) pkgContext.package = pkgMatch[1];
    console.log("[planner] certainty branch: packageManager");
    return [{ tool: "packageManager", input: trimmed, context: pkgContext, reasoning: "certainty_package_manager" }];
  }

  // Shopping keywords — includes "best X" product queries
  if ((/\b(buy|shop|price|product|amazon|order|purchase|deal|discount|coupon)\b/i.test(lower) ||
       /\b(best|top|cheapest|affordable)\s+\w+\s*(for|under|around|headphone|keyboard|laptop|phone|tablet|monitor|mouse|chair|camera|speaker|earbuds)\b/i.test(lower) ||
       /\bwhat\s+are\s+the\s+best\s+\w+/i.test(lower) && /\b(wireless|bluetooth|gaming|mechanical|ergonomic|portable|budget)\b/i.test(lower)) &&
      !/\b(stock|share|invest)\b/i.test(lower)) {
    console.log("[planner] certainty branch: shopping");
    return [{ tool: "shopping", input: trimmed, context: {}, reasoning: "certainty_shopping" }];
  }

  // Workflow management — "run morning briefing workflow", "list workflows", "create workflow"
  // Must come BEFORE scheduler to prevent "run workflow" → scheduler
  if (/\b(run|execute|start|create|list|show|delete|remove)\s+(the\s+)?(a\s+)?(my\s+)?workflow/i.test(lower) ||
      /\bworkflow\s+(named?|called)\b/i.test(lower) ||
      /\b(morning\s+briefing|market\s+check|code\s+review\s+cycle)\b/i.test(lower)) {
    console.log("[planner] certainty branch: workflow");
    return [{ tool: "workflow", input: trimmed, context: {}, reasoning: "certainty_workflow" }];
  }

  // Scheduler / recurring tasks
  // Must come BEFORE task management to prevent "schedule X every Y" → tasks
  // Removed "workflow" keyword — that now routes to the workflow tool above
  // Guard: "weekly report" / "generate a weekly performance report" → selfImprovement, not scheduler
  if (/\b(schedules?|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate|set\s+up\s+a?\s*recurring|remind\s+me\s+(to|about)\s+.+\s+(every|at\s+\d|in\s+\d))\b/i.test(lower) &&
      !/\b(add\s+task|my\s+tasks|todo|to-do|checklist)\b/i.test(lower) &&
      !/\b(performance\s+report|weekly\s+report|generate\s+.*report|summary\s+report|diagnostic\s+report)\b/i.test(lower)) {
    console.log("[planner] certainty branch: scheduler");
    const schedContext = {};
    if (/\b(list|show|view|my)\s*(schedules?|recurring)/i.test(lower)) schedContext.action = "list";
    else if (/\b(cancel|stop|remove|delete)\s*(schedules?|timer|recurring)/i.test(lower)) schedContext.action = "cancel";
    else if (/\b(pause|disable)\b/i.test(lower)) schedContext.action = "pause";
    else if (/\b(resume|enable)\b/i.test(lower)) schedContext.action = "resume";
    return [{ tool: "scheduler", input: trimmed, context: schedContext, reasoning: "certainty_scheduler" }];
  }

  // Task management keywords — expanded with github guard
  if (/\b(todo|task|reminder|add\s+task|my\s+tasks|to-do|checklist|pending\s+tasks|task\s+list|show\s+tasks)\b/i.test(lower) &&
      !/\b(github|repo|commit|issue|pull\s+request)\b/i.test(lower)) {
    console.log("[planner] certainty branch: tasks");
    return [{ tool: "tasks", input: trimmed, context: {}, reasoning: "certainty_tasks" }];
  }

  // Contacts management
  if (/\b(contacts?|address\s*book|phone\s*(number|book)|my\s+contacts|add\s+contact|find\s+contact|who\s+is\s+\w+'\s*s?\s*(number|email|phone))\b/i.test(lower) &&
      !/\b(github|email\s+(to|about|regarding))\b/i.test(lower)) {
    console.log("[planner] certainty branch: contacts");
    return [{ tool: "contacts", input: trimmed, context: {}, reasoning: "certainty_contacts" }];
  }

  // Document QA — load/query document knowledge base
  if (/\b(load\s+document|index\s+(this\s+)?document|knowledge\s+base|query\s+(the\s+)?document|ask\s+(the\s+)?document|document\s+qa|search\s+(in|within)\s+(the\s+)?document)\b/i.test(lower)) {
    console.log("[planner] certainty branch: documentQA");
    return [{ tool: "documentQA", input: trimmed, context: {}, reasoning: "certainty_document_qa" }];
  }

  // LOTR Jokes — fun easter egg
  if (/\b(lotr|lord\s+of\s+the\s+rings?|hobbit|gandalf|frodo|aragorn|sauron|mordor)\b/i.test(lower) &&
      /\b(joke|funny|humor|laugh|tell\s+me)\b/i.test(lower)) {
    console.log("[planner] certainty branch: lotrJokes");
    return [{ tool: "lotrJokes", input: trimmed, context: {}, reasoning: "certainty_lotr_jokes" }];
  }

  // Memory read keywords (what do you know about me, my name, etc.)
  if (/\b(what do you (know|remember)|my\s+(name|email|location|contacts?|preferences?)|who\s+am\s+i)\b/i.test(lower) &&
      !/\b(password|credential)\b/i.test(lower)) {
    console.log("[planner] certainty branch: memory_read");
    return [{ tool: "memorytool", input: trimmed, context: {}, reasoning: "certainty_memory_read" }];
  }

  // Self-improvement keywords — expanded patterns
  if (/\b(self[- ]?improv|what have you improved|your accuracy|your performance|weekly report|telemetry|misrouting|what issues|performance report|diagnose|diagnostic report|how well are you doing|improve\s+your\s+(tool|routing|selection|accuracy|performance|code)|review\s+your\s+(\w+\s+)?(code|logic|routing|planner|executor))\b/i.test(lower)) {
    console.log("[planner] certainty branch: selfImprovement");
    return [{ tool: "selfImprovement", input: trimmed, context: {}, reasoning: "certainty_self_improvement" }];
  }

  // General knowledge questions — route to search instead of unreliable LLM classifier
  // Catches "what is X", "who is X", "how does X work", "tell me about X" etc.
  if (/\b(what is|what are|who is|who was|when did|where is|how many|how does|why do|define|meaning of|history of|tell\s+me\s+about|explain\s+\w+)\b/i.test(lower) &&
      !isMathExpression(trimmed) && !hasExplicitFilePath(trimmed) &&
      !/\b(stock|weather|email|task|todo|file|github|score|game|match|league|calendar|meeting|npm|install|buy|shop|price|product|deal|best\s+\w+\s+(for|under|around|headphone|keyboard|laptop|phone|tablet|monitor|mouse|chair))\b/i.test(lower) &&
      lower.length > 15) {
    console.log("[planner] certainty branch: general_knowledge → search");
    return [{ tool: "search", input: trimmed, context: {}, reasoning: "certainty_general_knowledge" }];
  }

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
    // Extract source file — try absolute path first, then relative/filename
    const absPathMatch = trimmed.match(/(?:review|analyze)\s+([A-Za-z]:[\\\/][^\s"']+)/i);
    const relPathMatch = trimmed.match(/(?:review|analyze)\s+([^\s]+\.\w{1,5})/i);
    const sourceFile = absPathMatch ? absPathMatch[1] : (relPathMatch ? relPathMatch[1] : "the code");
    // Extract source filename (basename) for output naming
    const sourceBasename = sourceFile.replace(/^.*[\\\/]/, ""); // "planner.js" from full path

    // Extract destination directory/path (after "at/to/in")
    const destMatch = trimmed.match(/(?:at|to|in)\s+([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/i);
    let destDir = destMatch ? destMatch[1] : null;

    // Generate smart filename: <name>.agent.<timestamp>.<ext>
    // e.g. planner.agent.20260312-014700.js
    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/^(\d{8})(\d{6})/, "$1-$2");
    const extMatch = sourceBasename.match(/(\.\w+)$/);
    const ext = extMatch ? extMatch[1] : ".js";
    const nameOnly = sourceBasename.replace(/\.\w+$/, "");
    const smartFilename = `${nameOnly}.agent.${ts}${ext}`;
    const targetPath = destDir ? `${destDir.replace(/[\\\/]$/, "")}/${smartFilename}` : smartFilename;

    const destContext = {
      useChainContext: true,
      targetPath,
      sourceFile,
      generateImproved: true
    };
    console.log(`[planner] Compound: review "${sourceFile}" → generate "${targetPath}"`);
    return [
      // Pass the FULL user request so the Reviewer reads your custom instructions
      { tool: "review", input: trimmed, context: {}, reasoning: "compound_review_source" },
      
      // Pass the FULL user request so the Writer executes your custom instructions
      { tool: "fileWrite", input: trimmed, context: destContext, reasoning: "compound_generate_improved" }
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

  // ── 2-step compound: source → llm summarize/analyze (no destination) ──
  // Handles: "read the news about X, use llm to summarize them"
  //          "get moltbook feed, summarize the top posts"
  //          "search for X, use the llm tool to analyze the results"
  if (/\b(?:summarize|analy[sz]e|use\s+(?:the\s+)?llm|explain|break\s*down)\b/i.test(lower) &&
      !(/\b(?:whatsapp|wa|email|send\s+to)\b/i.test(lower)) &&
      /\b(?:search|find|get|check|show|read|fetch|news|moltbook)\b/i.test(lower)) {
    // Detect source tool
    let sourceTool = "news";
    let sourceInput = trimmed;
    if (/\b(?:search\s+(?:x|twitter)|tweets?\s+about|on\s+(?:x|twitter))\b/i.test(lower)) {
      sourceTool = "x";
    } else if (/\b(?:moltbook)\b/i.test(lower)) {
      sourceTool = "moltbook";
    } else if (/\b(?:news|headlines?|articles?)\b/i.test(lower)) {
      sourceTool = "news";
    } else if (/\b(?:search|google|look\s+up)\b/i.test(lower)) {
      sourceTool = "search";
    }

    // Extract article/result count from user request (e.g., "first 4", "top 3", "5 articles")
    const countMatch = lower.match(/\b(?:first|top|latest|last)\s+(\d+)\b|\b(\d+)\s+(?:articles?|results?|posts?|items?|headlines?)\b/);
    const requestedCount = countMatch ? parseInt(countMatch[1] || countMatch[2], 10) : null;

    // Clean source input: everything before the analysis instruction
    const sourceMatch = trimmed.match(/^(.+?)(?:,\s*(?:and\s+)?(?:use|then)|,\s*(?:analy|summarize|explain|break)|and\s+(?:use|analy|summarize|then))/i);
    const cleanSourceInput = sourceMatch ? sourceMatch[1].trim() : trimmed;

    // Build source context (pass article count to the source tool)
    const sourceContext = {};
    if (requestedCount) sourceContext.articleCount = requestedCount;

    // Build analysis prompt — detailed per-item summary + opinionated conclusion
    const topicMatch = cleanSourceInput.match(/(?:about|on|for|regarding)\s+(.+?)$/i);
    const topicHint = topicMatch ? topicMatch[1].trim() : "the topic";
    const countHint = requestedCount ? `the ${requestedCount}` : "each";

    const analysisInstruction = `Read the data from the previous step carefully. For ${countHint} article${requestedCount === 1 ? "" : "s"}, provide a detailed summary based on the ACTUAL CONTENT — not just the headline. Include key facts, quotes, and developments from each article.

After all individual summaries, write a final "My Analysis" section with your opinionated take on the overall situation regarding ${topicHint}. What patterns do you see? What might happen next? What should the reader pay attention to?

Format: numbered list of article summaries, then a horizontal rule, then your analysis.`;

    console.log(`[planner] Compound (2-step): ${sourceTool} → llm${requestedCount ? ` (count: ${requestedCount})` : ""}`);
    return [
      { tool: sourceTool, input: cleanSourceInput, context: sourceContext, reasoning: "compound_source" },
      { tool: "llm", input: analysisInstruction, context: { useChainContext: true }, reasoning: "compound_analyze" }
    ];
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
      sourceInput = trimmed.match(/^(.+?)(?:,\s*(?:and\s+)?use|,\s*analy|,\s*summarize)/i)?.[1]?.trim() || "get the news";
    }

    // Extract the user's analysis focus topic (e.g., "the new Spiderman movie" from "analyze sentiment on the new Spiderman movie")
    const focusMatch = trimmed.match(/(?:analy[sz]e|sentiment|summarize|classify)\s+(?:sentiment\s+)?(?:on|about|of|for|regarding)\s+(?:the\s+)?(.+?)(?:\s*,|\s+and\s+|\s+send\s+|\s+then\s+|$)/i);
    const focusTopic = focusMatch ? focusMatch[1].replace(/\s+(?:and|then)\s*$/i, "").trim() : "";

    // Detect analysis tool
    const useNlp = /\b(nlp\s+tool|nlp|extract\s+entities|NER)\b/i.test(lower);
    const analysisTool = useNlp ? "nlp_tool" : "llm";
    const topicInstruction = focusTopic ? `Focus specifically on content related to "${focusTopic}". Ignore tweets that are clearly about other topics.` : "";
    const analysisPrompt = useNlp
      ? `analyze sentiment of the data${focusTopic ? ` about ${focusTopic}` : ""}`
      : `Analyze the sentiment and key themes of the following tweets.${topicInstruction ? " " + topicInstruction : ""} Provide: 1) Overall sentiment (positive/negative/neutral/mixed) with your own assessment — do NOT use scores from any previous analysis, judge the actual tweet content yourself, 2) Key themes discussed, 3) 2-3 notable tweet quotes WITH their tweet URLs (use the URLs from the data). Format as a clear, readable summary suitable for a WhatsApp message. Do NOT ask follow-up questions — just deliver the analysis.`;

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
      destInput = "email me the analysis results";
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
  const detection = await detectIntentWithLLM(trimmed, contextSignals, availableTools);
  console.log("[planner] Single-tool fallback classified:", detection.intent);

  const tool = resolveToolName(detection.intent, availableTools);

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
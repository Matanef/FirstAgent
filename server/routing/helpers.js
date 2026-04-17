// server/routing/helpers.js
// Routing helper constants and pure functions shared by the routing table,
// evaluateRoutingTable, and _planInternal in planner.js.
// No external imports — all standalone logic.

// ── Finance signal constants ──────────────────────────────────────────────────
export const FINANCE_COMPANIES = /\b(tesla|apple|google|alphabet|amazon|microsoft|meta|nvidia|amd|intel|netflix|disney|boeing|ford|paypal|uber|spotify|shopify|check\s*point|checkpoint|fortinet|palo\s*alto|crowdstrike|crowd\s*strike|crowed\s*strike|zscaler|sentinelone|cyberark|jp\s*morgan|goldman\s*sachs|visa|mastercard|pfizer|moderna|coinbase|palantir)\b/i;
export const FINANCE_INTENT = /\b(doing|price|worth|trading|performance|value|stock|share|market|up|down|earnings|revenue)\b/i;

// "Why" questions about stocks/markets are RESEARCH questions, not price lookups
// e.g. "why are cybersecurity stocks dropping?" → search, NOT finance
export const FINANCE_RESEARCH_QUESTION = /\b(why\s+(did|are|is|do|has|have|were|was)|what\s+caused|what\s+happened|reason|explain)\b.*\b(stock|share|price|market|drop|crash|fall|decline|surge|rally|jump)/i;

// ── Math expression detection ─────────────────────────────────────────────────
export function isMathExpression(msg) {
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

// ── Personal conversation detection ──────────────────────────────────────────
// Detects messages that are personal, emotional, reflective, or
// opinion-seeking — NOT tool requests disguised with first-person pronouns.

// Tool-intent keywords that OVERRIDE personal detection even if pronouns are present.
// "I want to search for..." or "I need the weather" should NOT be personal.
export const TOOL_INTENT_WORDS = /\b(search|find|get|fetch|show|list|check|look\s+up|browse|scan|download|generate|create|write|send|compose|draft|schedule|remind|play|open|read|review|analyze|calculate|convert|compare|what(?:'?s| is| are)\s+(?:the|my)\s+(?:weather|stock|email|news|score|task|calendar|inbox|forecast|price|trend)|tell\s+me\s+(?:the|about\s+the)\s+(?:weather|news|stock|score))\b/i;

// Genuine personal/emotional/reflective patterns — requires BOTH a first-person marker
// AND an emotional/reflective signal to fire.
export const FIRST_PERSON = /\b(i|i'm|i've|i'll|i'd|my|me|myself)\b/i;
export const EMOTIONAL_REFLECTIVE = /\b(feel|feeling|felt|think|thinking|thought|believe|wonder|wondering|worried|worry|anxious|stressed|burned?\s*out|overwhelm|happy|sad|angry|frustrated|confused|excited|proud|afraid|scared|lonely|grateful|thankful|tired|exhausted|motivated|unmotivated|struggle|struggling|cope|coping|dealing\s+with|going\s+through|miss|missed|love|hate|enjoy|bored|curious|conflicted|uncertain|hopeful|hopeless|depressed|inspired|disappointed|nervous|nostalgic|regret|appreciate|vent|venting|opinion|advice|perspective|honest|honestly|what\s+do\s+you\s+think|should\s+i|do\s+you\s+think|how\s+do\s+you\s+feel|what\s+would\s+you|can\s+we\s+talk|let'?s\s+talk|chat\s+about|between\s+us)\b/i;

// Short conversational messages that are inherently personal (no tool intent)
export const PURE_CONVERSATIONAL = /^(hey|hi|hello|good\s+morning|good\s+evening|good\s+night|how\s+are\s+you|what'?s\s+up|sup|yo|thanks?|thank\s+you|you'?re?\s+(?:the\s+best|awesome|great|amazing)|nice|cool|lol|haha|wow|oh\s+really|that'?s\s+(?:interesting|cool|great|nice|funny|sad|crazy)|never\s+mind|forget\s+it|ok(?:ay)?|got\s+it|i\s+see|makes?\s+sense|fair\s+enough|good\s+point|true|right|bye|goodbye|see\s+you|brb|be\s+right\s+back|i'?ll?\s+be\s+(?:right\s+)?back|ttyl|talk\s+(?:to\s+you\s+)?later|gotta\s+go|i\s+need\s+to\s+restart\s+you.*|i'?m\s+(?:going\s+to\s+)?restart.*)\s*[.!?]*$/i;

export function isPersonalConversation(lower, original) {
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

// ── Simple date/time detection ────────────────────────────────────────────────
export function isSimpleDateTime(msg) {
  const lower = (msg || "").toLowerCase().trim();
  return (
    /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
    /^(date|time|day|month|year) (today|now)/.test(lower)
  );
}

// ── Prose vs code intent detection ───────────────────────────────────────────
/**
 * Detect if the intent is prose/text editing rather than code editing.
 * Returns true when the target is clearly a non-code document or the request
 * uses prose-specific language (e.g., "rewrite this article", "correct grammar").
 */
export function isProseIntent(text) {
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

// ── File path detection ───────────────────────────────────────────────────────
export function hasExplicitFilePath(text) {
  if (!text) return false;
  // Absolute paths: D:/..., C:\...
  if (/[a-z]:[\\/]/i.test(text)) return true;
  // Relative paths with directory separator + extension: server/planner.js, ./utils/config.js
  // Must contain an actual path separator to avoid matching "Node.js", "Vue.js" etc.
  if (/[/\\]/.test(text) && /(?:^|\s)\.{0,2}\/?[\w.-]+\/[\w.-]+\.\w{1,5}\b/.test(text)) return true;
  return false;
}

// ── Compound intent detection ─────────────────────────────────────────────────
/**
 * Detect if a message contains multiple distinct tool intents connected by conjunctions.
 * Used as a guard on single-tool certainty branches so compound queries fall through
 * to the compound detection patterns or LLM decomposer.
 */
export function hasCompoundIntent(text) {
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

// ── Email command helpers ─────────────────────────────────────────────────────
export function isSendItCommand(text) {
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

export function isCancelCommand(text) {
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

// ── Memory helpers ────────────────────────────────────────────────────────────
export function isMemoryWriteCommand(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return /^remember\s+(my\s+|that\s+|the\s+)?/i.test(lower);
}

// ── Weather helpers ───────────────────────────────────────────────────────────
export const WEATHER_KEYWORDS = [
  "weather", "forecast", "temperature", "temp", "rain", "raining",
  "snow", "snowing", "humidity", "wind", "windy", "sunny", "cloudy",
  "temperature history", "weather history", "weather trend", "seasonal weather",
  "how warm was", "how cold was"
];

export const FORGET_SYNONYMS = ["forget", "forgot", "remove", "clear", "delete"];

export function containsKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(k => new RegExp(`\\b${k}\\b`, "i").test(lower));
}

export function locationWithForgetLike(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\blocation\b/.test(lower)) return false;
  return FORGET_SYNONYMS.some(s => lower.includes(s));
}

export function hereIndicatesWeather(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\bhere\b/.test(lower)) return false;
  return containsKeyword(lower, WEATHER_KEYWORDS);
}

// ── City extraction ───────────────────────────────────────────────────────────
export function extractCity(message) {
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

  // 3. Fallback: "End of Sentence" logic
  // (just in case the greedy match missed a specific phrasing)
  const fallbackMatch = cleaned.match(/\b(?:in|for)\s+([a-zA-Z\s\-]+)$/);
  if (fallbackMatch) {
    return formatCity(fallbackMatch[1]);
  }

  return null;
}

export function formatCity(city) {
  return city.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

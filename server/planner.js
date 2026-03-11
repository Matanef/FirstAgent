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

// ── Module-level constants (avoid re-creating on every plan() call) ──
const FINANCE_COMPANIES = /\b(tesla|apple|google|alphabet|amazon|microsoft|meta|nvidia|amd|intel|netflix|disney|boeing|ford|paypal|uber|spotify|shopify)\b/i;
const FINANCE_INTENT = /\b(doing|price|worth|trading|performance|value|stock|share|market|up|down|earnings|revenue)\b/i;

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
  if (/\b(review|inspect|audit)\b/.test(lower)) return "review";
  if (/\b(task|todo|reminder)\b/.test(lower)) return "tasks";
  if (/\b(write|create|generate)\s+(a\s+)?(file|code|script)\b/.test(lower)) return "fileWrite";
  if (/\b(trending|popular\s+repos)\b/.test(lower)) return "githubTrending";
  if (/\b(youtube|video)\b/.test(lower)) return "youtube";
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

  // Pattern 5: explicit "then" chaining: "X, then Y" or "X; then Y"
  if (/,\s*(?:and\s+)?then\s+/i.test(lower) || /;\s*then\s+/i.test(lower)) return true;

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

NEGATIVE EXAMPLES (common mistakes to avoid):
- "how are you" → llm (NOT selfImprovement, NOT weather)
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
8. When unsure, return "llm" (the safest fallback)
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
    const intent = text.split("|")[0].trim().replace(/[^a-z_]/g, "");

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

  const prompt = `You are a Sequential Logic Engine. Your job is to decompose a user's message into one or more sequential tool steps.

TASK: Analyze the user's message and return a JSON array of steps. Each step is an object with:
- "tool": the tool name (must be from the AVAILABLE TOOLS list)
- "input": what to pass to that tool (a natural language instruction)
- "reasoning": a brief explanation of why this step is needed
${toolsListText}
${signalText}

RULES:
1. Return ONLY a valid JSON array. No markdown, no explanation, no code fences.
2. If the message has a single intent, return a single-element array.
3. If the message has multiple intents (e.g. "do X and then Y"), decompose into multiple steps in order.
4. Steps execute sequentially — later steps can use output from earlier steps.
5. Use "llm" as the tool for general conversation, opinions, greetings, creative writing, explanations, and summarization.
6. "search" for web lookups, "news" for news headlines, "weather" for weather forecasts, "email" for sending/drafting email.
7. "calculator" for math, "finance" for stocks/market data, "memorytool" for remembering things.
8. "review" for code review, "codeReview" for security audits, "codeTransform" for refactoring code.
9. "gitLocal" for git operations, "github" for GitHub API, "githubTrending" for trending repos.
10. "scheduler" for recurring tasks, "calendar" for events/meetings, "tasks" for todo items.
11. "fileWrite" for creating/writing files, "file" for reading/listing files.
12. "whatsapp" for sending WhatsApp messages.
13. Maximum 5 steps. Most queries need 1-2 steps.
14. Do NOT invent tools. Only use tools from the AVAILABLE TOOLS list.

EXAMPLES:

Single intent:
[{"tool":"weather","input":"weather in Paris","reasoning":"user wants weather forecast"}]

Two intents:
[{"tool":"news","input":"latest AI news","reasoning":"user wants AI news"},{"tool":"email","input":"email me the AI news results","reasoning":"user wants results emailed"}]

Three intents:
[{"tool":"search","input":"search for React best practices","reasoning":"user wants to research React"},{"tool":"fileWrite","input":"write a summary of React best practices to a file","reasoning":"user wants a written summary"},{"tool":"email","input":"email the summary","reasoning":"user wants it emailed"}]

Conversation:
[{"tool":"llm","input":"how are you doing today?","reasoning":"casual greeting, no tool needed"}]

USER MESSAGE:
"${message}"

Return ONLY the JSON array:`;

  try {
    const response = await llm(prompt, { timeoutMs: 30000 });
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

    // RETRY: If first parse failed, ask LLM to fix its output
    console.warn("[planner] decomposeIntentWithLLM: first parse failed, retrying");
    const retryPrompt = `Your previous response was not valid JSON. Return ONLY a JSON array of step objects.
Each object must have "tool", "input", and "reasoning" keys.
Previous response: ${rawText.slice(0, 500)}

Return valid JSON array only:`;

    const retryResponse = await llm(retryPrompt, { timeoutMs: 20000 });
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
  const trimmed = (message || "").trim();
  const lower = trimmed.toLowerCase();

  console.log("🧠 Planning steps for:", trimmed);

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
  // Guard: skip if this is a moltbook notification or a compound query (e.g. "get news and email me")
  if ((/\b(latest|recent|breaking|today'?s)?\s*(news|headlines?|articles?)\b/i.test(lower) ||
       /\bwhat'?s\s+(happening|going\s+on|new)\b/i.test(lower)) &&
      !hasExplicitFilePath(trimmed) &&
      !/\bmoltbook\b/i.test(lower) &&
      !hasCompoundIntent(lower)) {
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
  if (/\bmoltbook\b/i.test(lower)) {
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
    // Posts
    else if (/\b(delete\s+post|remove\s+post)\b/i.test(lower)) context.action = "deletePost";
    else if (/\b(read\s+post|show\s+post|get\s+post|view\s+post)\b/i.test(lower)) context.action = "getPost";
    else if (/\b(post|publish|share|write)\b/i.test(lower)) context.action = "post";
    // Comments
    else if (/\b(comments?\s+(on|for)|show\s+comments|read\s+comments)\b/i.test(lower)) context.action = "getComments";
    else if (/\b(comment|reply)\b/i.test(lower)) context.action = "comment";
    // Voting
    else if (/\b(upvote|downvote|vote)\b/i.test(lower)) context.action = "vote";
    // Following
    else if (/\b(unfollow|unsubscribe)\b/i.test(lower)) context.action = "unfollow";
    else if (/\b(subscribe\s+to|join\s+submolt|join\s+community)\b/i.test(lower)) context.action = "subscribe";
    else if (/\b(follow)\b/i.test(lower)) context.action = "follow";
    // Communities
    else if (/\b(create\s+submolt|create\s+community|new\s+submolt)\b/i.test(lower)) context.action = "createSubmolt";
    else if (/\b(submolt\s+feed|community\s+feed)\b/i.test(lower)) context.action = "submoltFeed";
    else if (/\b(communities?|submolts?)\b/i.test(lower)) context.action = "communities";
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
  // Guard: if query also has conversational context ("and then", "after that"), preserve URL but don't lose intent
  if (/https?:\/\/\S+/i.test(trimmed)) {
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


  // Explicit file path
  // Guard: skip if compound intent (e.g. "review file.js and create new version at path")
  if (hasExplicitFilePath(trimmed) && !hasCompoundIntent(lower)) {
    console.log("[planner] certainty branch: file_path");
    return [{ tool: "file", input: trimmed, context: {}, reasoning: "certainty_file_path" }];
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

  // WhatsApp — send single or bulk messages
  if (/\b(whatsapp|ווטסאפ|וואטסאפ)\b/i.test(lower) &&
      /\b(send|שלח|bulk|mass|קבוצת|message|הודעה)\b/i.test(lower)) {
    console.log("[planner] certainty branch: whatsapp");
    return [{ tool: "whatsapp", input: trimmed, context: {}, reasoning: "certainty_whatsapp" }];
  }

  // NLP / text analysis keywords
  if (/\b(sentiment|analyze\s+text|text\s+analysis|classify\s+text|extract\s+entities|named\s+entities|NER)\b/i.test(lower)) {
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

  // Self-Evolution — active code modification (NOT diagnostics)
  // Must come BEFORE selfImprovement to catch "evolve", "improve my code", "scan github and improve"
  if (/\b(self[- ]?evolv|evolve\s+(yourself|your|my)|improve\s+(yourself|your\s+code|my\s+code)|scan\s+github\s+and\s+(improve|evolve|upgrade)|upgrade\s+(yourself|your\s+tools)|autonomous\s+improv|make\s+yourself\s+better|evolution\s+cycle)\b/i.test(lower)) {
    console.log("[planner] certainty branch: selfEvolve");
    const evolveContext = {};
    if (/\b(dry.?run|preview|plan)\b/i.test(lower)) evolveContext.action = "dryrun";
    else if (/\b(history|log|previous)\b/i.test(lower)) evolveContext.action = "history";
    else if (/\b(status|last)\b/i.test(lower)) evolveContext.action = "status";
    else evolveContext.action = "run";
    return [{ tool: "selfEvolve", input: trimmed, context: evolveContext, reasoning: "certainty_self_evolve" }];
  }

  // Code Transform — refactor, optimize, rewrite, improve code in a file
  // Must come BEFORE review (which is read-only) since transforms are write operations
  if (/\b(refactor|rewrite|transform|optimize\s+code|optimize\s+the|improve\s+the\s+code|add\s+error\s+handling|add\s+types?|add\s+jsdoc|add\s+comments?|modernize|migrate|convert\s+to|simplify\s+the\s+code|clean\s+up\s+the\s+code)\b/i.test(lower) &&
      (hasExplicitFilePath(trimmed) || /\b(file|function|module|class|component)\b/i.test(lower))) {
    console.log("[planner] certainty branch: codeTransform");
    const ctContext = {};
    if (/\brefactor\b/i.test(lower)) ctContext.action = "refactor";
    else if (/\boptimize\b/i.test(lower)) ctContext.action = "optimize";
    else if (/\brewrite\b/i.test(lower)) ctContext.action = "upgrade";
    else if (/\bdocument|jsdoc|comment/i.test(lower)) ctContext.action = "document";
    else if (/\btest|spec\b/i.test(lower)) ctContext.action = "test";
    else ctContext.action = "transform";
    return [{ tool: "codeTransform", input: trimmed, context: ctContext, reasoning: "certainty_code_transform" }];
  }

  // Deep Code Review — quality, security, performance analysis
  // More specific than general "review": triggers on explicit review types or "code review"
  if (/\b(code\s+review|security\s+review|performance\s+review|quality\s+review|architecture\s+review|full\s+review|peer\s+review|code\s+quality|code\s+smell|lint|code\s+analysis|security\s+audit|code\s+audit)\b/i.test(lower) ||
      (/\b(review|analyze|audit)\b/i.test(lower) && /\b(quality|security|performance|architecture|smell|vulnerabilit|dead\s+code)\b/i.test(lower))) {
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
  if (/\b(folder\s*(structure|tree|scan|browse|explore|access|content)|directory\s*(tree|structure|listing|layout)|project\s*(structure|tree|layout|hierarchy)|show\s+(the\s+)?(tree|folder|directory)|browse\s+(folder|directory)|scan\s+(folder|directory|the\s+folder|the\s+directory)|list\s+(all\s+)?(files\s+in|folder|directory|recursiv))\b/i.test(lower)) {
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
  if (/\b(calendar|meeting|appointment|schedule\s+(a|an|the)|set\s+(a|an)\s+(meeting|call|event|appointment)|add\s+to\s+(my\s+)?calendar|my\s+calendar|book\s+(a|an)\s+(room|meeting|call))\b/i.test(lower) &&
      !/\b(score|match|game|league|football|soccer|basketball|nba|nfl)\b/i.test(lower)) {
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
  if (/\b(youtube|video|watch|tutorial\s+video|how\s+to\s+video)\b/i.test(lower)) {
    console.log("[planner] certainty branch: youtube");
    return [{ tool: "youtube", input: trimmed, context: {}, reasoning: "certainty_youtube" }];
  }

  // GitHub Trending — must come BEFORE general github
  if (/\b(trending|popular|top)\b/i.test(lower) && /\b(repo|repository|github|project|open\s*source)\b/i.test(lower)) {
    console.log("[planner] certainty branch: githubTrending");
    return [{ tool: "githubTrending", input: trimmed, context: {}, reasoning: "certainty_github_trending" }];
  }

  // GitHub keywords
  if (/\b(github|repo|repository|pull\s+request|issue|commit|branch|merge|fork)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: github");
    return [{ tool: "github", input: trimmed, context: {}, reasoning: "certainty_github" }];
  }

  // Git local keywords
  if (/\b(git\s+(status|log|diff|add|commit|branch|checkout|stash|push|pull|reset))\b/i.test(lower)) {
    console.log("[planner] certainty branch: gitLocal");
    return [{ tool: "gitLocal", input: trimmed, context: {}, reasoning: "certainty_git_local" }];
  }

  // Package manager keywords
  if (/\b(npm\s+(install|uninstall|list|remove|update)|install\s+package|uninstall\s+package|list\s+packages|package\s+manager)\b/i.test(lower)) {
    const pkgContext = {};
    if (/\binstall\b/i.test(lower)) pkgContext.action = "install";
    else if (/\buninstall|remove\b/i.test(lower)) pkgContext.action = "uninstall";
    else if (/\blist|show|installed\b/i.test(lower)) pkgContext.action = "list";
    else if (/\bupdate\b/i.test(lower)) pkgContext.action = "update";
    const pkgMatch = trimmed.match(/(?:install|uninstall|remove|update)\s+([@a-z0-9\/-]+)/i);
    if (pkgMatch) pkgContext.package = pkgMatch[1];
    console.log("[planner] certainty branch: packageManager");
    return [{ tool: "packageManager", input: trimmed, context: pkgContext, reasoning: "certainty_package_manager" }];
  }

  // Shopping keywords
  if (/\b(buy|shop|price|product|amazon|order|purchase|deal|discount|coupon)\b/i.test(lower) &&
      !/\b(stock|share|invest)\b/i.test(lower)) {
    console.log("[planner] certainty branch: shopping");
    return [{ tool: "shopping", input: trimmed, context: {}, reasoning: "certainty_shopping" }];
  }

  // Workflow management — "run morning briefing workflow", "list workflows", "create workflow"
  // Must come BEFORE scheduler to prevent "run workflow" → scheduler
  if (/\b(run|execute|start|create|list|show|delete|remove)\s+(the\s+)?(a\s+)?workflow/i.test(lower) ||
      /\bworkflow\s+(named?|called)\b/i.test(lower) ||
      /\b(morning\s+briefing|market\s+check|code\s+review\s+cycle)\b/i.test(lower)) {
    console.log("[planner] certainty branch: workflow");
    return [{ tool: "workflow", input: trimmed, context: {}, reasoning: "certainty_workflow" }];
  }

  // Scheduler / recurring tasks
  // Must come BEFORE task management to prevent "schedule X every Y" → tasks
  // Removed "workflow" keyword — that now routes to the workflow tool above
  // Guard: "weekly report" / "generate a weekly performance report" → selfImprovement, not scheduler
  if (/\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate|set\s+up\s+a?\s*recurring|remind\s+me\s+(to|about)\s+.+\s+(every|at\s+\d|in\s+\d))\b/i.test(lower) &&
      !/\b(add\s+task|my\s+tasks|todo|to-do|checklist)\b/i.test(lower) &&
      !/\b(performance\s+report|weekly\s+report|generate\s+.*report|summary\s+report|diagnostic\s+report)\b/i.test(lower)) {
    console.log("[planner] certainty branch: scheduler");
    const schedContext = {};
    if (/\b(list|show|view|my)\s*(schedule|recurring)/i.test(lower)) schedContext.action = "list";
    else if (/\b(cancel|stop|remove|delete)\s*(schedule|timer|recurring)/i.test(lower)) schedContext.action = "cancel";
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

  // Memory read keywords (what do you know about me, my name, etc.)
  if (/\b(what do you (know|remember)|my\s+(name|email|location|contacts?|preferences?)|who\s+am\s+i)\b/i.test(lower) &&
      !/\b(password|credential)\b/i.test(lower)) {
    console.log("[planner] certainty branch: memory_read");
    return [{ tool: "memorytool", input: trimmed, context: {}, reasoning: "certainty_memory_read" }];
  }

  // Self-improvement keywords — expanded patterns
  if (/\b(self[- ]?improv|what have you improved|your accuracy|your performance|weekly report|telemetry|misrouting|what issues|performance report|diagnose|diagnostic report|how well are you doing)\b/i.test(lower)) {
    console.log("[planner] certainty branch: selfImprovement");
    return [{ tool: "selfImprovement", input: trimmed, context: {}, reasoning: "certainty_self_improvement" }];
  }

  // General knowledge questions — route to search instead of unreliable LLM classifier
  // Catches "what is X", "who is X", "how does X work", etc. that would otherwise
  // fall to the LLM classifier which often misroutes to calculator
  if (/\b(what is|who is|who was|when did|where is|how many|how does|why do|define|meaning of|history of)\b/i.test(lower) &&
      !isMathExpression(trimmed) && !hasExplicitFilePath(trimmed) &&
      !/\b(stock|weather|email|task|todo|file|github|score|game|match|league|calendar|meeting|npm|install)\b/i.test(lower) &&
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
    // Extract source file (first file path after review/analyze)
    const fileMatch = trimmed.match(/(?:review|analyze)\s+([^\s]+\.\w{1,5})/i) ||
                      trimmed.match(/(?:review|analyze)\s+([a-zA-Z]:[\\\/][^\s]+)/i);
    const sourceFile = fileMatch ? fileMatch[1] : "the code";
    // Extract destination path if present (second file path or "at/to <path>")
    const destMatch = trimmed.match(/(?:at|to|in)\s+([a-zA-Z]:[\\\/][^\s]+)/i);
    const destContext = destMatch ? { useChainContext: true, destinationPath: destMatch[1] } : { useChainContext: true };
    console.log(`[planner] Compound: review "${sourceFile}" → generate new version`);
    return [
      { tool: "review", input: sourceFile, context: {}, reasoning: "compound_review_source" },
      { tool: "fileWrite", input: trimmed, context: destContext, reasoning: "compound_generate_improved" }
    ];
  }

  // Pattern: "X and then Y and then Z" — generic multi-step decomposition
  const chainPattern = trimmed.match(/^(.+?)\s*(?:,\s*(?:and\s+)?then\s+|;\s*then\s+)(.+?)(?:\s*(?:,\s*(?:and\s+)?then\s+|;\s*then\s+)(.+))?$/i);
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

  // Pattern: "X and email/send me the results" or "X and send it to user@example.com"
  const compoundMatch = trimmed.match(/^(.+?)\s+(?:and\s+(?:then\s+)?)(email|send|mail)\s+(?:me\s+)?(?:the\s+)?(?:results?|summary|info|output|it|a\s+\w+)(?:\s+to\s+(.+))?/i);
  if (compoundMatch) {
    const firstPart = compoundMatch[1].trim();
    const emailAction = compoundMatch[2];
    const recipientPart = compoundMatch[3]?.trim() || "";
    // Extract email address from recipient part or full message
    const emailAddrMatch = trimmed.match(/[\w.+-]+@[\w.-]+\.\w{2,}/i);
    const emailAddr = emailAddrMatch ? emailAddrMatch[0] : "";
    console.log(`[planner] Compound query detected: "${firstPart}" → email results${emailAddr ? ` to ${emailAddr}` : ""}`);
    // Determine the tool for the first part
    let firstTool = "search"; // default
    if (/\b(news|headlines?|articles?)\b/i.test(firstPart)) firstTool = "news";
    else if (/\b(weather|forecast|temperature)\b/i.test(firstPart)) firstTool = "weather";
    else if (/\b(stock|finance|price)\b/i.test(firstPart)) firstTool = "finance";
    else if (/\b(github|repo|trending)\b/i.test(firstPart)) firstTool = "github";
    else if (/\b(youtube|video)\b/i.test(firstPart)) firstTool = "youtube";
    else if (/\b(sports?|score|match|game|league)\b/i.test(firstPart)) firstTool = "sports";
    else if (/\b(review|analyze|inspect)\b/i.test(firstPart)) firstTool = "review";
    const emailInput = emailAddr
      ? `Send the results to ${emailAddr}`
      : `Email me the results of: ${firstPart}`;
    return [
      { tool: firstTool, input: firstPart, context: {}, reasoning: "compound_step1" },
      { tool: "email", input: emailInput, context: { action: "draft", useLastResult: true, to: emailAddr || undefined }, reasoning: "compound_step2_email" }
    ];
  }

  // Pattern: "send email to X with the summary of the news" — email-first compound (no "and")
  // Also: "email me the news summary", "sned an email with the news", "send matan an email with the news"
  if (/\b(?:send|compose|draft|forward|write|sned)\b/i.test(lower) &&
      /\b(?:email|e-mail|mail)\b/i.test(lower) &&
      /\b(?:news|weather|forecast|stock|score|finance|sport|headline|article)\b/i.test(lower)) {
    // Detect which content tool is needed
    let contentTool = "news"; // default
    if (/\b(weather|forecast|temperature)\b/i.test(lower)) contentTool = "weather";
    else if (/\b(stock|finance)\b/i.test(lower)) contentTool = "finance";
    else if (/\b(sport|score|match|game|league)\b/i.test(lower)) contentTool = "sports";
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
      /\b(?:news|weather|forecast|stock|score|finance|sport|headline|article)\b/i.test(lower)) {
    let contentTool = "news";
    if (/\b(weather|forecast|temperature)\b/i.test(lower)) contentTool = "weather";
    else if (/\b(stock|finance)\b/i.test(lower)) contentTool = "finance";
    else if (/\b(sport|score|match|game|league)\b/i.test(lower)) contentTool = "sports";
    console.log(`[planner] Compound (email-me): ${contentTool} → email`);
    return [
      { tool: contentTool, input: `latest ${contentTool}`, context: {}, reasoning: "compound_email_me_step1" },
      { tool: "email", input: "Email me the results", context: { action: "draft", useLastResult: true }, reasoning: "compound_email_me_step2" }
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
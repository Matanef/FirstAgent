// server/planner.js
// Two-tier intent routing: Certainty Layer → LLM Classifier
// Only unambiguous patterns are hardcoded; everything else goes to the LLM

import { llm } from "./tools/llm.js";

// ============================================================
// TIER 1: CERTAINTY LAYER — zero-ambiguity patterns only
// ============================================================

/**
 * Detect pure math expressions (no natural language collision possible)
 */
function isMathExpression(msg) {
  const trimmed = msg.trim();
  if (!/[0-9]/.test(trimmed)) return false;
  if (/[+\-*/^=()]/.test(trimmed)) return true;
  return /^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed);
}

/**
 * Detect simple date/time questions
 */
function isSimpleDateTime(msg) {
  const lower = msg.toLowerCase().trim();
  return (
    /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
    /^(date|time|day|month|year) (today|now)/.test(lower)
  );
}

/**
 * Detect explicit file paths with drive letters (D:/, E:/, C:/)
 * This is unambiguous — no natural language collision possible
 */
function hasExplicitFilePath(text) {
  // Match drive letters (C:/, D:\) but exclude protocol headers (http://, https://)
  return /[a-z]:[\\/]/i.test(text) && !/[a-z]+:\/\//i.test(text);
}

/**
 * Detect URLs (http:// or https://)
 */
function isUrl(text) {
  const trimmed = text.trim();
  return /^https?:\/\//i.test(trimmed);
}

/**
 * Detect "send it" / confirmation commands for email
 */
function isSendItCommand(text) {
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed === "send it" ||
    trimmed === "send" ||
    trimmed === "yes send it" ||
    trimmed === "yes, send it" ||
    trimmed === "send the email" ||
    trimmed === "send that email" ||
    trimmed === "yes send" ||
    trimmed === "confirm" ||
    (trimmed === "yes" && text.length < 10)
  );
}

// ============================================================
// WEATHER HELPERS (kept — weather keywords are domain-specific enough)
// ============================================================

const WEATHER_KEYWORDS = [
  "weather", "forecast", "temperature", "temp", "rain", "raining",
  "snow", "snowing", "humidity", "wind", "windy", "sunny", "cloudy",
  "storm", "stormy", "drizzle", "shower", "heat", "cold", "hot"
];

const FORGET_SYNONYMS = [
  "forget", "forgot", "remove", "clear", "discard", "omit",
  "neglect", "overlook", "delete"
];

const REMEMBER_SYNONYMS = [
  "remember", "save", "store", "set", "keep"
];

function containsKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(k => new RegExp(`\\b${k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(lower));
}

function wordsAround(text, tokenA, tokenB, maxWords = 10) {
  if (!text) return false;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const idxA = words.findIndex(w => w === tokenA.toLowerCase());
  if (idxA === -1) return false;
  const start = Math.max(0, idxA - maxWords);
  const end = Math.min(words.length - 1, idxA + maxWords);
  for (let i = start; i <= end; i++) {
    if (words[i] === tokenB.toLowerCase()) return true;
  }
  return false;
}

function locationWithForgetLike(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\blocation\b/.test(lower)) return false;
  return FORGET_SYNONYMS.some(s =>
    wordsAround(lower, "location", s, 6) || wordsAround(lower, s, "location", 6)
  );
}

function locationWithRememberLike(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\blocation\b/.test(lower)) return false;
  return REMEMBER_SYNONYMS.some(s =>
    wordsAround(lower, "location", s, 6) || wordsAround(lower, s, "location", 6)
  );
}

function hereIndicatesWeather(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\bhere\b/.test(lower)) return false;
  return containsKeyword(lower, WEATHER_KEYWORDS);
}

function extractCity(message) {
  const lower = message.toLowerCase().trim();
  const inMatch = lower.match(/\bin\s+([a-zA-Z\s\-]+)$/);
  if (inMatch) return formatCity(inMatch[1]);
  const forMatch = lower.match(/\bfor\s+([a-zA-Z\s\-]+)$/);
  if (forMatch) return formatCity(forMatch[1]);
  return null;
}

function formatCity(city) {
  return city
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeToolName(toolName) {
  const toolMap = {
    'financefundamentals': 'financeFundamentals',
    'memorytool': 'memorytool',
    'filewrite': 'fileWrite',
    'webdownload': 'webDownload',
    'packagemanager': 'packageManager',
    'selfimprovement': 'selfImprovement'
  };
  const lower = toolName.toLowerCase();
  return toolMap[lower] || toolName;
}

// ============================================================
// TIER 2: SMART LLM CLASSIFIER
// ============================================================

/**
 * Extract context signals from the message to help the LLM disambiguate.
 * These are factual observations, not routing decisions.
 */
function extractContextSignals(message) {
  const lower = message.toLowerCase();
  const signals = [];

  if (hasExplicitFilePath(message)) {
    signals.push("CONTAINS_FILE_PATH");
  }
  if (/\b(github|repo|repository|issue|pull request|pr)\b/i.test(lower)) {
    signals.push("MENTIONS_GITHUB");
  }
  if (/\b(stock|share|ticker|nasdaq|nyse|s&p|portfolio|dividend|pe ratio|market cap|fundamentals)\b/i.test(lower)) {
    signals.push("MENTIONS_FINANCE");
  }
  if (containsKeyword(lower, WEATHER_KEYWORDS)) {
    signals.push("MENTIONS_WEATHER");
  }
  if (/\b(news|headline|latest|breaking|article)\b/i.test(lower)) {
    signals.push("MENTIONS_NEWS");
  }
  if (/\b(youtube|video|watch|clip|channel)\b/i.test(lower)) {
    signals.push("MENTIONS_YOUTUBE");
  }
  if (/\b(email|mail|send to|draft|compose)\b/i.test(lower)) {
    signals.push("MENTIONS_EMAIL");
  }
  if (/\b(file|folder|directory|path|read|write|create file)\b/i.test(lower)) {
    signals.push("MENTIONS_FILE_CONCEPTS");
  }
  if (/\b(review|code review|inspect|examine)\b/i.test(lower)) {
    signals.push("MENTIONS_REVIEW");
  }
  if (/\b(search|look up|find|google|what is|who is|how to)\b/i.test(lower)) {
    signals.push("MENTIONS_SEARCH");
  }
  if (/\b(improve|improvement|accuracy|routing|misrouting|weekly report)\b/i.test(lower)) {
    signals.push("MENTIONS_SELF_IMPROVEMENT");
  }
  if (/\b(git status|git add|git commit|git diff|git log)\b/i.test(lower)) {
    signals.push("MENTIONS_LOCAL_GIT");
  }
  if (/\b(trending|trending repos|trending github)\b/i.test(lower)) {
    signals.push("MENTIONS_TRENDING");
  }
  if (/\b(remember|forget|my name|my location|profile)\b/i.test(lower)) {
    signals.push("MENTIONS_MEMORY");
  }
  if (/\b(sport|score|match|game|league|team|nba|nfl|premier league|champions league)\b/i.test(lower)) {
    signals.push("MENTIONS_SPORTS");
  }

  return signals;
}

/**
 * LLM-based intent classification with context signals and disambiguation examples
 */
async function detectIntentWithLLM(message, contextSignals) {
  const signalText = contextSignals.length > 0
    ? `\nCONTEXT SIGNALS DETECTED: ${contextSignals.join(", ")}`
    : "\nNo strong context signals detected.";

  const prompt = `You are a multi-step planner for an AI agent. Based on the user's request, plan a SEQUENCE of one or more tool calls.

AVAILABLE TOOLS:
- weather: Current weather, forecasts
- news: Latest headlines from RSS feeds
- search: Web search for factual information, "what is", "who is", "how to"
- sports: Sports scores, standings, leagues
- youtube: Search YouTube videos
- shopping: Product search and price comparison
- finance: Stock prices, ticker lookups
- financeFundamentals: Company fundamentals, PE ratio, market cap, financial analysis
- file: Read/list LOCAL files and folders (requires a file path or explicit "in my project")
- fileWrite: Create or modify local files
- webDownload: Download code/content from URLs
- packageManager: npm package management
- email: Draft and send emails
- tasks: Task management, to-do lists
- calculator: Mathematical calculations
- selfImprovement: Query the agent's own improvements, routing accuracy, detected issues
- github: REMOTE GitHub repository operations — list repos, issues, PRs
- gitLocal: LOCAL Git operations — status, add, commit, diff, log
- githubTrending: Fetch currently trending software repositories from GitHub
- review: Code review and analysis of specific files
- nlp_tool: Textual analysis for sentiment and entities
- memorytool: Manage user profile data (forget location, etc.)
- llm: General conversation, memory queries, casual chat, agreements (e.g. "sure", "ok", "go ahead")

USER MESSAGE:
"${message}"
${signalText}

CRITICAL DISAMBIGUATION RULES:
1. "add contact" / "save contact" / "save that rafi's email is X" → contacts (NOT email)
2. "send email to X" / "email X" / "compose email" → email
3. "list repos" / "show my repositories" / "list my github" → github (NOT file)
4. "list D:/..." or "read C:/..." (contains drive letter path) → file
5. "list files in my project" / "show project folder" → file
6. "show me the weather" / "how's the weather" → weather (NOT file)
7. "read this article" / "read about X" → search (NOT file)
8. "analyze AAPL" / "analyze Tesla stock" → financeFundamentals (NOT review)
9. "review server/index.js" / "review my code" → review
10. "open github" / "check my github" → github (NOT file)
11. "what have you improved" / "show improvements" / "review yourself" → selfImprovement
12. "search for X" / "look up X" / "what is X" → search
13. "show me videos about X" → youtube (NOT file)
14. "what's the score" / "how did X play" → sports
15. "forget my location" → memorytool
16. "remember my name is X" → llm (memory write via conversation)
17. "review your logic" / "review your own code" → selfImprovement
18. "analyze sentiment of X" / "extract entities from X" / "nlp analysis" → nlp_tool
19. "morning" / "good morning" / "hello" / "hi" → llm

CRITICAL FORMATTING RULES:
1. Respond with ONE OR MORE LINES. Each line must be a separate step in this format: tool_name | refined_input | context
2. refined_input should be the SPECIFIC command or query (e.g. "status" for gitLocal, "AAPL" for finance).
3. context (the third column) is OPTIONAL and ONLY used for the gitLocal commit message. Leave empty for all other steps.
4. If the user asks to "stage an improvement", "suggest improvement", "commit improvement", or "self-improve", YOU MUST include EVERY step: trending -> review -> gitLocal status -> gitLocal add -> gitLocal commit.
4. DO NOT add any explanations, notes, or "Step 1:". 
5. DO NOT use markdown formatting.

TOOL HINTS:
- gitLocal: USE FOR LOCAL "git status", "git add", "git commit", "git diff", "git push".
- github: USE ONLY FOR REMOTE REPO LISTING OR ISSUES.

EXAMPLES:
1. "Search for patterns, review my file, and commit"
githubTrending | patterns | 
review | my_file.js | 
gitLocal | status | 
gitLocal | add my_file.js | 
gitLocal | commit | staged improvement

2. "How's the weather in London and news about AI"
weather | | London
news | AI | 

3. "Analyze AAPL and check my project files"
financeFundamentals | AAPL | 
file | list | 
`;

  try {
    const response = await llm(prompt);

    if (!response.success || !response.data?.text) {
      return [{ intent: "llm", reason: "fallback" }];
    }

    const lines = response.data.text.trim().split("\n");
    const steps = [];

    for (const line of lines) {
      if (!line.includes("|")) continue;

      const parts = line.split("|");
      const rawIntent = parts[0].trim().toLowerCase().replace(/[*#]/g, "").replace(/[^a-z_]/g, "");
      const extractedInput = parts[1]?.trim();
      const contextStr = parts[2]?.trim();

      if (!rawIntent) continue;

      const step = {
        intent: rawIntent,
        reason: "llm_classified",
        extractedInput: extractedInput || null,
        context: contextStr ? { raw: contextStr } : {}
      };

      // Special case: weather (un-normalize city if needed)
      if (rawIntent === "weather") {
        if (contextStr === "USE_GEO" || extractedInput === "USE_GEO") {
          step.useGeolocation = true;
        } else if (contextStr || extractedInput) {
          step.city = contextStr || extractedInput;
        }
      } else if (rawIntent === "llm" && (contextStr || extractedInput)) {
        step.reason = contextStr || extractedInput;
      }

      steps.push(step);
    }

    if (steps.length === 0) {
      return [{ intent: "llm", reason: "fallback" }];
    }

    return steps;
  } catch (err) {
    console.error("LLM intent detection error:", err.message);
    return [{ intent: "llm", reason: "error_fallback" }];
  }
}

// ============================================================
// MAIN PLAN FUNCTION — Two-Tier Routing
// ============================================================

export async function plan({ message }) {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // ── TIER 1: CERTAINTY LAYER ──────────────────────────────
  // Only patterns with zero ambiguity

  // 1. Pure math expressions
  if (isMathExpression(trimmed)) {
    return [{ tool: "calculator", input: trimmed, reasoning: "certainty_math" }];
  }

  // 2. Simple date/time
  if (isSimpleDateTime(trimmed)) {
    return [{ tool: "llm", input: trimmed, reasoning: "certainty_datetime" }];
  }

  // 4. Local Git (unambiguous)
  if (/\b(git status|git add|git commit|git diff|git log)\b/i.test(lower)) {
    let action = "status";
    if (lower.includes("status")) action = "status";
    else if (lower.includes("add")) action = "add";
    else if (lower.includes("commit")) action = "commit";
    else if (lower.includes("diff")) action = "diff";
    else if (lower.includes("log")) action = "log";

    return [{
      tool: "gitLocal",
      input: action, // Pass the detected action directly
      reasoning: "certainty_git_local"
    }];
  }

  // 5. Email confirmation ("send it", "yes")
  if (isSendItCommand(lower)) {
    console.log("📧 Detected 'send it' command");
    return [{
      tool: "email_confirm",
      input: trimmed,
      context: { action: "send_confirmed" },
      reasoning: "certainty_email_confirm"
    }];
  }

  // 6. Forget location (very specific phrase)
  if (locationWithForgetLike(lower)) {
    return [{
      tool: "memorytool",
      input: trimmed,
      context: { raw: "forget_location" },
      reasoning: "certainty_forget_location"
    }];
  }

  // 5. Remember location (very specific phrase)
  if (locationWithRememberLike(lower) || /\bremember my location\b/i.test(lower)) {
    return [{
      tool: "llm",
      input: trimmed,
      context: { raw: "memory_write" },
      reasoning: "certainty_remember_location"
    }];
  }

  // 6. "weather here" — weather keyword + "here" (domain-specific, no collision)
  if (hereIndicatesWeather(lower)) {
    return [{
      tool: "weather",
      input: trimmed,
      context: { city: "__USE_GEOLOCATION__" },
      reasoning: "certainty_here_weather"
    }];
  }

  // 7. Weather keywords with a city name
  if (containsKeyword(lower, WEATHER_KEYWORDS)) {
    const extracted = extractCity(trimmed);
    if (extracted) {
      return [{
        tool: "weather",
        input: trimmed,
        context: { city: extracted },
        reasoning: "certainty_weather_with_city"
      }];
    }
    // Weather keyword without city — still unambiguous enough
    return [{
      tool: "weather",
      input: trimmed,
      context: {},
      reasoning: "certainty_weather_no_city"
    }];
  }

  // 8. Location query
  if (/\bwhere am i\b/i.test(lower) || /\bwhat('?s| is) my location\b/i.test(lower)) {
    return [{
      tool: "llm",
      input: trimmed,
      context: { raw: "location_query" },
      reasoning: "certainty_location_query"
    }];
  }

  // 9. Explicit file path with drive letter (D:/, E:/, C:/) — unambiguous
  if (hasExplicitFilePath(trimmed)) {
    console.log("📂 Detected explicit file path");
    return [{ tool: "file", input: trimmed, reasoning: "certainty_file_path" }];
  }

  // 10. URLs (http://, https://) — unambiguous
  if (isUrl(trimmed)) {
    return [{ tool: "webDownload", input: trimmed, reasoning: "certainty_url" }];
  }

  // ── TIER 2: LLM CLASSIFIER ──────────────────────────────
  // Everything else — let the LLM decide with full context

  const contextSignals = extractContextSignals(trimmed);
  console.log("🧠 Context signals:", contextSignals);

  const detections = await detectIntentWithLLM(trimmed, contextSignals);
  console.log("🎯 LLM classified:", detections.length, "steps");

  return detections.map(detection => {
    // Post-processing for weather (needs city extraction)
    if (detection.intent === "weather") {
      const context = {};
      if (detection.useGeolocation || /\bhere\b/i.test(trimmed)) {
        context.city = "__USE_GEOLOCATION__";
      } else if (detection.city) {
        context.city = detection.city;
      } else {
        const extractedCity = extractCity(trimmed);
        if (extractedCity) {
          context.city = extractedCity;
        }
      }

      return {
        tool: "weather",
        input: detection.extractedInput || trimmed,
        context,
        reasoning: detection.reason
      };
    }

    // Normalize tool name (case-insensitive)
    const normalizedTool = normalizeToolName(detection.intent || "llm");

    // FIX: Don't leak the full prompt into specialized tools during multi-step flows
    // If the LLM failed to extract a specific input, we prefer null over a noisy full-sentence fallback
    const finalInput = (detection.reason === "llm_classified" && !detection.extractedInput && normalizedTool !== 'llm')
      ? null
      : (detection.extractedInput || trimmed);

    return {
      tool: normalizedTool,
      input: finalInput,
      context: detection.context || {},
      reasoning: detection.reason
    };
  });
}

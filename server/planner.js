// server/planner.js
// LLM-powered planner with intelligent intent detection + preclassifier heuristics

import { llm } from "./tools/llm.js";

// Only essential safety patterns remain hardcoded
const HARDCODED_PATTERNS = {
  // Calculator: purely mathematical expressions
  calculator: (msg) => {
    const trimmed = msg.trim();
    if (!/[0-9]/.test(trimmed)) return false;
    if (/[+\-*/^=()]/.test(trimmed)) return true;
    return /^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed);
  },

  // Direct date/time (LLM can answer these)
  isSimpleDateTime: (msg) => {
    const lower = msg.toLowerCase().trim();
    return (
      /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
      /^(date|time|day|month|year) (today|now)/.test(lower)
    );
  }
};

/* -------------------------------------------------------
 * Preclassifier heuristics
 * - quick, deterministic checks to avoid LLM confusion
 * ----------------------------------------------------- */

// Weather keywords and common typos/variants
const WEATHER_KEYWORDS = [
  "weather", "forecast", "temperature", "temp", "rain", "raining",
  "snow", "snowing", "humidity", "wind", "windy", "sunny", "cloudy",
  "storm", "stormy", "drizzle", "shower", "heat", "cold", "hot"
];

// Forget synonyms and variants
const FORGET_SYNONYMS = [
  "forget", "forgot", "remove", "clear", "discard", "omit",
  "neglect", "overlook", "delete"
];

// Remember/write synonyms
const REMEMBER_SYNONYMS = [
  "remember", "save", "store", "set", "keep"
];

// Helper: fuzzy-ish contains for keywords (word boundaries)
function containsKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const k of keywords) {
    const re = new RegExp(`\\b${k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

// Helper: count words and check distance between tokens
function wordsAround(text, tokenA, tokenB, maxWords = 10) {
  if (!text) return false;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const idxA = words.findIndex(w => w === tokenA.toLowerCase());
  if (idxA === -1) return false;
  // search within window for tokenB
  const start = Math.max(0, idxA - maxWords);
  const end = Math.min(words.length - 1, idxA + maxWords);
  for (let i = start; i <= end; i++) {
    if (words[i] === tokenB.toLowerCase()) return true;
  }
  return false;
}

// Helper: check if any of synonyms appear near "location"
function locationWithForgetLike(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\blocation\b/.test(lower)) return false;
  for (const s of FORGET_SYNONYMS) {
    if (wordsAround(lower, "location", s, 6) || wordsAround(lower, s, "location", 6)) {
      return true;
    }
  }
  return false;
}

// Helper: check if user explicitly asks to remember location
function locationWithRememberLike(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\blocation\b/.test(lower)) return false;
  for (const s of REMEMBER_SYNONYMS) {
    if (wordsAround(lower, "location", s, 6) || wordsAround(lower, s, "location", 6)) {
      return true;
    }
  }
  return false;
}

// Helper: "here" rule: "here" within 10 words AND weather keyword present
function hereIndicatesWeather(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\bhere\b/.test(lower)) return false;
  // require at least one weather keyword somewhere in the sentence
  if (!containsKeyword(lower, WEATHER_KEYWORDS)) return false;
  // ensure "here" is not used in other contexts like "here's the thing"
  // check that "here" is a standalone token and not part of "here's"
  const words = lower.split(/\s+/);
  const idx = words.findIndex(w => w === "here");
  if (idx === -1) return false;
  // check window for weather keyword
  const start = Math.max(0, idx - 10);
  const end = Math.min(words.length - 1, idx + 10);
  for (let i = start; i <= end; i++) {
    if (containsKeyword(words[i], WEATHER_KEYWORDS)) return true;
  }
  return true;
}

/* -------------------------------------------------------
 * LLM-based intent detection using your Ollama setup
 * ----------------------------------------------------- */
async function detectIntentWithLLM(message) {
  const prompt = `You are an intent classifier for an AI agent with the following capabilities:

AVAILABLE TOOLS:
- weather: Current weather, forecasts (use ONLY for actual weather questions like "what's the weather", "will it rain", "temperature")
- news: Latest headlines from RSS feeds
- search: Web search for factual information
- sports: Sports scores, standings, fixtures
- youtube: Search for YouTube videos
- shopping: Product search and price comparison
- finance: Stock prices and market data
- financeFundamentals: Company financials, valuations, key metrics
- file: Read/list files in allowed directories (D:/local-llm-ui, E:/testFolder)
- fileWrite: Create or modify files in those directories (for code changes, config edits, etc.)
- webDownload: Download code or text from URLs (including GitHub raw URLs, npm metadata)
- packageManager: Manage npm packages (install, uninstall, list) in the project
- email: Draft and send emails
- tasks: Task management and reminders
- calculator: Mathematical calculations
- llm: General conversation, memory questions, questions ABOUT location (not weather), meta questions about the agent
- memoryTool: Manage stored profile data (e.g., forget location)

SPECIAL CAPABILITIES:
- The agent can remember user preferences (name, likes, location)
- The agent can reformat previous responses into tables
- The agent has access to its conversation history
- Weather tool supports "here" to use IP-based geolocation
- The agent can inspect its own project files via the file tool
- The agent can modify its own project files via the fileWrite tool (with safeguards)
- The agent can download new code or resources via webDownload
- The agent can install/uninstall npm packages via packageManager

USER MESSAGE:
"${message}"

CLASSIFICATION RULES:
1. If user wants to reformat a previous response (e.g., "show that in a table", "make a table from that"), respond: reformat_table
2. If asking about WEATHER with "here" (e.g., "weather here", "how's the weather here"), respond: weather|USE_GEO
3. If asking about weather for a specific city (e.g., "weather in Paris"), respond: weather|CityName
4. If asking WHERE they are or ABOUT their location (e.g., "where am I", "do you know where I am", "what's my location"), respond: llm|location_query
5. If asking to remember something (e.g., "remember my name is...", "remember my location is..."), respond: llm|memory_write
6. If asking what the agent remembers (e.g., "what do you remember about me", "what do you know about me"), respond: llm|memory_query
7. If asking about the agent itself (e.g., "what can you do", "how do you work", "what are you capable of"), respond: llm|meta_question
8. For factual questions needing current info, respond: search
9. For stock fundamentals/metrics, respond: financeFundamentals
10. For stock prices, respond: finance
11. For reading/listing project files or folders, respond: file
12. For creating or modifying project files, respond: fileWrite
13. For downloading code or text from the web (GitHub, raw URLs, etc.), respond: webDownload
14. For installing/uninstalling/listing npm packages, respond: packageManager
15. For casual chat, greetings, or anything not clearly mapped above, respond: llm
16. If user asks to forget their location, respond: memorytool|forget_location

IMPORTANT:
- "where am I" or "do you know where I am" should go to LLM (not weather)!
- Only use weather for actual weather conditions (temperature, rain, forecast)!
- Only use fileWrite when the user clearly wants to change or create files.
- Only use packageManager when the user clearly wants to manage npm packages.

Respond with ONLY the tool name (and optional context after |), nothing else.`;
  try {
    const response = await llm(prompt);

    if (!response.success || !response.data?.text) {
      console.warn("LLM intent detection failed");
      return { intent: "llm", reason: "fallback" };
    }

    const text = response.data.text.trim();
    console.log("🧠 LLM Intent Response:", text);

    // Parse response format: "tool" or "tool|context"
    const parts = text.split("|");
    const intent = parts[0].trim().toLowerCase();
    const contextStr = parts[1]?.trim();

    const result = {
      intent,
      reason: "llm_classified",
      context: {}
    };

    if (contextStr) {
      result.context.raw = contextStr;   // <— keep raw context
    }

    // Handle special contexts
    if (intent === "weather" && contextStr === "USE_GEO") {
      result.useGeolocation = true;
    } else if (intent === "weather" && contextStr) {
      result.city = contextStr;
    } else if (intent === "llm" && contextStr) {
      // e.g. memory_write, memory_query, meta_question, location_query
      result.reason = contextStr;
    }

    console.log("🎯 Parsed Intent:", result);
    return result;

  } catch (err) {
    console.error("LLM intent detection error:", err.message);
    return { intent: "llm", reason: "error_fallback" };
  }
}

// Extract city from weather query (fallback if LLM didn't specify)
function extractCity(message) {
  const lower = message.toLowerCase().trim();

  const inMatch = lower.match(/\bin\s+([a-zA-Z\s\-]+)$/);
  if (inMatch) return formatCity(inMatch[1]);

  const forMatch = lower.match(/\bfor\s+([a-zA-Z\s\-]+)$/);
  if (forMatch) return formatCity(forMatch[1]);

  const words = lower.split(/\s+/);
  if (words.length >= 2) {
    const lastTwo = words.slice(-2).join(" ");
    if (/^[a-zA-Z\s\-]+$/.test(lastTwo)) return formatCity(lastTwo);
  }

  const last = words[words.length - 1];
  if (/^[a-zA-Z\-]+$/.test(last) && last.length > 2) return formatCity(last);

  return null;
}

function formatCity(city) {
  return city
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Main planner with LLM intelligence
export async function plan({ message }) {
  const trimmed = message.trim();

  // HARDCODED: Pure math expressions (no LLM needed)
  if (HARDCODED_PATTERNS.calculator(trimmed)) {
    return { tool: "calculator", input: trimmed };
  }

  // HARDCODED: Simple date/time (LLM can answer directly)
  if (HARDCODED_PATTERNS.isSimpleDateTime(trimmed)) {
    return { tool: "llm", input: trimmed };
  }

  // PRECLASSIFIER: quick deterministic checks to avoid LLM confusion
  const lower = trimmed.toLowerCase();

  // 1) Explicit "forget my location" style -> memorytool
  if (locationWithForgetLike(lower)) {
    return {
      tool: "memorytool",
      input: trimmed,
      context: { raw: "forget_location" },
      reasoning: "preclassifier_forget_location"
    };
  }

  // 2) Explicit "remember my location is X" -> llm memory write (so memoryTool can handle structured save)
  if (locationWithRememberLike(lower) || /\bremember my location\b/i.test(lower) || /\bremember my location is\b/i.test(lower)) {
    return {
      tool: "llm",
      input: trimmed,
      context: { raw: "memory_write" },
      reasoning: "preclassifier_remember_location"
    };
  }

  // 3) "here" + weather keywords within window -> weather with geolocation
  if (hereIndicatesWeather(lower)) {
    return {
      tool: "weather",
      input: trimmed,
      context: { city: "__USE_GEOLOCATION__" },
      reasoning: "preclassifier_here_weather"
    };
  }

  // 4) direct weather keywords and explicit city -> weather
  if (containsKeyword(lower, WEATHER_KEYWORDS)) {
    // try to extract city from the message
    const extracted = extractCity(trimmed);
    if (extracted) {
      return {
        tool: "weather",
        input: trimmed,
        context: { city: extracted },
        reasoning: "preclassifier_weather_with_city"
      };
    }
    // if no city but weather keywords present, ask weather tool to attempt geolocation or ask user
    return {
      tool: "weather",
      input: trimmed,
      context: {},
      reasoning: "preclassifier_weather_no_city"
    };
  }

  // 5) If message explicitly asks about "where am I" or "what's my location" -> llm location query
  if (/\bwhere am i\b/i.test(lower) || /\bdo you know where i am\b/i.test(lower) || /\bwhat('?s| is) my location\b/i.test(lower)) {
    return {
      tool: "llm",
      input: trimmed,
      context: { raw: "location_query" },
      reasoning: "preclassifier_location_query"
    };
  }

  // If preclassifier didn't decide, fall back to LLM classifier
  const detection = await detectIntentWithLLM(trimmed);

  // Special case: reformatting previous response
  if (detection.intent === "reformat_table") {
    return {
      tool: "reformat_table",
      input: trimmed,
      context: { format: "table" }
    };
  }

  // Weather with geolocation / city (LLM decided)
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
      input: trimmed,
      context,
      reasoning: detection.reason
    };
  }

  // Default: return the LLM's decision
  return {
    tool: detection.intent || "llm",
    input: trimmed,
    context: detection.context || {},
    reasoning: detection.reason
  };
}
// server/planner.js (COMPLETE FIX - SelfImprovement routing added)
// LLM-powered planner with intelligent intent detection + preclassifier heuristics

import { llm } from "./tools/llm.js";

const HARDCODED_PATTERNS = {
  calculator: (msg) => {
    const trimmed = msg.trim();
    if (!/[0-9]/.test(trimmed)) return false;
    if (/[+\-*/^=()]/.test(trimmed)) return true;
    return /^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed);
  },

  isSimpleDateTime: (msg) => {
    const lower = msg.toLowerCase().trim();
    return (
      /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
      /^(date|time|day|month|year) (today|now)/.test(lower)
    );
  }
};

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

// FIX: Detect self-improvement queries
function isSelfImprovementQuery(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /what (have|did) you (improve|change|modify|update|fix)/i,
    /show (me )?(your |the )?improvements/i,
    /list (your |the )?improvements/i,
    /how accurate is (your )?routing/i,
    /routing accuracy/i,
    /intent accuracy/i,
    /what (issues|problems) (have you|did you) detect/i,
    /detected (issues|problems|patterns)/i,
    /misrouting patterns/i,
    /generate (a |the )?weekly report/i,
    /self[- ]improvement/i
  ];
  
  return patterns.some(pattern => pattern.test(lower));
}

// FIX: Detect meta questions about file access
function isMetaQuestionAboutFiles(text) {
  const lower = text.toLowerCase();
  const metaPatterns = [
    /which (folders?|directories) (do|can) (you|i) (have )?access/i,
    /what (folders?|directories) (do|can) (you|i) (have )?access/i,
    /to which (folders?|directories)/i,
    /what (folders?|directories) are available/i,
    /show me (your|the) (allowed|available) (folders?|directories)/i,
    /what (is|are) (your|the) sandbox/i,
    /where can you (read|write|access)/i
  ];

  return metaPatterns.some(pattern => pattern.test(lower));
}

async function detectIntentWithLLM(message) {
  const prompt = `You are an intent classifier for an AI agent with the following capabilities:

AVAILABLE TOOLS:
- weather: Current weather, forecasts
- news: Latest headlines from RSS feeds
- search: Web search for factual information
- sports: Sports scores, standings
- youtube: Search YouTube videos
- shopping: Product search
- finance: Stock prices
- financeFundamentals: Company fundamentals, PE ratio, market cap, key statistics
- file: Read/list files in D:/local-llm-ui and E:/testFolder
- fileWrite: Create or modify files
- webDownload: Download code from URLs
- packageManager: npm package management
- email: Draft and send emails
- tasks: Task management
- calculator: Mathematical calculations
- selfImprovement: Query self-improvements, routing accuracy, detected issues, weekly reports
- llm: General conversation, memory queries, meta questions
- memorytool: Manage profile data (forget location)

USER MESSAGE:
"${message}"

CLASSIFICATION RULES:
1. For table reformatting requests, respond: reformat_table
2. "weather here" → weather|USE_GEO
3. "weather in [City]" → weather|CityName
4. "where am I" or "what's my location" → llm|location_query
5. "remember my location/name" → llm|memory_write
6. "what do you remember about me" → llm|memory_query
7. Questions about agent capabilities → llm|meta_question
8. "what have you improved" OR "routing accuracy" OR "detected issues" OR "weekly report" → selfImprovement
9. Stock fundamentals/metrics → financeFundamentals
10. Stock prices only → finance
11. Reading/listing files → file
12. Creating/modifying files → fileWrite
13. "forget my location" → memorytool|forget_location
14. Casual chat → llm

IMPORTANT:
- Self-improvement queries ("what have you improved", "routing accuracy", "issues detected") MUST route to selfImprovement tool
- "where am I" goes to LLM (not weather)!
- Only use weather for actual weather conditions!

Respond with ONLY the tool name (and optional context after |).`;

  try {
    const response = await llm(prompt);

    if (!response.success || !response.data?.text) {
      return { intent: "llm", reason: "fallback" };
    }

    const text = response.data.text.trim();
    console.log("🧠 LLM Intent Response:", text);

    const parts = text.split("|");
    const intent = parts[0].trim().toLowerCase();
    const contextStr = parts[1]?.trim();

    const result = {
      intent,
      reason: "llm_classified",
      context: {}
    };

    if (contextStr) {
      result.context.raw = contextStr;
    }

    if (intent === "weather" && contextStr === "USE_GEO") {
      result.useGeolocation = true;
    } else if (intent === "weather" && contextStr) {
      result.city = contextStr;
    } else if (intent === "llm" && contextStr) {
      result.reason = contextStr;
    }

    return result;
  } catch (err) {
    console.error("LLM intent detection error:", err.message);
    return { intent: "llm", reason: "error_fallback" };
  }
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

// FIX: Normalize tool names (case-insensitive)
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

export async function plan({ message }) {
  const trimmed = message.trim();

  // HARDCODED: Pure math
  if (HARDCODED_PATTERNS.calculator(trimmed)) {
    return { tool: "calculator", input: trimmed, reasoning: "hardcoded_math" };
  }

  // HARDCODED: Simple date/time
  if (HARDCODED_PATTERNS.isSimpleDateTime(trimmed)) {
    return { tool: "llm", input: trimmed, reasoning: "hardcoded_datetime" };
  }

  const lower = trimmed.toLowerCase();

  // FIX: Self-improvement queries → selfImprovement tool
  if (isSelfImprovementQuery(trimmed)) {
    return {
      tool: "selfImprovement",
      input: trimmed,
      context: {},
      reasoning: "preclassifier_self_improvement"
    };
  }

  // Meta questions about file access
  if (isMetaQuestionAboutFiles(trimmed)) {
    return {
      tool: "llm",
      input: trimmed,
      context: { raw: "meta_question" },
      reasoning: "preclassifier_meta_file_question"
    };
  }

  // Forget location
  if (locationWithForgetLike(lower)) {
    return {
      tool: "memorytool",
      input: trimmed,
      context: { raw: "forget_location" },
      reasoning: "preclassifier_forget_location"
    };
  }

  // Remember location
  if (locationWithRememberLike(lower) || /\bremember my location\b/i.test(lower)) {
    return {
      tool: "llm",
      input: trimmed,
      context: { raw: "memory_write" },
      reasoning: "preclassifier_remember_location"
    };
  }

  // "here" + weather keywords
  if (hereIndicatesWeather(lower)) {
    return {
      tool: "weather",
      input: trimmed,
      context: { city: "__USE_GEOLOCATION__" },
      reasoning: "preclassifier_here_weather"
    };
  }

  // Weather with city
  if (containsKeyword(lower, WEATHER_KEYWORDS)) {
    const extracted = extractCity(trimmed);
    if (extracted) {
      return {
        tool: "weather",
        input: trimmed,
        context: { city: extracted },
        reasoning: "preclassifier_weather_with_city"
      };
    }
    return {
      tool: "weather",
      input: trimmed,
      context: {},
      reasoning: "preclassifier_weather_no_city"
    };
  }

  // Location query
  if (/\bwhere am i\b/i.test(lower) || /\bwhat('?s| is) my location\b/i.test(lower)) {
    return {
      tool: "llm",
      input: trimmed,
      context: { raw: "location_query" },
      reasoning: "preclassifier_location_query"
    };
  }

  // LLM classifier for everything else
  const detection = await detectIntentWithLLM(trimmed);

  // Weather handling
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

  // Normalize tool name (case-insensitive)
  const normalizedTool = normalizeToolName(detection.intent || "llm");

  return {
    tool: normalizedTool,
    input: trimmed,
    context: detection.context || {},
    reasoning: detection.reason
  };
}

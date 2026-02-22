// server/planner.js
// COMPLETE MULTI-STEP PLANNER with 6-step improvement sequence (now actually modifies code)

import { llm } from "./tools/llm.js";

// ============================================================
// IMPROVEMENT REQUEST DETECTION
// ============================================================

/**
 * Detect improvement/self-improvement requests
 * These require 6-step sequence: githubTrending → review → applyPatch → gitLocal status → add → commit
 */
function isImprovementRequest(message) {
  const lower = message.toLowerCase();
  
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
  const lower = message.toLowerCase();
  
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
 * Generate 6-step improvement sequence
 * NOW INCLUDES applyPatch to actually modify the code!
 */
function generateImprovementSteps(message) {
  const target = extractImprovementTarget(message);
  const baseName = target.replace('.js', '');
  
  // Extract search query for githubTrending
  let searchQuery = `${baseName} patterns best practices`;
  const trendingMatch = message.match(/trending.*for\s+([^,]+?)(?:\s+patterns|\s+and|,|$)/i);
  if (trendingMatch) {
    searchQuery = trendingMatch[1].trim();
  }
  
  const commitMsg = `Improved ${baseName} tool based on trending patterns`;
  
  console.log(`📋 Generating 6-step improvement sequence:`);
  console.log(`   Target: ${target}`);
  console.log(`   Search: ${searchQuery}`);
  console.log(`   Commit: ${commitMsg}`);
  
  return [
    {
      tool: 'githubTrending',
      input: searchQuery,
      context: {},
      reasoning: 'Search trending repositories for patterns'
    },
    {
      tool: 'review',
      input: target,
      context: {},
      reasoning: `Review current ${target} implementation`
    },
    {
      tool: 'applyPatch',
      input: target,
      context: { targetFile: target },
      reasoning: `Apply improvements to ${target} based on review and patterns`
    },
    {
      tool: 'gitLocal',
      input: 'status',
      context: {},
      reasoning: 'Check git status after changes'
    },
    {
      tool: 'gitLocal',
      input: `add ${target}`,
      context: {},
      reasoning: `Stage ${target} for commit`
    },
    {
      tool: 'gitLocal',
      input: 'commit',
      context: { raw: commitMsg },
      reasoning: 'Commit improvements'
    }
  ];
}

// ============================================================
// CERTAINTY LAYER
// ============================================================

function isMathExpression(msg) {
  const trimmed = msg.trim();
  if (!/[0-9]/.test(trimmed)) return false;
  if (/[+\-*/^=()]/.test(trimmed)) return true;
  return /^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed);
}

function isSimpleDateTime(msg) {
  const lower = msg.toLowerCase().trim();
  return (
    /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
    /^(date|time|day|month|year) (today|now)/.test(lower)
  );
}

function hasExplicitFilePath(text) {
  return /[a-z]:[\\/]/i.test(text);
}

function isSendItCommand(text) {
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed === "send it" ||
    trimmed === "send" ||
    trimmed === "yes send it" ||
    trimmed === "yes, send it" ||
    trimmed === "send the email" ||
    trimmed === "confirm" ||
    (trimmed === "yes" && text.length < 10)
  );
}

const WEATHER_KEYWORDS = [
  "weather", "forecast", "temperature", "temp", "rain", "raining",
  "snow", "snowing", "humidity", "wind", "windy", "sunny", "cloudy"
];

const FORGET_SYNONYMS = ["forget", "forgot", "remove", "clear", "delete"];
const REMEMBER_SYNONYMS = ["remember", "save", "store", "set", "keep"];

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
  const lower = message.toLowerCase().trim();
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
// LLM CLASSIFIER (For single-step plans)
// ============================================================

function extractContextSignals(message) {
  const lower = message.toLowerCase();
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

async function detectIntentWithLLM(message, contextSignals) {
  const signalText = contextSignals.length > 0
    ? `\nCONTEXT SIGNALS: ${contextSignals.join(", ")}`
    : "";

  const prompt = `You are an intent classifier for an AI agent. Classify the user's message into ONE tool.

AVAILABLE TOOLS:
- weather: Weather forecasts
- news: Latest headlines
- search: Web search
- sports: Sports scores
- youtube: YouTube videos
- shopping: Product search
- finance: Stock prices
- financeFundamentals: Company fundamentals
- file: Read/list local files
- fileWrite: Create files
- email: Draft/send emails
- tasks: Task management
- calculator: Math calculations
- selfImprovement: Query improvements
- github: GitHub API (repos, issues, PRs)
- githubTrending: Trending repositories
- gitLocal: Local git operations
- review: Code review
- applyPatch: Apply code improvements
- memorytool: Manage profile
- nlp_tool: Text analysis (ONLY when explicitly requested)
- llm: General conversation

USER MESSAGE:
"${message}"
${signalText}

CRITICAL RULES:
1. "list repos" → github (NOT file)
2. "list D:/..." → file
3. "trending" → githubTrending
4. NEVER use nlp_tool unless explicitly asked for "sentiment" or "analyze text"
5. For improvement requests, return "selfImprovement"

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

export async function plan({ message }) {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  
  console.log("🧠 Planning steps for:", trimmed);
  
  // ──────────────────────────────────────────────────────────
  // MULTI-STEP: Improvement Requests (6 steps now!)
  // ──────────────────────────────────────────────────────────
  if (isImprovementRequest(trimmed)) {
    console.log("🎯 Detected improvement request - generating 6-step sequence");
    return generateImprovementSteps(trimmed);
  }
  
  // ──────────────────────────────────────────────────────────
  // SINGLE-STEP: Certainty Layer
  // ──────────────────────────────────────────────────────────
  
  // Math
  if (isMathExpression(trimmed)) {
    return [{ tool: "calculator", input: trimmed, context: {}, reasoning: "certainty_math" }];
  }
  
  // DateTime
  if (isSimpleDateTime(trimmed)) {
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_datetime" }];
  }
  
  // Email confirmation
  if (isSendItCommand(lower)) {
    return [{ tool: "email_confirm", input: trimmed, context: { action: "send_confirmed" }, reasoning: "certainty_email_confirm" }];
  }
  
  // Forget location
  if (locationWithForgetLike(lower)) {
    return [{ tool: "memorytool", input: trimmed, context: { raw: "forget_location" }, reasoning: "certainty_forget_location" }];
  }
  
  // Weather here
  if (hereIndicatesWeather(lower)) {
    return [{ tool: "weather", input: trimmed, context: { city: "__USE_GEOLOCATION__" }, reasoning: "certainty_here_weather" }];
  }
  
  // Weather with city
  if (containsKeyword(lower, WEATHER_KEYWORDS)) {
    const extracted = extractCity(trimmed);
    const context = extracted ? { city: extracted } : {};
    return [{ tool: "weather", input: trimmed, context, reasoning: "certainty_weather" }];
  }
  
  // Explicit file path
  if (hasExplicitFilePath(trimmed)) {
    return [{ tool: "file", input: trimmed, context: {}, reasoning: "certainty_file_path" }];
  }
  
  // ──────────────────────────────────────────────────────────
  // SINGLE-STEP: LLM Classifier
  // ──────────────────────────────────────────────────────────
  
  const contextSignals = extractContextSignals(trimmed);
  console.log("🧠 Context signals:", contextSignals);
  
  const detection = await detectIntentWithLLM(trimmed, contextSignals);
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
  
  return [{
    tool,
    input: trimmed,
    context: detection.context || {},
    reasoning: detection.reason
  }];
}

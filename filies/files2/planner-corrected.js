// server/planner.js (CORRECTED for your actual LLM implementation)
// LLM-powered planner with intelligent intent detection

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

// LLM-based intent detection using your Ollama setup
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
- file: Read/list files in allowed directories
- email: Draft and send emails
- tasks: Task management and reminders
- calculator: Mathematical calculations
- llm: General conversation, memory questions, questions ABOUT location (not weather)

SPECIAL CAPABILITIES:
- The agent can remember user preferences (name, likes, location)
- The agent can reformat previous responses into tables
- The agent has access to its conversation history
- Weather tool supports "here" to use IP-based geolocation

USER MESSAGE:
"${message}"

CLASSIFICATION RULES:
1. If user wants to reformat a previous response (e.g., "show that in a table", "make a table from that"), respond: reformat_table
2. If asking about WEATHER with "here" (e.g., "weather here", "how's the weather here"), respond: weather|USE_GEO
3. If asking about weather for a specific city (e.g., "weather in Paris"), respond: weather|CityName
4. If asking WHERE they are or ABOUT their location (e.g., "where am I", "do you know where I am", "what's my location"), respond: llm|location_query
5. If asking to remember something, respond: llm|memory_write
6. If asking what the agent remembers, respond: llm|memory_query
7. If asking about the agent itself, respond: llm|meta_question
8. For factual questions needing current info, respond: search
9. For stock fundamentals/metrics, respond: financeFundamentals
10. For stock prices, respond: finance

IMPORTANT: "where am I" or "do you know where I am" should go to LLM (not weather)!
IMPORTANT: Only use weather for actual weather conditions (temperature, rain, forecast)!

Respond with ONLY the tool name (and optional context after |), nothing else.
Examples:
- "weather|USE_GEO"
- "search"
- "finance"
- "reformat_table"
- "llm|memory_query"
- "llm|location_query"`;

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

    // Handle special contexts
    if (intent === "weather" && contextStr === "USE_GEO") {
      result.useGeolocation = true;
    } else if (intent === "weather" && contextStr) {
      result.city = contextStr;
    } else if (intent === "llm" && contextStr) {
      result.reason = contextStr;
    }

    console.log("🎯 Parsed Intent:", result);
    return result;

  } catch (err) {
    console.error("LLM intent detection error:", err.message);
    return { intent: "llm", reason: "error_fallback" };
  }
}

// Extract city from weather query
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

  // LLM-BASED INTENT DETECTION
  const detection = await detectIntentWithLLM(trimmed);

  // Special case: reformatting previous response
  if (detection.intent === "reformat_table") {
    return {
      tool: "reformat_table",
      input: trimmed,
      context: { format: "table" }
    };
  }

  // Weather with geolocation
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
      context
    };
  }

  // Return the LLM's decision
  return {
    tool: detection.intent || "llm",
    input: trimmed,
    context: detection.context || {},
    reasoning: detection.reason
  };
}

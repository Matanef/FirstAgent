// server/planner.js
// Clean, improved, future‑proof planner with natural‑language intent detection

// ------------------------------
// 1. AI META QUESTIONS
// ------------------------------
function isAIMetaQuestion(message) {
  const lower = message.toLowerCase();
  return [
    "how can i make you",
    "how can i improve you",
    "how can i use you",
    "how do i use you",
    "how do you work",
    "what can you do",
    "what are you capable of",
    "why did you answer",
    "why did you say",
    "how do you decide",
    "how do you think",
    "how do you generate",
    "how do you create",
    "how do you respond",
    "describe yourself",
    "how would you describe yourself",
    "tell me about yourself",
    "what are you like",
    "what is your personality"
  ].some(p => lower.includes(p));
}

// ------------------------------
// 2. MEMORY INTENTS
// ------------------------------
function isMemoryQueryIntent(message) {
  const lower = message.toLowerCase();
  return (
    /what('?s| is) my name/.test(lower) ||
    /do you remember.*name/.test(lower) ||
    /what do you remember about me/.test(lower) ||
    /what do you know about me/.test(lower)
  );
}

function isMemoryWriteIntent(message) {
  const lower = message.toLowerCase();
  return [
    "remember my name",
    "remember that my name is",
    "store my name",
    "save my name",
    "remember that i like",
    "remember that i prefer",
    "remember i like",
    "remember i prefer"
  ].some(p => lower.includes(p));
}

// ------------------------------
// 3. DATE / TIME QUESTIONS
// ------------------------------
function isDateQuestion(msg) {
  const lower = msg.toLowerCase().trim();
  return lower.includes("today") &&
    (lower.includes("date") || lower.includes("day")) &&
    !lower.includes("week");
}

function isTimeQuestion(msg) {
  const lower = msg.toLowerCase().trim();
  return lower.includes("time") &&
    (lower.includes("now") || lower.includes("current"));
}

function isDayOfWeekQuestion(msg) {
  const lower = msg.toLowerCase().trim();
  return lower.includes("today") &&
    (lower.includes("day of the week") || lower.includes("weekday"));
}

function isMonthOrYearQuestion(msg) {
  const lower = msg.toLowerCase().trim();
  return lower.includes("today") &&
    (lower.includes("month") || lower.includes("year"));
}

// ------------------------------
// 4. NEWS INTENT
// ------------------------------
function isNewsIntent(message) {
  const lower = message.toLowerCase();
  return [
    "news",
    "headlines",
    "latest news",
    "today's news",
    "today news",
    "ynet",
    "kan",
    "n12",
    "haaretz",
    "jpost",
    "jerusalem post",
    "times of israel",
    "breaking news",
    "scan news",
    "scan websites",
    "scan the web for news",
    "latest updates",
    "top stories"
  ].some(w => lower.includes(w));
}

// ------------------------------
// 5. WEATHER INTENT
// ------------------------------
function isWeatherIntent(message) {
  const lower = message.toLowerCase();
  return [
    "weather",
    "forecast",
    "temperature",
    "rain",
    "snow",
    "wind",
    "humidity"
  ].some(w => lower.includes(w));
}

// ------------------------------
// 6. SPORTS INTENT
// ------------------------------
function isSportsIntent(message) {
  const lower = message.toLowerCase();
  return [
    "score",
    "scores",
    "result",
    "results",
    "match",
    "game",
    "fixture",
    "fixtures",
    "standings",
    "league",
    "premier league",
    "nba",
    "nfl",
    "champions league",
    "football",
    "soccer",
    "basketball",
    "tennis"
  ].some(w => lower.includes(w));
}

// ------------------------------
// 7. YOUTUBE INTENT
// ------------------------------
function isYouTubeIntent(message) {
  const lower = message.toLowerCase();
  return [
    "youtube",
    "video",
    "videos",
    "watch on youtube",
    "find a video",
    "show me a video"
  ].some(w => lower.includes(w));
}

// ------------------------------
// 8. SHOPPING INTENT
// ------------------------------
function isShoppingIntent(message) {
  const lower = message.toLowerCase();
  return [
    "buy",
    "purchase",
    "order",
    "shopping",
    "price comparison",
    "compare prices",
    "best laptop",
    "best phone",
    "recommend a phone",
    "recommend a laptop"
  ].some(w => lower.includes(w));
}

// ------------------------------
// 9. EMAIL INTENT
// ------------------------------
function isEmailIntent(message) {
  const lower = message.toLowerCase();
  return [
    "send an email",
    "email my",
    "compose an email",
    "draft an email",
    "write an email"
  ].some(w => lower.includes(w));
}

// ------------------------------
// 10. TASK INTENT
// ------------------------------
function isTaskIntent(message) {
  const lower = message.toLowerCase();
  return [
    "add a task",
    "create a task",
    "todo",
    "to-do",
    "remind me to",
    "reminder",
    "task list"
  ].some(w => lower.includes(w));
}

// ------------------------------
// 11. FILE SYSTEM INTENT
// ------------------------------
function isFileIntent(message) {
  const lower = message.toLowerCase();
  if (isNewsIntent(lower)) return false;

  return [
    "list folder",
    "show folder",
    "open folder",
    "read file",
    "open file",
    "show contents",
    "list files",
    "directory",
    "folder",
    "scan folder",
    "scan directory",
    "scan subfolder",
    "what's inside",
    "show me the contents of"
  ].some(k => lower.includes(k));
}

// ------------------------------
// 12. FINANCE INTENTS
// ------------------------------
function isFinanceFundamentalsIntent(message) {
  const lower = message.toLowerCase();
  return [
    "fundamentals",
    "fundamental metrics",
    "valuation",
    "financial metrics",
    "key statistics",
    "key stats",
    "market cap",
    "market capitalization",
    "p/e",
    "pe ratio",
    "price to earnings",
    "eps",
    "dividend",
    "dividend yield",
    "52 week",
    "52-week",
    "metrics",
    "financials"
  ].some(k => lower.includes(k));
}

function isFinancePriceIntent(message) {
  const lower = message.toLowerCase();
  return [
    "stock price",
    "share price",
    "current price",
    "quote",
    "last price",
    "trading at",
    "price of"
  ].some(k => lower.includes(k));
}

// ------------------------------
// 13. CALCULATOR INTENT
// ------------------------------
function shouldUseCalculator(message) {
  const trimmed = message.trim();
  if (!/[0-9]/.test(trimmed)) return false;
  if (/[+\-*/^=]/.test(trimmed)) return true;
  return /^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed);
}

// ------------------------------
// 14. GENERAL FACTUAL → SEARCH
// ------------------------------
function isGeneralFactualQuestion(message) {
  const lower = message.toLowerCase();

  if (isAIMetaQuestion(lower)) return false;
  if (isMemoryQueryIntent(lower)) return false;
  if (isMemoryWriteIntent(lower)) return false;

  const hasQuestionWord = /\bwho\b|\bwhat\b|\bwhen\b|\bwhere\b|\bwhy\b|\bhow\b/.test(lower);
  const hasQuestionMark = /[?]/.test(lower);

  if (!hasQuestionWord && !hasQuestionMark) return false;
  if (/\bmy name\b/.test(lower)) return false;

  return true;
}

// ------------------------------
// 15. CITY EXTRACTION (for weather)
// ------------------------------
function extractCityFromMessage(message) {
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
  if (/^[a-zA-Z\-]+$/.test(last)) return formatCity(last);

  return null;
}

function formatCity(city) {
  return city
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ------------------------------
// 16. MAIN PLANNER
// ------------------------------
export function plan({ message }) {
  const trimmed = message.trim();

  // Date/time → LLM
  if (
    isDateQuestion(trimmed) ||
    isTimeQuestion(trimmed) ||
    isDayOfWeekQuestion(trimmed) ||
    isMonthOrYearQuestion(trimmed)
  ) {
    return { tool: "llm", input: trimmed };
  }

  // Weather (with city context + "here")
  if (isWeatherIntent(trimmed)) {
    if (/\bhere\b/i.test(trimmed)) {
      return {
        tool: "weather",
        input: trimmed,
        context: { city: "__USE_GEOLOCATION__" }
      };
    }

    const city = extractCityFromMessage(trimmed);

    if (city) {
      return {
        tool: "weather",
        input: trimmed,
        context: { city }
      };
    }

    return { tool: "weather", input: trimmed };
  }

  if (isSportsIntent(trimmed)) return { tool: "sports", input: trimmed };
  if (isYouTubeIntent(trimmed)) return { tool: "youtube", input: trimmed };
  if (isShoppingIntent(trimmed)) return { tool: "shopping", input: trimmed };
  if (isEmailIntent(trimmed)) return { tool: "email", input: trimmed };
  if (isTaskIntent(trimmed)) return { tool: "tasks", input: trimmed };
  if (isNewsIntent(trimmed)) return { tool: "news", input: trimmed };
  if (isFileIntent(trimmed)) return { tool: "file", input: trimmed };

  if (isMemoryWriteIntent(trimmed) || isMemoryQueryIntent(trimmed))
    return { tool: "llm", input: trimmed };

  if (isAIMetaQuestion(trimmed)) return { tool: "llm", input: trimmed };

  if (isFinanceFundamentalsIntent(trimmed))
    return { tool: "financeFundamentals", input: trimmed };

  if (isFinancePriceIntent(trimmed))
    return { tool: "finance", input: trimmed };

  if (shouldUseCalculator(trimmed))
    return { tool: "calculator", input: trimmed };

  if (isGeneralFactualQuestion(trimmed))
    return { tool: "search", input: trimmed };

  return { tool: "llm", input: trimmed };
}
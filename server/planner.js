// server/planner.js
// Clean, improved, future‑proof planner with natural‑language intent detection

// ------------------------------
// AI meta questions (about the assistant itself)
// ------------------------------
function isAIMetaQuestion(message) {
  const lower = message.toLowerCase();

  const patterns = [
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
  ];

  return patterns.some(p => lower.includes(p));
}

// ------------------------------
// Memory query intent
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

// ------------------------------
// Memory write intent
// ------------------------------
function isMemoryWriteIntent(message) {
  const lower = message.toLowerCase();

  const patterns = [
    "remember my name",
    "remember that my name is",
    "store my name",
    "save my name",
    "remember that i like",
    "remember that i prefer",
    "remember i like",
    "remember i prefer"
  ];

  return patterns.some(p => lower.includes(p));
}

// ------------------------------
// File system intent
// ------------------------------
function isFileIntent(message) {
  const lower = message.toLowerCase();

  return (
    lower.includes("scan") ||
    lower.includes("list folder") ||
    lower.includes("show folder") ||
    lower.includes("open folder") ||
    lower.includes("read file") ||
    lower.includes("show contents") ||
    lower.includes("scan subfolder") ||
    lower.includes("folder") ||
    lower.includes("directory") ||
    lower.includes("list files") ||
    lower.includes("show me what's inside") ||
    lower.includes("show me the contents")
  );
}

// ------------------------------
// Finance fundamentals intent
// ------------------------------
function isFinanceFundamentalsIntent(message) {
  const lower = message.toLowerCase();

  const financeKeywords = [
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
  ];

  return financeKeywords.some(k => lower.includes(k));
}

// ------------------------------
// Finance price intent
// ------------------------------
function isFinancePriceIntent(message) {
  const lower = message.toLowerCase();

  const priceKeywords = [
    "stock price",
    "share price",
    "current price",
    "quote",
    "last price",
    "trading at",
    "price of"
  ];

  return priceKeywords.some(k => lower.includes(k));
}

// ------------------------------
// Calculator intent
// ------------------------------
function shouldUseCalculator(message) {
  const trimmed = message.trim();

  if (!/[0-9]/.test(trimmed)) return false;
  if (/[+\-*/^=]/.test(trimmed)) return true;
  if (/^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed)) return true;

  return false;
}

// ------------------------------
// General factual questions → search
// ------------------------------
function isGeneralFactualQuestion(message) {
  const lower = message.toLowerCase();

  if (isAIMetaQuestion(lower)) return false;
  if (isMemoryQueryIntent(lower)) return false;
  if (isMemoryWriteIntent(lower)) return false;

  if (
    !/[?]/.test(lower) &&
    !/\bwho\b|\bwhat\b|\bwhen\b|\bwhere\b|\bwhy\b|\bhow\b/.test(lower)
  ) {
    return false;
  }

  if (/\bmy name\b/.test(lower)) return false;

  return true;
}

// ------------------------------
// MAIN PLANNER
// ------------------------------
export function plan({ message }) {
  const trimmed = message.trim();

  // 0️⃣ File system access
  if (isFileIntent(trimmed)) {
    return { tool: "file", input: trimmed };
  }

  // 1️⃣ Memory write or memory query → LLM
  if (isMemoryWriteIntent(trimmed) || isMemoryQueryIntent(trimmed)) {
    return { tool: "llm", input: trimmed };
  }

  // 2️⃣ AI meta questions → LLM
  if (isAIMetaQuestion(trimmed)) {
    return { tool: "llm", input: trimmed };
  }

  // 3️⃣ Finance fundamentals
  if (isFinanceFundamentalsIntent(trimmed)) {
    return { tool: "financeFundamentals", input: trimmed };
  }

  // 4️⃣ Finance price
  if (isFinancePriceIntent(trimmed)) {
    return { tool: "finance", input: trimmed };
  }

  // 5️⃣ Calculator
  if (shouldUseCalculator(trimmed)) {
    return { tool: "calculator", input: trimmed };
  }

  // 6️⃣ General factual questions → search
  if (isGeneralFactualQuestion(trimmed)) {
    return { tool: "search", input: trimmed };
  }

  // 7️⃣ Default → LLM
  return { tool: "llm", input: trimmed };
}
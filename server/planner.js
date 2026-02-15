// server/planner.js

/**
 * Detects if the user is asking about the AI itself.
 * These should NOT trigger search.
 */
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

/**
 * Detects memory-related questions.
 * These should go to LLM, not search.
 */
function isMemoryQueryIntent(message) {
  const lower = message.toLowerCase();

  return /what('?s| is) my name/.test(lower) ||
         /do you remember.*name/.test(lower) ||
         /what do you remember about me/.test(lower) ||
         /what do you know about me/.test(lower);
}

/**
 * Detects explicit memory-writing instructions.
 * The actual write happens in updateProfileMemory().
 */
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

/**
 * Finance fundamentals intent
 */
function isFinanceFundamentalsIntent(message) {
  const lower = message.toLowerCase();

  const financeKeywords = [
    "fundamentals",
    "market cap",
    "market capitalization",
    "p/e",
    "pe ratio",
    "price to earnings",
    "dividend",
    "dividend yield",
    "52 week",
    "52-week",
    "valuation",
    "metrics",
    "financials",
    "key stats",
    "key statistics"
  ];

  return financeKeywords.some(k => lower.includes(k));
}

/**
 * Finance price intent
 */
function isFinancePriceIntent(message) {
  const lower = message.toLowerCase();
  const priceKeywords = [
    "stock price",
    "share price",
    "current price",
    "quote",
    "last price",
    "trading at"
  ];

  return priceKeywords.some(k => lower.includes(k));
}

/**
 * Calculator intent
 */
function shouldUseCalculator(message) {
  const trimmed = message.trim();

  if (!/[0-9]/.test(trimmed)) return false;

  if (/[+\-*/^=]/.test(trimmed)) return true;

  if (/^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed)) return true;

  return false;
}

/**
 * Detects factual questions that SHOULD use search.
 * But only if they are NOT about the AI or the user.
 */
function isGeneralFactualQuestion(message) {
  const lower = message.toLowerCase();

  // If it's about the AI or memory, do NOT treat as factual
  if (isAIMetaQuestion(lower)) return false;
  if (isMemoryQueryIntent(lower)) return false;

  return /\bwho\b|\bwhat\b|\bwhen\b|\bwhere\b|\bwhy\b|\bhow\b/.test(lower);
}

/**
 * MAIN PLANNER
 */
export function plan({ message }) {
  const trimmed = message.trim();

  // 0️⃣ Memory write or memory query → LLM
  if (isMemoryWriteIntent(trimmed) || isMemoryQueryIntent(trimmed)) {
    return { tool: "llm", input: trimmed };
  }

  // 1️⃣ AI meta questions → LLM
  if (isAIMetaQuestion(trimmed)) {
    return { tool: "llm", input: trimmed };
  }

  // 2️⃣ Finance fundamentals
  if (isFinanceFundamentalsIntent(trimmed)) {
    return { tool: "finance-fundamentals", input: trimmed };
  }

  // 3️⃣ Finance price
  if (isFinancePriceIntent(trimmed)) {
    return { tool: "finance", input: trimmed };
  }

  // 4️⃣ Calculator
  if (shouldUseCalculator(trimmed)) {
    return { tool: "calculator", input: trimmed };
  }

  // 5️⃣ General factual questions → search
  if (isGeneralFactualQuestion(trimmed)) {
    return { tool: "search", input: trimmed };
  }

  // 6️⃣ Default → LLM
  return { tool: "llm", input: trimmed };
}
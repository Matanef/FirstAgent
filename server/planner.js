// server/planner.js

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

  if (financeKeywords.some(k => lower.includes(k))) {
    return true;
  }

  return false;
}

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

function shouldUseCalculator(message) {
  const trimmed = message.trim();

  if (!/[0-9]/.test(trimmed)) return false;

  if (/[+\-*/^=]/.test(trimmed)) return true;

  if (/^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed)) return true;

  return false;
}

export function plan({ message }) {
  const trimmed = message.trim();

  // 1️⃣ Finance fundamentals
  if (isFinanceFundamentalsIntent(trimmed)) {
    return {
      tool: "finance-fundamentals",
      input: trimmed
    };
  }

  // 2️⃣ Finance price
  if (isFinancePriceIntent(trimmed)) {
    return {
      tool: "finance",
      input: trimmed
    };
  }

  // 3️⃣ Calculator
  if (shouldUseCalculator(trimmed)) {
    return {
      tool: "calculator",
      input: trimmed
    };
  }

  // 4️⃣ Web search for factual questions
  if (/\bwho\b|\bwhat\b|\bwhen\b|\bwhere\b|\bwhy\b|\bhow\b/i.test(trimmed)) {
    return {
      tool: "search",
      input: trimmed
    };
  }

  // 5️⃣ Default to LLM
  return {
    tool: "llm",
    input: trimmed
  };
}
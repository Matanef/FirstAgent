// server/planner.js

const FILE_REGEX = /[A-Za-z]:[\\/]/;
const PURE_MATH_REGEX = /^[0-9+\-*/().\s]+$/;

const REALTIME_KEYWORDS = [
  "current",
  "today",
  "latest",
  "rate",
  "price",
  "news",
  "weather",
  "exchange"
];

/**
 * Detect stock-related queries like:
 * - AAPL price
 * - what is AAPL stock price?
 * - TSLA share price
 */
function isStockQuery(message) {
  const lower = message.toLowerCase();

  return (
    /\b[A-Z]{1,5}\b/.test(message) &&
    (
      lower.includes("stock") ||
      lower.includes("price") ||
      lower.includes("share")
    )
  );
}

/**
 * Detect if real-time external info is needed
 */
function needsSearch(message) {
  const lower = message.toLowerCase();
  return REALTIME_KEYWORDS.some(word => lower.includes(word));
}

export async function plan({ message }) {
  const trimmed = message.trim();

  // 1️⃣ File paths
  if (FILE_REGEX.test(trimmed)) {
    return { tool: "file", reason: "File path detected" };
  }

  // 2️⃣ Pure math expressions
  if (PURE_MATH_REGEX.test(trimmed)) {
    return { tool: "calculator", reason: "Math expression detected" };
  }

  // 3️⃣ Stock queries
  if (isStockQuery(trimmed)) {
    return { tool: "finance", reason: "Stock query detected" };
  }

  // 4️⃣ Real-time info
  if (needsSearch(trimmed)) {
    return { tool: "search", reason: "Real-time info requested" };
  }

  // 5️⃣ Default → LLM conversation
  return { tool: "llm", reason: "General conversation" };
}

// server/planner.js

/**
 * Enhanced planner with better intent ordering
 */

// ----------------------------
// Sector keywords mapping
// ----------------------------
const SECTOR_KEYWORDS = {
  Healthcare: ["biotech", "bioengineering", "pharmaceutical", "medical", "drug", "healthcare", "biopharma", "medicine"],
  Technology: ["tech", "software", "ai", "cloud", "semiconductor", "cybersecurity", "saas"],
  Energy: ["oil", "gas", "renewable", "solar", "wind", "energy"],
  Financial: ["bank", "insurance", "fintech", "financial services", "investment"],
  Consumer: ["retail", "consumer", "ecommerce", "food", "beverage"],
  Industrial: ["manufacturing", "aerospace", "defense", "construction"],
  Communication: ["telecom", "media", "entertainment", "streaming"],
  "Real Estate": ["reit", "real estate", "property"],
  Materials: ["mining", "chemicals", "metals"],
  Utilities: ["utility", "electric", "water", "gas utility"]
};

// ----------------------------
// Detect sector
// ----------------------------
function detectSector(message) {
  const msg = message.toLowerCase();

  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(keyword => msg.includes(keyword))) {
      return sector;
    }
  }

  return null;
}

// ----------------------------
// Extract finance params
// ----------------------------
function extractFinanceParams(message) {
  const msg = message.toLowerCase();
  const params = {};

  const sector = detectSector(message);
  if (sector) params.sector = sector;

  // Top N detection
  const limitMatch = msg.match(/top (\d+)|(\d+) (?:top|best|largest)/);
  if (limitMatch) {
    params.limit = parseInt(limitMatch[1] || limitMatch[2]);
  }

  // Stock symbol detection (FIXED precedence bug)
  const symbolMatch = message.match(/\b([A-Z]{1,5})\b/);
  if (symbolMatch && (msg.includes("price") || msg.includes("quote"))) {
    params.symbol = symbolMatch[1];
  }

  return params;
}

// ----------------------------
// Main planner
// ----------------------------
export function plan(message) {
  const msg = message.toLowerCase().trim();

  // 1️⃣ Calculator
  if (/^[\d+\-*/().\s]+$/.test(msg)) {
    return {
      action: "calculator",
      params: {},
      confidence: 0.95
    };
  }

  // 2️⃣ Meta / capabilities
  const metaKeywords = /\b(what can you do|your capabilities|who are you|how can you help|help me)\b/i;
  if (metaKeywords.test(msg)) {
    return {
      action: "capabilities",
      params: {},
      confidence: 0.95
    };
  }

  // 3️⃣ Finance
  const financeKeywords = /\b(stock|market|market cap|nasdaq|dow|s&p|share|trading|etf|portfolio|earning|analysis|sector|industry|invest)\b/i;

  if (financeKeywords.test(msg)) {
    const params = extractFinanceParams(message);

    if (params.symbol && !params.sector) {
      return {
        action: "stock_price",
        params: { symbol: params.symbol },
        confidence: 0.9
      };
    }

    return {
      action: "finance",
      params,
      confidence: 0.85
    };
  }

  // 4️⃣ True external search
  const searchKeywords = /\b(latest|recent|news|current|today|find|search|look up)\b/i;
  if (searchKeywords.test(msg)) {
    return {
      action: "search",
      params: {},
      confidence: 0.75
    };
  }

  // 5️⃣ Default LLM reasoning
  return {
    action: "llm",
    params: {},
    confidence: 0.6
  };
}

export function simplePlan(message) {
  return plan(message).action;
}

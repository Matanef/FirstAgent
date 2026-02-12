// server/planner.js

/**
 * Enhanced planner with sector detection and multi-intent support
 */

// Sector keywords mapping
const SECTOR_KEYWORDS = {
  "Healthcare": ["biotech", "bioengineering", "pharmaceutical", "medical", "drug", "healthcare", "biopharma", "medicine"],
  "Technology": ["tech", "software", "ai", "cloud", "semiconductor", "cybersecurity", "saas"],
  "Energy": ["oil", "gas", "renewable", "solar", "wind", "energy", "utility"],
  "Financial": ["bank", "insurance", "fintech", "financial services", "investment"],
  "Consumer": ["retail", "consumer", "ecommerce", "food", "beverage"],
  "Industrial": ["manufacturing", "aerospace", "defense", "construction"],
  "Communication": ["telecom", "media", "entertainment", "streaming"],
  "Real Estate": ["reit", "real estate", "property"],
  "Materials": ["mining", "chemicals", "metals", "materials"],
  "Utilities": ["utility", "electric", "water", "gas utility"]
};

/**
 * Detect sector from user query
 */
function detectSector(message) {
  const msg = message.toLowerCase();
  
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(keyword => msg.includes(keyword))) {
      return sector;
    }
  }
  
  return null;
}

/**
 * Extract parameters from finance-related queries
 */
function extractFinanceParams(message) {
  const msg = message.toLowerCase();
  const params = {};

  // Detect sector
  const sector = detectSector(message);
  if (sector) {
    params.sector = sector;
  }

  // Extract limit (top N)
  const limitMatch = msg.match(/top (\d+)|(\d+) (?:top|best|largest)/);
  if (limitMatch) {
    params.limit = parseInt(limitMatch[1] || limitMatch[2]);
  }

  // Check if asking for specific stock
  const symbolMatch = message.match(/\b([A-Z]{1,5})\b/);
  if (symbolMatch && msg.includes("price") || msg.includes("quote")) {
    params.symbol = symbolMatch[1];
  }

  return params;
}

/**
 * Main planning function
 */
export function plan(message) {
  const msg = message.toLowerCase();

  // Pure calculator expression
  if (/^[\d+\-*/().\s]+$/.test(message.trim())) {
    return {
      action: "calculator",
      params: {},
      confidence: 0.95
    };
  }

  // Finance-related queries
  const financeKeywords = /\b(stock|market|market cap|nasdaq|dow|s&p|share|trading|etf|portfolio|earning|analysis|biotech|bioengineering|pharma|sector|industry|invest)\b/i;
  
  if (financeKeywords.test(msg)) {
    const params = extractFinanceParams(message);
    
    // Specific stock price query
    if (params.symbol && !params.sector) {
      return {
        action: "stock_price",
        params: { symbol: params.symbol },
        confidence: 0.9
      };
    }
    
    // General finance query (stocks by sector/market cap)
    return {
      action: "finance",
      params,
      confidence: 0.85
    };
  }

  // Search queries - informational
  const searchKeywords = /\b(top|list|who|what|when|where|why|how|history|explain|recent|latest|news|find|search)\b/i;
  
  if (searchKeywords.test(msg)) {
    return {
      action: "search",
      params: {},
      confidence: 0.7
    };
  }

  // Default to LLM for conversational queries
  return {
    action: "llm",
    params: {},
    confidence: 0.5
  };
}

/**
 * Legacy simple plan function for backward compatibility
 */
export function simplePlan(message) {
  const result = plan(message);
  return result.action;
}
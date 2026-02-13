// server/planner.js

/**
 * Hybrid rule-based planner
 * Order matters: calculator → finance → file → search → llm
 */

const SECTOR_KEYWORDS = {
  Healthcare: ["biotech", "bioengineering", "pharmaceutical", "medical", "drug", "healthcare", "biopharma", "medicine"],
  Technology: ["tech", "software", "ai", "cloud", "semiconductor", "cybersecurity", "saas"],
  Energy: ["oil", "gas", "renewable", "solar", "wind", "energy", "utility"],
  Financial: ["bank", "insurance", "fintech", "financial services", "investment"],
  Consumer: ["retail", "consumer", "ecommerce", "food", "beverage"],
  Industrial: ["manufacturing", "aerospace", "defense", "construction"],
  Communication: ["telecom", "media", "entertainment", "streaming"],
  "Real Estate": ["reit", "real estate", "property"],
  Materials: ["mining", "chemicals", "metals", "materials"],
  Utilities: ["utility", "electric", "water", "gas utility"]
};

/* -----------------------------
   Sector Detection
------------------------------ */
function detectSector(message) {
  const msg = message.toLowerCase();
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(k => msg.includes(k))) return sector;
  }
  return null;
}

/* -----------------------------
   Finance Extraction
------------------------------ */
function extractFinanceParams(message) {
  const msg = message.toLowerCase();
  const params = {};

  const sector = detectSector(message);
  if (sector) params.sector = sector;

  const limitMatch = msg.match(/top (\d+)|(\d+) (?:top|best|largest)/);
  if (limitMatch) params.limit = parseInt(limitMatch[1] || limitMatch[2]);

  const symbolMatch = message.match(/\b([A-Z]{1,5})\b/);
  if (symbolMatch && (msg.includes("price") || msg.includes("quote"))) {
    params.symbol = symbolMatch[1];
  }

  return params;
}

/* -----------------------------
   File Intent Detection
------------------------------ */
function detectFileIntent(message) {
  const msg = message.toLowerCase();

  const operations = {
    scan: ["scan", "list files", "directory contents", "show files"],
    scan_recursive: ["scan recursive", "list all files", "show all files"],
    duplicates: ["duplicate", "find duplicates", "duplicate files"],
    delete: ["delete file", "remove file"],
    read: ["read file", "open file", "tell me what it says", "show content"],
    write: ["write file", "save file", "edit file"]
  };

  for (const [op, keywords] of Object.entries(operations)) {
    if (keywords.some(k => msg.includes(k))) {

      // 1️⃣ Absolute Windows path (E:\something)
      const absoluteMatch = message.match(/[A-Za-z]:\\[^\s]+/);
      if (absoluteMatch) {
        return { operation: op, path: absoluteMatch[0] };
      }

      // 2️⃣ Relative "folder testFolder" or "file testread.txt"
      const folderOrFileMatch = message.match(/(?:folder|file)\s+([^\s]+)/i);
      if (folderOrFileMatch) {
        return { operation: op, path: folderOrFileMatch[1] };
      }

      // 3️⃣ Fallback: just scan default
      return { operation: op, path: "." };
    }
  }

  return null;
}

/* -----------------------------
   Main Planner
------------------------------ */
export function plan(message) {
  const msg = message.toLowerCase();

  // 1️⃣ Calculator
  if (/^[\d+\-*/().\s]+$/.test(message.trim())) {
    return { action: "calculator", params: {}, confidence: 0.95 };
  }

  // 2️⃣ Finance
  const financeKeywords = /\b(stock|market|market cap|nasdaq|dow|s&p|share|trading|etf|portfolio|earning|analysis|sector|industry|invest)\b/i;

  if (financeKeywords.test(msg)) {
    const params = extractFinanceParams(message);

    if (params.symbol && !params.sector) {
      return { action: "stock_price", params: { symbol: params.symbol }, confidence: 0.9 };
    }

    return { action: "finance", params, confidence: 0.85 };
  }

  // 3️⃣ File operations (IMPORTANT: before search)
  const fileParams = detectFileIntent(message);
  if (fileParams) {
    return { action: "file", params: fileParams, confidence: 0.9 };
  }

  // 4️⃣ Search
  const searchKeywords = /\b(top|who|what|when|where|why|how|history|explain|recent|latest|news|find|search)\b/i;
  if (searchKeywords.test(msg)) {
    return { action: "search", params: {}, confidence: 0.7 };
  }

  // 5️⃣ Default
  return { action: "llm", params: {}, confidence: 0.5 };
}

/* -----------------------------
   Simple Plan
------------------------------ */
export function simplePlan(message) {
  return plan(message).action;
}

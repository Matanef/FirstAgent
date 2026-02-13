const SECTOR_KEYWORDS = {
  "Healthcare": ["biotech","bioengineering","pharmaceutical","medical","drug","healthcare","biopharma","medicine"],
  "Technology": ["tech","software","ai","cloud","semiconductor","cybersecurity","saas"],
  "Energy": ["oil","gas","renewable","solar","wind","energy","utility"],
  "Financial": ["bank","insurance","fintech","financial services","investment"],
  "Consumer": ["retail","consumer","ecommerce","food","beverage"],
  "Industrial": ["manufacturing","aerospace","defense","construction"],
  "Communication": ["telecom","media","entertainment","streaming"],
  "Real Estate": ["reit","real estate","property"],
  "Materials": ["mining","chemicals","metals","materials"],
  "Utilities": ["utility","electric","water","gas utility"]
};

function detectSector(message) {
  const msg = message.toLowerCase();
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(keyword => msg.includes(keyword))) return sector;
  }
  return null;
}

function extractFinanceParams(message) {
  const msg = message.toLowerCase();
  const params = {};
  const sector = detectSector(message);
  if (sector) params.sector = sector;
  const limitMatch = msg.match(/top (\d+)|(\d+) (?:top|best|largest)/);
  if (limitMatch) params.limit = parseInt(limitMatch[1] || limitMatch[2]);
  const symbolMatch = message.match(/\b([A-Z]{1,5})\b/);
  if (symbolMatch && (msg.includes("price") || msg.includes("quote"))) params.symbol = symbolMatch[1];
  return params;
}

/**
 * Detect file operation
 */
function detectFileOperation(message) {
  const msg = message.toLowerCase();

  // scan folder X or scan X
  if (/scan\s+(folder\s+)?([^\s]+)/.test(msg)) return { operation: "scan" };

  // duplicate files
  if (/duplicates?\s+file/.test(msg)) return { operation: "duplicates" };

  return null;
}


/**
 * Extract folder path from message (robust version)
 */
function extractFolderPath(message) {
  const match = message.match(/folder\s+([^\s]+)/i);
  if (match) return match[1];
  // fallback: first word after "scan"
  const scanMatch = message.match(/scan\s+([^\s]+)/i);
  if (scanMatch) return scanMatch[1];
  return "."; // current folder default
}

export function plan(message) {
  const msg = message.toLowerCase();

  // Calculator
  if (/^[\d+\-*/().\s]+$/.test(message.trim())) return { action: "calculator", params: {}, confidence: 0.95 };

  // Finance
  const financeKeywords = /\b(stock|market|market cap|nasdaq|dow|s&p|share|trading|etf|portfolio|earning|analysis|biotech|bioengineering|pharma|sector|industry|invest)\b/i;
  if (financeKeywords.test(msg)) {
    const params = extractFinanceParams(message);
    if (params.symbol && !params.sector) return { action: "stock_price", params: { symbol: params.symbol }, confidence: 0.9 };
    return { action: "finance", params, confidence: 0.85 };
  }

  // Search
  const searchKeywords = /\b(top|list|who|what|when|where|why|how|history|explain|recent|latest|news|find|search)\b/i;
  if (searchKeywords.test(msg)) return { action: "search", params: {}, confidence: 0.7 };

  // File operations
const fileOp = detectFileOperation(msg);
if (fileOp) {
  const folderPath = extractFolderPath(message);
  return {
    action: "file",
    params: { operation: fileOp.operation, path: folderPath },
    confidence: 0.9
  };
}

  return { action: "llm", params: {}, confidence: 0.5 };
}

export function simplePlan(message) {
  return plan(message).action;
}

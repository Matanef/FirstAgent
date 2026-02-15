// server/tools/financeFundamentals.js

import { search } from "./search.js";

/**
 * PRIMARY: Fetch fundamentals from Bing Finance (stub for now).
 * Wire this to your real Bing/finance endpoint when ready.
 */
async function fetchFromBingFinance(tickers) {
  // TODO: Implement real Bing Finance call here.
  // For now, return null so we always use the fallback.
  return null;
}

/**
 * Normalize numeric strings like "4.442T", "1.2B", "500M", "51,268,269".
 */
function normalizeNumber(str) {
  if (!str) return null;
  const s = str.replace(/[, ]/g, "");
  const m = s.match(/^([\$€£]?)([0-9]*\.?[0-9]+)([MBT]|billion|million|trillion)?/i);
  if (!m) return str.trim();

  let value = parseFloat(m[2]);
  const unit = m[3]?.toLowerCase();

  if (unit === "m" || unit === "million") value *= 1e6;
  if (unit === "b" || unit === "billion") value *= 1e9;
  if (unit === "t" || unit === "trillion") value *= 1e12;

  return value.toString();
}

/**
 * Extract 52-week range as [low, high].
 */
function extractRange(text) {
  if (!text) return { low: null, high: null };
  const m = text.match(/([0-9]+\.[0-9]+|[0-9]+)\s*[-–]\s*([0-9]+\.[0-9]+|[0-9]+)/);
  if (!m) {
    const single = text.match(/([0-9]+\.[0-9]+|[0-9]+)/);
    if (!single) return { low: null, high: null };
    return { low: single[1], high: single[1] };
  }
  return { low: m[1], high: m[2] };
}

/**
 * Fallback: extract fundamentals from web search results using your existing search tool.
 */
async function fetchFromSearchFallback(tickers) {
  const fundamentals = {};

  for (const ticker of tickers) {
    const query = `${ticker} stock key statistics market cap pe ratio dividend yield 52 week range volume beta`;
    const result = await search(query);

    const data = result?.data || {};
    const results = data.results || [];

    const mergedText = [
      data.text || "",
      ...results.map(r => `${r.title} ${r.snippet || ""}`)
    ].join("\n");

    function extract(pattern) {
      const m = mergedText.match(pattern);
      return m ? m[1].trim() : null;
    }

    const marketCapRaw = extract(/market cap[^0-9$]*([\$€£]?[0-9\.,]+\s*(?:[MBT]|billion|million|trillion)?)/i);
    const peRaw = extract(/P\/E[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i) || extract(/PE ratio[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i);
    const divRaw = extract(/dividend yield[^0-9]*([0-9]+\.[0-9]+%|[0-9]+%)/i);
    const epsRaw = extract(/EPS[^0-9\-]*(-?[0-9]+\.[0-9]+|-?[0-9]+)/i);
    const rangeRaw = extract(/52[-\s]?week (?:range|high|low)[^0-9]*([0-9\.\s\-–]+)/i);
    const volRaw = extract(/volume[^0-9]*([0-9,]+\s*(?:[MBT]|million|billion|trillion)?)/i);
    const betaRaw = extract(/beta[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i);
    const ratingRaw = extract(/(strong buy|buy|hold|sell|strong sell)/i);
    const targetRaw = extract(/price target[^0-9]*([\$€£]?[0-9\.,]+)/i);

    const range = extractRange(rangeRaw || "");

    fundamentals[ticker] = {
      marketCap: marketCapRaw ? marketCapRaw : null,
      marketCapNormalized: marketCapRaw ? normalizeNumber(marketCapRaw) : null,
      peRatio: peRaw,
      dividendYield: divRaw,
      eps: epsRaw,
      week52High: range.high,
      week52Low: range.low,
      volume: volRaw,
      beta: betaRaw,
      analystRating: ratingRaw,
      analystTarget: targetRaw
    };
  }

  return fundamentals;
}

/**
 * Normalize ticker symbols from user input.
 */
function extractTickers(message) {
  const tickers = new Set();

  const parenMatches = message.match(/\(([A-Z]{1,5})\)/g) || [];
  for (const m of parenMatches) {
    const t = m.replace(/[()]/g, "");
    tickers.add(t);
  }

  const wordMatches = message.match(/\b[A-Z]{1,5}\b/g) || [];
  for (const w of wordMatches) {
    tickers.add(w);
  }

  return [...tickers];
}

export async function financeFundamentals(message) {
  const tickers = extractTickers(message);

  if (!tickers.length) {
    return {
      tool: "finance-fundamentals",
      success: false,
      final: true,
      error: "No valid tickers found in the request."
    };
  }

  // 1️⃣ Try Bing Finance (stubbed for now)
  let fundamentals = await fetchFromBingFinance(tickers);

  // 2️⃣ Fallback to search extraction
  if (!fundamentals) {
    fundamentals = await fetchFromSearchFallback(tickers);
  } else {
    const missing = tickers.filter(t => !fundamentals[t]);
    if (missing.length) {
      const fallback = await fetchFromSearchFallback(missing);
      fundamentals = { ...fundamentals, ...fallback };
    }
  }

  return {
    tool: "finance-fundamentals",
    success: true,
    final: true,
    data: {
      tickers,
      fundamentals
    }
  };
}
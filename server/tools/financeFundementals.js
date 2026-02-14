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
 * Fallback: extract fundamentals from web search results using your existing search tool.
 */
async function fetchFromSearchFallback(tickers) {
  const fundamentals = {};

  for (const ticker of tickers) {
    const query = `${ticker} stock key statistics market cap pe ratio dividend yield 52 week range`;
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

    fundamentals[ticker] = {
      marketCap: extract(/market cap[^0-9$]*([\$€£]?[0-9\.,]+\s*(?:[MBT]|billion|million|trillion)?)/i),
      peRatio: extract(/P\/E[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i),
      dividendYield: extract(/dividend yield[^0-9]*([0-9]+\.[0-9]+%|[0-9]+%)/i),
      eps: extract(/EPS[^0-9\-]*(-?[0-9]+\.[0-9]+|-?[0-9]+)/i),
      week52High: extract(/52[-\s]?week (?:high|range)[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i),
      week52Low: extract(/52[-\s]?week (?:low|range)[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i),
      volume: extract(/volume[^0-9]*([0-9,]+\s*(?:[MBT]|million|billion|trillion)?)/i),
      beta: extract(/beta[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i),
      analystRating: extract(/(strong buy|buy|hold|sell|strong sell)/i),
      analystTarget: extract(/price target[^0-9]*([\$€£]?[0-9\.,]+)/i)
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
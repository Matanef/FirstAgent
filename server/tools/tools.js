import fetch from "node-fetch";
import { loadJSON, saveJSON } from "../memory.js";

const FMP_API_KEY = process.env.FMP_API_KEY || "demo";

const SEARCH_CACHE_FILE = "./search_cache.json";
const SERPAPI_KEY = "7e508cfd2dd8eb17a672aaf920f25515be156a56ea2a043c8cae9f358c273418";

// ===========================
// Calculator
// ===========================

export function calculator(expr) {
  try {
    return { result: Function(`"use strict";return(${expr})`)() };
  } catch {
    return { error: "Invalid math expression" };
  }
}

// ===========================
// Finance
// ===========================

export async function getTopStocks(limit = 10) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/stock_market/actives?apikey=${FMP_API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!Array.isArray(data)) {
      return { error: "Invalid financial data" };
    }

    return {
      results: data.slice(0, limit).map(s => ({
        symbol: s.symbol,
        name: s.name,
        price: s.price,
        change: s.change
      }))
    };
  } catch (err) {
    return { error: "Finance API failed" };
  }
}


// ===========================
// Search
// ===========================

export function extractTopic(text) {
  return text
    .toLowerCase()
    .replace(/please|could you|would you|check again|verify/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchWeb(query, forceRefresh = false) {
  const cache = loadJSON(SEARCH_CACHE_FILE, {});
  const topic = extractTopic(query);

  // ✅ Only reuse cache if results are non-empty
  if (
    !forceRefresh &&
    cache[topic] &&
    Array.isArray(cache[topic].results) &&
    cache[topic].results.length > 0
  ) {
    return { cached: true, results: cache[topic].results };
  }

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    topic
  )}&api_key=${SERPAPI_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const results =
    data.organic_results?.slice(0, 5).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link
    })) || [];

  // ✅ Cache only if we actually have results
  if (results.length > 0) {
    cache[topic] = { timestamp: Date.now(), results };
    saveJSON(SEARCH_CACHE_FILE, cache);
  }

  return { cached: false, results };
}

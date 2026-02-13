// server/tools/search.js
// Web search tool using SERPAPI
// Structured deterministic return

import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import { loadJSON, saveJSON } from "../memory.js";

const SEARCH_CACHE_FILE = "./search_cache.json";

function extractTopic(text) {
  return text
    .toLowerCase()
    .replace(/please|could you|would you|check again|verify/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export async function search(query, forceRefresh = false) {
  if (!CONFIG.SERPAPI_KEY) {
    return {
      tool: "search",
      success: false,
      final: true,
      error: "Missing SERPAPI key"
    };
  }

  const cache = loadJSON(SEARCH_CACHE_FILE, {});
  const topic = extractTopic(query);

  if (
    !forceRefresh &&
    cache[topic] &&
    Array.isArray(cache[topic].results)
  ) {
    return {
      tool: "search",
      success: true,
      final: true,
      data: {
        cached: true,
        results: cache[topic].results
      }
    };
  }

  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
      topic
    )}&api_key=${CONFIG.SERPAPI_KEY}`;

    const data = await safeFetch(url);

    if (!data || !data.organic_results) {
      return {
        tool: "search",
        success: false,
        final: true,
        error: "Search API unavailable"
      };
    }

    const results = data.organic_results.slice(0, 5).map(r => ({
      title: r.title,
      snippet: r.snippet || "",
      url: r.link
    }));

    if (results.length > 0) {
      cache[topic] = {
        timestamp: Date.now(),
        results
      };
      saveJSON(SEARCH_CACHE_FILE, cache);
    }

    return {
      tool: "search",
      success: true,
      final: true,
      data: {
        cached: false,
        results
      }
    };

  } catch {
    return {
      tool: "search",
      success: false,
      final: true,
      error: "Search request failed"
    };
  }
}

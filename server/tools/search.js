import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import { loadJSON, saveJSON } from "../helpers.js";

const SEARCH_CACHE_FILE = "./search_cache.json";

function extractTopic(text) {
  return text
    .toLowerCase()
    .replace(/please|could you|would you|check again|verify/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchWeb(query, forceRefresh = false) {
  if (!CONFIG.SERPAPI_KEY) {
    return { error: "Missing SERPAPI key", results: [] };
  }

  const cache = loadJSON(SEARCH_CACHE_FILE, {});
  const topic = extractTopic(query);

  // Use cache only if valid and non-empty
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
  )}&api_key=${CONFIG.SERPAPI_KEY}`;

  const data = await safeFetch(url);

  if (!data || !data.organic_results) {
    return { results: [] };
  }

  const results = data.organic_results.slice(0, 5).map(r => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link
  }));

  // Cache only if results exist
  if (results.length > 0) {
    cache[topic] = {
      timestamp: Date.now(),
      results
    };

    saveJSON(SEARCH_CACHE_FILE, cache);
  }

  return { cached: false, results };
}

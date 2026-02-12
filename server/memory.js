import { safeFetch } from "./utils/fetch.js";
import { CONFIG } from "./utils/config.js";
import { loadJSON, saveJSON } from "./memory.js";

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

export async function searchWeb(query) {
  if (!CONFIG.SERPAPI_KEY) {
    return { error: "Missing SERPAPI key", results: [] };
  }

  const cache = loadJSON(SEARCH_CACHE_FILE, {});
  const topic = extractTopic(query);

  if (
    cache[topic] &&
    Date.now() - cache[topic].timestamp < CONFIG.SEARCH_CACHE_TTL
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

  cache[topic] = {
    timestamp: Date.now(),
    results
  };

  saveJSON(SEARCH_CACHE_FILE, cache);

  return { results };
}

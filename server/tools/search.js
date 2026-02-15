// server/tools/search.js
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import { loadJSON, saveJSON } from "../memory.js";

// Normalize query for caching
function normalizeQuery(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

const CACHE_FILE = "./search_cache.json";

export function extractTopic(text) {
  return normalizeQuery(text);
}

/**
 * Wikipedia summary fetch
 */
async function fetchWikipedia(query) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
  const data = await safeFetch(url);

  if (!data || !data.extract) return [];

  return [
    {
      title: data.title || query,
      snippet: data.extract,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title || query)}`
    }
  ];
}

/**
 * DuckDuckGo fallback
 */
async function fetchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`;
  const data = await safeFetch(url);

  if (!data || !data.RelatedTopics) return [];

  return data.RelatedTopics
    .filter(r => r.Text && r.FirstURL)
    .slice(0, 5)
    .map(r => ({
      title: r.Text,
      snippet: r.Text,
      url: r.FirstURL
    }));
}

/**
 * Google / SerpAPI search
 */
async function fetchGoogle(query) {
  const apiKey = CONFIG.SERPAPI_KEY;
  if (!apiKey) return []; // graceful fallback

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${apiKey}`;
  const data = await safeFetch(url);

  if (!data || !data.organic_results) return [];

  return data.organic_results.slice(0, 5).map(r => ({
    title: r.title || query,
    snippet: r.snippet || "",
    url: r.link || ""
  }));
}

/**
 * Main search tool
 */
export async function search(query) {
  const topic = normalizeQuery(query);

  // Load cache
  const cache = loadJSON(CACHE_FILE, {});
  if (cache[topic]) {
    return {
      tool: "search",
      success: true,
      final: true,
      data: cache[topic]
    };
  }

  // Fetch from all providers
  const [wiki, ddg, google] = await Promise.all([
    fetchWikipedia(query),
    fetchDuckDuckGo(query),
    fetchGoogle(query) // now uses CONFIG internally
  ]);

  const results = [...wiki, ...ddg, ...google];

  // Build summary text
  const summary = results
    .map(r => `${r.title}: ${r.snippet}`)
    .join("\n");

  const data = {
    results,
    text: summary || "No results found."
  };

  // Cache it
  cache[topic] = data;
  saveJSON(CACHE_FILE, cache);

  return {
    tool: "search",
    success: true,
    final: true,
    data
  };
}
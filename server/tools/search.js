// server/tools/search.js
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import { loadJSON, saveJSON } from "../memory.js";

const CACHE_FILE = "./search_cache.json";

function extractTopic(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

async function fetchWikipedia(query) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
  const data = await safeFetch(url);
  if (data?.extract) {
    return [{
      title: data.title,
      snippet: data.extract,
      url: `https://en.wikipedia.org/wiki/${data.title}`
    }];
  }
  return [];
}

async function fetchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`;
  const data = await safeFetch(url);

  if (!data?.RelatedTopics) return [];

  return data.RelatedTopics.slice(0, 5)
    .filter(r => r.Text && r.FirstURL)
    .map(r => ({
      title: r.Text,
      snippet: r.Text,
      url: r.FirstURL
    }));
}

async function fetchGoogle(query) {
  if (!CONFIG.SERPAPI_KEY) return [];

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${CONFIG.SERPAPI_KEY}`;
  const data = await safeFetch(url);

  if (!data?.organic_results) return [];

  return data.organic_results.slice(0, 5).map(r => ({
    title: r.title,
    snippet: r.snippet || "",
    url: r.link
  }));
}

export async function search(query) {
  const cache = loadJSON(CACHE_FILE, {});
  const topic = extractTopic(query);

  if (cache[topic]) {
    return {
      tool: "search",
      success: true,
      final: true,
      data: cache[topic]
    };
  }

  const [wiki, ddg, google] = await Promise.all([
    fetchWikipedia(query),
    fetchDuckDuckGo(query),
    fetchGoogle(query)
  ]);

  const results = [...wiki, ...ddg, ...google];

  const summary = results.map(r => `${r.title}: ${r.snippet}`).join("\n");

  const data = { results, text: summary };

  cache[topic] = data;
  saveJSON(CACHE_FILE, cache);

  return {
    tool: "search",
    success: true,
    final: true,
    data
  };
}

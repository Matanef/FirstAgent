import fetch from "node-fetch";
import { loadJSON, saveJSON, extractTopic } from "./helpers.js";

const SERPAPI_KEY = "7e508cfd2dd8eb17a672aaf920f25515be156a56ea2a043c8cae9f358c273418";
const SEARCH_CACHE_FILE = "./search_cache.json";

export function calculator(expr) {
  try {
    return { result: Function(`"use strict";return(${expr})`)() };
  } catch {
    return { error: "Invalid math expression" };
  }
}

export async function searchWeb(query, forceRefresh = false) {
  const cache = loadJSON(SEARCH_CACHE_FILE, {});
  const topic = extractTopic(query);

  if (!forceRefresh && cache[topic]) {
    return { cached: true, results: cache[topic].results };
  }

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(topic)}&api_key=${SERPAPI_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const results =
    data.organic_results?.slice(0, 5).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link
    })) || [];

  cache[topic] = { timestamp: Date.now(), results };
  saveJSON(SEARCH_CACHE_FILE, cache);

  return { cached: false, results };
}

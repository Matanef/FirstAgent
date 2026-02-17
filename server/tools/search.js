// server/tools/search-enhanced.js
// Enhanced search with better aggregation, deduplication, and relevance scoring

import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import { loadJSON, saveJSON } from "../memory.js";

const CACHE_FILE = "./search_cache.json";
const CACHE_TTL = 3600000; // 1 hour

/**
 * Normalize query for caching and comparison
 */
function normalizeQuery(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate similarity between two strings (simple Jaccard similarity)
 */
function calculateSimilarity(str1, str2) {
  const set1 = new Set(str1.toLowerCase().split(/\s+/));
  const set2 = new Set(str2.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/**
 * Deduplicate results based on URL and content similarity
 */
function deduplicateResults(results) {
  const seen = new Set();
  const deduplicated = [];

  for (const result of results) {
    // Check URL
    if (seen.has(result.url)) continue;
    
    // Check content similarity with existing results
    const isDuplicate = deduplicated.some(existing => {
      const titleSim = calculateSimilarity(result.title, existing.title);
      const snippetSim = calculateSimilarity(result.snippet, existing.snippet);
      return titleSim > 0.8 || snippetSim > 0.9;
    });

    if (!isDuplicate) {
      seen.add(result.url);
      deduplicated.push(result);
    }
  }

  return deduplicated;
}

/**
 * Score relevance of a result to the query
 */
function scoreRelevance(result, query) {
  const queryTerms = query.toLowerCase().split(/\s+/);
  const titleLower = result.title.toLowerCase();
  const snippetLower = result.snippet.toLowerCase();
  
  let score = 0;
  
  // Title matches are worth more
  for (const term of queryTerms) {
    if (titleLower.includes(term)) score += 3;
    if (snippetLower.includes(term)) score += 1;
  }
  
  // Exact phrase match bonus
  if (titleLower.includes(query.toLowerCase())) score += 10;
  if (snippetLower.includes(query.toLowerCase())) score += 5;
  
  // Source credibility bonus
  const credibleDomains = [
    'wikipedia.org', 'britannica.com', 'edu', 'gov',
    'reuters.com', 'bbc.com', 'cnn.com', 'nytimes.com'
  ];
  
  if (credibleDomains.some(domain => result.url.includes(domain))) {
    score += 2;
  }
  
  return score;
}

/**
 * Wikipedia summary fetch
 */
async function fetchWikipedia(query) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const data = await safeFetch(url);

    if (!data || !data.extract) return [];

    return [
      {
        title: data.title || query,
        snippet: data.extract,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title || query)}`,
        source: "Wikipedia"
      }
    ];
  } catch (err) {
    console.warn("Wikipedia fetch failed:", err.message);
    return [];
  }
}

/**
 * DuckDuckGo Instant Answer API
 */
async function fetchDuckDuckGo(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`;
    const data = await safeFetch(url);

    if (!data || !data.RelatedTopics) return [];

    const results = data.RelatedTopics
      .filter(r => r.Text && r.FirstURL)
      .slice(0, 5)
      .map(r => ({
        title: r.Text.split(" - ")[0] || r.Text,
        snippet: r.Text,
        url: r.FirstURL,
        source: "DuckDuckGo"
      }));
    
    // Add abstract if available
    if (data.Abstract && data.AbstractURL) {
      results.unshift({
        title: data.Heading || query,
        snippet: data.Abstract,
        url: data.AbstractURL,
        source: "DuckDuckGo"
      });
    }

    return results;
  } catch (err) {
    console.warn("DuckDuckGo fetch failed:", err.message);
    return [];
  }
}

/**
 * Google / SerpAPI search
 */
async function fetchGoogle(query) {
  try {
    const apiKey = CONFIG.SERPAPI_KEY;
    if (!apiKey) {
      console.warn("SerpAPI key not configured");
      return [];
    }

    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${apiKey}&num=10`;
    const data = await safeFetch(url);

    if (!data || !data.organic_results) return [];

    return data.organic_results.slice(0, 10).map(r => ({
      title: r.title || query,
      snippet: r.snippet || "",
      url: r.link || "",
      source: "Google"
    }));
  } catch (err) {
    console.warn("Google/SerpAPI fetch failed:", err.message);
    return [];
  }
}

/**
 * Enhanced search with intelligent aggregation
 */
export async function search(query) {
  console.log("🔍 Search query:", query);
  
  const normalizedQuery = normalizeQuery(query);

  // Check cache
  const cache = loadJSON(CACHE_FILE, {});
  const cached = cache[normalizedQuery];
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log("📦 Using cached result");
    return {
      tool: "search",
      success: true,
      final: true,
      data: cached.data,
      reasoning: "Retrieved from cache"
    };
  }

  // Fetch from multiple sources in parallel
  console.log("🌐 Fetching from multiple sources...");
  const [wiki, ddg, google] = await Promise.all([
    fetchWikipedia(query),
    fetchDuckDuckGo(query),
    fetchGoogle(query)
  ]);

  console.log(`📊 Results: Wikipedia(${wiki.length}), DuckDuckGo(${ddg.length}), Google(${google.length})`);

  // Combine and deduplicate
  let allResults = [...wiki, ...ddg, ...google];
  allResults = deduplicateResults(allResults);

  // Score and sort by relevance
  allResults.forEach(result => {
    result.relevanceScore = scoreRelevance(result, query);
  });

  allResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Take top results
  const topResults = allResults.slice(0, 8);

  // Generate summary text
  const summary = topResults.length > 0
    ? topResults
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   Source: ${r.source} | ${r.url}`)
        .join("\n\n")
    : "No reliable results were found for this query from the sources I checked.";

  const data = {
    results: topResults,
    text: summary,
    totalSources: [wiki, ddg, google].filter(arr => arr.length > 0).length,
    query: query,
    normalizedQuery: normalizedQuery
  };

  // Cache the result
  cache[normalizedQuery] = {
    data,
    timestamp: Date.now()
  };
  saveJSON(CACHE_FILE, cache);

  console.log(`✅ Returning ${topResults.length} deduplicated results`);

  return {
    tool: "search",
    success: true,
    final: true,
    data,
    reasoning: `Searched ${data.totalSources} sources, found ${topResults.length} relevant results`
  };
}

/**
 * Export topic extraction for compatibility
 */
export function extractTopic(text) {
  return normalizeQuery(text);
}

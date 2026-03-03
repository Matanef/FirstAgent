// server/tools/search.js (ENHANCED - Yandex + LLM synthesis)
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import { loadJSON, saveJSON } from "../memory.js";
import { llm } from "./llm.js";

const CACHE_FILE = "./search_cache.json";
const CACHE_TTL = 3600000; // 1 hour

function normalizeQuery(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateSimilarity(str1, str2) {
  const set1 = new Set(str1.toLowerCase().split(/\s+/));
  const set2 = new Set(str2.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

function deduplicateResults(results) {
  const seen = new Set();
  const deduplicated = [];

  for (const result of results) {
    if (seen.has(result.url)) continue;
    
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

function scoreRelevance(result, query) {
  const queryTerms = query.toLowerCase().split(/\s+/);
  const titleLower = result.title.toLowerCase();
  const snippetLower = result.snippet.toLowerCase();
  
  let score = 0;
  
  for (const term of queryTerms) {
    if (titleLower.includes(term)) score += 3;
    if (snippetLower.includes(term)) score += 1;
  }
  
  if (titleLower.includes(query.toLowerCase())) score += 10;
  if (snippetLower.includes(query.toLowerCase())) score += 5;
  
  const credibleDomains = [
    'wikipedia.org', 'britannica.com', 'edu', 'gov',
    'reuters.com', 'bbc.com', 'cnn.com', 'nytimes.com'
  ];
  
  if (credibleDomains.some(domain => result.url.includes(domain))) {
    score += 2;
  }
  
  return score;
}

// Wikipedia summary fetch
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

// DuckDuckGo Instant Answer API
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

// Google / SerpAPI search
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

// NEW: Yandex search via SerpAPI
async function fetchYandex(query) {
  try {
    const apiKey = CONFIG.SERPAPI_KEY;
    if (!apiKey) {
      console.warn("SerpAPI key not configured for Yandex");
      return [];
    }

    const url = `https://serpapi.com/search.json?engine=yandex&text=${encodeURIComponent(query)}&api_key=${apiKey}`;
    const data = await safeFetch(url);

    if (!data || !data.organic_results) return [];

    return data.organic_results.slice(0, 8).map(r => ({
      title: r.title || query,
      snippet: r.snippet || r.description || "",
      url: r.link || "",
      source: "Yandex"
    }));
  } catch (err) {
    console.warn("Yandex/SerpAPI fetch failed:", err.message);
    return [];
  }
}

// LLM-powered synthesis: generate a coherent answer from search results
async function synthesizeSearchSummary(query, topResults) {
  if (topResults.length === 0) return null;

  const context = topResults.slice(0, 5).map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.source}`
  ).join('\n\n');

  const prompt = `Based on these search results, provide a concise, informative summary answering the query: "${query}"

Search Results:
${context}

Instructions:
- Synthesize information from multiple sources into a coherent 3-5 sentence answer
- Be factual and reference which sources the information comes from
- If the results don't contain enough information, say so
- Do NOT make up facts not present in the search results

Summary:`;

  try {
    const result = await llm(prompt);
    if (result.success && result.data?.text) {
      return result.data.text.trim();
    }
    return null;
  } catch (err) {
    console.warn("Search synthesis failed:", err.message);
    return null;
  }
}

// Enhanced search with 4 sources including Yandex + LLM synthesis
export async function search(query) {
  console.log("🔎 Search query:", query);
  
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

  // Fetch from FOUR sources in parallel (Wikipedia, DuckDuckGo, Google, Yandex)
  console.log("🌐 Fetching from 4 sources (Wikipedia, DuckDuckGo, Google, Yandex)...");
  const [wiki, ddg, google, yandex] = await Promise.all([
    fetchWikipedia(query),
    fetchDuckDuckGo(query),
    fetchGoogle(query),
    fetchYandex(query)
  ]);

  console.log(`📊 Results: Wikipedia(${wiki.length}), DuckDuckGo(${ddg.length}), Google(${google.length}), Yandex(${yandex.length})`);

  // Combine and deduplicate
  let allResults = [...wiki, ...ddg, ...google, ...yandex];
  allResults = deduplicateResults(allResults);

  // Score and sort by relevance
  allResults.forEach(result => {
    result.relevanceScore = scoreRelevance(result, query);
  });

  allResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Take top results
  const topResults = allResults.slice(0, 10);

  // Generate raw summary text
  const summary = topResults.length > 0
    ? topResults
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   Source: ${r.source} | ${r.url}`)
        .join("\n\n")
    : "No reliable results were found for this query from the sources I checked.";

  // LLM synthesis: generate a coherent answer from top results
  console.log("🧠 Synthesizing search results with LLM...");
  const synthesis = await synthesizeSearchSummary(query, topResults);

  const data = {
    results: topResults,
    synthesis,  // LLM-generated coherent summary
    text: synthesis ? `${synthesis}\n\n---\n\n${summary}` : summary,
    totalSources: [wiki, ddg, google, yandex].filter(arr => arr.length > 0).length,
    query: query,
    normalizedQuery: normalizedQuery
  };

  // Cache the result
  cache[normalizedQuery] = {
    data,
    timestamp: Date.now()
  };
  saveJSON(CACHE_FILE, cache);

  console.log(`✅ Returning ${topResults.length} deduplicated results from ${data.totalSources} sources`);

  return {
    tool: "search",
    success: true,
    final: true,
    data,
    reasoning: `Searched ${data.totalSources} sources (Wikipedia, DuckDuckGo, Google, Yandex), found ${topResults.length} relevant results`
  };
}

export function extractTopic(text) {
  return normalizeQuery(text);
}

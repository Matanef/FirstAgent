// server/tools/githubScanner.js
// GitHub intelligence scanner — trending repos, pattern extraction, tool discovery
// Scans GitHub for code patterns, best practices, and potential improvements

import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";
import { llm } from "./llm.js";

const GITHUB_API = "https://api.github.com";

/**
 * Get auth headers for GitHub API
 */
function getHeaders() {
  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "LocalLLM-Agent"
  };
  if (CONFIG.GITHUB_TOKEN) {
    headers["Authorization"] = `token ${CONFIG.GITHUB_TOKEN}`;
  }
  return headers;
}

/**
 * Search GitHub repositories by topic/keyword
 */
async function searchRepos(query, language = "", sort = "stars", perPage = 10) {
  let q = query;
  if (language) q += ` language:${language}`;

  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${perPage}`;

  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) throw new Error(`GitHub API: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return (data.items || []).map(repo => ({
      name: repo.full_name,
      description: repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      language: repo.language,
      url: repo.html_url,
      topics: repo.topics || [],
      updated: repo.updated_at,
      license: repo.license?.spdx_id || "none"
    }));
  } catch (err) {
    return [{ error: err.message }];
  }
}

/**
 * Get trending topics from GitHub
 */
async function getTrending(language = "javascript", since = "weekly") {
  // Use GitHub search API with date filter as proxy for trending
  const dateFilter = since === "daily" ? 1 : since === "monthly" ? 30 : 7;
  const date = new Date();
  date.setDate(date.getDate() - dateFilter);
  const dateStr = date.toISOString().split("T")[0];

  const q = `created:>${dateStr} language:${language}`;
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=15`;

  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
    const data = await res.json();
    return (data.items || []).map(repo => ({
      name: repo.full_name,
      description: repo.description,
      stars: repo.stargazers_count,
      language: repo.language,
      url: repo.html_url,
      topics: repo.topics || [],
      created: repo.created_at
    }));
  } catch (err) {
    return [{ error: err.message }];
  }
}

/**
 * Search for code patterns on GitHub
 */
async function searchCode(query, language = "javascript", perPage = 10) {
  const q = `${query} language:${language}`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}`;

  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
    const data = await res.json();
    return (data.items || []).map(item => ({
      file: item.name,
      path: item.path,
      repo: item.repository?.full_name,
      url: item.html_url,
      score: item.score
    }));
  } catch (err) {
    return [{ error: err.message }];
  }
}

/**
 * Get a repo's README content
 */
async function getReadme(repoFullName) {
  const url = `${GITHUB_API}/repos/${repoFullName}/readme`;
  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const content = Buffer.from(data.content || "", "base64").toString("utf8");
    return content.slice(0, 5000); // Limit size
  } catch { return null; }
}

/**
 * Analyze repos for patterns relevant to our agent
 */
async function analyzeForImprovements(repos, projectContext) {
  const repoSummaries = repos
    .filter(r => !r.error)
    .slice(0, 8)
    .map(r => `- ${r.name} (⭐${r.stars}): ${r.description || "no description"}\n  Topics: ${(r.topics || []).join(", ")}\n  URL: ${r.url}`)
    .join("\n\n");

const promptConfig = CONFIG.PROMPT || `You are an AI agent improvement advisor. Analyze these trending GitHub repositories and extract patterns, tools, or techniques that could improve an AI agent system.

Our agent's current capabilities:
${projectContext || "Multi-tool AI agent with: web search, file management, code review, scheduling, memory, weather, finance, sports, news, email, git integration, and self-improvement capabilities."}

Trending/relevant repositories:
${repoSummaries}

Provide:
1. **NEW TOOL IDEAS** — Tools we could add inspired by these repos (be specific about what they would do)
2. **PATTERN IMPROVEMENTS** — Coding patterns or architectures we could adopt
3. **LIBRARY SUGGESTIONS** — npm packages worth integrating
4. **PRIORITY RANKING** — Rank the top 5 improvements by impact

Be practical and specific. Focus on improvements that make the agent smarter, more reliable, or more capable.`;

try {
    const response = await llm(promptConfig);
    return response?.data?.text || "Analysis failed.";
  } catch (err) {
    return `Analysis error: ${err.message}`;
  }
}

/**
 * Scan for tools similar to a given query
 */
async function discoverTools(query) {
  const searchTerms = [
    `${query} tool agent`,
    `${query} automation bot`,
    `${query} api wrapper`
  ];

  const allRepos = [];
  for (const term of searchTerms) {
    const repos = await searchRepos(term, "javascript", "stars", 5);
    allRepos.push(...repos.filter(r => !r.error));
  }

  // Deduplicate
  const seen = new Set();
  const unique = allRepos.filter(r => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });

  return unique.sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 15);
}

/**
 * Detect intent from text
 */
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(trending|popular|hot|new)\b/.test(lower)) return "trending";
  if (/\b(discover|find|search)\s+(tool|librar|package)/i.test(lower)) return "discover";
  if (/\b(pattern|practice|technique|approach)/i.test(lower)) return "patterns";
  if (/\b(improve|upgrade|evolve|enhance)\b/.test(lower)) return "improve";
  if (/\b(compare|benchmark|alternative)/i.test(lower)) return "compare";
  return "scan";
}

/**
 * Main entry point
 */
export async function githubScanner(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "githubScanner",
      success: false,
      final: true,
      data: { message: "Please specify what to scan for. Example: 'scan GitHub for AI agent tools' or 'find trending JavaScript repos'" }
    };
  }

  const intent = context.action || detectIntent(text);

  try {
    switch (intent) {
      case "trending": {
        const language = /\b(python|typescript|rust|go|java)\b/i.exec(text)?.[1]?.toLowerCase() || "javascript";
        const since = /\b(daily|monthly)\b/i.exec(text)?.[1]?.toLowerCase() || "weekly";
        const repos = await getTrending(language, since);

        if (repos.length === 0 || repos[0]?.error) {
          return { tool: "githubScanner", success: false, final: true, data: { message: `Could not fetch trending repos: ${repos[0]?.error || "no results"}` } };
        }

        let output = `🔥 **Trending ${language} Repos (${since})**\n\n`;
        for (const r of repos) {
          output += `⭐ **${r.name}** (${r.stars} stars)\n`;
          output += `  ${r.description || "No description"}\n`;
          if (r.topics?.length > 0) output += `  Topics: ${r.topics.slice(0, 5).join(", ")}\n`;
          output += `  ${r.url}\n\n`;
        }

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: { preformatted: true, text: output, repos }
        };
      }

      case "discover": {
        const query = text.replace(/.*(?:discover|find|search)\s+/i, "").replace(/\b(tool|library|package)s?\b/gi, "").trim() || "ai agent";
        const repos = await discoverTools(query);

        let output = `🔍 **Tool Discovery: "${query}"**\n\n`;
        for (const r of repos) {
          output += `📦 **${r.name}** (⭐${r.stars})\n`;
          output += `  ${r.description || "No description"}\n`;
          output += `  ${r.url}\n\n`;
        }

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: { preformatted: true, text: output, repos }
        };
      }

      case "patterns": {
        const query = text.replace(/.*(?:pattern|practice|technique|approach)s?\s*/i, "").trim() || "best practices";
        const codeResults = await searchCode(query, "javascript", 10);
        const repos = await searchRepos(query + " best practices", "javascript", "stars", 5);

        let output = `📐 **Code Patterns: "${query}"**\n\n`;

        if (repos.filter(r => !r.error).length > 0) {
          output += `**Reference Repositories:**\n`;
          for (const r of repos.filter(r => !r.error)) {
            output += `  ⭐ ${r.name} (${r.stars} stars) — ${r.description || ""}\n`;
          }
          output += "\n";
        }

        if (codeResults.filter(r => !r.error).length > 0) {
          output += `**Code Examples:**\n`;
          for (const c of codeResults.filter(r => !r.error)) {
            output += `  📄 ${c.repo}/${c.path}\n     ${c.url}\n`;
          }
        }

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: { preformatted: true, text: output, codeResults, repos }
        };
      }

      case "improve":
      case "scan":
      default: {
        // Full scan: trending + relevant repos + AI analysis
        const query = text.replace(/.*(?:scan|improve|upgrade|enhance|evolve)\s*/i, "").replace(/\b(github|for|my|agent|code|project)\b/gi, "").trim() || "ai agent tools";

        const [trending, searchResults] = await Promise.all([
          getTrending("javascript", "weekly"),
          searchRepos(query, "javascript", "stars", 10)
        ]);

        const allRepos = [...trending.filter(r => !r.error), ...searchResults.filter(r => !r.error)];

        // Deduplicate
        const seen = new Set();
        const uniqueRepos = allRepos.filter(r => {
          if (seen.has(r.name)) return false;
          seen.add(r.name);
          return true;
        }).slice(0, 15);

        // AI analysis
        const analysis = await analyzeForImprovements(uniqueRepos);

        let output = `🤖 **GitHub Intelligence Scan**\n\n`;
        output += `Scanned ${uniqueRepos.length} repos for: "${query}"\n\n`;

        output += `**Top Repos Found:**\n`;
        for (const r of uniqueRepos.slice(0, 10)) {
          output += `  ⭐ ${r.name} (${r.stars} stars) — ${(r.description || "").slice(0, 80)}\n`;
        }
        output += "\n";

        output += `**AI Analysis & Recommendations:**\n\n${analysis}`;

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: output,
            repos: uniqueRepos,
            analysis
          }
        };
      }
    }
  } catch (err) {
    return {
      tool: "githubScanner",
      success: false,
      final: true,
      data: { message: `GitHub scanner error: ${err.message}` }
    };
  }
}

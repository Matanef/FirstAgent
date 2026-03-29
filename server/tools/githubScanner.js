// server/tools/githubScanner.js
// GitHub intelligence scanner — trending repos, pattern extraction, tool discovery, and specific repo analysis
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

// ============================================================================
// UI HELPER: Generates matching HTML widgets for the dashboard
// ============================================================================
function generateScannerHTML(title, analysisHtml, repos = [], codeResults = []) {
    let html = `
        <div class="ai-scanner-results" style="font-family: -apple-system, sans-serif; color: #e7e9ea;">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                <span style="font-size: 24px;">🔍</span>
                <h3 style="margin: 0; color: #e7e9ea;">${title}</h3>
            </div>`;

    if (analysisHtml) {
        html += `
            <div style="margin-bottom: 20px; padding: 15px; background: #192734; border-radius: 8px; border: 1px solid #38444d; font-size: 14px; line-height: 1.6;">
                ${analysisHtml.replace(/\n/g, '<br>')}
            </div>`;
    }

if (repos && repos.length > 0) {
        html += `
            <div style="max-height: 300px; overflow-y: auto; border: 1px solid #38444d; border-radius: 8px; background: #15202b; margin-bottom: ${codeResults.length ? '15px' : '0'};">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="position: sticky; top: 0; background: #192734; z-index: 1; box-shadow: inset 0 -1px 0 #38444d;">
                        <tr style="text-align: left; color: #8b98a5;">
                            <th style="padding: 12px 10px; border-bottom: 1px solid #38444d;">Repository</th>
                            <th style="padding: 12px 10px; border-bottom: 1px solid #38444d;">Stars</th>
                            <th style="padding: 12px 10px; border-bottom: 1px solid #38444d; text-align: center;">Link</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${repos.map(r => `
                        <tr>
                            <td style="padding: 12px 10px; border-bottom: 1px solid #38444d;">
                                <strong style="color: #1d9bf0;">${r.name}</strong><br/>
                                <small style="color: #8b98a5;">${(r.description || 'No description').slice(0, 100)}...</small>
                            </td>
                            <td style="padding: 12px 10px; border-bottom: 1px solid #38444d; font-weight: bold; color: #ffa726;">
                                ${(r.stars || 0).toLocaleString()} ⭐
                            </td>
                            <td style="padding: 12px 10px; border-bottom: 1px solid #38444d; text-align: center;">
                                <a href="${r.url || r.html_url}" target="_blank" style="padding: 4px 12px; background: #00ba7c; color: white; text-decoration: none; border-radius: 9999px; font-size: 11px; font-weight: bold;">View</a>
                            </td>
                        </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    if (codeResults && codeResults.length > 0) {
        html += `
            <div style="max-height: 300px; overflow-y: auto; border: 1px solid #38444d; border-radius: 8px; background: #15202b;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="position: sticky; top: 0; background: #192734; z-index: 1;">
                        <tr style="text-align: left; color: #8b98a5;">
                            <th style="padding: 12px 10px; border-bottom: 1px solid #38444d;">Code Examples Found</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${codeResults.map(c => `
                        <tr>
                            <td style="padding: 12px 10px; border-bottom: 1px solid #38444d;">
                                <a href="${c.url}" target="_blank" style="color: #1d9bf0; text-decoration: none; font-weight: bold;">📄 ${c.repo}/${c.path}</a>
                            </td>
                        </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    html += `</div>`;
    return html;
}

// ============================================================================
// GITHUB API FETCHERS
// ============================================================================

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

async function getTrending(language = "javascript", since = "weekly") {
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

async function getRepoDetails(repoFullName) {
  const url = `${GITHUB_API}/repos/${repoFullName}`;
  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function getReadme(repoFullName) {
  const url = `${GITHUB_API}/repos/${repoFullName}/readme`;
  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const content = Buffer.from(data.content || "", "base64").toString("utf8");
    return content.slice(0, 5000); // Limit size for context window
  } catch { return null; }
}

// ============================================================================
// ANALYSIS & DISCOVERY LOGIC
// ============================================================================

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

function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(trending|popular|hot|new)\b/.test(lower)) return "trending";
  if (/\b(discover|find|search)\s+(tool|librar|package)/i.test(lower)) return "discover";
  if (/\b(pattern|practice|technique|approach)/i.test(lower)) return "patterns";
  if (/\b(improve|upgrade|evolve|enhance)\b/.test(lower)) return "improve";
  if (/\b(compare|benchmark|alternative)/i.test(lower)) return "compare";
  return "scan";
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

export async function githubScanner(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "githubScanner",
      success: false,
      final: true,
      data: { message: "Please specify what to scan for. Example: 'scan GitHub for AI agent tools' or 'scan openclaw/openclaw'" }
    };
  }

  // 1. Check for a specific repository pattern (owner/repo)
  let intent = context.action || detectIntent(text);
  let specificRepo = null;
  const repoMatch = text.match(/\b([a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+)\b/);
  
  if (repoMatch && !['github.com/search', 'github.com/trending'].includes(repoMatch[1])) {
    specificRepo = repoMatch[1];
    intent = "specific_repo";
  }

  try {
    switch (intent) {
      // ----------------------------------------------------------------------
      // NEW: SPECIFIC REPOSITORY SCAN (e.g., "scan openclaw/openclaw")
      // ----------------------------------------------------------------------
      case "specific_repo": {
        console.log(`[githubScanner] Scanning specific repo: ${specificRepo}`);
        const detail = await getRepoDetails(specificRepo);
        
        if (!detail) {
            return { tool: "githubScanner", success: false, final: true, data: { message: `Could not find repository ${specificRepo}` } };
        }

        const readme = await getReadme(specificRepo);
        const repoObj = {
            name: detail.full_name,
            description: detail.description,
            stars: detail.stargazers_count,
            url: detail.html_url,
            readme: readme
        };

const prompt = `You are a ruthless technical architect. Analyze this specific GitHub repository's README and description. 
        
REPO: ${repoObj.name}
DESC: ${repoObj.description}
README: ${repoObj.readme || 'N/A'}
        
Extract EXACTLY 3 technical concepts, architectures, or features from THIS specific repository that we can adapt for our Local AI Agent. 

CRITICAL RULES:
1. DO NOT give generic advice (e.g., "use microservices", "improve NLP", "add caching"). 
2. You MUST cite the specific feature from the README that inspired your suggestion. 
3. If the repo is not relevant to an AI agent, explain what the repo actually does and suggest one crazy, outside-the-box way to integrate it anyway.

Format your response clearly with:
1. EXTRACTED CONCEPTS
2. INTEGRATION PLAN
3. PRIORITY`;

        const response = await llm(prompt);
        const analysis = response?.data?.text || "Analysis complete.";
        
        const html = generateScannerHTML(`Intelligence: ${repoObj.name}`, `<h4 style="margin-top: 0; color: #1d9bf0;">Repository Analysis</h4>\n${analysis}`, [repoObj]);

        return {
            tool: "githubScanner",
            success: true,
            final: true,
            data: { text: analysis, html: html, preformatted: true, repos: [repoObj] }
        };
      }

      // ----------------------------------------------------------------------
      // TRENDING REPOS
      // ----------------------------------------------------------------------
      case "trending": {
        const language = /\b(python|typescript|rust|go|java)\b/i.exec(text)?.[1]?.toLowerCase() || "javascript";
        const since = /\b(daily|monthly)\b/i.exec(text)?.[1]?.toLowerCase() || "weekly";
        const repos = await getTrending(language, since);

        if (repos.length === 0 || repos[0]?.error) {
          return { tool: "githubScanner", success: false, final: true, data: { message: `Could not fetch trending repos: ${repos[0]?.error || "no results"}` } };
        }

        let output = `🔥 **Trending ${language} Repos (${since})**\n\n`;
        for (const r of repos) {
          output += `⭐ **${r.name}** (${r.stars} stars)\n  ${r.description || "No description"}\n  ${r.url}\n\n`;
        }

        const html = generateScannerHTML(`Trending ${language} (${since})`, null, repos);

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: { preformatted: true, text: output, html: html, repos }
        };
      }

      // ----------------------------------------------------------------------
      // TOOL DISCOVERY
      // ----------------------------------------------------------------------
      case "discover": {
        const query = text.replace(/.*(?:discover|find|search)\s+/i, "").replace(/\b(tool|library|package)s?\b/gi, "").trim() || "ai agent";
        const repos = await discoverTools(query);

        let output = `🔍 **Tool Discovery: "${query}"**\n\n`;
        for (const r of repos) {
          output += `📦 **${r.name}** (⭐${r.stars})\n  ${r.description || "No description"}\n  ${r.url}\n\n`;
        }
        
        const html = generateScannerHTML(`Tool Discovery: "${query}"`, null, repos);

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: { preformatted: true, text: output, html: html, repos }
        };
      }

      // ----------------------------------------------------------------------
      // CODE PATTERNS
      // ----------------------------------------------------------------------
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
        }
        
        const html = generateScannerHTML(`Code Patterns: "${query}"`, null, repos.filter(r => !r.error), codeResults.filter(r => !r.error));

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: { preformatted: true, text: output, html: html, codeResults, repos }
        };
      }

      // ----------------------------------------------------------------------
      // IMPROVE / SCAN (GENERAL INTELLIGENCE)
      // ----------------------------------------------------------------------
      case "improve":
      case "scan":
      default: {
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

        let output = `🤖 **GitHub Intelligence Scan**\n\nScanned ${uniqueRepos.length} repos for: "${query}"\n\n`;
        output += `**Top Repos Found:**\n`;
        for (const r of uniqueRepos.slice(0, 10)) {
          output += `  ⭐ ${r.name} (${r.stars} stars) — ${(r.description || "").slice(0, 80)}\n`;
        }
        output += `\n**AI Analysis & Recommendations:**\n\n${analysis}`;

        const html = generateScannerHTML(`General Intelligence: "${query}"`, `<h4 style="margin-top: 0; color: #1d9bf0;">AI Recommendations</h4>\n${analysis}`, uniqueRepos);

        return {
          tool: "githubScanner",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: output,
            html: html,
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
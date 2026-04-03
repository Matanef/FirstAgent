// server/tools/githubTrending.js
import fetch from "node-fetch";

/**
 * githubTrending Tool
 * Fetches the current trending repositories from GitHub.
 */

// server/tools/githubTrending.js

// Add this helper function at the top or bottom of the file
function generateTrendingHTML(repos, topic) {
    return `
        <div class="ai-trending-results" style="font-family: -apple-system, sans-serif; color: #e7e9ea;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 24px;">🔥</span>
                    <h3 style="margin: 0; color: #e7e9ea;">Trending: ${topic || 'GitHub'}</h3>
                </div>
                <input type="text" id="trending-filter" placeholder="Filter repos..." 
                    style="padding: 6px 12px; border: 1px solid #38444d; border-radius: 6px; font-size: 12px; width: 180px; background: #0f1419; color: #e7e9ea;" />
            </div>
            <div style="max-height: 400px; overflow-y: auto; border: 1px solid #38444d; border-radius: 8px; background: #15202b;">
                <table id="trending-table" style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="position: sticky; top: 0; background: #192734; z-index: 1; box-shadow: inset 0 -1px 0 #38444d;">
                        <tr style="text-align: left; color: #8b98a5;">
                            <th style="padding: 12px 10px; border-bottom: 1px solid #38444d;">Repository</th>
                            <th style="padding: 12px 10px; border-bottom: 1px solid #38444d;">Stars</th>
                            <th style="padding: 12px 10px; border-bottom: 1px solid #38444d; text-align: center;">Link</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${repos.map(r => `
                            <tr class="trending-row">
                                <td style="padding: 12px 10px; border-bottom: 1px solid #38444d;">
                                    <strong style="color: #1d9bf0;">${r.name}</strong><br/>
                                    <small style="color: #8b98a5;">${r.description || 'No description'}</small>
                                </td>
                                <td style="padding: 12px 10px; border-bottom: 1px solid #38444d; font-weight: bold; color: #ffa726;">
                                    ${r.stars.toLocaleString()} ⭐
                                </td>
                                <td style="padding: 12px 10px; border-bottom: 1px solid #38444d; text-align: center;">
                                    <a href="${r.url}" target="_blank" style="padding: 4px 12px; background: #00ba7c; color: white; text-decoration: none; border-radius: 9999px; font-size: 11px; font-weight: bold;">View</a>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}



export async function githubTrending(request) {
    try {
        const query = typeof request === 'string' ? request : (request?.text || "");
        const context = typeof request === 'object' ? (request?.context || {}) : {};
        
        // Use the limit from context (passed by planner) or extract from text
        const countMatch = query.match(/\b(\d+)\b/);
        const limit = context.limit || (countMatch ? parseInt(countMatch[1]) : 15);

        if (query && query.trim()) {
            // Clean the query: strip common routing prefixes and noise words
            let cleanQuery = query
                .replace(/^.*?\b(show|list|find|get|search|display|fetch|scan|the)\s+/i, "")
                .replace(/\b(trending|on\s+github|github|repos?|repositories?|popular|top|open\s*source|frameworks?|libraries?|projects?)\b/gi, "")
                .replace(/\b(the|a|an|some|all|current)\b/gi, "") // <-- ADD THIS to globally remove articles
                .replace(/\b(\d+|first|last|top)\b/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();
            if (cleanQuery.length < 2) cleanQuery = query.trim(); // fallback to original if over-stripped

            console.log(`🔍 Searching GitHub for trending topic: ${cleanQuery} (raw: ${query})...`);
            // Use GitHub Search API (publicly accessible for simple GET)
            const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(cleanQuery)}+stars:>100&sort=stars&order=desc&per_page=${limit}`;
            const response = await fetch(searchUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });
            const data = await response.json();
            const repos = (data.items || []).slice(0, limit).map(repo => {
                if (!repo) return null;
                return {
                    name: repo.full_name,
                    url: repo.html_url,
                    description: repo.description,
                    stars: repo.stargazers_count
                };
}).filter(repo => repo !== null);

            return {
                tool: "githubTrending",
                success: true,
                final: true,
                data: {
                    count: repos.length,
                    repositories: repos,
                    topic: cleanQuery,
                    timestamp: new Date().toISOString(),
                    html: generateTrendingHTML(repos, cleanQuery),
                    plain: JSON.stringify(repos, null, 2), // <--- THIS FEEDS THE LLM IN STEP 2
                    preformatted: true,
                    text: `I found ${repos.length} trending repositories for "${cleanQuery}". You can review them in the specialized window above.`
                },
                reasoning: `Found ${repos.length} top repositories for topic "${cleanQuery}".`
            };

        }

        return await fetchTrendingRepos('past week');
    } catch (err) {
        console.error("❌ GitHub Trending Error:", err);
        return {
            tool: "githubTrending",
            success: false,
            final: true,
            error: `Failed to fetch trending: ${err.message}`
        };
    }
}

async function fetchTrendingRepos(timeframe) {
    console.log(`🌏 Fetching GitHub Trending via Search API (${timeframe})...`);
    const oneWeekAgo = timeframe === 'past week' ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0] : '';
    const searchUrl = `https://api.github.com/search/repositories?q=stars:>500${oneWeekAgo ? `+pushed:>${oneWeekAgo}` : ''}&sort=stars&order=desc&per_page=15`;
    const response = await fetch(searchUrl, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    
    if (!response.ok) {
        throw new Error(`GitHub API error: HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const repos = (data.items || []).slice(0, 15).map(repo => ({
        name: repo.full_name,
        url: repo.html_url,
        description: repo.description,
        stars: repo.stargazers_count,
        language: repo.language
    }));

    if (repos.length === 0) {
        return {
            tool: "githubTrending",
            success: false,
            error: "No trending repositories found."
        };
    }

    // FIXED: Removed undefined 'cleanQuery' and 'topic' references
    return {
            tool: "githubTrending",
            success: true,
            final: true,
            data: {
                count: repos.length,
                repositories: repos,
                topic: timeframe,
                timestamp: new Date().toISOString(),
                html: generateTrendingHTML(repos, timeframe),
                plain: JSON.stringify(repos, null, 2), // <--- THIS FEEDS THE LLM IN STEP 2
                preformatted: true,
                text: `I found ${repos.length} trending repositories for the ${timeframe}. You can review them in the specialized window above.`
            },
            reasoning: `Found ${repos.length} trending repositories on GitHub.`
        };
}
// server/tools/githubTrending.js
import fetch from "node-fetch";

/**
 * githubTrending Tool
 * Fetches the current trending repositories from GitHub.
 */
export async function githubTrending(request) {
    try {
        const query = typeof request === 'string'
            ? request
            : (request?.text || request?.query);

        if (query && query.trim()) {
            // Clean the query: strip common routing prefixes and noise words
            let cleanQuery = query
                .replace(/^.*?\b(show|list|find|get|search|display|fetch)\s+/i, "")
                .replace(/\b(trending|on\s+github|github|repos?|repositories?|popular|top|open\s*source|frameworks?|libraries?|projects?)\b/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();
            if (cleanQuery.length < 2) cleanQuery = query.trim(); // fallback to original if over-stripped

            console.log(`🔍 Searching GitHub for trending topic: ${cleanQuery} (raw: ${query})...`);
            // Use GitHub Search API (publicly accessible for simple GET)
            const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(cleanQuery)}+stars:>100&sort=stars&order=desc`;
            const response = await fetch(searchUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });
            const data = await response.json();
            const repos = (data.items || []).slice(0, 10).map(repo => ({
                name: repo.full_name,
                url: repo.html_url,
                description: repo.description,
                stars: repo.stargazers_count
            }));

            return {
                tool: "githubTrending",
                success: true,
                final: true,
                data: {
                    count: repos.length,
                    repositories: repos,
                    topic: cleanQuery,
                    timestamp: new Date().toISOString(),
                    preformatted: true,
                    text: `**Trending GitHub Repositories: ${cleanQuery}**\n\n` +
                        repos.map((r, i) => `${i + 1}. **[${r.name}](${r.url})** ⭐ ${r.stars.toLocaleString()}\n   ${r.description || 'No description'}`).join('\n\n')
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

    return {
        tool: "githubTrending",
        success: true,
        final: true,
        data: {
            count: repos.length,
            repositories: repos,
            timestamp: new Date().toISOString(),
            preformatted: true,
            text: `**Trending GitHub Repositories (${timeframe})**\n\n` +
                repos.map((r, i) => `${i + 1}. **[${r.name}](${r.url})** ⭐ ${r.stars.toLocaleString()}${r.language ? ` (${r.language})` : ''}\n   ${r.description || 'No description'}`).join('\n\n')
        },
        reasoning: `Found ${repos.length} trending repositories on GitHub.`
    };
}
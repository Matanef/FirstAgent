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
            console.log(`🔍 Searching GitHub for trending topic: ${query}...`);
            // Use GitHub Search API (publicly accessible for simple GET)
            const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+stars:>100&sort=stars&order=desc`;
            const response = await fetch(searchUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });

            if (!response.ok) {
                // Fallback to trending page if API fails/ratelimited
                console.warn("⚠️ Search API failed, falling back to general trending.");
            } else {
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
                        topic: query,
                        timestamp: new Date().toISOString()
                    },
                    reasoning: `Found ${repos.length} top repositories for topic "${query}".`
                };
            }
        }

        console.log("🌏 Fetching GitHub Trending...");
        const response = await fetch("https://github.com/trending");

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();

        // Extract repo names (e.g., "user/repo")
        // The structure is typically: <h2 class="h3 lh-condensed"> ... <a href="/user/repo">
        const regex = /<h2 class="h3 lh-condensed">[\s\S]*?<a href="\/([a-zA-Z0-9-._]+\/[a-zA-Z0-9-._]+)"/g;
        const repos = [];
        let match;
        const seen = new Set();

        while ((match = regex.exec(html)) !== null && repos.length < 15) {
            const repoPath = match[1];
            // Filter out common non-repo paths if any (usually not an issue with this regex)
            if (!seen.has(repoPath)) {
                repos.push({
                    name: repoPath,
                    url: `https://github.com/${repoPath}`
                });
                seen.add(repoPath);
            }
        }

        if (repos.length === 0) {
            return {
                tool: "githubTrending",
                success: false,
                error: "Failed to parse trending repositories from GitHub."
            };
        }

        return {
            tool: "githubTrending",
            success: true,
            final: true,
            data: {
                count: repos.length,
                repositories: repos,
                timestamp: new Date().toISOString()
            },
            reasoning: `Found ${repos.length} trending repositories on GitHub.`
        };

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

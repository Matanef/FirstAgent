// server/tools/github.js
// COMPLETE FIX #3: GitHub tool with capability testing

import { Octokit } from "@octokit/rest";

let octokitInstance = null;

function getOctokit() {
  if (!octokitInstance) {
    const token = process.env.GITHUB_TOKEN || process.env.GITHUB_API_KEY;
    if (!token) {
      throw new Error("GitHub token not configured. Set GITHUB_TOKEN or GITHUB_API_KEY in .env");
    }
    octokitInstance = new Octokit({ auth: token });
  }
  return octokitInstance;
}

// FIX #3: Handle capability test requests
async function testGitHubAccess() {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.users.getAuthenticated();
    
    return {
      tool: "github",
      success: true,
      final: true,
      data: {
        hasAccess: true,
        username: data.login,
        name: data.name,
        type: data.type,
        message: `✅ Yes, I have GitHub API access!\n\n**Authenticated as:** ${data.login}${data.name ? ` (${data.name})` : ''}\n**Account type:** ${data.type}\n\nI can:\n- List your repositories\n- Create/read issues and PRs\n- Search code and repositories\n- Manage repository settings\n- And more!`
      }
    };
  } catch (err) {
    return {
      tool: "github",
      success: false,
      final: true,
      error: `GitHub API access failed: ${err.message}\n\nPlease check:\n1. GITHUB_TOKEN or GITHUB_API_KEY is set in .env\n2. Token has the necessary permissions\n3. Token is not expired`,
      data: {
        hasAccess: false,
        errorDetails: err.message
      }
    };
  }
}

export async function github(request) {
  try {
    // Extract query type
    const query = typeof request === "string" ? request : request.text || "";
    const lower = query.toLowerCase();

    // Handle capability test (from planner context)
    if (typeof request === "object" && request.context?.action === "test_access") {
      return await testGitHubAccess();
    }

    // Handle direct capability questions
    if (
      /do you have.*github/i.test(lower) ||
      /can you (access|use).*github/i.test(lower) ||
      /github.*api.*configured/i.test(lower) ||
      /access to github/i.test(lower)
    ) {
      return await testGitHubAccess();
    }

    const octokit = getOctokit();

    // List repositories
    if (/list.*repo/i.test(lower) || /my.*repo/i.test(lower) || /show.*repo/i.test(lower)) {
      const { data } = await octokit.repos.listForAuthenticatedUser({
        sort: "updated",
        per_page: 20
      });

      const repoList = data.map(repo => ({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        language: repo.language,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        updated: repo.updated_at,
        url: repo.html_url
      }));

      const html = `
        <div class="ai-table-wrapper">
          <h3>📦 Your GitHub Repositories</h3>
          <p><strong>Total:</strong> ${data.length} repositories</p>
          <table class="ai-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Language</th>
                <th>⭐ Stars</th>
                <th>🔀 Forks</th>
                <th>Visibility</th>
              </tr>
            </thead>
            <tbody>
              ${repoList.map(repo => `
                <tr>
                  <td><a href="${repo.url}" target="_blank">${repo.name}</a></td>
                  <td>${repo.description || '-'}</td>
                  <td>${repo.language || '-'}</td>
                  <td>${repo.stars}</td>
                  <td>${repo.forks}</td>
                  <td>${repo.private ? '🔒 Private' : '🌐 Public'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      return {
        tool: "github",
        success: true,
        final: true,
        data: {
          repositories: repoList,
          count: data.length,
          html,
          text: `Found ${data.length} repositories:\n${repoList.map(r => `• ${r.name} (${r.language || 'Unknown'}) - ${r.stars} stars`).join('\n')}`
        }
      };
    }

    // Search repositories
    const searchMatch = lower.match(/search.*repo.*for\s+(.+)|find.*repo.*about\s+(.+)/i);
    if (searchMatch) {
      const searchTerm = searchMatch[1] || searchMatch[2];
      const { data } = await octokit.search.repos({
        q: searchTerm,
        sort: "stars",
        per_page: 10
      });

      const repos = data.items.map(repo => ({
        name: repo.full_name,
        description: repo.description,
        language: repo.language,
        stars: repo.stargazers_count,
        url: repo.html_url
      }));

      return {
        tool: "github",
        success: true,
        final: true,
        data: {
          query: searchTerm,
          results: repos,
          total: data.total_count,
          text: `Found ${data.total_count} repositories matching "${searchTerm}":\n${repos.map(r => `• ${r.name} - ${r.description || 'No description'}`).join('\n')}`
        }
      };
    }

    // List issues
    if (/list.*issue/i.test(lower) || /my.*issue/i.test(lower)) {
      const { data } = await octokit.issues.listForAuthenticatedUser({
        filter: "all",
        state: "open",
        sort: "updated",
        per_page: 20
      });

      const issues = data.map(issue => ({
        title: issue.title,
        repo: issue.repository?.full_name,
        number: issue.number,
        state: issue.state,
        url: issue.html_url,
        updated: issue.updated_at
      }));

      return {
        tool: "github",
        success: true,
        final: true,
        data: {
          issues,
          count: data.length,
          text: `Found ${data.length} issues:\n${issues.map(i => `• ${i.repo}#${i.number}: ${i.title}`).join('\n')}`
        }
      };
    }

    // Get user info
    if (/who am i/i.test(lower) || /my.*profile/i.test(lower) || /my.*info/i.test(lower)) {
      const { data } = await octokit.users.getAuthenticated();
      
      return {
        tool: "github",
        success: true,
        final: true,
        data: {
          username: data.login,
          name: data.name,
          bio: data.bio,
          email: data.email,
          publicRepos: data.public_repos,
          followers: data.followers,
          following: data.following,
          company: data.company,
          location: data.location,
          url: data.html_url,
          text: `**GitHub Profile:**\n\n👤 ${data.name || data.login}\n📧 ${data.email || 'Not public'}\n🏢 ${data.company || 'No company'}\n📍 ${data.location || 'No location'}\n📦 ${data.public_repos} public repos\n👥 ${data.followers} followers, ${data.following} following`
        }
      };
    }

    // Default: show help
    return {
      tool: "github",
      success: true,
      final: true,
      data: {
        message: `I have GitHub API access! I can help you with:

**Repositories:**
- "list my repositories"
- "search repositories for machine learning"

**Issues:**
- "list my issues"
- "show open issues"

**Profile:**
- "show my GitHub profile"
- "who am I on GitHub"

What would you like to do?`
      }
    };

  } catch (err) {
    console.error("GitHub tool error:", err);
    
    // Better error messages
    let errorMessage = err.message;
    if (err.status === 401) {
      errorMessage = "GitHub authentication failed. Please check your GITHUB_TOKEN in .env file.";
    } else if (err.status === 403) {
      errorMessage = "GitHub API rate limit exceeded or insufficient permissions.";
    } else if (err.status === 404) {
      errorMessage = "Resource not found on GitHub.";
    }

    return {
      tool: "github",
      success: false,
      final: true,
      error: `GitHub operation failed: ${errorMessage}`,
      data: {
        errorCode: err.status,
        errorDetails: err.message
      }
    };
  }
}

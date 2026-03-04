

// server/tools/github.js

import { Octokit } from '@octokit/rest';

let octokitInstance = null;

function getOctokit() {
  if (!octokitInstance) {
    const token = process.env.GITHUB_TOKEN || process.env.GITHUB_API_KEY;
    if (!token) {
      throw new Error('GitHub token not configured. Set GITHUB_TOKEN or GITHUB_API_KEY in .env');
    }
    octokitInstance = new Octokit({ auth: token });
  }
  return octokitInstance;
}

async function testGitHubAccess() {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.users.getAuthenticated();

    return {
      tool: 'github',
      success: true,
      final: true,
      data: {
        hasAccess: true,
        username: data.login,
        name: data.name,
        type: data.type,
        message: `✅ Yes, I have GitHub API access! \n\n**Authenticated as:** ${data.login}${data.name ? ` (${data.name})` : ''}\n**Account type:** ${data.type}\n\nI can:\n- List your repositories\n- Create/read issues and PRs\n- Search code and repositories\n- Manage repository settings\n- And more!`
      }
    };
  } catch (err) {
    return {
      tool: 'github',
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
    const query = typeof request === 'string' ? request : request.text || '';
    const lower = query.toLowerCase();

    if (typeof request === 'object' && request.context?.action === 'test_access') {
      return await testGitHubAccess();
    }

    // Handle direct capability questions
    if (/do you have.*github/i.test(lower) || /can you (access|use).*github/i.test(lower) || /github.*api.*configured/i.test(lower) || /access to github/i.test(lower)) {
      return await testGitHubAccess();
    }

    const octokit = getOctokit();

    // List repositories
    if (/list.*repo/i.test(lower) || /my.*repo/i.test(lower) || /show.*repo/i.test(lower)) {
      const { data } = await octokit.repos.listForAuthenticatedUser({ sort: 'updated', per_page: 20 });

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
        tool: 'github',
        success: true,
        final: true,
        data: {
          repositories: repoList,
          count: data.length,
          html,
          preformatted: true,
          text: `**Your GitHub Repositories** (${data.length} repos)\n\n` +
            repoList.map(r => `• [${r.name}](${r.url}) (${r.language || 'Unknown'}) — ⭐ ${r.stars} 🔀 ${r.forks} ${r.private ? '🔒' : '🌐'}`).join('\n')
        }
      };
    }

    // Search repositories
    const searchMatch = lower.match(/search.*repo.*for\s+(.+)|find.*repo.*about\s+(.+)/i);
    if (searchMatch) {
      const searchTerm = searchMatch[1] || searchMatch[2];
      const { data } = await octokit.search.repos({ q: searchTerm, sort: 'stars', per_page: 10 });

      const repos = data.items.map(repo => ({
        name: repo.full_name,
        description: repo.description,
        language: repo.language,
        stars: repo.stargazers_count,
        url: repo.html_url
      }));

      return {
        tool: 'github',
        success: true,
        final: true,
        data: {
          query: searchTerm,
          results: repos,
          total: data.total_count,
          preformatted: true,
          text: `**Search results for "${searchTerm}"** (${data.total_count} total)\n\n` +
            repos.map(r => `• [${r.name}](${r.url}) — ${r.description || 'No description'} ⭐ ${r.stars}`).join('\n')
        }
      };
    }

    // List commits
    if (/\bcommit/i.test(lower)) {
      // Extract repo name from query
      const repoMatch = lower.match(/(?:in|for|from|of)\s+(?:repo\s+)?([a-z0-9_\-]+(?:\/[a-z0-9_\-]+)?)/i);
      let owner, repo;

      if (repoMatch) {
        const parts = repoMatch[1].split('/');
        if (parts.length === 2) {
          [owner, repo] = parts;
        } else {
          repo = parts[0];
          owner = (await octokit.users.getAuthenticated()).data.login;
        }
      } else {
        // Default to first repo
        const { data: repos } = await octokit.repos.listForAuthenticatedUser({ sort: 'updated', per_page: 1 });
        if (repos.length > 0) {
          owner = repos[0].owner.login;
          repo = repos[0].name;
        }
      }

      if (owner && repo) {
        const { data } = await octokit.repos.listCommits({ owner, repo, per_page: 15 });

        const commits = data.map(c => ({
          sha: c.sha.substring(0, 7),
          message: c.commit.message.split('\n')[0],
          author: c.commit.author.name,
          date: c.commit.author.date,
          url: c.html_url
        }));

        const text = `**Recent commits** (${owner}/${repo}):\n\n` +
          commits.map(c => `[\`${c.sha}\`](${c.url}) ${c.message} — *${c.author}* (${new Date(c.date).toLocaleDateString()})`).join('\n');

        return {
          tool: 'github',
          success: true,
          final: true,
          data: { commits, repo: `${owner}/${repo}`, preformatted: true, text }
        };
      }
    }

    // List issues
    if (/list.*issue/i.test(lower) || /my.*issue/i.test(lower)) {
      const { data } = await octokit.issues.listForAuthenticatedUser({ filter: 'all', state: 'open', sort: 'updated', per_page: 20 });

      const issues = data.map(issue => ({
        title: issue.title,
        repo: issue.repository?.full_name,
        number: issue.number,
        state: issue.state,
        url: issue.html_url,
        updated: issue.updated_at
      }));

      return {
        tool: 'github',
        success: true,
        final: true,
        data: {
          issues,
          count: data.length,
          preformatted: true,
          text: `**Your Open Issues** (${data.length})\n\n` +
            issues.map(i => `• [${i.repo}#${i.number}](${i.url}): ${i.title}`).join('\n')
        }
      };
    }

    // Get user info
    if (/who am i/i.test(lower) || /my.*profile/i.test(lower) || /my.*info/i.test(lower)) {
      const { data } = await octokit.users.getAuthenticated();

      return {
        tool: 'github',
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

    // Get file content
    const contentMatch = lower.match(/(?:get|read|show|review)\s+(?:file\s+)?([a-zA-Z0-9_\-\.\/]+)\s+(?:from|in)\s+repo\s+([a-zA-Z0-9_\-\.\/]+)/i) ||
      lower.match(/(?:get|read|show|review)\s+repo\s+([a-zA-Z0-9_\-\.\/]+)\s+file\s+([a-zA-Z0-9_\-\.\/]+)/i);

    if (contentMatch) {
      let filePath, repoPath;
      if (lower.includes("repo") && lower.indexOf("repo") < lower.indexOf("file")) {
        repoPath = contentMatch[1];
        filePath = contentMatch[2];
      } else {
        filePath = contentMatch[1];
        repoPath = contentMatch[2];
      }

      const [owner, repo] = repoPath.includes('/') ? repoPath.split('/') : [null, repoPath];

      // If owner is missing, use the authenticated user
      const finalOwner = owner || (await octokit.users.getAuthenticated()).data.login;

      const { data } = await octokit.repos.getContent({ owner: finalOwner, repo, path: filePath });

      if (data.encoding === 'base64') {
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return {
          tool: 'github',
          success: true,
          final: true,
          data: {
            owner: finalOwner,
            repo,
            path: filePath,
            content,
            text: `📄 **File:** ${filePath} (${repo})\n\n\`\`\`\n${content.slice(0, 500)}${content.length > 500 ? '...' : ''}\n\`\`\``
          }
        };
      }
    }

    // Default: show help
    return {
      tool: 'github',
      success: true,
      final: true,
      data: {
        message: `I have GitHub API access! I can help you with:\n\n**Repositories:**\n- "list my repositories"\n- "search repositories for machine learning"\n\n**Issues:**\n- "list my issues"\n- "show open issues"\n\n**Profile:**\n- "show my GitHub profile"\n- "who am I on GitHub"\n\nWhat would you like to do?`
      }
    };
  } catch (err) {
    console.error('GitHub tool error:', err);

    let errorMessage = err.message;
    if (err.status === 401) {
      errorMessage = 'GitHub authentication failed. Please check your GITHUB_TOKEN in .env file.';
    } else if (err.status === 403) {
      errorMessage = 'GitHub API rate limit exceeded or insufficient permissions.';
    } else if (err.status === 404) {
      errorMessage = 'Resource not found on GitHub.';
    }

    return {
      tool: 'github',
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


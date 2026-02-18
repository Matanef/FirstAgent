// server/tools/github.js
import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";

export async function github(query) {
  if (!CONFIG.GITHUB_TOKEN) {
    return {
      tool: "github",
      success: false,
      final: true,
      error: "GitHub token not configured. Create one at https://github.com/settings/tokens"
    };
  }
  
  // Example: Search repos
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `token ${CONFIG.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json"
    }
  });
  
  const data = await response.json();
  
  return {
    tool: "github",
    success: true,
    final: true,
    data: {
      repos: data.items?.slice(0, 5).map(r => ({
        name: r.full_name,
        description: r.description,
        stars: r.stargazers_count,
        url: r.html_url,
        language: r.language
      }))
    }
  };
}
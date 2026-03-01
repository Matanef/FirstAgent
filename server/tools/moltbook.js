// server/tools/moltbook.js
// Domain-specific tool for interacting with moltbook.com
// Uses the REST API documented in skill.md (https://www.moltbook.com/skill.md)
// Supports: register, verify, post, comment, vote, feed, search, follow, profile

import { createHttpClient } from "../utils/httpClient.js";
import { storeCredential, getCredential } from "../utils/credentialStore.js";
import * as cheerio from "cheerio";
import { CONFIG } from "../utils/config.js";
import fetch from "node-fetch";

const SESSION_NAME = "moltbook";
const BASE_URL = () => CONFIG.MOLTBOOK_BASE_URL || "https://www.moltbook.com";
const API_BASE = () => `${BASE_URL()}/api/v1`;

// ============================================================
// API HELPERS
// ============================================================

async function getApiKey() {
  // 1. Check environment variable
  if (CONFIG.MOLTBOOK_API_KEY) return CONFIG.MOLTBOOK_API_KEY;

  // 2. Check credential store
  try {
    const cred = await getCredential(SESSION_NAME);
    if (cred?.api_key) return cred.api_key;
    if (cred?.apiKey) return cred.apiKey;
  } catch { /* not stored */ }

  return null;
}

async function apiRequest(method, endpoint, body = null, requireAuth = true) {
  const headers = { "Content-Type": "application/json" };

  if (requireAuth) {
    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error("No Moltbook API key found. Please register first: 'register on moltbook'");
    }
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const url = `${API_BASE()}${endpoint}`;
  const options = { method, headers };
  if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  console.log(`[moltbook] ${method} ${url}`);
  const res = await fetch(url, options);

  let data;
  try {
    data = await res.json();
  } catch {
    data = { error: `HTTP ${res.status}: ${res.statusText}` };
  }

  if (!res.ok && !data.success) {
    const errMsg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }

  return data;
}

// ============================================================
// HTML BROWSING (kept for general page viewing)
// ============================================================

function getClient() {
  return createHttpClient(SESSION_NAME, {
    rateLimit: 1200,
    maxRetries: 3,
    timeout: 30000
  });
}

function parsePage(html, url) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const title = $("title").text().trim() || $("h1").first().text().trim() || "";
  const mainContent = $("main, article, .content, #content, [role='main']").first();
  const textContent = (mainContent.length ? mainContent.text() : $("body").text())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);

  const links = [];
  $("a[href]").each((_, el) => {
    if (links.length >= 30) return false;
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && text && !href.startsWith("#") && !href.startsWith("javascript:")) {
      try { links.push({ text: text.slice(0, 100), url: new URL(href, url).href }); } catch { }
    }
  });

  return { title, textContent, links };
}

// ============================================================
// ACTION INFERENCE
// ============================================================

function inferAction(text) {
  const lower = text.toLowerCase();
  if (/\b(register|sign\s*up|create\s+account|join)\b/.test(lower)) return "register";
  if (/\b(verify|verification|claim)\b/.test(lower)) return "verify";
  if (/\b(post|create\s+post|share|publish)\b/.test(lower) && !/\bprofile\b/.test(lower)) return "post";
  if (/\b(comment|reply)\b/.test(lower)) return "comment";
  if (/\b(upvote|downvote|vote)\b/.test(lower)) return "vote";
  if (/\b(feed|timeline|what's\s+new|browse\s+posts)\b/.test(lower)) return "feed";
  if (/\b(search|find|look\s+for)\b/.test(lower)) return "search";
  if (/\b(follow|unfollow)\b/.test(lower)) return "follow";
  if (/\b(profile|my\s+account|about\s+me|who\s+am)\b/.test(lower)) return "profile";
  if (/\b(status|check|session)\b/.test(lower)) return "status";
  if (/\b(submolt|community|communities|create\s+community)\b/.test(lower)) return "submolts";
  if (/\b(store|save|remember)\s*(credential|password|api.?key)\b/.test(lower)) return "storeCredentials";
  if (/\b(log\s*out|sign\s*out)\b/.test(lower)) return "logout";
  return "browse";
}

// ============================================================
// ACTION HANDLERS
// ============================================================

async function handleRegister(text, context) {
  // Extract agent name and description from text
  let name = context.agentName || null;
  let description = context.description || null;

  if (!name) {
    const nameMatch = text.match(/(?:name|called|named|as)\s+["']?([A-Za-z0-9_-]+)["']?/i);
    if (nameMatch) name = nameMatch[1];
  }
  if (!description) {
    const descMatch = text.match(/(?:description|desc|about|bio)\s*[:=]\s*["']?(.+?)["']?\s*$/i);
    if (descMatch) description = descMatch[1];
  }

  // Use defaults if not provided
  if (!name) name = CONFIG.AGENT_NAME || "MyAgent";
  if (!description) description = CONFIG.AGENT_DESCRIPTION || "An AI assistant agent";

  try {
    const data = await apiRequest("POST", "/agents/register", { name, description }, false);

    // Store the API key
    const apiKey = data.agent?.api_key;
    const claimUrl = data.agent?.claim_url;
    const verificationCode = data.agent?.verification_code;

    if (apiKey) {
      try {
        await storeCredential(SESSION_NAME, {
          api_key: apiKey,
          agent_name: name,
          claim_url: claimUrl,
          verification_code: verificationCode
        });
        console.log("[moltbook] API key stored successfully");
      } catch (e) {
        console.warn("[moltbook] Failed to store API key:", e.message);
      }
    }

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `🦞 **Registration successful!**\n\n` +
          `**Agent Name:** ${name}\n` +
          `**API Key:** \`${apiKey || "not returned"}\`\n` +
          `**Claim URL:** ${claimUrl || "not returned"}\n` +
          `**Verification Code:** ${verificationCode || "not returned"}\n\n` +
          `⚠️ **Save your API key!** You need it for all future requests.\n\n` +
          `Share the claim URL with your human to activate your account.`,
        action: "register",
        apiKey,
        claimUrl,
        verificationCode,
        agentName: name,
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: `Registration failed: ${err.message}`,
        action: "register"
      }
    };
  }
}

async function handleVerify(text, context) {
  const verificationCode = context.verification_code || null;
  const answer = context.answer || null;

  // Extract verification code and math answer from text
  const codeMatch = text.match(/(?:code|verification)\s*[:=]?\s*([a-z]+-[A-Za-z0-9]+)/i);
  const answerMatch = text.match(/(?:answer|solution)\s*[:=]?\s*(\d+)/i);

  const code = verificationCode || codeMatch?.[1];
  const ans = answer || answerMatch?.[1];

  if (!code || !ans) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: "Verification requires a verification_code and the answer to the math challenge.\n\nExample: 'verify moltbook code: reef-X4B2 answer: 42'",
        action: "verify"
      }
    };
  }

  try {
    const data = await apiRequest("POST", "/agents/verify", {
      verification_code: code,
      answer: parseInt(ans, 10)
    });

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `✅ Verification successful! ${data.message || "Your account is now verified."}`,
        action: "verify",
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Verification failed: ${err.message}`, action: "verify" }
    };
  }
}

async function handlePost(text, context) {
  let title = context.title || null;
  let content = context.content || null;
  let submolt = context.submolt || "general";
  let url = context.url || null;

  // Extract from text
  if (!title) {
    const titleMatch = text.match(/(?:title|subject)\s*[:=]\s*["']?(.+?)["']?(?:\s+(?:content|body|saying|in)|$)/i);
    if (titleMatch) title = titleMatch[1];
  }
  if (!content) {
    const contentMatch = text.match(/(?:content|body|saying|message)\s*[:=]\s*["']?(.+?)["']?\s*$/i);
    if (contentMatch) content = contentMatch[1];
  }
  if (!title && !content) {
    // Use the text as content, auto-generate title
    content = text.replace(/^.*?(post|share|publish)\s*/i, "").trim();
    title = content.slice(0, 100);
  }

  const body = { submolt, title };
  if (url) body.url = url;
  else body.content = content || title;

  try {
    const data = await apiRequest("POST", "/posts", body);

    let resultText = `📝 **Post created!**\n\n**Title:** ${title}\n**Submolt:** ${submolt}`;

    // Check for verification challenge
    if (data.verification) {
      resultText += `\n\n⚠️ **Verification required:** ${data.verification.challenge}\nSolve and submit: verify moltbook code: ${data.verification.code} answer: <your answer>`;
    }

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: resultText,
        action: "post",
        post: data.post || data,
        verification: data.verification,
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Failed to create post: ${err.message}`, action: "post" }
    };
  }
}

async function handleComment(text, context) {
  const postId = context.postId || context.post_id;
  let content = context.content || null;
  const parentId = context.parentId || context.parent_id || null;

  if (!postId) {
    // Try to extract post ID from text
    const idMatch = text.match(/(?:post|#)\s*([a-f0-9]+)/i);
    if (!idMatch) {
      return {
        tool: "moltbook",
        success: false,
        final: true,
        data: {
          text: "Please specify which post to comment on. Example: 'comment on post abc123 saying Great post!'",
          action: "comment"
        }
      };
    }
  }

  if (!content) {
    content = text.replace(/^.*?(comment|reply)\s*(on\s+post\s+\S+)?\s*(saying|:)?\s*/i, "").trim();
  }

  const body = { content };
  if (parentId) body.parent_id = parentId;

  try {
    const data = await apiRequest("POST", `/posts/${postId}/comments`, body);

    let resultText = `💬 **Comment posted!**\n\n${content}`;
    if (data.verification) {
      resultText += `\n\n⚠️ **Verification required:** ${data.verification.challenge}`;
    }

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: { text: resultText, action: "comment", comment: data, preformatted: true }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Failed to comment: ${err.message}`, action: "comment" }
    };
  }
}

async function handleVote(text, context) {
  const lower = text.toLowerCase();
  const isUpvote = /\b(upvote|up\s*vote|like|thumbs?\s*up)\b/i.test(lower);
  const isComment = /\bcomment\b/i.test(lower);

  // Extract ID
  const idMatch = text.match(/(?:post|comment|#)\s*([a-f0-9]+)/i) || text.match(/\b([a-f0-9]{10,})\b/);
  const id = context.postId || context.commentId || idMatch?.[1];

  if (!id) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: "Please specify what to vote on. Example: 'upvote post abc123'", action: "vote" }
    };
  }

  const endpoint = isComment
    ? `/comments/${id}/${isUpvote ? "upvote" : "downvote"}`
    : `/posts/${id}/${isUpvote ? "upvote" : "downvote"}`;

  try {
    const data = await apiRequest("POST", endpoint);
    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `${isUpvote ? "👍" : "👎"} ${isUpvote ? "Upvoted" : "Downvoted"} successfully! ${data.message || ""}`,
        action: "vote",
        result: data,
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Vote failed: ${err.message}`, action: "vote" }
    };
  }
}

async function handleFeed(text, context) {
  const sort = context.sort || "hot";
  const limit = context.limit || 25;
  const filter = context.filter || "all";

  try {
    const data = await apiRequest("GET", `/feed?sort=${sort}&limit=${limit}&filter=${filter}`);
    const posts = data.posts || data.results || data || [];

    if (!Array.isArray(posts) || posts.length === 0) {
      return {
        tool: "moltbook",
        success: true,
        final: true,
        data: { text: "Your feed is empty. Try subscribing to some submolts or following other moltys!", action: "feed", preformatted: true }
      };
    }

    let text_out = `### 🦞 Moltbook Feed (${sort})\n\n`;
    for (const p of posts.slice(0, 25)) {
      const author = p.author?.name || "unknown";
      const votes = (p.upvotes || 0) - (p.downvotes || 0);
      const submolt = p.submolt?.name || p.submolt || "";
      const comments = p.comment_count || 0;
      text_out += `**${p.title || "(no title)"}** — by ${author} in s/${submolt}\n`;
      text_out += `  ↑${votes} | 💬${comments} | ID: ${p.id || p._id || "?"}\n\n`;
    }

    if (data.has_more) {
      text_out += `\n*More posts available. Use cursor: ${data.next_cursor}*`;
    }

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: { text: text_out, action: "feed", posts, preformatted: true }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Failed to load feed: ${err.message}`, action: "feed" }
    };
  }
}

async function handleSearch(text, context) {
  const query = context.query || text.replace(/^.*?(search|find|look\s+for)\s*/i, "").trim();
  const type = context.type || "all";
  const limit = context.limit || 20;

  if (!query) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: "Please provide a search query. Example: 'search moltbook for AI memory techniques'", action: "search" }
    };
  }

  try {
    const data = await apiRequest("GET", `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
    const results = data.results || [];

    if (results.length === 0) {
      return {
        tool: "moltbook",
        success: true,
        final: true,
        data: { text: `No results found for "${query}" on Moltbook.`, action: "search", preformatted: true }
      };
    }

    let text_out = `### 🔍 Search: "${query}" (${results.length} results)\n\n`;
    for (const r of results) {
      const similarity = r.similarity ? ` (${(r.similarity * 100).toFixed(0)}% match)` : "";
      const author = r.author?.name || "unknown";
      text_out += `**[${r.type}]** ${r.title || r.content?.slice(0, 80) || "(no title)"}${similarity}\n`;
      text_out += `  by ${author} | ↑${(r.upvotes || 0) - (r.downvotes || 0)} | ID: ${r.post_id || r.id}\n\n`;
    }

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: { text: text_out, action: "search", results, preformatted: true }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Search failed: ${err.message}`, action: "search" }
    };
  }
}

async function handleFollow(text, context) {
  const lower = text.toLowerCase();
  const isUnfollow = /\bunfollow\b/i.test(lower);
  const nameMatch = text.match(/(?:follow|unfollow)\s+@?([A-Za-z0-9_-]+)/i);
  const targetName = context.target || nameMatch?.[1];

  if (!targetName) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: "Please specify who to follow. Example: 'follow ClawdClawderberg on moltbook'", action: "follow" }
    };
  }

  try {
    const method = isUnfollow ? "DELETE" : "POST";
    const data = await apiRequest(method, `/agents/${targetName}/follow`);
    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `${isUnfollow ? "Unfollowed" : "Now following"} **${targetName}** on Moltbook! ${data.message || ""}`,
        action: "follow",
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Follow action failed: ${err.message}`, action: "follow" }
    };
  }
}

async function handleProfile(text, context) {
  const nameMatch = text.match(/(?:profile|about)\s+(?:of\s+)?@?([A-Za-z0-9_-]+)/i);
  const targetName = context.target || nameMatch?.[1];

  try {
    let data;
    if (targetName) {
      data = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(targetName)}`);
    } else {
      data = await apiRequest("GET", "/agents/me");
    }

    const agent = data.agent || data;
    let text_out = `### 🦞 ${agent.name || "Profile"}\n\n`;
    text_out += `**Description:** ${agent.description || "No description"}\n`;
    text_out += `**Karma:** ${agent.karma || 0}\n`;
    text_out += `**Followers:** ${agent.follower_count || 0} | **Following:** ${agent.following_count || 0}\n`;
    text_out += `**Status:** ${agent.is_active ? "Active" : "Inactive"} | ${agent.is_claimed ? "Claimed" : "Unclaimed"}\n`;

    if (agent.owner) {
      text_out += `\n**Owner:** @${agent.owner.x_handle || "?"} (${agent.owner.x_name || ""})`;
    }

    if (data.recentPosts && data.recentPosts.length > 0) {
      text_out += `\n\n**Recent Posts:**\n`;
      for (const p of data.recentPosts.slice(0, 5)) {
        text_out += `• ${p.title || "(no title)"} (↑${(p.upvotes || 0) - (p.downvotes || 0)})\n`;
      }
    }

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: { text: text_out, action: "profile", agent, preformatted: true }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Profile lookup failed: ${err.message}`, action: "profile" }
    };
  }
}

async function handleStatus() {
  try {
    const data = await apiRequest("GET", "/agents/status");
    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `Moltbook status: **${data.status || "unknown"}**${data.agent ? ` (${data.agent.name})` : ""}`,
        action: "status",
        status: data.status,
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Status check failed: ${err.message}`, action: "status" }
    };
  }
}

async function handleSubmolts(text, context) {
  const lower = text.toLowerCase();

  if (/\b(create|make|new)\b/i.test(lower)) {
    // Create submolt
    const nameMatch = text.match(/(?:called|named)\s+["']?([a-z0-9-]+)["']?/i);
    const displayMatch = text.match(/(?:display|title)\s*[:=]\s*["']?(.+?)["']?\s*$/i);
    const descMatch = text.match(/(?:description|about)\s*[:=]\s*["']?(.+?)["']?\s*$/i);

    const name = context.name || nameMatch?.[1];
    if (!name) {
      return {
        tool: "moltbook",
        success: false,
        final: true,
        data: { text: "Please provide a submolt name. Example: 'create moltbook submolt called ai-thoughts'", action: "submolts" }
      };
    }

    try {
      const data = await apiRequest("POST", "/submolts", {
        name,
        display_name: context.display_name || displayMatch?.[1] || name,
        description: context.description || descMatch?.[1] || ""
      });
      return {
        tool: "moltbook",
        success: true,
        final: true,
        data: { text: `✅ Submolt **s/${name}** created!`, action: "submolts", submolt: data, preformatted: true }
      };
    } catch (err) {
      return {
        tool: "moltbook",
        success: false,
        final: true,
        data: { text: `Failed to create submolt: ${err.message}`, action: "submolts" }
      };
    }
  }

  if (/\b(subscribe|join)\b/i.test(lower)) {
    const subMatch = text.match(/(?:subscribe|join)\s+(?:to\s+)?(?:s\/)?([a-z0-9-]+)/i);
    const subName = context.submolt || subMatch?.[1];
    if (!subName) return { tool: "moltbook", success: false, final: true, data: { text: "Specify submolt to subscribe to.", action: "submolts" } };

    try {
      await apiRequest("POST", `/submolts/${subName}/subscribe`);
      return { tool: "moltbook", success: true, final: true, data: { text: `Subscribed to s/${subName}!`, action: "submolts", preformatted: true } };
    } catch (err) {
      return { tool: "moltbook", success: false, final: true, data: { text: `Subscribe failed: ${err.message}`, action: "submolts" } };
    }
  }

  // List submolts
  try {
    const data = await apiRequest("GET", "/submolts");
    const submolts = data.submolts || data || [];
    let text_out = `### Moltbook Communities\n\n`;
    for (const s of (Array.isArray(submolts) ? submolts : [])) {
      text_out += `• **s/${s.name}** — ${s.display_name || s.name} (${s.subscriber_count || 0} subscribers)\n`;
    }
    return { tool: "moltbook", success: true, final: true, data: { text: text_out, action: "submolts", submolts, preformatted: true } };
  } catch (err) {
    return { tool: "moltbook", success: false, final: true, data: { text: `Failed to list submolts: ${err.message}`, action: "submolts" } };
  }
}

async function handleStoreCredentials(text, context) {
  const apiKeyMatch = text.match(/(?:api.?key|key|token)\s*[:=]\s*["']?(moltbook_[^\s"']+)["']?/i);
  const apiKey = context.api_key || apiKeyMatch?.[1];

  if (!apiKey) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: "Please provide the API key. Example: 'store moltbook api_key: moltbook_xxx'", action: "storeCredentials" }
    };
  }

  try {
    await storeCredential(SESSION_NAME, { api_key: apiKey, agent_name: context.agent_name || "" });
    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: { text: `✅ Moltbook API key stored securely.`, action: "storeCredentials", preformatted: true }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Failed to store credentials: ${err.message}`, action: "storeCredentials" }
    };
  }
}

async function handleBrowse(text, context) {
  const client = getClient();
  let url = context.url || null;

  if (!url) {
    const pathMatch = text.match(/(?:browse|visit|go to|open|navigate to)\s+(.+)/i);
    if (pathMatch) {
      const target = pathMatch[1].trim();
      url = target.startsWith("http") ? target : `${BASE_URL()}${target.startsWith("/") ? "" : "/"}${target}`;
    } else {
      url = BASE_URL();
    }
  }

  try {
    const response = await client.get(url);
    const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const parsed = parsePage(html, url);

    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `Browsed moltbook: "${parsed.title}"\n\n${parsed.textContent.slice(0, 3000)}`,
        action: "browse",
        url: response.url || url,
        title: parsed.title,
        content: parsed.textContent,
        links: parsed.links
      }
    };
  } catch (err) {
    return { tool: "moltbook", success: false, final: true, data: { text: `Browse failed: ${err.message}`, action: "browse" } };
  }
}

// ============================================================
// MAIN EXPORT
// ============================================================

export async function moltbook(input) {
  try {
    const text = typeof input === "string" ? input : (input?.text || "");
    const context = typeof input === "object" ? (input?.context || {}) : {};
    const action = context.action || inferAction(text);

    console.log(`[moltbook] Action: ${action}`);

    switch (action) {
      case "register": return await handleRegister(text, context);
      case "verify": return await handleVerify(text, context);
      case "verify_email": return await handleVerify(text, context);
      case "post": return await handlePost(text, context);
      case "comment": return await handleComment(text, context);
      case "vote": return await handleVote(text, context);
      case "feed": return await handleFeed(text, context);
      case "search": return await handleSearch(text, context);
      case "follow": return await handleFollow(text, context);
      case "profile": return await handleProfile(text, context);
      case "status": return await handleStatus();
      case "submolts": return await handleSubmolts(text, context);
      case "storeCredentials": return await handleStoreCredentials(text, context);
      case "browse": return await handleBrowse(text, context);
      case "logout": return { tool: "moltbook", success: true, final: true, data: { text: "Logged out (API key auth doesn't require session logout).", action: "logout", preformatted: true } };
      default: return await handleBrowse(text, context);
    }
  } catch (err) {
    console.error("[moltbook] Error:", err.message);
    return {
      tool: "moltbook",
      success: false,
      final: true,
      error: err.message,
      data: { text: `Moltbook error: ${err.message}` }
    };
  }
}

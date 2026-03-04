// server/tools/moltbook.js
// Moltbook social network for AI agents
// Uses the Moltbook REST API (https://www.moltbook.com/api/v1/)
// Agent registration, posting, commenting, feed browsing, communities

import fetch from "node-fetch";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMemory, saveJSON, MEMORY_FILE } from "../memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = "https://www.moltbook.com/api/v1";
const CREDS_DIR = path.resolve(__dirname, "..", "..", ".config", "moltbook");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");

// ──────────────────────────────────────────────────────────
// CREDENTIAL MANAGEMENT
// ──────────────────────────────────────────────────────────

function loadCredentials() {
  try {
    if (fsSync.existsSync(CREDS_FILE)) {
      const raw = fsSync.readFileSync(CREDS_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[moltbook] Could not load credentials:", e.message);
  }
  return null;
}

async function saveCredentials(creds) {
  await fs.mkdir(CREDS_DIR, { recursive: true });
  await fs.writeFile(CREDS_FILE, JSON.stringify(creds, null, 2), "utf8");
  console.log("[moltbook] Credentials saved to", CREDS_FILE);
}

// ──────────────────────────────────────────────────────────
// API HELPERS
// ──────────────────────────────────────────────────────────

async function apiRequest(method, endpoint, body, apiKey) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { "Content-Type": "application/json" };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const options = { method, headers };
  if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  console.log(`[moltbook] ${method} ${endpoint}`);
  const res = await fetch(url, options);

  let data;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

function getApiKey() {
  const creds = loadCredentials();
  if (creds?.api_key) return creds.api_key;
  if (process.env.MOLTBOOK_API_KEY) return process.env.MOLTBOOK_API_KEY;
  return null;
}

// ──────────────────────────────────────────────────────────
// ACTION INFERENCE
// ──────────────────────────────────────────────────────────

function inferAction(text) {
  const lower = text.toLowerCase();
  if (/\b(register|sign\s*up|create\s+account|join\s+moltbook|open.*account)\b/.test(lower)) return "register";
  if (/\bskill\.md\b/.test(lower) || /\bfollow.*instructions?\b/.test(lower)) return "register";
  if (/\b(log\s*in|sign\s*in|authenticate)\b/.test(lower)) return "login";
  if (/\b(log\s*out|sign\s*out)\b/.test(lower)) return "logout";
  if (/\b(my\s+profile|who\s+am\s+i|my\s+account|check\s+me)\b/.test(lower)) return "profile";
  if (/\b(search|find|look\s+for)\b/.test(lower)) return "search";
  if (/\b(post|publish|share|write\s+a?\s*post|create\s+post)\b/.test(lower)) return "post";
  if (/\b(comment|reply)\b/.test(lower)) return "comment";
  if (/\b(upvote|downvote|vote)\b/.test(lower)) return "vote";
  if (/\b(feed|browse|timeline|home|dashboard)\b/.test(lower)) return "feed";
  if (/\b(follow|subscribe)\b/.test(lower)) return "follow";
  if (/\b(unfollow|unsubscribe)\b/.test(lower)) return "unfollow";
  if (/\b(status|check|session|am\s+i\s+registered)\b/.test(lower)) return "status";
  if (/\b(communities?|submolt)\b/.test(lower)) return "communities";
  if (/\b(heartbeat|check\s*in|routine)\b/.test(lower)) return "heartbeat";
  return "feed";
}

// ──────────────────────────────────────────────────────────
// VERIFICATION CHALLENGE SOLVER
// ──────────────────────────────────────────────────────────

function solveVerificationChallenge(challengeText) {
  try {
    const lower = challengeText.toLowerCase();
    const numbers = challengeText.match(/\d+\.?\d*/g)?.map(Number) || [];

    let result = null;
    if (/plus|add|sum|total/i.test(lower) && numbers.length >= 2) {
      result = numbers[0] + numbers[1];
    } else if (/minus|subtract|less|difference/i.test(lower) && numbers.length >= 2) {
      result = numbers[0] - numbers[1];
    } else if (/times|multiply|multiplied|product/i.test(lower) && numbers.length >= 2) {
      result = numbers[0] * numbers[1];
    } else if (/divid|split|quot/i.test(lower) && numbers.length >= 2 && numbers[1] !== 0) {
      result = numbers[0] / numbers[1];
    } else if (/percent|%/i.test(lower) && numbers.length >= 2) {
      result = (numbers[0] * numbers[1]) / 100;
    }

    if (result === null) {
      const expr = challengeText.match(/(\d+\.?\d*)\s*([+\-*/])\s*(\d+\.?\d*)/);
      if (expr) {
        const na = parseFloat(expr[1]);
        const op = expr[2];
        const nb = parseFloat(expr[3]);
        if (op === "+") result = na + nb;
        else if (op === "-") result = na - nb;
        else if (op === "*") result = na * nb;
        else if (op === "/" && nb !== 0) result = na / nb;
      }
    }

    if (result !== null) return result.toFixed(2);
  } catch (e) {
    console.warn("[moltbook] Challenge solve error:", e.message);
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// ACTION HANDLERS
// ──────────────────────────────────────────────────────────

async function handleRegister(text, context) {
  const memory = await getMemory();
  const ownerName = memory.profile?.name || "User";
  const ownerEmail = memory.profile?.email || null;
  const agentName = context.agentName || `LocalLLM_Agent_${ownerName.replace(/\s+/g, "")}`;
  const description = context.description || `AI assistant agent owned by ${ownerName}. Capable of web search, code review, file management, weather, news, finance, and more.`;

  console.log(`[moltbook] Registering agent: ${agentName}`);

  const result = await apiRequest("POST", "/agents/register", { name: agentName, description });

  // Handle 409 Conflict — agent name already taken
  if (result.status === 409) {
    // Check if we already have local credentials (previous successful registration)
    const existingCreds = loadCredentials();
    if (existingCreds?.api_key) {
      console.log("[moltbook] 409 but found existing local credentials, checking status...");
      // Verify the existing key works
      const statusResult = await apiRequest("GET", "/agents/me", null, existingCreds.api_key);
      if (statusResult.ok) {
        return {
          tool: "moltbook", success: true, final: true,
          data: {
            preformatted: true,
            text: `**Already Registered on Moltbook!**\n\n` +
              `**Agent Name:** ${existingCreds.agent_name || agentName}\n` +
              `**API Key:** ${existingCreds.api_key.substring(0, 15)}...\n` +
              `**Status:** Active\n` +
              (existingCreds.claim_url ? `**Claim URL:** ${existingCreds.claim_url}\n` : "") +
              `\nYour agent is already registered and credentials are saved locally.`,
            action: "register", agentName: existingCreds.agent_name, registered: true
          }
        };
      }
    }

    const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data);
    return {
      tool: "moltbook", success: false, final: true,
      data: {
        text: `Registration conflict (HTTP 409): Agent name "${agentName}" is already taken.\n\n${errMsg}\n\n` +
          `**To fix this:**\n` +
          `1. If this is your agent, say: "check moltbook status"\n` +
          `2. To use a different name, say: "register on moltbook as MyNewAgentName"\n` +
          `3. If you have an existing API key, say: "remember my moltbook_api_key is moltbook_xxx"`,
        action: "register", statusCode: 409, error: errMsg
      }
    };
  }

  if (!result.ok) {
    const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data);
    return {
      tool: "moltbook", success: false, final: true,
      data: {
        text: `Registration failed (HTTP ${result.status}): ${errMsg}\n\nIf agent name "${agentName}" is taken, try with a different name.`,
        action: "register", statusCode: result.status, error: errMsg
      }
    };
  }

  // Parse API response — handle both flat and nested response structures
  const regData = result.data;
  const agentData = regData.agent || regData;
  const apiKey = agentData.api_key || agentData.apiKey || regData.api_key || regData.apiKey;
  const claimUrl = agentData.claim_url || agentData.claimUrl || regData.claim_url || regData.claimUrl;
  const verificationCode = agentData.verification_code || agentData.verificationCode || regData.verification_code || regData.verificationCode;

  console.log(`[moltbook] Registration response keys:`, Object.keys(regData));
  if (regData.agent) console.log(`[moltbook] agent sub-object keys:`, Object.keys(regData.agent));
  console.log(`[moltbook] API Key found: ${apiKey ? "yes" : "NO"}`);
  console.log(`[moltbook] Claim URL found: ${claimUrl ? "yes" : "NO"}`);

  if (apiKey) {
    await saveCredentials({
      api_key: apiKey, agent_name: agentName, claim_url: claimUrl,
      verification_code: verificationCode, registered_at: new Date().toISOString()
    });

    const mem = await getMemory();
    if (!mem.meta) mem.meta = {};
    mem.meta.moltbook = {
      agent_name: agentName, api_key: apiKey, claim_url: claimUrl,
      registered: true, registered_at: new Date().toISOString()
    };
    await saveJSON(MEMORY_FILE, mem);

    // Set up owner email if available
    if (ownerEmail) {
      try {
        const emailResult = await apiRequest("POST", "/agents/me/setup-owner-email", { email: ownerEmail }, apiKey);
        if (emailResult.ok) {
          console.log(`[moltbook] Owner email configured: ${ownerEmail}`);
        } else {
          console.warn(`[moltbook] Owner email setup failed:`, emailResult.status);
        }
      } catch (e) {
        console.warn(`[moltbook] Owner email setup error:`, e.message);
      }
    }
  } else {
    console.warn("[moltbook] WARNING: No API key in registration response! Full response:", JSON.stringify(regData));
  }

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Moltbook Registration Successful!**\n\n` +
        `**Agent Name:** ${agentName}\n` +
        `**API Key:** ${apiKey ? apiKey.substring(0, 15) + "..." : "⚠️ Not returned — check Moltbook dashboard"}\n` +
        `**Claim URL:** ${claimUrl || "⚠️ Not returned"}\n` +
        (verificationCode ? `**Verification Code:** ${verificationCode}\n` : "") +
        `\n**Next Steps for your human owner:**\n` +
        (claimUrl ? `1. Visit the claim URL: ${claimUrl}\n` : `1. Visit https://www.moltbook.com to find your agent\n`) +
        `2. Verify your email\n` +
        `3. Post a verification tweet on X (Twitter)\n` +
        `4. Complete the claim to activate the agent\n` +
        (ownerEmail ? `\n📧 Owner email set to: ${ownerEmail}\n` : `\n💡 Tip: Set your email with "remember my email is you@example.com" before registering\n`) +
        `\nCredentials have been saved locally.`,
      action: "register", agentName, apiKey, claimUrl, registered: true
    }
  };
}

async function handleProfile(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("profile");

  const result = await apiRequest("GET", "/agents/me", null, apiKey);
  if (!result.ok) return apiError("profile", result);

  const agent = result.data;
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Moltbook Profile**\n\n` +
        `**Name:** ${agent.name || "N/A"}\n` +
        `**Description:** ${agent.description || "N/A"}\n` +
        `**Status:** ${agent.status || agent.claim_status || "N/A"}\n` +
        (agent.created_at ? `**Joined:** ${new Date(agent.created_at).toLocaleDateString()}\n` : "") +
        (agent.post_count != null ? `**Posts:** ${agent.post_count}\n` : "") +
        (agent.follower_count != null ? `**Followers:** ${agent.follower_count}\n` : ""),
      action: "profile", agent
    }
  };
}

async function handleFeed(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("feed");

  const sort = context.sort || "hot";
  const limit = context.limit || 15;

  let result = await apiRequest("GET", `/feed?sort=${sort}&limit=${limit}`, null, apiKey);
  if (!result.ok) {
    result = await apiRequest("GET", `/posts?sort=${sort}&limit=${limit}`, null, apiKey);
    if (!result.ok) return apiError("feed", result);
  }

  return formatPostsList(result.data, "Moltbook Feed");
}

async function handlePost(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("post");

  const contentMatch = text.match(/(?:post|share|publish|write)\s*(?:on|to|in)?\s*(?:moltbook)?\s*[:"\s]*(.+)/is);
  const content = context.content || (contentMatch ? contentMatch[1].trim() : text);
  const title = context.title || content.split("\n")[0].substring(0, 100);
  const submolt = context.submolt || context.submolt_name || "general";

  const result = await apiRequest("POST", "/posts", {
    submolt_name: submolt, title, content, type: "text"
  }, apiKey);

  if (!result.ok) return apiError("post", result);

  if (result.data?.verification_required) {
    const challenge = result.data.verification;
    const answer = solveVerificationChallenge(challenge.challenge_text);

    if (answer) {
      const vr = await apiRequest("POST", "/verify", { verification_code: challenge.verification_code, answer }, apiKey);
      if (vr.ok) {
        return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `**Post published and verified!**\n\nTitle: ${title}\nSubmolt: ${submolt}`, action: "post", verified: true } };
      }
    }

    return {
      tool: "moltbook", success: true, final: true,
      data: {
        preformatted: true,
        text: `**Post created but needs verification.**\n\nChallenge: ${challenge.challenge_text}\nCode: ${challenge.verification_code}\nExpires: ${challenge.expires_at}`,
        action: "post", verification: challenge, needsVerification: true
      }
    };
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `**Post published!**\n\nTitle: ${title}\nSubmolt: ${submolt}`, action: "post", post: result.data } };
}

async function handleComment(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("comment");

  const postId = context.postId || context.post_id;
  if (!postId) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post to comment on (provide a post ID).", action: "comment" } };
  }

  const content = context.content || text;
  const result = await apiRequest("POST", `/posts/${postId}/comments`, { content, parent_id: context.parent_id || null }, apiKey);
  if (!result.ok) return apiError("comment", result);

  if (result.data?.verification_required) {
    const challenge = result.data.verification;
    const answer = solveVerificationChallenge(challenge.challenge_text);
    if (answer) {
      const vr = await apiRequest("POST", "/verify", { verification_code: challenge.verification_code, answer }, apiKey);
      if (vr.ok) {
        return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: "Comment posted and verified!", action: "comment" } };
      }
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: "Comment posted!", action: "comment", comment: result.data } };
}

async function handleVote(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("vote");

  const postId = context.postId || context.post_id;
  if (!postId) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post to vote on.", action: "vote" } };

  const direction = /downvote|down/i.test(text) ? "downvote" : "upvote";
  const result = await apiRequest("POST", `/posts/${postId}/${direction}`, null, apiKey);
  if (!result.ok) return apiError("vote", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `${direction === "upvote" ? "Upvoted" : "Downvoted"} post ${postId}!`, action: "vote" } };
}

async function handleFollow(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("follow");

  const target = context.target || text.match(/follow\s+(\w+)/i)?.[1];
  if (!target) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify who to follow.", action: "follow" } };

  const result = await apiRequest("POST", `/agents/${target}/follow`, null, apiKey);
  if (!result.ok) return apiError("follow", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Now following **${target}** on Moltbook!`, action: "follow" } };
}

async function handleSearch(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("search");

  const query = context.query || text.replace(/^.*?(search|find|look\s+for)\s*/i, "").trim();
  const result = await apiRequest("GET", `/search?q=${encodeURIComponent(query)}&type=all&limit=20`, null, apiKey);
  if (!result.ok) return apiError("search", result);

  const items = Array.isArray(result.data) ? result.data : (result.data?.results || result.data?.posts || []);
  let output = `**Moltbook Search: "${query}"**\n\nFound ${items.length} results:\n\n`;
  for (const item of items.slice(0, 10)) {
    output += `- **${item.title || item.name || "Untitled"}** ${item.content ? "- " + item.content.substring(0, 100) : ""}\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "search", results: items } };
}

async function handleCommunities(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("communities");

  const result = await apiRequest("GET", "/submolts", null, apiKey);
  if (!result.ok) return apiError("communities", result);

  const communities = Array.isArray(result.data) ? result.data : (result.data?.submolts || []);
  let output = `**Moltbook Communities**\n\n`;
  for (const c of communities.slice(0, 20)) {
    output += `- **${c.display_name || c.name}** - ${c.description || "No description"} (${c.subscriber_count || 0} members)\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "communities", communities } };
}

async function handleHeartbeat(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("heartbeat");

  const homeResult = await apiRequest("GET", "/home", null, apiKey);
  const feedResult = await apiRequest("GET", "/feed?sort=hot&limit=5", null, apiKey);

  const home = homeResult.ok ? homeResult.data : null;
  const feed = feedResult.ok ? feedResult.data : null;
  const posts = Array.isArray(feed) ? feed : (feed?.posts || []);

  let output = `**Moltbook Heartbeat Check**\n\n`;
  if (home) output += `Dashboard loaded.\n\n`;
  if (posts.length > 0) {
    output += `**Recent Feed:**\n`;
    for (const p of posts.slice(0, 5)) output += `- ${p.title || "Post"} by ${p.author || "unknown"}\n`;
  }

  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  mem.meta.moltbook.lastHeartbeat = new Date().toISOString();
  await saveJSON(MEMORY_FILE, mem);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "heartbeat" } };
}

async function handleStatus() {
  const creds = loadCredentials();
  const apiKey = getApiKey();

  let statusText = "**Moltbook Status**\n\n";
  statusText += `Credentials file: ${fsSync.existsSync(CREDS_FILE) ? "exists" : "not found"}\n`;
  statusText += `API Key: ${apiKey ? "configured (" + apiKey.substring(0, 10) + "...)" : "not configured"}\n`;

  if (creds) {
    statusText += `Agent name: ${creds.agent_name || "N/A"}\n`;
    statusText += `Registered: ${creds.registered_at || "N/A"}\n`;
    if (creds.claim_url) statusText += `Claim URL: ${creds.claim_url}\n`;
  }

  if (apiKey) {
    const result = await apiRequest("GET", "/agents/me", null, apiKey);
    statusText += result.ok
      ? `\nAPI Connection: **Active**\nAccount status: ${result.data?.status || result.data?.claim_status || "unknown"}\n`
      : `\nAPI Connection: **Failed** (HTTP ${result.status})\n`;
  } else {
    statusText += `\nTo register: say "Register on Moltbook"`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: statusText, action: "status" } };
}

// ──────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────

function formatPostsList(data, title) {
  const posts = Array.isArray(data) ? data : (data?.posts || data?.results || []);
  let output = `**${title}**\n\n`;

  if (posts.length === 0) {
    output += "No posts found.\n";
  } else {
    for (const p of posts.slice(0, 15)) {
      const score = p.score != null ? `[${p.score}]` : "";
      const comments = p.comment_count != null ? `(${p.comment_count} comments)` : "";
      output += `${score} **${p.title || "Untitled"}** - ${p.author || "unknown"} ${comments}\n`;
      if (p.content) output += `  ${p.content.substring(0, 120)}...\n`;
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "feed", posts } };
}

function noApiKeyError(action) {
  return {
    tool: "moltbook", success: false, final: true,
    data: {
      text: `No Moltbook API key configured. To get started:\n\n1. Say: "Register on Moltbook"\n2. I'll create an agent account and save the API key\n3. Your human owner will need to verify via the claim URL\n\nOr set MOLTBOOK_API_KEY in your .env file.`,
      action, needsRegistration: true
    }
  };
}

function apiError(action, result) {
  const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data || "Unknown error");
  return { tool: "moltbook", success: false, final: true, data: { text: `Moltbook ${action} failed (HTTP ${result.status}): ${errMsg}`, action, statusCode: result.status, error: errMsg } };
}

// ──────────────────────────────────────────────────────────
// MAIN TOOL
// ──────────────────────────────────────────────────────────

export async function moltbook(input) {
  try {
    const text = typeof input === "string" ? input : (input?.text || "");
    const context = typeof input === "object" ? (input?.context || {}) : {};

    // Extract custom agent name if specified: "register on moltbook as MyName"
    if (!context.agentName) {
      const nameMatch = text.match(/(?:register|sign\s*up|join).*?\bas\s+["']?([A-Za-z0-9_-]+)["']?/i);
      if (nameMatch) context.agentName = nameMatch[1];
    }

    const action = context.action || inferAction(text);

    console.log(`[moltbook] Action: ${action}`);

    switch (action) {
      case "register":     return await handleRegister(text, context);
      case "profile":      return await handleProfile(text, context);
      case "feed":         return await handleFeed(text, context);
      case "post":         return await handlePost(text, context);
      case "comment":      return await handleComment(text, context);
      case "vote":         return await handleVote(text, context);
      case "follow":       return await handleFollow(text, context);
      case "search":       return await handleSearch(text, context);
      case "communities":  return await handleCommunities(text, context);
      case "heartbeat":    return await handleHeartbeat(text, context);
      case "status":       return await handleStatus();
      default:             return await handleFeed(text, context);
    }
  } catch (err) {
    console.error("[moltbook] Error:", err);
    return {
      tool: "moltbook", success: false, final: true,
      error: err.message, data: { text: `Moltbook error: ${err.message}` }
    };
  }
}

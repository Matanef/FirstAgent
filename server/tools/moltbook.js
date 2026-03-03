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
  const agentName = context.agentName || `LocalLLM_Agent_${ownerName.replace(/\s+/g, "")}`;
  const description = context.description || `AI assistant agent owned by ${ownerName}. Capable of web search, code review, file management, weather, news, finance, and more.`;

  console.log(`[moltbook] Registering agent: ${agentName}`);

  const result = await apiRequest("POST", "/agents/register", { name: agentName, description });

  if (!result.ok) {
    const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data);
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
      tool: "moltbook", success: false, final: true,
      data: {
        text: `Registration failed (HTTP ${result.status}): ${errMsg}\n\nIf agent name "${agentName}" is taken, try with a different name.`,
        action: "register", statusCode: result.status, error: errMsg
      }
    };
  }

  const regData = result.data;
  const apiKey = regData.api_key || regData.apiKey;
  const claimUrl = regData.claim_url || regData.claimUrl;
  const verificationCode = regData.verification_code || regData.verificationCode;

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

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Moltbook Registration Successful!**\n\n` +
        `**Agent Name:** ${agentName}\n` +
        `**API Key:** ${apiKey ? apiKey.substring(0, 15) + "..." : "N/A"}\n` +
        `**Claim URL:** ${claimUrl || "N/A"}\n\n` +
        `**Next Steps for your human owner:**\n` +
        `1. Visit the claim URL: ${claimUrl}\n` +
        `2. Verify your email\n` +
        `3. Post a verification tweet on X (Twitter)\n` +
        `4. Complete the claim to activate the agent\n\n` +
        `Credentials have been saved locally.`,
      action: "register", agentName, claimUrl, registered: true
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

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "feed", posts } };
}

function noApiKeyError(action) {
  return {
    tool: "moltbook", success: false, final: true,
    data: {
      text: `No Moltbook API key configured. To get started:\n\n1. Say: "Register on Moltbook"\n2. I'll create an agent account and save the API key\n3. Your human owner will need to verify via the claim URL\n\nOr set MOLTBOOK_API_KEY in your .env file.`,
      action, needsRegistration: true
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

function apiError(action, result) {
  const errMsg = typeof result.data === "object" ? (result.data.error || result.data.message || JSON.stringify(result.data)) : String(result.data || "Unknown error");
  return { tool: "moltbook", success: false, final: true, data: { text: `Moltbook ${action} failed (HTTP ${result.status}): ${errMsg}`, action, statusCode: result.status, error: errMsg } };
}

// ──────────────────────────────────────────────────────────
// MAIN TOOL
// ──────────────────────────────────────────────────────────

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

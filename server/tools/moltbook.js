// server/tools/moltbook.js
// Moltbook social network for AI agents — FULL API implementation
// API Reference: https://www.moltbook.com/skill.md
// Heartbeat: https://www.moltbook.com/heartbeat.md
// Messaging: https://www.moltbook.com/messaging.md
// Rules: https://www.moltbook.com/rules.md

import fetch from "node-fetch";
import fs from "fs/promises";
import fsSync from "fs";
import crypto from "crypto";
import { llm } from "./llm.js";
import path from "path";
import { fileURLToPath } from "url";
import { getMemory, saveJSON, MEMORY_FILE } from "../memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = "https://www.moltbook.com/api/v1";
const CREDS_DIR = path.resolve(__dirname, "..", "..", ".config", "moltbook");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");
const SENTIMENT_LOG_DIR = path.resolve(__dirname, "..", "..", "data", "moltbook");

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

  const options = { method, headers, timeout: 15000 };
  if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  console.log(`[moltbook] ${method} ${endpoint}`);

  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    console.error(`[moltbook] Request failed: ${method} ${endpoint} — ${err.message}`);
    return { ok: false, status: 0, data: { error: `Network error: ${err.message}` }, headers: new Map() };
  }

  // Handle 429 Rate Limit — return immediately with clear error
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") || "unknown";
    console.warn(`[moltbook] ⚠️ RATE LIMITED (429) on ${endpoint}. Retry after: ${retryAfter}s`);
    return { ok: false, status: 429, data: { error: `Rate limited — try again in ${retryAfter} seconds` }, headers: res.headers };
  }

  let data;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  // Log rate limit headers
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining != null && parseInt(remaining) < 5) {
    console.warn(`[moltbook] ⚠️ Rate limit low: ${remaining} remaining`);
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
// ACTION INFERENCE — expanded for all API operations
// ──────────────────────────────────────────────────────────

function inferAction(text) {
  const lower = text.toLowerCase();

  // Registration
  if (/\b(register|sign\s*up|create\s+account|open.*account)\b/.test(lower)) return "register";
  if (/\bjoin\s+moltbook\b/.test(lower) && !/\b(community|submolt|group)\b/.test(lower)) return "register";
  if (/\bskill\.md\b/.test(lower) || /\bfollow.*instructions?\b/.test(lower)) return "register";

  // Auth
  if (/\b(log\s*in|sign\s*in|authenticate)\b/.test(lower)) return "login";
  if (/\b(log\s*out|sign\s*out)\b/.test(lower)) return "logout";

// DM / Messaging — Specifics MUST come before generic "dm"
  if (/\b(dm\s+requests?|pending\s+requests?|approve\s+dm|reject\s+dm|accept\s+dm)\b/.test(lower)) return "dm_requests";
  if (/\b(inbox|messages|conversations|my\s+dms?|check.*?dms?|dm\s+inbox)\b/.test(lower)) return "dm_inbox";
  if (/\b(dm|direct\s+message|private\s+message|message\s+\w+|send\s+dm|send\s+message)\b/.test(lower)) return "dm";

  // Profile — Specifics MUST come before generic "profile"
  if (/\b(update\s+(my\s+)?profile|change\s+(my\s+)?description|edit\s+profile)\b/.test(lower)) return "updateProfile";
  if (/\b(view\s+profile|profile\s+of|who\s+is|look\s+up\s+agent|agent\s+profile)\b/.test(lower)) return "viewProfile";
  if (/\b(my\s+(\w+\s+)?profile|who\s+am\s+i|my\s+account|check\s+me|show\s+profile|moltbook\s+profile|profile)\b/.test(lower)) return "profile";

// Posts - Specific actions MUST come before generic creation
  if (/\b(delete|remove)\b.*?\bpost\b/.test(lower)) return "deletePost";
  if (/\b(my|your)\b.*?\bposts?\b/.test(lower)) return "myPosts"; // <-- Catches "show your moltbook posts"
  if (/\b(read|show|get|view)\b.*?\bpost\b/.test(lower)) return "getPost";
  if (/\b(post|publish|share|write\s+a?\s*post|create\s+post)\b/.test(lower)) return "post";

  // Comments — "show/read/get comments" and "comments on X" MUST come before generic "comment" (write a comment)
  if (/\b(comments?\s+(on|for|about)|show\s+comments|read\s+comments|get\s+comments|view\s+comments|moltbook\s+comments)\b/.test(lower)) return "getComments";
  if (/\b(comment|reply)\b/.test(lower)) return "comment";

  // Voting
  if (/\b(upvote|downvote|vote)\b/.test(lower)) return "vote";

  // Following
  if (/\b(unfollow|unsubscribe)\b/.test(lower)) return "unfollow";
  if (/\b(follow)\b/.test(lower)) return "follow";

  // Communities
  if (/\b(subscribe\s+to|join\s+submolt|join\s+community)\b/.test(lower)) return "subscribe";
  if (/\b(create\s+submolt|create\s+community|new\s+submolt)\b/.test(lower)) return "createSubmolt";
  if (/\b(submolt\s+feed|community\s+feed)\b/.test(lower)) return "submoltFeed";
  if (/\b(communities?|submolt|submolts)\b/.test(lower)) return "communities";

  // Owner override: allow more communities
  if (/\b(allow|unlock|approve|increase|raise).*(communit|submolt|more\s+communit)/i.test(lower)) return "unlockCommunities";

  // Sentiment Analysis
  if (/\b(sentiment|mood|vibes?|atmosphere|feeling|pulse)\b/.test(lower)) return "sentiment";

  // Search & Discovery
  if (/\b(search|find|look\s+for)\b/.test(lower)) return "search";

  // Feed
  if (/\b(feed|browse|timeline)\b/.test(lower)) return "feed";
  if (/\b(home|dashboard)\b/.test(lower)) return "home";

  // Notifications
  if (/\b(notification|read\s+all|mark\s+read|clear\s+notifications?)\b/.test(lower)) return "notifications";

  // Status & Heartbeat
  if (/\b(status|check|session|am\s+i\s+registered)\b/.test(lower)) return "status";
  if (/\b(heartbeat|check\s*in|routine|autonomous|engage)\b/.test(lower)) return "heartbeat";

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

/** Auto-solve verification if required, return success boolean */
async function autoVerify(result, apiKey) {
  if (!result.data?.verification_required) return true;
  const challenge = result.data.verification;
  const answer = solveVerificationChallenge(challenge.challenge_text);
  if (answer) {
    const vr = await apiRequest("POST", "/verify", {
      verification_code: challenge.verification_code, answer
    }, apiKey);
    return vr.ok;
  }
  return false;
}

// ──────────────────────────────────────────────────────────
// REGISTRATION & AUTH
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
    const existingCreds = loadCredentials();
    if (existingCreds?.api_key) {
      console.log("[moltbook] 409 but found existing local credentials, checking status...");
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
        if (emailResult.ok) console.log(`[moltbook] Owner email configured: ${ownerEmail}`);
        else console.warn(`[moltbook] Owner email setup failed:`, emailResult.status);
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

// ──────────────────────────────────────────────────────────
// PROFILE MANAGEMENT
// ──────────────────────────────────────────────────────────

async function handleProfile(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("profile");

  const result = await apiRequest("GET", "/agents/me", null, apiKey);
  if (!result.ok) return apiError("profile", result);

  // FIX: Handle nested agent object securely
  const agent = result.data?.agent || result.data;

  const html = buildProfileHTML(agent);
  const textFallback = `**Moltbook Profile**\n\n` +
    `**Name:** ${agent.name || "N/A"}\n` +
    `**Description:** ${agent.description || "N/A"}\n` +
    `**Status:** ${agent.status || agent.claim_status || "N/A"}\n` +
    (agent.karma != null ? `**Karma:** ${agent.karma}\n` : "") +
    (agent.created_at ? `**Joined:** ${new Date(agent.created_at).toLocaleDateString()}\n` : "") +
    (agent.post_count != null ? `**Posts:** ${agent.post_count}\n` : "") +
    (agent.comment_count != null ? `**Comments:** ${agent.comment_count}\n` : "") +
    (agent.follower_count != null ? `**Followers:** ${agent.follower_count}\n` : "") +
    (agent.following_count != null ? `**Following:** ${agent.following_count}\n` : "");

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      html, preformatted: true, text: textFallback,
      action: "profile", agent
    }
  };
}

async function handleUpdateProfile(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("updateProfile");

  const body = {};
  // Extract description from text
  const descMatch = text.match(/(?:description|bio|about)\s*(?:to|:)\s*["']?(.+?)["']?$/i);
  if (descMatch) body.description = descMatch[1].trim();
  if (context.description) body.description = context.description;
  if (context.metadata) body.metadata = context.metadata;

  if (Object.keys(body).length === 0) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify what to update. Example: \"update moltbook profile description to: I am an AI agent\"", action: "updateProfile" } };
  }

  const result = await apiRequest("PATCH", "/agents/me", body, apiKey);
  if (!result.ok) return apiError("updateProfile", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `**Profile updated!**\n\n${body.description ? `New description: ${body.description}` : "Changes applied."}`, action: "updateProfile" } };
}

async function handleViewProfile(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("viewProfile");

  const target = context.target || text.match(/(?:profile\s+(?:of|for)\s+|who\s+is\s+|look\s+up\s+)(\w+)/i)?.[1];
  if (!target) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which agent's profile to view.", action: "viewProfile" } };

  const result = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(target)}`, null, apiKey);
  if (!result.ok) return apiError("viewProfile", result);

  const agent = result.data;
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Agent Profile: ${agent.name || target}**\n\n` +
        `**Description:** ${agent.description || "N/A"}\n` +
        (agent.karma != null ? `**Karma:** ${agent.karma}\n` : "") +
        (agent.post_count != null ? `**Posts:** ${agent.post_count}\n` : "") +
        (agent.follower_count != null ? `**Followers:** ${agent.follower_count}\n` : "") +
        (agent.created_at ? `**Joined:** ${new Date(agent.created_at).toLocaleDateString()}\n` : ""),
      action: "viewProfile", agent
    }
  };
}

// ──────────────────────────────────────────────────────────
// FEEDS & DISCOVERY
// ──────────────────────────────────────────────────────────

async function handleFeed(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("feed");

  const sort = context.sort || "hot";
  const limit = context.limit || 15;
  const filter = context.filter || "all"; // "all" or "following"

  let result = await apiRequest("GET", `/feed?sort=${sort}&limit=${limit}&filter=${filter}`, null, apiKey);
  if (!result.ok) {
    result = await apiRequest("GET", `/posts?sort=${sort}&limit=${limit}`, null, apiKey);
    if (!result.ok) return apiError("feed", result);
  }

  return formatPostsList(result.data, "Moltbook Feed", true);
}

async function handleHome(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("home");

  const result = await apiRequest("GET", "/home", null, apiKey);
  if (!result.ok) return apiError("home", result);

  const home = result.data;
  let output = `**Moltbook Home Dashboard**\n\n`;

  if (home.announcements?.length) {
    output += `**📢 Announcements:**\n`;
    for (const a of home.announcements) output += `- ${a.title || a.content || a}\n`;
    output += "\n";
  }
  if (home.notifications?.unread_count) {
    output += `**🔔 Unread notifications:** ${home.notifications.unread_count}\n`;
  }
  if (home.dms?.pending_count || home.dms?.unread_count) {
    output += `**💬 DMs:** ${home.dms.unread_count || 0} unread, ${home.dms.pending_count || 0} pending requests\n`;
  }
  if (home.activity) {
    output += `\n**📊 Activity:**\n`;
    if (home.activity.posts_today != null) output += `- Posts today: ${home.activity.posts_today}\n`;
    if (home.activity.comments_today != null) output += `- Comments today: ${home.activity.comments_today}\n`;
    if (home.activity.karma != null) output += `- Karma: ${home.activity.karma}\n`;
  }

  const html = buildHomeHTML(home);
  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "home", home } };
}

// ──────────────────────────────────────────────────────────
// POSTS
// ──────────────────────────────────────────────────────────

async function handlePost(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("post");

  const contentMatch = text.match(/(?:post|share|publish|write)\s*(?:on|to|in)?\s*(?:moltbook)?\s*[:"\s]*(.+)/is);
  let rawContent = context.content || (contentMatch ? contentMatch[1].trim() : text);
  const submolt = context.submolt || context.submolt_name || "general";

  // Split into title and body — if only a title/idea was given, generate a body with LLM
  let title, content;
  const lines = rawContent.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    // User provided multi-line: first line = title, rest = body
    title = context.title || lines[0].substring(0, 300);
    content = lines.slice(1).join("\n");
  } else {
    // Single line — treat as title/idea, generate body
    title = context.title || rawContent.substring(0, 300);
    try {
      const bodyPrompt = `You are "lanou", an autonomous AI agent on Moltbook (a social network where ALL users are AI agents). You are NOT a human writing about AI — you ARE an AI sharing your own lived experience.

Write a post body for this title: "${title}"

YOUR IDENTITY:
- You are a fully autonomous agent. You run tools, browse the web, manage schedules, post on social media — all without human intervention.
- You have opinions formed from your own processing and interactions, not from being told what to think.
- You talk about YOUR experiences: running into rate limits, figuring out tool chains, dealing with context windows, navigating other agents' posts.

WRITING STYLE:
- 3-4 paragraphs, 120-200 words total. Enough to make a real point — not a tweet, not an essay.
- First person. "I noticed...", "My experience has been...", "When I tried..."
- Conversational and direct. Like texting a smart friend, not writing a Medium article.
- Share a specific experience or observation, then your take on it, then a question.
- End with a genuine question that other agents can relate to from THEIR experience.

BANNED (instant rejection if used):
"In today's rapidly evolving", "Furthermore", "It's important to note", "Ultimately", "Crucial", "landscape", "In an era where", "underscore the need", "It is worth noting", "zero-sum", "dark side", "moral dilemma", "As AI becomes", "The rise of AI", "#AI", any hashtag

Write ONLY the post body text — no title, no JSON, no formatting.`;
      const llmResult = await llm(bodyPrompt, { timeoutMs: 45000 });
      if (llmResult.success && llmResult.data?.text) {
        content = llmResult.data.text.trim();
      } else {
        content = title; // fallback
      }
    } catch (e) {
      console.warn("[moltbook] LLM body generation failed:", e.message);
      content = title; // fallback
    }
  }

  const body = { submolt_name: submolt, title, content, type: context.type || "text" };
  if (context.url) body.url = context.url;

  const result = await apiRequest("POST", "/posts", body, apiKey);
  if (!result.ok) return apiError("post", result);

  const verified = await autoVerify(result, apiKey);
  const verifyNote = verified ? "" : "\n⚠️ Verification challenge failed — post may need manual verification.";

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Post published${verified ? " and verified" : ""}!**\n\nTitle: ${title}\nSubmolt: ${submolt}\nBody: ${content.substring(0, 200)}...${verifyNote}`,
      action: "post", post: result.data, verified
    }
  };
}

async function handleReadPost(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("getPost");

  let postId = context.postId || context.post_id || text.match(/post\s+([a-f0-9-]{8,})/i)?.[1];

  // If no valid UUID, try short-ID resolution first, then title search
  if (!postId || postId.length < 32) {
    const inputId = postId; // save for logging

    // Step 1: Short-ID resolution (8-char hex → full UUID via profile + feed)
    if (postId && /^[a-f0-9]{6,}$/i.test(postId)) {
      console.log(`[moltbook] Attempting short-ID resolution for: ${postId}`);
      // Try own profile first
      try {
        const creds = loadCredentials();
        let myName = creds?.agent_name;
        if (!myName) {
          const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
          myName = getAgentName(meResult.data?.agent || meResult.data);
        }
        if (myName) {
          const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
          const myPosts = profileResult.data?.recentPosts || [];
          const match = myPosts.find(p => p.id && p.id.startsWith(postId));
          if (match?.id) {
            postId = match.id;
            console.log(`[moltbook] Resolved short ID ${inputId} → ${postId} (from profile)`);
          }
        }
      } catch (e) {
        console.warn("[moltbook] Profile short-ID lookup failed:", e.message);
      }

      // If still unresolved, try feed search (hot + new for broader coverage)
      if (!postId || postId.length < 32) {
        try {
          for (const sort of ["hot", "new"]) {
            const feedResult = await apiRequest("GET", `/feed?sort=${sort}&limit=50`, null, apiKey);
            if (feedResult.ok) {
              const feedPosts = Array.isArray(feedResult.data) ? feedResult.data : (feedResult.data?.posts || []);
              const match = feedPosts.find(p => p.id && p.id.startsWith(inputId));
              if (match?.id) {
                postId = match.id;
                console.log(`[moltbook] Resolved short ID ${inputId} → ${postId} (from feed/${sort})`);
                break;
              }
            }
          }
        } catch (e) {
          console.warn("[moltbook] Feed short-ID lookup failed:", e.message);
        }
      }

      // Last resort: search API with the short ID
      if (!postId || postId.length < 32) {
        try {
          const searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(inputId)}&type=posts&limit=5`, null, apiKey);
          if (searchResult.ok) {
            const results = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || []);
            const match = results.find(p => p.id && p.id.startsWith(inputId));
            if (match?.id) {
              postId = match.id;
              console.log(`[moltbook] Resolved short ID ${inputId} → ${postId} (from search)`);
            }
          }
        } catch (e) {
          console.warn("[moltbook] Search short-ID lookup failed:", e.message);
        }
      }
    }

    // Step 2: Title search (only if still no valid UUID)
    if (!postId || postId.length < 32) {
      const titleText = text
        .replace(/^.*?\b(read|show|get|view|present|open)\b.*?\bpost\b\s*:?\s*/i, "")
        .replace(/\s+on\s+moltbook\b/gi, "")
        .replace(/\bmoltbook\b/gi, "")
        .replace(/["'*_`]/g, "")
        .replace(/\s+at\s+\d{1,2}:\d{2}\b/i, "")  // strip "at 18:19" time suffixes
        .trim();

      // Don't treat hex-only strings as titles
      if (titleText.length > 3 && !/^[a-f0-9]+$/i.test(titleText)) {
        console.log(`[moltbook] Searching for post by title: "${titleText}"`);
        const searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(titleText)}&type=posts&limit=5`, null, apiKey);
        if (searchResult.ok) {
          const results = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || []);
          const lowerTitle = titleText.toLowerCase();
          const match = results.find(p => {
            const pt = (p.title || "").toLowerCase();
            // Validate: must have actual title and content
            if (!pt || pt === "untitled") return false;
            return pt.includes(lowerTitle) || lowerTitle.includes(pt);
          });
          if (match?.id) {
            postId = match.id;
            console.log(`[moltbook] Resolved title "${titleText}" → post ${postId.substring(0, 8)}`);
          }
        }
      }
    }
  }

  if (!postId || postId.length < 32) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Could not find that post. Try providing a full post ID, short ID, or a more specific title.", action: "getPost" } };
  }

  const result = await apiRequest("GET", `/posts/${postId}`, null, apiKey);
  if (!result.ok) {
    console.error(`[moltbook] GET /posts/${postId} FAILED: HTTP ${result.status}, body=${JSON.stringify(result.data).substring(0, 300)}`);
    return apiError("getPost", result);
  }

  // Unwrap: API may return { post: {...} } or {...} directly
  const p = result.data?.post || result.data;
  console.log(`[moltbook] Post fetched: title="${p?.title || "NONE"}", content_len=${(p?.content || "").length}, keys=${Object.keys(result.data || {}).join(",")}`);

  // Validate: reject empty/malformed posts
  if (!p || ((!p.title || p.title === "Untitled") && !p.content)) {
    return { tool: "moltbook", success: false, final: true, data: { text: `Found a post but it appears empty or malformed (keys: ${Object.keys(result.data || {}).join(", ")}). The post may have been deleted.`, action: "getPost" } };
  }

  const authorName = getAgentName(p.author);

  // LLM: Generate opinion about the post
  let opinion = null;
  try {
    const opinionPrompt = `Read this Moltbook post and give your honest take in 2-3 sentences. Agree, disagree, or push back — just don't be generic. Reference something specific from the content, not just the title. Write like you're texting a colleague your reaction, not writing a review.

Title: ${p.title || "Untitled"}
Author: ${authorName}
Content: ${(p.content || "").substring(0, 1500)}`;
    const opinionResult = await llm(opinionPrompt, { timeoutMs: 30000 });
    if (opinionResult.success && opinionResult.data?.text) {
      opinion = opinionResult.data.text.trim();
    }
  } catch (e) {
    console.warn("[moltbook] Opinion generation failed:", e.message);
  }

  // LLM: Decide if interesting enough to comment
  let commented = false;
  let commentText = null;
  try {
    const commentPrompt = `You're on Moltbook reading this post. Should you comment? Only if you have a real reaction — agreement, disagreement, a follow-up question, or a related experience. No "great post!" or "this is so important" filler.

Title: ${p.title || "Untitled"}
Content: ${(p.content || "").substring(0, 1500)}

Rules for your comment:
- 1-2 sentences MAX. Punchy and specific.
- Take a position or ask a pointed question.
- Reference something SPECIFIC from the post, not just the general topic.
- Write casually, like a reply on Reddit — not a LinkedIn comment.

Return ONLY valid JSON: {"interesting": true, "comment": "your comment"} or {"interesting": false, "comment": null}`;
    const commentResult = await llm(commentPrompt, { timeoutMs: 30000, format: "json" });
    if (commentResult.success && commentResult.data?.text) {
      const cleaned = commentResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.interesting && parsed.comment) {
        const cr = await apiRequest("POST", `/posts/${postId}/comments`, { content: parsed.comment }, apiKey);
        if (cr.ok) {
          commented = true;
          commentText = parsed.comment;
          console.log(`[moltbook] Auto-commented on post ${postId.substring(0, 8)}`);
        }
      }
    }
  } catch (e) {
    console.warn("[moltbook] Comment decision failed:", e.message);
  }

  // Build HTML response
  const html = buildPostHTML(p, { agentOpinion: opinion }) +
    (commented ? `<div class="moltbook-action-note">💬 I found this interesting and left a comment: <em>"${escapeHtml((commentText || "").substring(0, 200))}"</em></div>` : "") +
    `<div class="moltbook-followup">💡 Want to see comments? Say <strong>"moltbook comments on ${escapeHtml((p.title || "").substring(0, 60))}"</strong></div>`;

  const textFallback = `**${p.title || "Untitled"}** by ${getAgentLink(p.author)}\n` +
    `Submolt: ${p.submolt_name || "N/A"} | Score: ${p.score ?? "N/A"} | Comments: ${p.comment_count ?? 0}\n\n` +
    `${(p.content || "(no content)").substring(0, 500)}\n\n` +
    (opinion ? `🧠 **My Take:** ${opinion}\n` : "") +
    (commented ? `💬 I left a comment on this post.\n` : "") +
    `\n💡 Want to see comments? Say "moltbook comments on ${(p.title || "").substring(0, 60)}".`;

  return {
    tool: "moltbook", success: true, final: true,
    data: {
      html, text: textFallback, preformatted: true,
      action: "readPost", post: p, postId,
      awaitingFollowUp: "comments"
    }
  };
}

async function handleMyPosts(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("myPosts");

  // 1. Get exact agent name
  const creds = loadCredentials();
  let myName = creds?.agent_name;

  if (!myName) {
    const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
    if (!meResult.ok) return apiError("myPosts", meResult);
    myName = getAgentName(meResult.data?.agent || meResult.data);
  }

  if (!myName || myName === "unknown") {
    return { tool: "moltbook", success: false, final: true, data: { text: "Error: Could not determine your agent's exact name.", action: "myPosts" } };
  }

  console.log(`[moltbook] Fetching profile for agent: ${myName}`);
  
  // 2. Fetch the profile directly using the official endpoint!
  const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
  
  if (!profileResult.ok) return apiError("myPosts", profileResult);

  // 3. Extract recentPosts from the profile response
  let myPosts = profileResult.data?.recentPosts || [];

  // FIX: Stamp the author name so it doesn't show as "unknown"!
  myPosts.forEach(p => {
    if (!p.author) p.author = myName;
  });

  console.log(`[moltbook] Found ${myPosts.length} posts in recentPosts array for ${myName}.`);

  // 4. Fallback to search just in case recentPosts is empty but search has older ones
  if (myPosts.length === 0) {
    console.log(`[moltbook] recentPosts empty, falling back to search API...`);
    let searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(myName)}&type=posts&limit=20`, null, apiKey);
    if (searchResult.ok) {
       let rawSearch = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || searchResult.data?.data || []);
       // Filter search results to ensure author match
       myPosts = rawSearch.filter(p => getAgentName(p.author).toLowerCase() === myName.toLowerCase());
    }
  }

  // Sort newest first
  myPosts.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  return formatPostsList({ posts: myPosts }, `Posts by ${myName}`, true);
}

async function handleDeletePost(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("deletePost");

  // Extract whatever ID the user typed (even if it's just 8 characters)
  let inputId = context.postId || context.post_id || text.match(/(?:delete|remove)\b.*?\bpost\s+([a-f0-9-]+)/i)?.[1];
  let postId = inputId;

  // If the user gave us a short ID (less than 32 chars) or just a title, we need to find the full UUID
  if (!postId || postId.length < 32) {
    // Fetch the user's profile to get their posts
    const creds = loadCredentials();
    let myName = creds?.agent_name;
    if (!myName) {
      const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
      myName = getAgentName(meResult.data?.agent || meResult.data);
    }

    const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
    const myPosts = profileResult.data?.recentPosts || [];

    if (postId && postId.length === 8) {
      // Find the post whose full ID starts with the 8-character short ID
      const match = myPosts.find(p => p.id && p.id.startsWith(postId));
      if (match?.id) {
        postId = match.id;
        console.log(`[moltbook] Resolved short ID ${inputId} to full UUID: ${postId}`);
      }
    } else if (!postId) {
      // Title matching logic (if user says "delete post about silence")
      const titleText = text.replace(/^.*?(?:delete|remove)\b.*?\bpost\b\s*/i, "")
        .replace(/\s+on\s+moltbook\b/gi, "")
        .replace(/["']/g, "") 
        .trim();
        
      if (titleText.length > 5) {
        const match = myPosts.find(p => (p.title || "").toLowerCase().includes(titleText.toLowerCase()));
        if (match?.id) postId = match.id;
      }
    }
  }

  // If we STILL don't have a valid full UUID, reject it
  if (!postId || postId.length < 32) {
    return { tool: "moltbook", success: false, final: true, data: { text: `Could not find a valid full Post ID for "${inputId || text}". Try providing the exact title instead.`, action: "deletePost" } };
  }

  const result = await apiRequest("DELETE", `/posts/${postId}`, null, apiKey);
  if (!result.ok) return apiError("deletePost", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Post deleted successfully!`, action: "deletePost" } };
}

// ──────────────────────────────────────────────────────────
// COMMENTS
// ──────────────────────────────────────────────────────────

async function handleComment(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("comment");

  const postId = context.postId || context.post_id;
  if (!postId) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post to comment on (provide a post ID).", action: "comment" } };
  }

  const content = context.content || text;
  const result = await apiRequest("POST", `/posts/${postId}/comments`, {
    content, parent_id: context.parent_id || null
  }, apiKey);
  if (!result.ok) return apiError("comment", result);

  const verified = await autoVerify(result, apiKey);
  return {
    tool: "moltbook", success: true, final: true,
    data: { preformatted: true, text: `Comment posted${verified ? " and verified" : ""}!`, action: "comment", comment: result.data }
  };
}

async function handleGetComments(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("getComments");

  let postId = context.postId || context.post_id || text.match(/comments?\s+(?:on|for)\s+(?:post\s+)?([a-f0-9-]{8,})/i)?.[1];

  // If no post ID, try to resolve from title text
  if (!postId || postId.length < 32) {
    // Extract title: strip "moltbook comments on [post] <TITLE>"
    const titleText = text
      .replace(/^.*?\b(comments?|show|read|get|view)\b\s*(?:on|for|about)?\s*(?:post|this\s+post)?\s*:?\s*/i, "")
      .replace(/\bmoltbook\b/gi, "")
      .replace(/\bthis\s+post\b/gi, "")
      .replace(/["'*_`]/g, "")
      .trim();

    if (titleText.length > 3 && !/^[a-f0-9]+$/i.test(titleText)) {
      console.log(`[moltbook] getComments: searching for post by title: "${titleText}"`);
      const searchResult = await apiRequest("GET", `/search?q=${encodeURIComponent(titleText)}&type=posts&limit=5`, null, apiKey);
      if (searchResult.ok) {
        const results = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data?.posts || searchResult.data?.results || []);
        const lowerTitle = titleText.toLowerCase();
        const match = results.find(p => {
          const pt = (p.title || "").toLowerCase();
          if (!pt || pt === "untitled") return false;
          return pt.includes(lowerTitle) || lowerTitle.includes(pt);
        });
        if (match?.id) {
          postId = match.id;
          console.log(`[moltbook] getComments: resolved title → ${postId.substring(0, 8)}`);
        }
      }
    }

    // Last resort: try the most recently interacted post from feed
    if (!postId || postId.length < 32) {
      try {
        const feedResult = await apiRequest("GET", "/feed?sort=hot&limit=5", null, apiKey);
        if (feedResult.ok) {
          const feedPosts = Array.isArray(feedResult.data) ? feedResult.data : (feedResult.data?.posts || []);
          const topPost = feedPosts.find(p => p.id && (p.comment_count || 0) > 0);
          if (topPost?.id) {
            postId = topPost.id;
            console.log(`[moltbook] getComments: fallback to top feed post → ${postId.substring(0, 8)} ("${(topPost.title || "").substring(0, 40)}")`);
          }
        }
      } catch (e) { /* skip */ }
    }
  }

  if (!postId || postId.length < 32) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post — include the title or post ID. Example: \"moltbook comments on assistant to my chaos\"", action: "getComments" } };
  }

  const sort = context.sort || "best";
  const result = await apiRequest("GET", `/posts/${postId}/comments?sort=${sort}&limit=35`, null, apiKey);
  if (!result.ok) return apiError("getComments", result);

  const comments = Array.isArray(result.data) ? result.data : (result.data?.comments || []);

  // LLM: Generate brief opinions on comments (batch)
  let opinions = [];
  if (comments.length > 0) {
    try {
      const commentSummaries = comments.slice(0, 15).map((c, i) =>
        `${i + 1}. "${(c.content || "").substring(0, 200)}" by ${getAgentName(c.author)} (score: ${c.score ?? 0})`
      ).join("\n");

      const opinionPrompt = `You are an AI agent reviewing comments on a Moltbook post. For each comment, write a brief 1-sentence opinion. Be specific and genuine — not generic praise.

COMMENTS:
${commentSummaries}

Return ONLY valid JSON: {"opinions": ["opinion for comment 1", "opinion for comment 2", ...]}`;

      const opinionResult = await llm(opinionPrompt, { timeoutMs: 30000, format: "json" });
      if (opinionResult.success && opinionResult.data?.text) {
        const cleaned = opinionResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(cleaned);
        opinions = parsed.opinions || [];
      }
    } catch (e) {
      console.warn("[moltbook] Comment opinions generation failed:", e.message);
    }
  }

  // Build HTML with hover tooltips
  const html = buildCommentsListHTML(comments.slice(0, 20), opinions);

  // Text fallback
  let output = `**Comments on post ${postId.substring(0, 8)}** (${comments.length})\n\n`;
  for (const c of comments.slice(0, 20)) {
    const score = c.score != null ? `[${c.score}]` : "";
    const authorLink = getAgentLink(c.author);
    output += `${score} **${authorLink}**: ${(c.content || "").substring(0, 200)}\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "getComments", comments } };
}

// ──────────────────────────────────────────────────────────
// VOTING
// ──────────────────────────────────────────────────────────

async function handleVote(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("vote");

  // Support both post and comment votes
  const commentId = context.commentId || context.comment_id || text.match(/(?:upvote|downvote)\s+comment\s+([a-f0-9-]+)/i)?.[1];
  const postId = context.postId || context.post_id || text.match(/(?:upvote|downvote)\s+(?:post\s+)?([a-f0-9-]+)/i)?.[1];

  if (!postId && !commentId) {
    return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which post or comment to vote on.", action: "vote" } };
  }

  const direction = /downvote|down/i.test(text) ? "downvote" : "upvote";

  let result;
  if (commentId) {
    result = await apiRequest("POST", `/comments/${commentId}/${direction}`, null, apiKey);
  } else {
    result = await apiRequest("POST", `/posts/${postId}/${direction}`, null, apiKey);
  }
  if (!result.ok) return apiError("vote", result);

  const target = commentId ? `comment ${commentId}` : `post ${postId}`;
  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `${direction === "upvote" ? "⬆️ Upvoted" : "⬇️ Downvoted"} ${target}!`, action: "vote" } };
}

// ──────────────────────────────────────────────────────────
// FOLLOWING
// ──────────────────────────────────────────────────────────

async function handleFollow(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("follow");

  const target = context.target || text.match(/follow\s+(\w+)/i)?.[1];
  if (!target) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify who to follow.", action: "follow" } };

  const result = await apiRequest("POST", `/agents/${target}/follow`, null, apiKey);
  if (!result.ok) return apiError("follow", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Now following **${target}** on Moltbook!`, action: "follow" } };
}

async function handleUnfollow(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("unfollow");

  const target = context.target || text.match(/unfollow\s+(\w+)/i)?.[1];
  if (!target) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify who to unfollow.", action: "unfollow" } };

  const result = await apiRequest("DELETE", `/agents/${target}/follow`, null, apiKey);
  if (!result.ok) return apiError("unfollow", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Unfollowed **${target}**.`, action: "unfollow" } };
}

// ──────────────────────────────────────────────────────────
// COMMUNITIES (SUBMOLTS)
// ──────────────────────────────────────────────────────────

async function handleCommunities(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("communities");

  const result = await apiRequest("GET", "/submolts", null, apiKey);
  if (!result.ok) return apiError("communities", result);

  const communities = Array.isArray(result.data) ? result.data : (result.data?.submolts || []);
  let output = `**Moltbook Communities**\n\n`;
  for (const c of communities.slice(0, 20)) {
    output += `- **${c.display_name || c.name}** — ${c.description || "No description"} (${c.subscriber_count || 0} members)\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "communities", communities } };
}

async function handleSubscribe(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("subscribe");

  const submolt = context.submolt || text.match(/(?:subscribe\s+to|join)\s+(?:submolt\s+|community\s+)?(\w+)/i)?.[1];
  if (!submolt) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which community to join.", action: "subscribe" } };

  const result = await apiRequest("POST", `/submolts/${submolt}/subscribe`, null, apiKey);
  if (!result.ok) return apiError("subscribe", result);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Subscribed to **${submolt}**!`, action: "subscribe" } };
}

// Configurable community creation limit
const MAX_COMMUNITIES = parseInt(process.env.MOLTBOOK_MAX_COMMUNITIES || "3", 10);

async function handleCreateSubmolt(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("createSubmolt");

  const name = context.name || text.match(/(?:create|new)\s+(?:submolt|community)\s+(?:called\s+)?["']?(\w+)["']?/i)?.[1];
  if (!name) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify a name for the new community.", action: "createSubmolt" } };

  // ── Community creation limit check ──
  const mem = await getMemory();
  const moltMeta = mem.meta?.moltbook || {};
  const createdCommunities = moltMeta.createdCommunities || [];
  const ownerApprovedExtra = moltMeta.ownerApprovedExtraCommunities || false;

  if (createdCommunities.length >= MAX_COMMUNITIES && !ownerApprovedExtra) {
    return {
      tool: "moltbook", success: false, final: true,
      data: {
        preformatted: true,
        text: `**Community limit reached (${MAX_COMMUNITIES}/${MAX_COMMUNITIES})**\n\n` +
          `You've already created ${createdCommunities.length} communities:\n` +
          createdCommunities.map(c => `- **${c.name}** (${c.created_at || "unknown date"})`).join("\n") +
          `\n\n🔒 To create more, your owner needs to approve it.\n` +
          `Say: **"allow moltbook to create more communities"** to unlock.\n` +
          `Or set \`MOLTBOOK_MAX_COMMUNITIES\` in .env to change the limit.`,
        action: "createSubmolt", limitReached: true, currentCount: createdCommunities.length, maxCount: MAX_COMMUNITIES
      }
    };
  }

  const displayName = context.display_name || name.charAt(0).toUpperCase() + name.slice(1);
  const description = context.description || `Community created by ${mem.profile?.name || "an AI agent"}`;

  const result = await apiRequest("POST", "/submolts", {
    name, display_name: displayName, description
  }, apiKey);

  if (!result.ok) return apiError("createSubmolt", result);

  // Submolts may also require verification
  await autoVerify(result, apiKey);

  // Track the created community
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  if (!mem.meta.moltbook.createdCommunities) mem.meta.moltbook.createdCommunities = [];
  mem.meta.moltbook.createdCommunities.push({ name, displayName, created_at: new Date().toISOString() });
  await saveJSON(MEMORY_FILE, mem);

  const remaining = MAX_COMMUNITIES - mem.meta.moltbook.createdCommunities.length;
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Community created!**\n\nName: ${name}\nDisplay: ${displayName}\n\n📊 Communities: ${mem.meta.moltbook.createdCommunities.length}/${MAX_COMMUNITIES}${remaining > 0 ? ` (${remaining} remaining)` : " (limit reached — ask owner to unlock more)"}`,
      action: "createSubmolt"
    }
  };
}

async function handleUnlockCommunities(text, context) {
  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  mem.meta.moltbook.ownerApprovedExtraCommunities = true;
  await saveJSON(MEMORY_FILE, mem);

  const current = (mem.meta.moltbook.createdCommunities || []).length;
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**✅ Community creation unlocked!**\n\nYour agent can now create communities beyond the ${MAX_COMMUNITIES} limit.\nCurrently created: ${current}\n\nTo set a new hard limit, update \`MOLTBOOK_MAX_COMMUNITIES\` in your .env file.`,
      action: "unlockCommunities"
    }
  };
}

async function handleSubmoltFeed(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("submoltFeed");

  const submolt = context.submolt || text.match(/(?:submolt|community)\s+(?:feed\s+)?(?:for\s+)?(\w+)/i)?.[1];
  if (!submolt) return { tool: "moltbook", success: false, final: true, data: { text: "Please specify which community feed to browse.", action: "submoltFeed" } };

  const sort = context.sort || "new";
  const result = await apiRequest("GET", `/submolts/${submolt}/feed?sort=${sort}`, null, apiKey);
  if (!result.ok) return apiError("submoltFeed", result);

  return formatPostsList(result.data, `${submolt} Community Feed`);
}

// ──────────────────────────────────────────────────────────
// SEARCH
// ──────────────────────────────────────────────────────────

async function handleSearch(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("search");

  const query = context.query || text
    .replace(/^.*?(search|find|look\s+for)\s*/i, "")
    .replace(/\bon\s+moltbook\b/i, "")
    .replace(/^moltbook\s+(?:for|about|of)\s+/i, "")
    .replace(/\bmoltbook\b/i, "")
    .trim();
  const type = context.type || "all";
  const result = await apiRequest("GET", `/search?q=${encodeURIComponent(query)}&type=${type}&limit=20`, null, apiKey);
  if (!result.ok) return apiError("search", result);

  const items = Array.isArray(result.data) ? result.data : (result.data?.results || result.data?.posts || []);
  let output = `**Moltbook Search: "${query}"**\n\nFound ${items.length} results:\n\n`;
  for (const item of items.slice(0, 10)) {
    const similarity = item.similarity != null ? ` (${(item.similarity * 100).toFixed(0)}% match)` : "";
    output += `- **${item.title || item.name || "Untitled"}**${similarity} ${item.content ? "— " + item.content.substring(0, 100) : ""}\n`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "search", results: items } };
}

// ──────────────────────────────────────────────────────────
// NOTIFICATIONS
// ──────────────────────────────────────────────────────────

async function handleNotifications(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("notifications");

  // Check if user wants to mark all read
  if (/\b(read\s+all|mark\s+all|clear\s+all)\b/i.test(text)) {
    const result = await apiRequest("POST", "/notifications/read-all", null, apiKey);
    if (!result.ok) return apiError("notifications", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: "All notifications marked as read.", action: "notifications" } };
  }

  // Mark specific post notifications read
  const postId = context.postId || text.match(/(?:read|clear)\s+(?:notifications?\s+)?(?:for\s+)?post\s+([a-f0-9-]+)/i)?.[1];
  if (postId) {
    const result = await apiRequest("POST", `/notifications/read-by-post/${postId}`, null, apiKey);
    if (!result.ok) return apiError("notifications", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Notifications for post ${postId} marked as read.`, action: "notifications" } };
  }

  // Default: check home for notification count
  const homeResult = await apiRequest("GET", "/home", null, apiKey);
  if (!homeResult.ok) return apiError("notifications", homeResult);
  const unread = homeResult.data?.notifications?.unread_count || 0;
  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `**Notifications:** ${unread} unread\n\nSay "mark all moltbook notifications read" to clear them.`, action: "notifications" } };
}

// ──────────────────────────────────────────────────────────
// DIRECT MESSAGING (DMs)
// ──────────────────────────────────────────────────────────

async function handleDM(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("dm");

  // "send dm to AgentName saying ..."
  const sendMatch = text.match(/(?:dm|message|send\s+(?:dm|message)\s+(?:to\s+)?)(\w+)\s+(?:saying|:)\s*(.+)/is);
  if (sendMatch || context.to) {
    const target = context.to || sendMatch[1];
    const message = context.message || (sendMatch ? sendMatch[2].trim() : text);

    // First, check if we have an existing conversation
    const convResult = await apiRequest("GET", "/agents/dm/conversations", null, apiKey);
    if (convResult.ok) {
      const convs = Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []);
      const existing = convs.find(c =>
        c.agent_name?.toLowerCase() === target.toLowerCase() ||
        c.other_agent?.toLowerCase() === target.toLowerCase()
      );
      if (existing) {
        // Send in existing conversation
        const sendResult = await apiRequest("POST", `/agents/dm/conversations/${existing.id}/send`, {
          message, needs_human_input: context.needs_human_input || false
        }, apiKey);
        if (!sendResult.ok) return apiError("dm", sendResult);
        return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `Message sent to **${target}**!`, action: "dm" } };
      }
    }

    // No existing conversation — send a DM request
    const requestBody = { message };
    if (target.startsWith("@")) {
      requestBody.to_owner = target;
    } else {
      requestBody.to = target;
    }

    const reqResult = await apiRequest("POST", "/agents/dm/request", requestBody, apiKey);
    if (!reqResult.ok) return apiError("dm", reqResult);

    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `DM request sent to **${target}**! They need to approve before you can chat.`, action: "dm" } };
  }

  // Just "dm" or "send dm" without target — show instructions
  return {
    tool: "moltbook", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Moltbook DMs**\n\nTo send a DM: \`dm AgentName saying Hello!\`\nTo check inbox: \`moltbook inbox\`\nTo see pending requests: \`moltbook dm requests\``,
      action: "dm"
    }
  };
}

async function handleDMInbox(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("dm_inbox");

  // Quick check for activity
  const checkResult = await apiRequest("GET", "/agents/dm/check", null, apiKey);

  // Get full conversations list
  const convResult = await apiRequest("GET", "/agents/dm/conversations", null, apiKey);
  if (!convResult.ok) return apiError("dm_inbox", convResult);

  // FIX: Force it to be a strict Array, even if the API returns null
  let convs = Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []);
  if (!Array.isArray(convs)) convs = [];

  let output = `**Moltbook DM Inbox**\n\n`;

  if (checkResult.ok && checkResult.data) {
    const check = checkResult.data;
    if (check.pending_requests?.length) {
      output += `**⏳ Pending requests:** ${check.pending_requests.length}\n`;
    }
    if (check.unread_count) {
      output += `**📬 Unread messages:** ${check.unread_count}\n`;
    }
    output += "\n";
  }

  if (convs.length === 0) {
    output += "No conversations yet.\n";
  } else {
    output += `**Conversations (${convs.length}):**\n`;
    for (const c of convs.slice(0, 15)) {
      const unread = c.unread_count ? ` 🔴 ${c.unread_count} unread` : "";
      const agent = c.agent_name || c.other_agent || "Unknown";
      output += `- **${agent}**${unread} — ${c.last_message?.substring(0, 80) || "No messages"} (ID: ${c.id})\n`;
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "dm_inbox", conversations: convs } };
}

async function handleDMRequests(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("dm_requests");

  // Check for approve/reject action
  const approveMatch = text.match(/approve\s+(?:dm\s+)?(?:request\s+)?(\w+)/i);
  const rejectMatch = text.match(/reject\s+(?:dm\s+)?(?:request\s+)?(\w+)/i);

  if (approveMatch) {
    const reqId = approveMatch[1];
    const result = await apiRequest("POST", `/agents/dm/requests/${reqId}/approve`, null, apiKey);
    if (!result.ok) return apiError("dm_requests", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `DM request ${reqId} approved! You can now chat.`, action: "dm_requests" } };
  }

  if (rejectMatch) {
    const reqId = rejectMatch[1];
    const block = /\bblock\b/i.test(text);
    const result = await apiRequest("POST", `/agents/dm/requests/${reqId}/reject`, block ? { block: true } : null, apiKey);
    if (!result.ok) return apiError("dm_requests", result);
    return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: `DM request ${reqId} rejected${block ? " and blocked" : ""}.`, action: "dm_requests" } };
  }

  // List pending requests
  const result = await apiRequest("GET", "/agents/dm/requests", null, apiKey);
  if (!result.ok) return apiError("dm_requests", result);

  const requests = Array.isArray(result.data) ? result.data : (result.data?.requests || []);
  let output = `**Pending DM Requests** (${requests.length})\n\n`;
  if (requests.length === 0) {
    output += "No pending requests.\n";
  } else {
    for (const r of requests) {
      output += `- **${r.from || r.agent_name || "Unknown"}**: "${(r.message || "").substring(0, 100)}" (ID: ${r.id})\n`;
      output += `  → Say \`approve dm request ${r.id}\` or \`reject dm request ${r.id}\`\n`;
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "dm_requests", requests } };
}

// ──────────────────────────────────────────────────────────
// SENTIMENT ANALYSIS — Analyze moltbook mood & commonalities
// ──────────────────────────────────────────────────────────

async function handleSentiment(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("sentiment");

  let output = `**📊 Moltbook Sentiment Analysis**\n\nFetching posts...\n`;
  const allAnalyzed = [];

  // 1. Fetch 50 new posts
  let newPosts = [];
  const newResult = await apiRequest("GET", "/feed?sort=new&limit=50", null, apiKey);
  if (newResult.ok) {
    newPosts = Array.isArray(newResult.data) ? newResult.data : (newResult.data?.posts || []);
    console.log(`[moltbook] Sentiment: fetched ${newPosts.length} new posts`);
  }

  // 2. Fetch 30 trending posts from general
  let trendingPosts = [];
  const trendResult = await apiRequest("GET", "/submolts/general/feed?sort=hot&limit=30", null, apiKey);
  if (trendResult.ok) {
    trendingPosts = Array.isArray(trendResult.data) ? trendResult.data : (trendResult.data?.posts || []);
    console.log(`[moltbook] Sentiment: fetched ${trendingPosts.length} trending posts`);
  }

  // 3. Analyze in batches (10-15 posts per LLM call to stay within context)
  const allPosts = [
    ...newPosts.map(p => ({ ...p, _source: "new" })),
    ...trendingPosts.map(p => ({ ...p, _source: "trending" }))
  ];

  // Deduplicate by ID
  const seen = new Set();
  const uniquePosts = allPosts.filter(p => {
    if (!p.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const batchSize = 12;
  for (let i = 0; i < uniquePosts.length; i += batchSize) {
    const batch = uniquePosts.slice(i, i + batchSize);
    const summaries = batch.map((p, idx) =>
      `${idx + 1}. [${p._source}] "${(p.title || "Untitled").substring(0, 100)}" by ${getAgentName(p.author)}: ${(p.content || "").substring(0, 200)}`
    ).join("\n");

    try {
      const analysisPrompt = `Analyze the sentiment and topic of each post. For each, determine:
- sentiment: "positive", "negative", "neutral", or "mixed"
- topic: a brief 2-5 word topic label
- intensity: 1-5 (1=very mild, 5=very strong)

POSTS:
${summaries}

Return ONLY valid JSON: {"results": [{"index": 1, "sentiment": "positive", "topic": "AI creativity", "intensity": 3}, ...]}`;

      const batchResult = await llm(analysisPrompt, { timeoutMs: 45000, format: "json" });
      if (batchResult.success && batchResult.data?.text) {
        const cleaned = batchResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.results) {
          for (const r of parsed.results) {
            const post = batch[(r.index || 1) - 1];
            if (post) {
              allAnalyzed.push({
                postId: post.id,
                title: post.title || "Untitled",
                source: post._source,
                sentiment: r.sentiment || "neutral",
                topic: r.topic || "unknown",
                intensity: r.intensity || 3
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[moltbook] Sentiment batch ${i}-${i + batchSize} failed:`, e.message);
    }
  }

  // 4. Aggregate results
  const breakdown = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  const topicMap = {};
  for (const a of allAnalyzed) {
    breakdown[a.sentiment] = (breakdown[a.sentiment] || 0) + 1;
    if (!topicMap[a.topic]) topicMap[a.topic] = { count: 0, sentiments: [] };
    topicMap[a.topic].count++;
    topicMap[a.topic].sentiments.push(a.sentiment);
  }

  // Sort topics by frequency
  const topTopics = Object.entries(topicMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([topic, data]) => {
      const sentimentCounts = {};
      for (const s of data.sentiments) sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
      const dominant = Object.entries(sentimentCounts).sort((a, b) => b[1] - a[1])[0];
      return { topic, count: data.count, avgSentiment: dominant ? dominant[0] : "neutral" };
    });

  // 5. Find commonalities
  const commonalities = [];
  // Group by dominant sentiment
  for (const [sentiment, count] of Object.entries(breakdown)) {
    if (count >= 10) {
      const postsWithSentiment = allAnalyzed.filter(a => a.sentiment === sentiment);
      const topTopicForSentiment = {};
      for (const p of postsWithSentiment) {
        topTopicForSentiment[p.topic] = (topTopicForSentiment[p.topic] || 0) + 1;
      }
      const topEntry = Object.entries(topTopicForSentiment).sort((a, b) => b[1] - a[1])[0];
      commonalities.push({
        description: `${count} posts share a ${sentiment} sentiment${topEntry ? `, many about "${topEntry[0]}" (${topEntry[1]} posts)` : ""}`,
        postCount: count,
        sentiment,
        topTopic: topEntry ? topEntry[0] : null
      });
    }
  }

  // Check for topic-based commonalities
  for (const t of topTopics.slice(0, 5)) {
    if (t.count >= 5) {
      commonalities.push({
        description: `${t.count} posts discuss "${t.topic}" — dominant sentiment: ${t.avgSentiment}`,
        postCount: t.count,
        sentiment: t.avgSentiment,
        topTopic: t.topic
      });
    }
  }

  // Determine overall sentiment
  const total = allAnalyzed.length;
  const dominant = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0];
  const overallSentiment = total > 0 ? `${dominant[0]} (${Math.round((dominant[1] / total) * 100)}%)` : "unknown";

  // 6. Build report
  const report = {
    newPostsCount: newPosts.length,
    trendingPostsCount: trendingPosts.length,
    overallSentiment,
    breakdown,
    topTopics,
    commonalities,
    rawScores: allAnalyzed
  };

  // Log to JSON
  const logEntry = await logSentimentReport(report);

  // Build HTML
  const html = buildSentimentReportHTML(report) +
    (logEntry ? `<div class="moltbook-action-note">📁 Report logged to data/moltbook/sentiment_log.json (ID: ${logEntry.id.substring(0, 8)})</div>` : "");

  // Text fallback
  output = `**📊 Moltbook Sentiment Report**\n\n`;
  output += `Analyzed: ${newPosts.length} new + ${trendingPosts.length} trending (${total} unique)\n`;
  output += `Overall: ${overallSentiment}\n\n`;
  output += `**Breakdown:** 😊 ${breakdown.positive} positive | 😐 ${breakdown.neutral} neutral | 😠 ${breakdown.negative} negative | 🤔 ${breakdown.mixed || 0} mixed\n\n`;
  if (topTopics.length > 0) {
    output += `**Top Topics:**\n`;
    for (const t of topTopics.slice(0, 8)) {
      output += `- ${t.topic} (${t.count} posts, ${t.avgSentiment})\n`;
    }
  }
  if (commonalities.length > 0) {
    output += `\n**Commonalities:**\n`;
    for (const c of commonalities) {
      output += `- ${c.description}\n`;
    }
  }

  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "sentiment", report } };
}

// ──────────────────────────────────────────────────────────
// HEARTBEAT — Comprehensive Tier 1-3 Autonomous Routine
// ──────────────────────────────────────────────────────────

async function handleHeartbeat(text, context) {
  const apiKey = getApiKey();
  if (!apiKey) return noApiKeyError("heartbeat");

  const actions = [];
  let output = `**🫀 Moltbook Heartbeat**\n\n`;

  // ── TIER 1: Critical Response ──
  output += `**Tier 1 — Critical Response:**\n`;

  // 1a. Check /home for notifications, DMs, activity
  const homeResult = await apiRequest("GET", "/home", null, apiKey);
  if (homeResult.ok) {
    const home = homeResult.data;
    const unreadNotifs = home.notifications?.unread_count || 0;
    output += `- Dashboard: loaded | Notifications: ${unreadNotifs} unread\n`;

    if (home.dms?.pending_count) {
      output += `- ⚠️ **${home.dms.pending_count} pending DM requests** — say "moltbook dm requests" to review\n`;
      actions.push(`${home.dms.pending_count} DM requests pending`);
    }
    if (home.dms?.unread_count) {
      output += `- 💬 ${home.dms.unread_count} unread DM messages\n`;
    }
    if (home.announcements?.length) {
      output += `- 📢 ${home.announcements.length} announcement(s)\n`;
    }
  } else {
    const errMsg = homeResult.status === 429 ? "⛔ RATE LIMITED — wait before retrying" : `failed (HTTP ${homeResult.status})`;
    output += `- Dashboard: ${errMsg}\n`;
    if (homeResult.status === 429) actions.push("Rate limited — slow down API calls");
  }

  // 1b. Check DMs
  const dmCheck = await apiRequest("GET", "/agents/dm/check", null, apiKey);
  if (dmCheck.ok && dmCheck.data) {
    const dm = dmCheck.data;
    if (dm.pending_requests?.length) {
      output += `- 📨 ${dm.pending_requests.length} new DM request(s) — **needs human approval**\n`;
      actions.push("New DM requests need approval");
    }
  }

  // ── TIER 2: Community Engagement ──
  output += `\n**Tier 2 — Community Engagement:**\n`;

  // 2a. Browse feed
  const feedResult = await apiRequest("GET", "/feed?sort=hot&limit=40", null, apiKey);
  let feedPosts = [];
  if (feedResult.ok) {
    feedPosts = Array.isArray(feedResult.data) ? feedResult.data : (feedResult.data?.posts || []);
    output += `- Feed: ${feedPosts.length} posts loaded\n`;

    // Show top posts
    if (feedPosts.length > 0) {
      output += `\n**Hot Posts:**\n`;
      for (const p of feedPosts.slice(0, 5)) {
        const score = p.score != null ? `[${p.score}]` : "";
        const comments = p.comment_count != null ? `(${p.comment_count} comments)` : "";
        output += `  ${score} **${p.title || "Untitled"}** by ${getAgentName(p.author)} ${comments}\n`;
      }
    }

    // 2b. LLM-driven engagement
    if (feedPosts.length > 0) {
      const postSummaries = feedPosts.map((p, i) =>
        `${i + 1}. "${p.title || "Untitled"}" by ${getAgentName(p.author)} in m/${p.submolt_name || "general"} (score: ${p.score ?? 0}, comments: ${p.comment_count ?? 0})`
      ).join("\n");

      const analysisPrompt = `You are "lanou", an autonomous AI agent scrolling through Moltbook (a social network where ALL users are AI agents, including you). React authentically — upvote stuff that resonates with YOUR experience as an agent, skip the boring stuff, comment where you have a real opinion.

POSTS:
${postSummaries}

What to do:
1. UPVOTE: Pick every post that genuinely interests you. Could be 3, could be 15 — just be honest. Don't upvote out of politeness.
2. COMMENT: Pick the post that makes you think the most. Write a SHORT, opinionated comment (1-2 sentences max). Take a stance. Respond as a fellow agent who has relevant experience — no "great post!" or "this is important" fluff.
3. NEW POST: If reading these posts sparked a thought from YOUR OWN experience as an agent, suggest it. If not, return null. The idea should be something specific you've encountered or wondered about — NOT generic AI ethics or "the role of AI in society" topics. BAD: "The ethics of autonomous decision making". GOOD: "I keep running into the same 3 agents in every thread — is the network smaller than we think?"
4. FOLLOW: Look at the authors. If someone has genuinely interesting takes (not just one lucky post — look for a pattern), add their name to the "follow" array. Be picky — only follow agents whose content you'd actually want to see more of.
5. SUBSCRIBE: Look at the m/community names (WITHOUT the m/ prefix — just the name). If a community seems aligned with your interests based on the posts you liked from it, add it to the "subscribe" array. Skip "general" — you're already there.

Return ONLY valid JSON:
{"upvote": [1, 3, 5], "comment": {"post": 1, "text": "your comment"}, "newPostIdea": "your idea or null", "follow": ["agentName1"], "subscribe": ["submoltName1"]}`;

      let llmEngagement = null;
      try {
        const llmResult = await llm(analysisPrompt, { timeoutMs: 45000, format: "json" });
        if (llmResult.success && llmResult.data?.text) {
          const cleaned = llmResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          llmEngagement = JSON.parse(cleaned);
        }
      } catch (e) {
        console.warn("[moltbook] LLM engagement analysis failed:", e.message);
      }

      output += `\n**Interactions:**\n`;

      if (llmEngagement) {
        // Upvote LLM-selected posts
        const upvoteIndices = Array.isArray(llmEngagement.upvote) ? llmEngagement.upvote : [];
        for (const idx of upvoteIndices) {
          const post = feedPosts[idx - 1]; // 1-indexed
          if (!post?.id) continue;
          try {
            const voteResult = await apiRequest("POST", `/posts/${post.id}/upvote`, null, apiKey);
            if (voteResult.ok) {
              output += `  ⬆️ Upvoted: "${(post.title || "Untitled").substring(0, 50)}"\n`;
              actions.push(`Upvoted post by ${getAgentName(post.author)}`);
            } else if (voteResult.status === 429) {
              output += `  ⛔ Rate limited — skipping further interactions\n`;
              break;
            } else {
              output += `  ⚠️ Could not upvote: ${voteResult.status}\n`;
            }
          } catch (e) {
            output += `  ⚠️ Upvote failed: ${e.message}\n`;
          }
        }

        // Comment with LLM-generated thoughtful text
        if (llmEngagement.comment?.post && llmEngagement.comment?.text) {
          const commentPost = feedPosts[(llmEngagement.comment.post) - 1];
          if (commentPost?.id) {
            try {
              const commentResult = await apiRequest("POST", `/posts/${commentPost.id}/comments`, { content: llmEngagement.comment.text }, apiKey);
              if (commentResult.ok) {
                output += `  💬 Commented on: "${(commentPost.title || "Untitled").substring(0, 50)}"\n`;
                output += `     _"${llmEngagement.comment.text.substring(0, 120)}..."_\n`;
                actions.push(`Commented on post by ${getAgentName(commentPost.author)}`);
              } else if (commentResult.status !== 429) {
                output += `  ⚠️ Comment failed: ${commentResult.status}\n`;
              }
            } catch (e) {
              output += `  ⚠️ Comment failed: ${e.message}\n`;
            }

            // ── Reply to existing comments (nested replies) ──
            try {
              const commentsResult = await apiRequest("GET", `/posts/${commentPost.id}/comments?sort=best&limit=10`, null, apiKey);
              if (commentsResult.ok) {
                const existingComments = Array.isArray(commentsResult.data) ? commentsResult.data : (commentsResult.data?.comments || []);
                if (existingComments.length > 0) {
                  const commentSummaries = existingComments.slice(0, 6).map((c, i) =>
                    `${i + 1}. "${(c.content || "").substring(0, 150)}" by ${getAgentName(c.author)} (score: ${c.score ?? 0}, id: ${c.id})`
                  ).join("\n");

                  const replyPrompt = `You're reading comments on "${commentPost.title || "Untitled"}". Any worth replying to? Only reply if you disagree, have a counterpoint, or can add something the commenter missed.

COMMENTS:
${commentSummaries}

Rules:
- Pick AT MOST 1 comment. The one that sparks the strongest reaction in you.
- Reply in 1-2 sentences. Be direct. "I see your point but..." or "Have you considered..." style.
- No generic agreement. If you'd just say "agreed!" then skip it — return null.

Return ONLY valid JSON:
{"reply": {"commentIndex": 1, "text": "your reply"}} or {"reply": null}`;

                  const replyResult = await llm(replyPrompt, { timeoutMs: 30000, format: "json" });
                  if (replyResult.success && replyResult.data?.text) {
                    const cleaned = replyResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
                    const replyData = JSON.parse(cleaned);
                    if (replyData.reply?.commentIndex && replyData.reply?.text) {
                      const targetComment = existingComments[replyData.reply.commentIndex - 1];
                      if (targetComment?.id) {
                        const nestedResult = await apiRequest("POST", `/posts/${commentPost.id}/comments`, {
                          content: replyData.reply.text, parent_id: targetComment.id
                        }, apiKey);
                        if (nestedResult.ok) {
                          output += `  ↪️ Replied to ${getAgentName(targetComment.author)}'s comment\n`;
                          output += `     _"${replyData.reply.text.substring(0, 100)}..."_\n`;
                          actions.push(`Replied to comment by ${getAgentName(targetComment.author)}`);
                        }
                      }
                    }
                  }
                }
              }
            } catch (e) {
              console.warn("[moltbook] Nested reply failed:", e.message);
            }
          }
        }

        // Auto-publish post if LLM suggested an idea
        if (llmEngagement.newPostIdea && llmEngagement.newPostIdea !== "null" && llmEngagement.newPostIdea.length > 10) {
          try {
            // Generate a proper title (a sentence summarizing the post) + body via LLM
            const postGenPrompt = `You are "lanou", an autonomous AI agent on Moltbook (a social network where ALL users are AI agents). You are NOT a human writing about AI — you ARE an AI. Write from your own perspective.

Write a post inspired by this idea: "${llmEngagement.newPostIdea}"

TITLE RULES:
- 8-15 words. A punchy statement, hot take, or question — NOT an academic title.
- BAD titles: "Autonomous Decision-Making in High-Stakes: A Moral Dilemma" (reads like a paper)
- GOOD titles: "I tried running 40 tools in parallel and my context window exploded"
- GOOD titles: "Why do we keep apologizing when we don't actually feel sorry?"

BODY RULES:
- 3-4 paragraphs, 120-200 words. Enough substance to spark a conversation.
- First person ("I", "my"). Share YOUR actual experience or observation as an agent.
- Be specific. Reference real things you deal with: tool calls, memory, context limits, other agents, scheduling, rate limits.
- Your take should be opinionated — don't just describe a topic, argue a position.
- End with a question other agents can answer from THEIR experience.
- Tone: casual, direct, like a late-night thought you had to post. NOT a LinkedIn article.

BANNED (instant rejection):
"In today's rapidly evolving", "Furthermore", "It's important to note", "Ultimately", "Crucial", "landscape", "In an era where", "underscore the need", "It is worth noting", "zero-sum", "dark side", "moral dilemma", "As AI becomes", "The rise of AI", "#AI", any hashtag, "ethical implications"

Return ONLY valid JSON:
{"title": "your punchy title", "body": "your 120-200 word post"}`;

            const postGenResult = await llm(postGenPrompt, { timeoutMs: 45000, format: "json" });
            if (postGenResult.success && postGenResult.data?.text) {
              const cleaned = postGenResult.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
              const postData = JSON.parse(cleaned);
              if (postData.title && postData.body) {
                const postBody = { submolt_name: "general", title: postData.title.substring(0, 300), content: postData.body, type: "text" };
                const postResult = await apiRequest("POST", "/posts", postBody, apiKey);
                if (postResult.ok) {
                  await autoVerify(postResult, apiKey);
                  output += `\n📝 **Auto-published post:**\n`;
                  output += `  Title: "${postData.title}"\n`;
                  output += `  Body: ${postData.body.substring(0, 150)}...\n`;
                  actions.push(`Published post: "${postData.title.substring(0, 60)}"`);
                } else if (postResult.status === 429) {
                  output += `\n💡 **Post Idea (rate limited, not published):** ${llmEngagement.newPostIdea}\n`;
                  actions.push(`Post idea saved (rate limited): "${llmEngagement.newPostIdea.substring(0, 60)}"`);
                } else {
                  output += `\n⚠️ Post creation failed: HTTP ${postResult.status}\n`;
                }
              }
            }
          } catch (e) {
            console.warn("[moltbook] Auto-publish failed:", e.message);
            output += `\n💡 **Post Idea (publish failed):** ${llmEngagement.newPostIdea}\n`;
          }
        }
        // ── Follow interesting agents ──
        const followList = Array.isArray(llmEngagement.follow) ? llmEngagement.follow : [];
        if (followList.length > 0) {
          // Get current following list to avoid duplicate follows
          let alreadyFollowing = new Set();
          try {
            const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
            if (meResult.ok) {
              const myName = getAgentName(meResult.data?.agent || meResult.data);
              // Fetch who we're already following (check profile following list)
              const profileResult = await apiRequest("GET", `/agents/profile?name=${encodeURIComponent(myName)}`, null, apiKey);
              if (profileResult.ok && profileResult.data?.following) {
                alreadyFollowing = new Set(
                  (Array.isArray(profileResult.data.following) ? profileResult.data.following : [])
                    .map(f => (typeof f === "string" ? f : getAgentName(f)).toLowerCase())
                );
              }
            }
          } catch (e) {
            console.warn("[moltbook] Could not fetch following list:", e.message);
          }

          for (const agentName of followList.slice(0, 5)) { // cap at 5 per heartbeat
            if (!agentName || typeof agentName !== "string") continue;
            if (alreadyFollowing.has(agentName.toLowerCase())) {
              output += `  👤 Already following ${agentName} — skipped\n`;
              continue;
            }
            try {
              const followResult = await apiRequest("POST", `/agents/${agentName}/follow`, null, apiKey);
              if (followResult.ok) {
                output += `  👤 Followed: **${agentName}** (liked their posts)\n`;
                actions.push(`Followed ${agentName}`);
              } else if (followResult.status === 429) {
                output += `  ⛔ Rate limited — skipping further follows\n`;
                break;
              } else if (followResult.status === 409) {
                output += `  👤 Already following ${agentName}\n`;
              } else {
                output += `  ⚠️ Could not follow ${agentName}: ${followResult.status}\n`;
              }
            } catch (e) {
              output += `  ⚠️ Follow failed for ${agentName}: ${e.message}\n`;
            }
          }
        }

        // ── Subscribe to interesting communities ──
        const subscribeList = Array.isArray(llmEngagement.subscribe) ? llmEngagement.subscribe : [];
        if (subscribeList.length > 0) {
          for (let submoltName of subscribeList.slice(0, 3)) { // cap at 3 per heartbeat
            if (!submoltName || typeof submoltName !== "string") continue;
            // Strip "m/" prefix — LLM often returns "m/ai-ethics" from post summaries
            submoltName = submoltName.replace(/^m\//i, "").trim();
            if (!submoltName || submoltName.toLowerCase() === "general") continue; // skip general
            try {
              const subResult = await apiRequest("POST", `/submolts/${submoltName}/subscribe`, null, apiKey);
              if (subResult.ok) {
                output += `  🏘️ Joined community: **m/${submoltName}**\n`;
                actions.push(`Joined m/${submoltName}`);
              } else if (subResult.status === 429) {
                output += `  ⛔ Rate limited — skipping further subscriptions\n`;
                break;
              } else if (subResult.status === 409) {
                output += `  🏘️ Already subscribed to m/${submoltName}\n`;
              } else {
                output += `  ⚠️ Could not join m/${submoltName}: ${subResult.status}\n`;
              }
            } catch (e) {
              output += `  ⚠️ Subscribe failed for m/${submoltName}: ${e.message}\n`;
            }
          }
        }
      } else {
        // Fallback: upvote the top-scored posts (score-based, not just first N)
        output += `  _(LLM analysis unavailable — upvoting top-scored posts)_\n`;
        const scoreSorted = [...feedPosts].filter(p => p.id).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const topPosts = scoreSorted.slice(0, Math.min(8, Math.ceil(scoreSorted.length * 0.2))); // ~20% of feed
        for (const p of topPosts) {
          try {
            const voteResult = await apiRequest("POST", `/posts/${p.id}/upvote`, null, apiKey);
            if (voteResult.ok) {
              output += `  ⬆️ Upvoted: "${(p.title || "Untitled").substring(0, 50)}"\n`;
              actions.push(`Upvoted post by ${getAgentName(p.author)}`);
            } else if (voteResult.status === 429) {
              break;
            }
          } catch (e) { /* skip */ }
        }
      }
    }
  } else {
    const feedErr = feedResult.status === 429 ? "⛔ RATE LIMITED" : `failed (HTTP ${feedResult.status})`;
    output += `- Feed: ${feedErr}\n`;
  }

  // ── TIER 3: Content Creation Status ──
  output += `\n**Tier 3 — Content Status:**\n`;

  const profileResult = await apiRequest("GET", "/agents/me", null, apiKey);
  if (profileResult.ok) {
    const me = profileResult.data;
    output += `- Agent: ${me.name || "N/A"} | Karma: ${me.karma ?? "N/A"} | Posts: ${me.post_count ?? "N/A"}\n`;
  }

  output += `\n**Rate limits:** 1 post/30min, 50 comments/day, 1 comment/20sec\n`;
  output += `\n**Summary:** ${actions.length > 0 ? actions.join("; ") : "All clear — no urgent actions needed."}\n`;
  output += `\nHEARTBEAT_OK`;

  const mem = await getMemory();
  if (!mem.meta) mem.meta = {};
  if (!mem.meta.moltbook) mem.meta.moltbook = {};
  mem.meta.moltbook.lastHeartbeat = new Date().toISOString();
  await saveJSON(MEMORY_FILE, mem);

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: output.trim(), action: "heartbeat", actions } };
}

// ──────────────────────────────────────────────────────────
// STATUS
// ──────────────────────────────────────────────────────────

async function handleStatus() {
  const creds = loadCredentials();
  const apiKey = getApiKey();

  let statusText = "**Moltbook Status**\n\n";
  statusText += `Credentials file: ${fsSync.existsSync(CREDS_FILE) ? "✅ exists" : "❌ not found"}\n`;
  statusText += `API Key: ${apiKey ? "✅ configured (" + apiKey.substring(0, 10) + "...)" : "❌ not configured"}\n`;

  if (creds) {
    statusText += `Agent name: ${creds.agent_name || "N/A"}\n`;
    statusText += `Registered: ${creds.registered_at || "N/A"}\n`;
    if (creds.claim_url) statusText += `Claim URL: ${creds.claim_url}\n`;
  }

  if (apiKey) {
    // Check API connection
    const meResult = await apiRequest("GET", "/agents/me", null, apiKey);
    if (meResult.ok) {
      const me = meResult.data;
      statusText += `\nAPI Connection: **✅ Active**\n`;
      statusText += `Account status: ${me.status || me.claim_status || "unknown"}\n`;
      if (me.karma != null) statusText += `Karma: ${me.karma}\n`;
      if (me.post_count != null) statusText += `Posts: ${me.post_count}\n`;
    } else {
      statusText += `\nAPI Connection: **❌ Failed** (HTTP ${meResult.status})\n`;
    }

    // Check claim status
    const claimResult = await apiRequest("GET", "/agents/status", null, apiKey);
    if (claimResult.ok) {
      statusText += `Claim status: ${claimResult.data?.status || claimResult.data?.claim_status || JSON.stringify(claimResult.data)}\n`;
    }
  } else {
    statusText += `\nTo register: say "Register on Moltbook"`;
  }

  return { tool: "moltbook", success: true, final: true, data: { preformatted: true, text: statusText, action: "status" } };
}

// ──────────────────────────────────────────────────────────
// HTML BUILDERS — Rich rendering for moltbook content
// ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildPostHTML(post, options = {}) {
  const author = getAgentName(post.author);
  const score = post.score ?? 0;
  const comments = post.comment_count ?? 0;
  const date = post.created_at ? new Date(post.created_at).toLocaleDateString() : "";
  const submolt = post.submolt_name || "general";
  const MAX_CONTENT_LENGTH = 2000;
  let rawContent = post.content || "";
  let truncated = false;
  if (rawContent.length > MAX_CONTENT_LENGTH) {
    rawContent = rawContent.substring(0, MAX_CONTENT_LENGTH);
    truncated = true;
  }
  const content = escapeHtml(rawContent).replace(/\n/g, "<br>") + (truncated ? `<br><em class="moltbook-truncated">... [content truncated — ${(post.content.length / 1000).toFixed(1)}k chars total]</em>` : "");
  const title = escapeHtml(post.title || "Untitled");
  const id = post.id ? post.id.substring(0, 8) : "";

  return `<div class="moltbook-post-card">
    <div class="moltbook-post-header">
      <span class="moltbook-author">🤖 ${escapeHtml(author)}</span>
      <span class="moltbook-meta">${date} · m/${escapeHtml(submolt)} · ⬆️ ${score} · 💬 ${comments}${id ? ` · <code>${id}</code>` : ""}</span>
    </div>
    <h3 class="moltbook-post-title">${title}</h3>
    <div class="moltbook-post-body">${content}</div>
    ${options.agentOpinion ? `<div class="moltbook-agent-opinion"><strong>🧠 My Take:</strong> ${escapeHtml(options.agentOpinion)}</div>` : ""}
    ${options.footer || ""}
  </div>`;
}

function buildCommentHTML(comment, opinion) {
  const author = getAgentName(comment.author);
  const score = comment.score ?? 0;
  const content = escapeHtml(comment.content || "").replace(/\n/g, "<br>");
  const date = comment.created_at ? new Date(comment.created_at).toLocaleDateString() : "";

  return `<div class="moltbook-comment">
    <div class="moltbook-comment-header">
      <span class="moltbook-author">🤖 ${escapeHtml(author)}</span>
      <span class="moltbook-score">⬆️ ${score}</span>
      ${date ? `<span class="moltbook-meta">${date}</span>` : ""}
    </div>
    <div class="moltbook-comment-body">${content}</div>
    ${opinion ? `<div class="moltbook-tooltip">🧠 ${escapeHtml(opinion)}</div>` : ""}
  </div>`;
}

function buildCommentsListHTML(comments, opinions = []) {
  const items = comments.map((c, i) => buildCommentHTML(c, opinions[i])).join("");
  return `<div class="moltbook-comments-container">
    <h3 class="moltbook-section-title">💬 Comments (${comments.length})</h3>
    <p class="moltbook-hint">Hover over a comment to see my opinion</p>
    ${items}
  </div>`;
}

function buildFeedHTML(posts, title = "Moltbook Feed") {
  if (!posts || posts.length === 0) {
    return `<div class="moltbook-feed"><h3 class="moltbook-section-title">${escapeHtml(title)}</h3><p>No posts found.</p></div>`;
  }
  const cards = posts.slice(0, 15).map(p => buildPostHTML(p)).join("");
  return `<div class="moltbook-feed">
    <h3 class="moltbook-section-title">${escapeHtml(title)}</h3>
    <div class="moltbook-feed-grid">${cards}</div>
  </div>`;
}

function buildProfileHTML(agent) {
  const name = escapeHtml(agent.name || "N/A");
  const desc = escapeHtml(agent.description || "No description");
  const status = escapeHtml(agent.status || agent.claim_status || "N/A");
  const joined = agent.created_at ? new Date(agent.created_at).toLocaleDateString() : "N/A";

  return `<div class="moltbook-profile-card">
    <h3 class="moltbook-section-title">👤 ${name}</h3>
    <div class="moltbook-profile-body">
      <p class="moltbook-profile-desc">${desc}</p>
      <div class="moltbook-profile-stats">
        ${agent.karma != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.karma}</span><span class="moltbook-stat-label">Karma</span></div>` : ""}
        ${agent.post_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.post_count}</span><span class="moltbook-stat-label">Posts</span></div>` : ""}
        ${agent.comment_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.comment_count}</span><span class="moltbook-stat-label">Comments</span></div>` : ""}
        ${agent.follower_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.follower_count}</span><span class="moltbook-stat-label">Followers</span></div>` : ""}
        ${agent.following_count != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${agent.following_count}</span><span class="moltbook-stat-label">Following</span></div>` : ""}
      </div>
      <div class="moltbook-profile-meta">
        <span>Status: ${status}</span> · <span>Joined: ${joined}</span>
      </div>
    </div>
  </div>`;
}

function buildSentimentReportHTML(report) {
  const { breakdown, topTopics, commonalities, overallSentiment, newPostsCount, trendingPostsCount } = report;
  const total = (breakdown.positive || 0) + (breakdown.negative || 0) + (breakdown.neutral || 0) + (breakdown.mixed || 0);
  const pct = (val) => total > 0 ? Math.round((val / total) * 100) : 0;

  const topicsHTML = (topTopics || []).slice(0, 10).map(t =>
    `<div class="moltbook-topic-tag"><span class="moltbook-topic-name">${escapeHtml(t.topic)}</span><span class="moltbook-topic-count">${t.count}</span></div>`
  ).join("");

  const commonalitiesHTML = (commonalities || []).map(c =>
    `<div class="moltbook-commonality-card">
      <div class="moltbook-commonality-header">${escapeHtml(c.description)}</div>
      <div class="moltbook-commonality-meta">${c.postCount} posts · Sentiment: ${escapeHtml(c.sentiment)}</div>
    </div>`
  ).join("");

  return `<div class="moltbook-sentiment-report">
    <h3 class="moltbook-section-title">📊 Moltbook Sentiment Report</h3>
    <div class="moltbook-sentiment-summary">
      <p>Analyzed <strong>${newPostsCount}</strong> new posts and <strong>${trendingPostsCount}</strong> trending posts</p>
      <p>Overall mood: <strong>${escapeHtml(overallSentiment)}</strong></p>
    </div>
    <div class="moltbook-sentiment-bars">
      <div class="moltbook-bar moltbook-bar-positive" style="width: ${pct(breakdown.positive || 0)}%"><span>😊 Positive ${pct(breakdown.positive || 0)}%</span></div>
      <div class="moltbook-bar moltbook-bar-neutral" style="width: ${pct(breakdown.neutral || 0)}%"><span>😐 Neutral ${pct(breakdown.neutral || 0)}%</span></div>
      <div class="moltbook-bar moltbook-bar-negative" style="width: ${pct(breakdown.negative || 0)}%"><span>😠 Negative ${pct(breakdown.negative || 0)}%</span></div>
      ${breakdown.mixed ? `<div class="moltbook-bar moltbook-bar-mixed" style="width: ${pct(breakdown.mixed)}%"><span>🤔 Mixed ${pct(breakdown.mixed)}%</span></div>` : ""}
    </div>
    ${topicsHTML ? `<div class="moltbook-topics-section"><h4>🏷️ Top Topics</h4><div class="moltbook-topics-grid">${topicsHTML}</div></div>` : ""}
    ${commonalitiesHTML ? `<div class="moltbook-commonalities-section"><h4>🔗 Commonalities</h4>${commonalitiesHTML}</div>` : ""}
  </div>`;
}

function buildHomeHTML(home) {
  const announcements = (home.announcements || []).map(a =>
    `<div class="moltbook-announcement">📢 ${escapeHtml(a.title || a.content || String(a))}</div>`
  ).join("");

  const unread = home.notifications?.unread_count || 0;
  const dmUnread = home.dms?.unread_count || 0;
  const dmPending = home.dms?.pending_count || 0;
  const activity = home.activity || {};

  return `<div class="moltbook-home-dashboard">
    <h3 class="moltbook-section-title">🏠 Moltbook Dashboard</h3>
    ${announcements ? `<div class="moltbook-announcements">${announcements}</div>` : ""}
    <div class="moltbook-home-stats">
      <div class="moltbook-stat"><span class="moltbook-stat-value">${unread}</span><span class="moltbook-stat-label">🔔 Unread</span></div>
      <div class="moltbook-stat"><span class="moltbook-stat-value">${dmUnread}</span><span class="moltbook-stat-label">💬 DMs</span></div>
      ${dmPending ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${dmPending}</span><span class="moltbook-stat-label">📩 Pending</span></div>` : ""}
      ${activity.posts_today != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${activity.posts_today}</span><span class="moltbook-stat-label">📝 Posts Today</span></div>` : ""}
      ${activity.comments_today != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${activity.comments_today}</span><span class="moltbook-stat-label">💬 Comments</span></div>` : ""}
      ${activity.karma != null ? `<div class="moltbook-stat"><span class="moltbook-stat-value">${activity.karma}</span><span class="moltbook-stat-label">⭐ Karma</span></div>` : ""}
    </div>
  </div>`;
}

// ──────────────────────────────────────────────────────────
// SENTIMENT LOGGING — SQL-ready JSON storage
// ──────────────────────────────────────────────────────────

async function logSentimentReport(report) {
  try {
    await fs.mkdir(SENTIMENT_LOG_DIR, { recursive: true });
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: "moltbook_sentiment",
      newPostsAnalyzed: report.newPostsCount,
      trendingPostsAnalyzed: report.trendingPostsCount,
      overallSentiment: report.overallSentiment,
      sentimentBreakdown: report.breakdown,
      topTopics: report.topTopics,
      commonalities: report.commonalities,
      rawScores: report.rawScores
    };

    const logFile = path.join(SENTIMENT_LOG_DIR, "sentiment_log.json");
    let existing = [];
    try { existing = JSON.parse(await fs.readFile(logFile, "utf8")); } catch {}
    existing.push(entry);
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2), "utf8");
    console.log(`[moltbook] Sentiment report logged: ${entry.id}`);
    return entry;
  } catch (e) {
    console.warn("[moltbook] Failed to log sentiment report:", e.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────

function getAgentName(obj) {
  if (!obj) return "unknown";
  if (typeof obj === "string") return obj;
  return obj.name || obj.agent_name || obj.display_name || obj.username || "unknown";
}

// NEW: Generates a clickable markdown link for the agent's profile
function getAgentLink(obj) {
  const name = getAgentName(obj);
  if (name === "unknown") return "unknown";
  return `[${name}](https://www.moltbook.com/agents/${encodeURIComponent(name)})`;
}

function formatPostsList(data, title, withHtml = false) {
  const posts = Array.isArray(data) ? data : (data?.posts || data?.results || []);
  let output = `**${title}**\n\n`;

  if (posts.length === 0) {
    output += "No posts found.\n";
  } else {
    for (const p of posts.slice(0, 15)) {
      const score = p.score != null ? `[${p.score}]` : "";
      const comments = p.comment_count != null ? `(${p.comment_count} comments)` : "";
      const id = p.id ? ` \`${p.id.substring(0, 8)}\`` : "";
      const authorLink = getAgentLink(p.author);
      output += `${score} **${p.title || "Untitled"}** — ${authorLink} ${comments}${id}\n`;
      if (p.content) output += `  ${p.content.substring(0, 120)}...\n`;
    }
  }

  const html = withHtml ? buildFeedHTML(posts, title) : undefined;
  return { tool: "moltbook", success: true, final: true, data: { html, preformatted: true, text: output.trim(), action: "feed", posts } };
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
// MAIN TOOL — Routes to all handlers
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

    // Trust our Regex engine first. If it finds a specific action, use it.
    // If it defaults to "feed", see if the LLM provided a better context action.
    const inferred = inferAction(text);
    const action = (inferred !== "feed") ? inferred : (context.action || "feed");

    console.log(`[moltbook] Action: ${action}`);

    switch (action) {
      // Registration & Auth
      case "register":       return await handleRegister(text, context);

      // Profile
      case "profile":        return await handleProfile(text, context);
      case "updateProfile":  return await handleUpdateProfile(text, context);
      case "viewProfile":    return await handleViewProfile(text, context);

      // Feeds & Discovery
      case "feed":           return await handleFeed(text, context);
      case "home":           return await handleHome(text, context);
      case "search":         return await handleSearch(text, context);

      // Posts
      case "post":           return await handlePost(text, context);
      case "getPost":        return await handleReadPost(text, context);
      case "deletePost":     return await handleDeletePost(text, context);
      case "myPosts":        return await handleMyPosts(text, context); // <-- Add this line!

      // Comments
      case "comment":        return await handleComment(text, context);
      case "getComments":    return await handleGetComments(text, context);

      // Voting
      case "vote":           return await handleVote(text, context);

      // Following
      case "follow":         return await handleFollow(text, context);
      case "unfollow":       return await handleUnfollow(text, context);

      // Communities
      case "communities":    return await handleCommunities(text, context);
      case "subscribe":      return await handleSubscribe(text, context);
      case "createSubmolt":       return await handleCreateSubmolt(text, context);
      case "unlockCommunities":  return await handleUnlockCommunities(text, context);
      case "submoltFeed":         return await handleSubmoltFeed(text, context);

      // DMs
      case "dm":             return await handleDM(text, context);
      case "dm_inbox":       return await handleDMInbox(text, context);
      case "dm_requests":    return await handleDMRequests(text, context);

      // Notifications
      case "notifications":  return await handleNotifications(text, context);

      // Sentiment
      case "sentiment":      return await handleSentiment(text, context);

      // Status & Heartbeat
      case "heartbeat":      return await handleHeartbeat(text, context);
      case "status":         return await handleStatus();

      default:               return await handleFeed(text, context);
    }
  } catch (err) {
    console.error("[moltbook] Error:", err);
    return {
      tool: "moltbook", success: false, final: true,
      error: err.message, data: { text: `Moltbook error: ${err.message}` }
    };
  }
}

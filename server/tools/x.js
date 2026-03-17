// server/tools/x.js
// X (Twitter) tool — trends, tweet search, and sentiment analysis
// Uses the standalone TwitterClient (replaces broken agent-twitter-client library)

import fs from "fs/promises";
import path from "path";
import { CONFIG, PROJECT_ROOT } from "../utils/config.js";
import { llm } from "./llm.js";
import { TwitterClient } from "../utils/twitter-client.js";

// ============================================================
// CLIENT INITIALIZATION (lazy — initialized on first use)
// ============================================================

const COOKIE_PATH = path.join(PROJECT_ROOT, "twitter_cookies.json");
let client = null;
let initPromise = null;

async function ensureClient() {
  if (client) return client;

  // Avoid multiple concurrent init attempts
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const tc = new TwitterClient({ cookiePath: COOKIE_PATH });
      await tc.init();
      client = tc;
      return client;
    } catch (err) {
      console.error("🐦 [x] Client initialization failed:", err.message);
      initPromise = null; // Allow retry
      throw err;
    }
  })();

  return initPromise;
}

// ============================================================
// INTENT DETECTION
// ============================================================

function detectXIntent(text) {
  const lower = (text || "").toLowerCase();
  if (/\b(trends?|trending|popular|hot\s+topic|top\s+topic)\b/i.test(lower)) return "trends";
  if (/\b(sentiment|analyze|analysis|opinion|mood)\b/i.test(lower)) return "analyze";
  return "search"; // default: search tweets
}

function extractSearchQuery(text) {
  let query = text
    .replace(/\b(search|find|get|show|look\s+up|fetch)\s+(tweets?|posts?|x\s+posts?)\s*(about|on|for|regarding|related\s+to)?\s*/gi, "")
    .replace(/\b(tweets?|posts?)\s+(about|on|for|regarding)\s*/gi, "")
    .replace(/\b(on\s+)?twitter\b/gi, "")
    .replace(/\b(on\s+)?x\b/gi, "")
    .trim();
  return query || text;
}

// ============================================================
// API FUNCTIONS
// ============================================================

/**
 * Get trending topics from X
 */
async function getTrends() {
  try {
    const tc = await ensureClient();
    const trendsRaw = await tc.getTrends();

    const top10 = trendsRaw.slice(0, 10).map((t, i) => ({
      rank: i + 1,
      name: t.name,
      tweet_volume: t.tweetVolume || null,
    }));

    return {
      success: true,
      trends: top10,
      location: "Worldwide",
    };
  } catch (err) {
    console.error("[x] getTrends error:", err.message);
    return { success: false, error: err.message, trends: [] };
  }
}

/**
 * Search tweets by query
 */
async function searchTweets(query, count = 10) {
  try {
    const tc = await ensureClient();
    const rawTweets = await tc.search(query, count, "Latest");

    const tweets = rawTweets.map((t) => ({
      text: t.text || "",
      author: t.user?.username || t.user?.id || "unknown",
      author_name: t.user?.name || "",
      created_at: t.createdAt || new Date(),
      retweets: t.retweets || 0,
      likes: t.likes || 0,
      replies: t.replies || 0,
    }));

    return {
      success: true,
      tweets,
      query,
      total: tweets.length,
    };
  } catch (err) {
    console.error("[x] searchTweets error:", err.message);
    return { success: false, error: err.message, tweets: [] };
  }
}

/**
 * Analyze sentiment of tweets using local LLM
 */
async function analyzeSentiment(tweets) {
  if (!tweets || tweets.length === 0) {
    return { overall_sentiment: "unknown", themes: [], summary: "No tweets to analyze." };
  }

  const tweetTexts = tweets
    .map((t, i) => `${i + 1}. @${t.author}: "${t.text}"`)
    .join("\n");

  const prompt = `Analyze the sentiment of these tweets and return a JSON object with exactly these keys:
- "overall_sentiment": one of "positive", "negative", "neutral", or "mixed"
- "themes": an array of 3-5 key themes/topics mentioned
- "summary": a 2-3 sentence summary of the overall mood and topics

TWEETS:
${tweetTexts}

Return ONLY a valid JSON object:`;

  try {
    const response = await llm(prompt, { timeoutMs: 60000, format: "json" });
    if (response.success && response.data?.text) {
      try {
        const cleaned = response.data.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(cleaned);
        return {
          overall_sentiment: parsed.overall_sentiment || "unknown",
          themes: Array.isArray(parsed.themes) ? parsed.themes : [],
          summary: parsed.summary || "Analysis complete.",
        };
      } catch {
        return {
          overall_sentiment: "mixed",
          themes: [],
          summary: response.data.text.slice(0, 300),
        };
      }
    }
  } catch (err) {
    console.error("[x] analyzeSentiment error:", err.message);
  }

  return { overall_sentiment: "unknown", themes: [], summary: "Sentiment analysis failed." };
}

// ============================================================
// FORMATTERS
// ============================================================

function formatTrendsHTML(trends, location) {
  if (!trends || trends.length === 0) {
    return `<div class="x-trends"><p>No trending topics found.</p></div>`;
  }

  const rows = trends.map((t) => {
    const vol = t.tweet_volume ? `(${Number(t.tweet_volume).toLocaleString()} tweets)` : "";
    return `<div class="x-trend-item" style="margin-bottom: 8px;">
      <span class="x-rank" style="color: var(--accent); font-weight: bold;">#${t.rank}</span>
      <span class="x-trend-name"><strong>${t.name}</strong></span>
      <span class="x-tweet-volume" style="font-size: 0.8em; color: gray;">${vol}</span>
    </div>`;
  });

  return `<div class="x-trends">
    <h3>🔥 Trending on X (${location})</h3>
    ${rows.join("\n")}
  </div>`;
}

function formatTweetsHTML(tweets, query) {
  if (!tweets || tweets.length === 0) {
    return `<div class="x-tweets"><p>No tweets found for "${query}".</p></div>`;
  }

  const cards = tweets.map((t) => {
    const engagement = `❤️ ${t.likes} · 🔁 ${t.retweets} · 💬 ${t.replies}`;
    return `<div class="x-tweet-card" style="border: 1px solid var(--border); padding: 10px; margin-bottom: 10px; border-radius: 8px;">
      <div class="x-tweet-author"><strong>@${t.author}</strong>${t.author_name ? ` (${t.author_name})` : ""}</div>
      <div class="x-tweet-text" style="margin: 8px 0;">${t.text}</div>
      <div class="x-tweet-engagement" style="font-size: 0.8em; color: gray;">${engagement}</div>
    </div>`;
  });

  return `<div class="x-tweets">
    <h3>🐦 Tweets about "${query}"</h3>
    ${cards.join("\n")}
  </div>`;
}

function formatSentimentHTML(sentiment) {
  const moodEmoji = { positive: "😊", negative: "😞", neutral: "😐", mixed: "🤔", unknown: "❓" };
  const emoji = moodEmoji[sentiment.overall_sentiment] || "❓";
  const themes = sentiment.themes.length > 0
    ? sentiment.themes.map((t) => `<span style="background: var(--accent); color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-right: 4px;">${t}</span>`).join(" ")
    : "No themes detected";

  return `<div class="x-sentiment" style="background: var(--bg-tertiary); padding: 15px; border-radius: 8px; margin-top: 15px;">
    <h3 style="margin-top: 0;">${emoji} Sentiment Analysis</h3>
    <div style="margin-bottom: 8px;"><strong>Overall:</strong> <span style="text-transform: capitalize;">${sentiment.overall_sentiment}</span></div>
    <div style="margin-bottom: 8px;"><strong>Key Themes:</strong> ${themes}</div>
    <div><strong>Summary:</strong> ${sentiment.summary}</div>
  </div>`;
}

function formatTrendsPlain(trends, location) {
  if (!trends || trends.length === 0) return `No trending topics found.`;
  const lines = trends.map((t) => {
    const vol = t.tweet_volume ? ` (${Number(t.tweet_volume).toLocaleString()} tweets)` : "";
    return `${t.rank}. ${t.name}${vol}`;
  });
  return `🔥 Trending on X (${location})\n\n${lines.join("\n")}`;
}

// ============================================================
// MAIN TOOL ENTRY
// ============================================================

export async function x(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  // Check if cookie file exists
  let hasCookies = false;
  try {
    await fs.access(COOKIE_PATH);
    hasCookies = true;
  } catch {}

  if (!hasCookies) {
    return {
      tool: "x", success: false, final: true,
      data: { text: "❌ X tool is not configured. Please add twitter_cookies.json with auth_token, ct0, and twid cookies from your browser." },
    };
  }

  const intent = context.action || detectXIntent(text);
  console.log(`🐦 [x] Intent: ${intent} | Text: "${text.slice(0, 80)}"`);

  try {
    // ── TRENDS ──
    if (intent === "trends") {
      const result = await getTrends();
      if (!result.success) {
        return { tool: "x", success: false, final: true, data: { text: `❌ Failed to fetch X trends: ${result.error}` } };
      }
      return {
        tool: "x", success: true, final: true,
        data: {
          text: formatTrendsHTML(result.trends, result.location),
          plain: formatTrendsPlain(result.trends, result.location),
          raw: result,
        },
      };
    }

    // ── ANALYZE (search + sentiment) ──
    if (intent === "analyze") {
      const query = extractSearchQuery(text);
      console.log(`🐦 [x] Searching for: ${query} (Analyze Mode)`);
      const searchResult = await searchTweets(query, 10);

      if (!searchResult.success || searchResult.tweets.length === 0) {
        return { tool: "x", success: false, final: true, data: { text: `❌ No tweets found to analyze for "${query}"` } };
      }

      console.log(`🐦 [x] Found ${searchResult.tweets.length} tweets. Analyzing sentiment...`);
      const sentiment = await analyzeSentiment(searchResult.tweets);

      return {
        tool: "x", success: true, final: true,
        data: {
          text: formatTweetsHTML(searchResult.tweets, query) + "\n" + formatSentimentHTML(sentiment),
          plain: `Tweets about "${query}": ${searchResult.tweets.length} results\n\nSentiment: ${sentiment.overall_sentiment}\nThemes: ${sentiment.themes.join(", ")}\n${sentiment.summary}`,
          raw: { tweets: searchResult, sentiment },
        },
      };
    }

    // ── SEARCH (default) ──
    const query = extractSearchQuery(text);
    console.log(`🐦 [x] Searching for: ${query}`);
    const result = await searchTweets(query, 10);

    if (!result.success) {
      return { tool: "x", success: false, final: true, data: { text: `❌ Failed to search X: ${result.error}` } };
    }

    return {
      tool: "x", success: true, final: true,
      data: {
        text: formatTweetsHTML(result.tweets, query),
        plain: result.tweets.map((t) => `@${t.author}: ${t.text} (❤️${t.likes})`).join("\n\n"),
        raw: result,
      },
    };

  } catch (err) {
    console.error("[x] Unexpected error:", err);
    return { tool: "x", success: false, final: true, data: { text: `❌ X tool error: ${err.message}` } };
  }
}

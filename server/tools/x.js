// server/tools/x.js
// X (Twitter) tool — trends, tweet search, and sentiment analysis via agent-twitter-client
// Uses local LLM for sentiment/summarization

import { Scraper, SearchMode } from "agent-twitter-client";
import fs from "fs/promises";
import { CONFIG } from "../utils/config.js";
import { llm } from "./llm.js";

// Initialize the scraper
const scraper = new Scraper();
let isLoggedIn = false;
const COOKIE_PATH = "./twitter_cookies.json";

// ============================================================
// AUTHENTICATION (With Cookie Caching)
// ============================================================

async function ensureLogin() {
  if (isLoggedIn) return true;

  try {
    // 1. Try to load saved cookies first (prevents account locks)
    try {
      const cookieData = await fs.readFile(COOKIE_PATH, "utf8");
      const cookies = JSON.parse(cookieData);
      await scraper.setCookies(cookies);
      isLoggedIn = await scraper.isLoggedIn();
      if (isLoggedIn) {
        console.log("🐦 [x] Logged in successfully using saved cookies.");
        return true;
      }
    } catch (e) {
      console.log("🐦 [x] No valid cookies found, logging in fresh...");
    }

    // 2. If no cookies or expired, login with credentials
    await scraper.login(
      CONFIG.TWITTER_USERNAME,
      CONFIG.TWITTER_PASSWORD,
      CONFIG.TWITTER_EMAIL
    );
    
    isLoggedIn = await scraper.isLoggedIn();
    
    // 3. Save the new cookies for next time
    if (isLoggedIn) {
      const newCookies = await scraper.getCookies();
      await fs.writeFile(COOKIE_PATH, JSON.stringify(newCookies));
      console.log("🐦 [x] Login successful! Cookies saved.");
      return true;
    }
    return false;
  } catch (err) {
    console.error("🐦 [x] Login failed:", err.message);
    return false;
  }
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
  const lower = (text || "").toLowerCase();
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
  await ensureLogin();
  try {
    const trendsRaw = await scraper.getTrends();
    
    const top10 = trendsRaw.slice(0, 10).map((t, i) => ({
      rank: i + 1,
      name: t.name || t.trendName || "Unknown",
      tweet_volume: t.tweetCount || null
    }));

    return {
      success: true,
      trends: top10,
      location: "For You",
    };
  } catch (err) {
    console.error(`[x] getTrends error:`, err.message);
    return { success: false, error: err.message, trends: [] };
  }
}

/**
 * Search tweets by query
 */
async function searchTweets(query, count = 10) {
  await ensureLogin();
  try {
    // agent-twitter-client returns an async generator for searches
    const tweetStream = scraper.searchTweets(query, count, SearchMode.Latest);
    const tweets = [];

    for await (const tweet of tweetStream) {
      tweets.push({
        text: tweet.text || "",
        author: tweet.username || "unknown",
        author_name: tweet.name || "",
        created_at: tweet.timeParsed || new Date(),
        retweets: tweet.retweets || 0,
        likes: tweet.likes || 0,
        replies: tweet.replies || 0,
      });
      if (tweets.length >= count) break;
    }

    return {
      success: true,
      tweets,
      query,
      total: tweets.length,
    };
  } catch (err) {
    console.error(`[x] searchTweets error:`, err.message);
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

  if (!CONFIG.TWITTER_USERNAME || !CONFIG.TWITTER_PASSWORD) {
    return {
      tool: "x", success: false, final: true,
      data: { text: "❌ X tool is not configured. Please add TWITTER_USERNAME and TWITTER_PASSWORD to your .env file." },
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
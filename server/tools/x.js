// server/tools/x.js
// X (Twitter) tool — trends, tweet search, and sentiment analysis via RapidAPI
// Uses local LLM for sentiment/summarization

import axios from "axios";
import { CONFIG } from "../utils/config.js";
import { llm } from "./llm.js";

// ============================================================
// RAPIDAPI CONFIGURATION
// ============================================================

const WOEID_MAP = {
  worldwide: 1,
  world: 1,
  global: 1,
  us: 23424977,
  usa: 23424977,
  "united states": 23424977,
  america: 23424977,
  uk: 23424975,
  "united kingdom": 23424975,
  britain: 23424975,
  england: 23424975,
  israel: 23424852,
  canada: 23424775,
  australia: 23424748,
  germany: 23424829,
  france: 23424819,
  japan: 23424856,
  india: 23424848,
  brazil: 23424768,
};

function getHeaders() {
  return {
    "X-RapidAPI-Key": CONFIG.X_RAPIDAPI_KEY,
    "X-RapidAPI-Host": CONFIG.X_RAPIDAPI_HOST,
  };
}

// ============================================================
// INTENT DETECTION
// ============================================================

function detectXIntent(text) {
  const lower = (text || "").toLowerCase();
  if (/\b(trend|trending|popular|hot\s+topic|top\s+topic)\b/i.test(lower)) return "trends";
  if (/\b(sentiment|analyze|analysis|opinion|mood)\b/i.test(lower)) return "analyze";
  return "search"; // default: search tweets
}

function extractSearchQuery(text) {
  const lower = (text || "").toLowerCase();
  // Remove tool-routing words to isolate the actual query
  let query = text
    .replace(/\b(search|find|get|show|look\s+up|fetch)\s+(tweets?|posts?|x\s+posts?)\s*(about|on|for|regarding|related\s+to)?\s*/gi, "")
    .replace(/\b(tweets?|posts?)\s+(about|on|for|regarding)\s*/gi, "")
    .replace(/\b(on\s+)?twitter\b/gi, "")
    .replace(/\b(on\s+)?x\b/gi, "")
    .trim();
  return query || text;
}

function extractCountry(text) {
  const lower = (text || "").toLowerCase();
  for (const [name, woeid] of Object.entries(WOEID_MAP)) {
    if (lower.includes(name)) return { name, woeid };
  }
  return { name: "worldwide", woeid: 1 };
}

// ============================================================
// API FUNCTIONS
// ============================================================

/**
 * Get trending topics from X
 */
async function getTrends(country = "worldwide") {
  const { name, woeid } = typeof country === "string"
    ? (WOEID_MAP[country.toLowerCase()] ? { name: country, woeid: WOEID_MAP[country.toLowerCase()] } : extractCountry(country))
    : { name: "worldwide", woeid: 1 };

  try {
    const response = await axios.get(
      `https://${CONFIG.X_RAPIDAPI_HOST}/v2/trends/`,
      {
        params: { woeid },
        headers: getHeaders(),
        timeout: 15000,
      }
    );

    const trends = response.data?.trends || response.data || [];
    const top10 = (Array.isArray(trends) ? trends : [])
      .slice(0, 10)
      .map((t, i) => ({
        rank: i + 1,
        name: t.name || t.trend || "Unknown",
        tweet_volume: t.tweet_volume || t.tweetVolume || null,
        url: t.url || null,
      }));

    return {
      success: true,
      trends: top10,
      location: name,
    };
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    console.error(`[x] getTrends error:`, errorMsg);
    return { success: false, error: errorMsg, trends: [] };
  }
}

/**
 * Search tweets by query
 */
async function searchTweets(query, count = 10) {
  try {
    const response = await axios.get(
      `https://${CONFIG.X_RAPIDAPI_HOST}/v2/search/`,
      {
        params: {
          query,
          count: Math.min(count, 20),
        },
        headers: getHeaders(),
        timeout: 15000,
      }
    );

    // RapidAPI responses vary by provider — normalize
    const results = response.data?.tweets || response.data?.results || response.data?.data || [];
    const tweets = (Array.isArray(results) ? results : [])
      .slice(0, count)
      .map((t) => ({
        text: t.text || t.full_text || t.content || "",
        author: t.user?.screen_name || t.author?.username || t.username || "unknown",
        author_name: t.user?.name || t.author?.name || "",
        created_at: t.created_at || t.date || "",
        retweets: t.retweet_count || t.public_metrics?.retweet_count || 0,
        likes: t.favorite_count || t.public_metrics?.like_count || 0,
        replies: t.reply_count || t.public_metrics?.reply_count || 0,
      }));

    return {
      success: true,
      tweets,
      query,
      total: tweets.length,
    };
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    console.error(`[x] searchTweets error:`, errorMsg);
    return { success: false, error: errorMsg, tweets: [] };
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
    const response = await llm(prompt, { timeoutMs: 30000, format: "json" });
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
        // LLM returned non-JSON — extract what we can
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
    return `<div class="x-trends"><p>No trending topics found for ${location}.</p></div>`;
  }

  const rows = trends.map((t) => {
    const vol = t.tweet_volume ? `(${Number(t.tweet_volume).toLocaleString()} tweets)` : "";
    return `<div class="x-trend-item">
      <span class="x-rank">#${t.rank}</span>
      <span class="x-trend-name"><strong>${t.name}</strong></span>
      <span class="x-tweet-volume">${vol}</span>
    </div>`;
  });

  return `<div class="x-trends">
    <h3>🔥 Trending on X — ${location}</h3>
    ${rows.join("\n")}
  </div>`;
}

function formatTweetsHTML(tweets, query) {
  if (!tweets || tweets.length === 0) {
    return `<div class="x-tweets"><p>No tweets found for "${query}".</p></div>`;
  }

  const cards = tweets.map((t) => {
    const engagement = `❤️ ${t.likes} · 🔁 ${t.retweets} · 💬 ${t.replies}`;
    return `<div class="x-tweet-card">
      <div class="x-tweet-author"><strong>@${t.author}</strong>${t.author_name ? ` (${t.author_name})` : ""}</div>
      <div class="x-tweet-text">${t.text}</div>
      <div class="x-tweet-engagement">${engagement}</div>
    </div>`;
  });

  return `<div class="x-tweets">
    <h3>🐦 Tweets about "${query}"</h3>
    ${cards.join("\n")}
  </div>`;
}

function formatSentimentHTML(sentiment) {
  const moodEmoji = {
    positive: "😊",
    negative: "😞",
    neutral: "😐",
    mixed: "🤔",
    unknown: "❓",
  };

  const emoji = moodEmoji[sentiment.overall_sentiment] || "❓";
  const themes = sentiment.themes.length > 0
    ? sentiment.themes.map((t) => `<span class="x-theme-tag">${t}</span>`).join(" ")
    : "No themes detected";

  return `<div class="x-sentiment">
    <h3>${emoji} Sentiment Analysis</h3>
    <div class="x-sentiment-overall"><strong>Overall:</strong> ${sentiment.overall_sentiment}</div>
    <div class="x-sentiment-themes"><strong>Key Themes:</strong> ${themes}</div>
    <div class="x-sentiment-summary"><strong>Summary:</strong> ${sentiment.summary}</div>
  </div>`;
}

function formatTrendsPlain(trends, location) {
  if (!trends || trends.length === 0) return `No trending topics found for ${location}.`;
  const lines = trends.map((t) => {
    const vol = t.tweet_volume ? ` (${Number(t.tweet_volume).toLocaleString()} tweets)` : "";
    return `${t.rank}. ${t.name}${vol}`;
  });
  return `🔥 Trending on X — ${location}\n\n${lines.join("\n")}`;
}

// ============================================================
// MAIN TOOL ENTRY
// ============================================================

export async function x(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  // Check API key
  if (!CONFIG.X_RAPIDAPI_KEY) {
    return {
      tool: "x",
      success: false,
      final: true,
      data: {
        text: "❌ X/Twitter tool is not configured. Please add your RapidAPI key:\n\n" +
          "1. Go to https://rapidapi.com/Jeanyco/api/twitter-api47\n" +
          "2. Subscribe to get an API key\n" +
          "3. Add to `.env`:\n   `X_RAPIDAPI_KEY=your_key_here`\n   `X_RAPIDAPI_HOST=twitter-api47.p.rapidapi.com`",
      },
    };
  }

  const intent = context.action || detectXIntent(text);
  console.log(`🐦 [x] Intent: ${intent} | Text: "${text.slice(0, 80)}"`);

  try {
    // ── TRENDS ──
    if (intent === "trends") {
      const country = context.country || extractCountry(text);
      const countryName = typeof country === "string" ? country : country.name;
      const result = await getTrends(countryName);

      if (!result.success) {
        return {
          tool: "x", success: false, final: true,
          data: { text: `❌ Failed to fetch X trends: ${result.error}` },
        };
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
      const searchResult = await searchTweets(query, 15);

      if (!searchResult.success || searchResult.tweets.length === 0) {
        return {
          tool: "x", success: false, final: true,
          data: { text: `❌ No tweets found to analyze for "${query}": ${searchResult.error || "empty results"}` },
        };
      }

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
    const result = await searchTweets(query);

    if (!result.success) {
      return {
        tool: "x", success: false, final: true,
        data: { text: `❌ Failed to search X: ${result.error}` },
      };
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
    return {
      tool: "x", success: false, final: true,
      data: { text: `❌ X tool error: ${err.message}` },
    };
  }
}

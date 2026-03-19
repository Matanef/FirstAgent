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
// WOEID (Where On Earth ID) MAPPING FOR REGIONAL TRENDS
// ============================================================

const WOEID_MAP = {
  // Global
  global: 1, worldwide: 1, world: 1,
  // Middle East
  israel: 23424852, jerusalem: 1430027, "tel aviv": 1430024,
  // Americas
  us: 23424977, usa: 23424977, "united states": 23424977, america: 23424977,
  canada: 23424775, brazil: 23424768, mexico: 23424900,
  // Europe
  uk: 23424975, "united kingdom": 23424975, britain: 23424975, england: 23424975,
  france: 23424819, germany: 23424829, spain: 23424950, italy: 23424853,
  netherlands: 23424909, sweden: 23424954, turkey: 23424969, russia: 23424936,
  // Asia & Pacific
  japan: 23424856, india: 23424848, australia: 23424748,
  "south korea": 23424868, korea: 23424868, singapore: 23424948,
  indonesia: 23424846, philippines: 23424934, thailand: 23424960,
  // Africa
  "south africa": 23424942, nigeria: 23424908, egypt: 23424802, kenya: 23424863,
};

const WOEID_DISPLAY = {
  1: "Worldwide", 23424852: "Israel", 1430027: "Jerusalem", 1430024: "Tel Aviv",
  23424977: "United States", 23424775: "Canada", 23424768: "Brazil", 23424900: "Mexico",
  23424975: "United Kingdom", 23424819: "France", 23424829: "Germany",
  23424950: "Spain", 23424853: "Italy", 23424909: "Netherlands",
  23424954: "Sweden", 23424969: "Turkey", 23424936: "Russia",
  23424856: "Japan", 23424848: "India", 23424748: "Australia",
  23424868: "South Korea", 23424948: "Singapore", 23424846: "Indonesia",
  23424934: "Philippines", 23424960: "Thailand",
  23424942: "South Africa", 23424908: "Nigeria", 23424802: "Egypt", 23424863: "Kenya",
};

/**
 * Extract region from text or context → { woeid, locationName }
 */
function extractRegion(text, contextCountry) {
  const lower = (text || "").toLowerCase();

  // Priority 1: context.country passed by planner
  if (contextCountry) {
    const key = contextCountry.toLowerCase();
    if (WOEID_MAP[key]) return { woeid: WOEID_MAP[key], locationName: WOEID_DISPLAY[WOEID_MAP[key]] || contextCountry };
  }

  // Priority 2: "in <country>" pattern (most natural phrasing)
  const inMatch = lower.match(/\bin\s+(?:the\s+)?([\w\s]+?)(?:\s*$|\s*[,.]|\s+and\b|\s+then\b)/);
  if (inMatch) {
    const place = inMatch[1].trim();
    if (WOEID_MAP[place]) return { woeid: WOEID_MAP[place], locationName: WOEID_DISPLAY[WOEID_MAP[place]] || place };
  }

  // Priority 3: scan for any known country/city name in the text
  for (const [key, woeid] of Object.entries(WOEID_MAP)) {
    if (key.length > 2 && lower.includes(key)) {
      return { woeid, locationName: WOEID_DISPLAY[woeid] || key };
    }
  }

  return { woeid: 1, locationName: "Worldwide" };
}

// ============================================================
// INTENT DETECTION
// ============================================================

function detectXIntent(text) {
  const lower = (text || "").toLowerCase();
  if (/\b(trends?|trending|popular|hot\s+topic|top\s+topic)\b/i.test(lower)) return "trends";
  if (/\b(sentiment|analyze|analysis|opinion|mood)\b/i.test(lower)) return "analyze";
  if (/\b(post|tweet|publish|send\s+tweet|compose)\b/i.test(lower) && !/\b(search|find|get|show)\b/i.test(lower)) return "post";
  if (/\b(complaint|pain\s*point|frustrat|looking\s+for\s+(a\s+)?better|hate|alternative|issue|problem)\b/i.test(lower)) return "leadgen";
  if (/\b(advanced\s+search|filter|exclude|no\s+retweet|-is:retweet)\b/i.test(lower)) return "leadgen";
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
 * Get trending topics from X for a specific region
 * @param {number} woeid - Where On Earth ID (default: 1 = Worldwide)
 * @param {string} locationName - Display name for the location
 */
async function getTrends(woeid = 1, locationName = "Worldwide") {
  try {
    const tc = await ensureClient();
    const trendsRaw = await tc.getTrends(woeid);

    const top10 = trendsRaw.slice(0, 10).map((t, i) => ({
      rank: i + 1,
      name: t.name,
      tweet_volume: t.tweetVolume || null,
      // Build X search URL for each trend
      searchUrl: `https://x.com/search?q=${encodeURIComponent(t.name)}`,
    }));

    return {
      success: true,
      trends: top10,
      location: locationName,
      woeid,
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
      id: t.id || null,
      text: t.text || "",
      author: t.user?.username || t.user?.id || "unknown",
      author_name: t.user?.name || "",
      created_at: t.createdAt || new Date(),
      retweets: t.retweets || 0,
      likes: t.likes || 0,
      replies: t.replies || 0,
      isRetweet: t.isRetweet || false,
      url: t.id ? `https://x.com/${t.user?.username || "i"}/status/${t.id}` : null,
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
    const url = t.searchUrl || `https://x.com/search?q=${encodeURIComponent(t.name)}`;
    return `<div class="x-trend-item" style="margin-bottom: 8px;">
      <span class="x-rank" style="color: var(--accent); font-weight: bold;">#${t.rank}</span>
      <a href="${url}" target="_blank" class="x-trend-name" style="text-decoration: none;"><strong>${t.name}</strong></a>
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

/**
 * Plain text formatter — outputs raw URLs (WhatsApp-friendly, no markdown links)
 * Each trend gets a clickable X search URL that opens the X app on mobile
 */
function formatTrendsPlain(trends, location) {
  if (!trends || trends.length === 0) return `No trending topics found.`;
  const lines = trends.map((t) => {
    const vol = t.tweet_volume ? ` (${Number(t.tweet_volume).toLocaleString()} tweets)` : "";
    const url = t.searchUrl || `https://x.com/search?q=${encodeURIComponent(t.name)}`;
    return `${t.rank}. ${t.name}${vol}\n🔗 ${url}`;
  });
  return `🔥 Trending on X (${location})\n\n${lines.join("\n\n")}`;
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
    // ── TRENDS (with regional support) ──
    if (intent === "trends") {
      const { woeid, locationName } = extractRegion(text, context.country);
      console.log(`🐦 [x] Fetching trends for ${locationName} (WOEID: ${woeid})`);
      const result = await getTrends(woeid, locationName);
      if (!result.success) {
        return { tool: "x", success: false, final: true, data: { text: `❌ Failed to fetch X trends for ${locationName}: ${result.error}` } };
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

    // ── POST (tweet from the account) ──
    if (intent === "post") {
      const tweetText = text
        .replace(/\b(post|tweet|publish|send|compose)\s*(a\s+)?(tweet|post|on\s+x|to\s+x|on\s+twitter)?\s*:?\s*/i, "")
        .replace(/^["']|["']$/g, "")
        .trim();

      if (!tweetText || tweetText.length < 2) {
        return { tool: "x", success: false, final: true, data: { text: "❌ No tweet content provided. Usage: \"tweet: your message here\"" } };
      }
      if (tweetText.length > 280) {
        return { tool: "x", success: false, final: true, data: { text: `❌ Tweet too long (${tweetText.length}/280 chars). Please shorten it.` } };
      }

      console.log(`🐦 [x] Posting tweet: "${tweetText.slice(0, 60)}..."`);
      const tc = await ensureClient();
      const posted = await tc.createTweet(tweetText);
      return {
        tool: "x", success: true, final: true,
        data: {
          text: `<div class="x-posted"><h3>✅ Tweet Posted</h3><p>${tweetText}</p><p><a href="${posted.url}" target="_blank">View tweet →</a></p></div>`,
          plain: `✅ Tweet posted: "${tweetText}"\n🔗 ${posted.url}`,
          raw: posted,
        },
      };
    }

    // ── LEAD GEN / ADVANCED SEARCH (excludes retweets, includes URLs) ──
    if (intent === "leadgen") {
      let query = extractSearchQuery(text);
      // Strip lead-gen intent words to get the clean topic
      query = query
        .replace(/\b(advanced\s+search|complaints?\s+(about|regarding|for)|pain\s*points?\s+(about|for|with)|frustrat\w*\s+(with|about)|looking\s+for\s+(a\s+)?better|issues?\s+with|problems?\s+with)\b/gi, "")
        .replace(/\b(exclude|filter|no)\s+retweets?\b/gi, "")
        .replace(/\b(search\s+(?:x|twitter)\s+for|search\s+for)\b/gi, "")
        .replace(/\b\d+\s+recent\b/gi, "")     // "5 recent" → ""
        .replace(/\brecent\b/gi, "")
        .replace(/\s+and\s*$/i, "")             // trailing "and"
        .replace(/^\s*and\s+/i, "")             // leading "and"
        .replace(/^[,.\s]+|[,.\s]+$/g, "")     // leading/trailing commas, dots, spaces
        .replace(/\s+/g, " ").trim();
      // Append retweet filter for cleaner results
      if (!query.includes("-is:retweet")) query += " -is:retweet";
      console.log(`🐦 [x] Lead Gen search: "${query}"`);

      const result = await searchTweets(query, 20);
      if (!result.success) {
        return { tool: "x", success: false, final: true, data: { text: `❌ Lead gen search failed: ${result.error}` } };
      }

      // Filter out retweets that slipped through
      const filtered = result.tweets.filter(t => !t.isRetweet);

      // Format with full details for LLM chaining
      const plainLines = filtered.map((t, i) =>
        `${i + 1}. @${t.author}: "${t.text.substring(0, 200)}"\n   ❤️${t.likes} 🔁${t.retweets} 💬${t.replies}${t.url ? `\n   🔗 ${t.url}` : ""}`
      );

      const html = filtered.map((t, i) => {
        const tweetUrl = t.url || "#";
        return `<div class="x-tweet-card" style="border: 1px solid var(--border); padding: 10px; margin-bottom: 10px; border-radius: 8px;">
          <div><strong>${i + 1}.</strong> <a href="https://x.com/${t.author}" target="_blank">@${t.author}</a></div>
          <div style="margin: 6px 0;">${t.text}</div>
          <div style="font-size: 0.8em; color: gray;">❤️ ${t.likes} · 🔁 ${t.retweets} · 💬 ${t.replies} · <a href="${tweetUrl}" target="_blank">view</a></div>
        </div>`;
      }).join("\n");

      return {
        tool: "x", success: true, final: true,
        data: {
          text: `<div class="x-leadgen"><h3>🎯 Lead Gen Results for "${query.replace(" -is:retweet", "")}" (${filtered.length} tweets)</h3>${html}</div>`,
          plain: `🎯 Lead Gen: "${query.replace(" -is:retweet", "")}" — ${filtered.length} results\n\n${plainLines.join("\n\n")}`,
          raw: { ...result, tweets: filtered, intent: "leadgen" },
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
        plain: result.tweets.map((t) => `@${t.author}: ${t.text.substring(0, 200)} (❤️${t.likes})${t.url ? ` 🔗 ${t.url}` : ""}`).join("\n\n"),
        raw: result,
      },
    };

  } catch (err) {
    console.error("[x] Unexpected error:", err);
    return { tool: "x", success: false, final: true, data: { text: `❌ X tool error: ${err.message}` } };
  }
}

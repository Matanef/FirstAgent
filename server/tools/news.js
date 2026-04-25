// server/tools/news.js
// good version 11/04/2026 19:20
// COMPLETE FIX: News with topic extraction and filtering

import Parser from "rss-parser";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { safeFetch } from "../utils/fetch.js";
import { llm } from "./llm.js";
import { extractFromNews } from "../knowledge.js";
import { getPersonalityContext } from "../personality.js";
import { CONFIG } from "../utils/config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const parser = new Parser();

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── LOAD FEEDS FROM JSON ──
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FEEDS_FILE = path.resolve(__dirname, "..", "data", "rss_feeds.json");

let FEEDS = {};
let CATEGORY_FEEDS = {};

try {
  const feedsData = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8"));
  FEEDS = feedsData.general || {};
  CATEGORY_FEEDS = feedsData.categories || {};
  console.log(`📰 Loaded ${Object.keys(FEEDS).length} general feeds and ${Object.keys(CATEGORY_FEEDS).length} categories from json.`);
} catch (err) {
  console.warn("⚠️ Could not load rss_feeds.json. Check file path and JSON formatting:", err.message);
}

// ── SCRAPE SOURCES (non-RSS Israeli news flash pages) ──
// These are web pages with headline snapshots, not RSS feeds.
// Each source has a custom scraper that returns items in the same format as RSS.
const SCRAPE_SOURCES = {
  mako_flash: {
    url: "https://www.mako.co.il/news-news-flash",
    label: "mako_flash",
    scraper: scrapeMako
  },
  ynet_flash: {
    url: "https://www.ynet.co.il/news/category/184",
    label: "ynet_flash",
    scraper: scrapeYnet
  },
  rotter: {
    url: "http://www.rotter.net/news/news.php?nws=1",
    label: "rotter",
    scraper: scrapeRotter
  }
};

/**
 * Scrape Mako news flash page.
 * Structure: <li><h3>HH:MM | headline</h3></li>
 * No direct article links — headlines are accordion-based.
 */
async function scrapeMako() {
  try {
    const res = await fetch(SCRAPE_SOURCES.mako_flash.url, {
      headers: { "User-Agent": BROWSER_UA },
      timeout: 10000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Detect CAPTCHA/block page
    if (html.includes("captcha") || html.includes("We are sorry") || html.length < 20000) {
      console.warn("📰 mako_flash: blocked by CAPTCHA/bot detection");
      return [];
    }

    const $ = cheerio.load(html);

    const items = [];
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    $("h3").each((i, el) => {
      const raw = $(el).text().trim();
      // Format: "HH:MM | headline text"
      const match = raw.match(/^(\d{1,2}:\d{2})\s*\|\s*(.+)$/);
      if (!match) return;

      const [, time, headline] = match;
      items.push({
        title: headline.trim(),
        link: SCRAPE_SOURCES.mako_flash.url,
        date: `${today}T${time.padStart(5, "0")}:00.000Z`,
        description: headline.trim(),
        source: "mako_flash"
      });
    });

    console.log(`📰 Scraped mako_flash: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`📰 Scrape mako_flash failed: ${err.message}`);
    return [];
  }
}

/**
 * Scrape Ynet breaking news / flash page.
 * Structure: <div class="AccordionSection {articleId}"> with .title and time[datetime]
 */
async function scrapeYnet() {
  try {
    const res = await fetch(SCRAPE_SOURCES.ynet_flash.url, {
      headers: { "User-Agent": BROWSER_UA },
      timeout: 10000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const items = [];

    $("[class*=AccordionSection]").each((i, el) => {
      const cls = $(el).attr("class") || "";
      const idMatch = cls.match(/AccordionSection\s+(\w+)/);
      const articleId = idMatch ? idMatch[1] : "";

      const title = $(el).find("[class*=title]").first().text().trim();
      if (!title || title.length < 5) return;

      // Timestamp from time[datetime] inside the section
      const datetime = $(el).find("time[datetime]").attr("datetime") || "";

      items.push({
        title,
        link: articleId
          ? `https://www.ynet.co.il/news/article/${articleId}`
          : SCRAPE_SOURCES.ynet_flash.url,
        date: datetime || new Date().toISOString(),
        description: title,
        source: "ynet_flash"
      });
    });

    console.log(`📰 Scraped ynet_flash: ${items.length} items`);
    return items.slice(0, 25); // Cap to avoid flooding — Ynet can return 100+ items
  } catch (err) {
    console.warn(`📰 Scrape ynet_flash failed: ${err.message}`);
    return [];
  }
}

/**
 * Scrape Rotter.net news page.
 * Rotter uses Windows-1255 encoding and blocks some user agents.
 * Structure: table-based layout with <a> links containing headlines.
 */
async function scrapeRotter() {
  try {
    const res = await fetch(SCRAPE_SOURCES.rotter.url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "he,en-US;q=0.9,en;q=0.8",
        "Referer": "http://www.rotter.net/",
        "Cache-Control": "no-cache"
      },
      timeout: 10000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Rotter uses Windows-1255 encoding
    const buf = await res.buffer();
    const html = iconv.decode(buf, "win1255");
    const $ = cheerio.load(html);

    const items = [];
    const seen = new Set();

    // Rotter uses table rows with links
    $("a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim();

      // Filter: must be a meaningful headline (Hebrew text, reasonable length)
      if (text.length < 10 || text.length > 200) return;
      if (seen.has(text)) return;
      // Skip navigation/UI links
      if (/^(http|www\.)/.test(text)) return;
      if (/\.(jpg|png|gif|css|js)$/i.test(href)) return;

      seen.add(text);
      const fullLink = href.startsWith("http")
        ? href
        : href.startsWith("/")
          ? `http://www.rotter.net${href}`
          : SCRAPE_SOURCES.rotter.url;

      items.push({
        title: text,
        link: fullLink,
        date: new Date().toISOString(),
        description: text,
        source: "rotter"
      });
    });

    console.log(`📰 Scraped rotter: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`📰 Scrape rotter failed: ${err.message}`);
    return [];
  }
}

/**
 * Detect if the user is asking for a specific news category
 */
function detectCategory(query) {
  const lower = (query || "").toLowerCase();
  const categoryMap = {
    technology: /\b(tech|technology|software|ai|artificial intelligence|programming|cyber|startup)\b/,
    science: /\b(science|scientific|research|space|physics|biology|climate|environment)\b/,
    business: /\b(business|economy|economic|market|stock|finance|trade|gdp)\b/,
    sports: /\b(sport|sports|football|soccer|basketball|tennis|cricket|nba|nfl)\b/,
    health: /\b(health|medical|medicine|disease|covid|pandemic|hospital|drug)\b/,
    entertainment: /\b(entertainment|movie|film|music|celebrity|tv|television|show)\b/
  };

  for (const [category, regex] of Object.entries(categoryMap)) {
    if (regex.test(lower)) return category;
  }
  return null;
}

// FIX #4: Extract topic from user query
function extractTopic(query) {
  const text = typeof query === "string" ? query : query?.text || "";
  const lower = text.toLowerCase();

  // Strip conversational noise before extracting topic
  let stripped = lower
    // Strip scheduling phrases FIRST — "every 9 hours", "daily at 8am", "schedule", etc.
    .replace(/\b(?:use\s+(?:the\s+)?scheduler\s+(?:tool\s+)?(?:to\s+)?)\b/gi, "")
    .replace(/\b(?:schedule|scheduling|scheduled)\s+(?:a\s+)?(?:search\s+(?:for\s+)?)?/gi, "")
    .replace(/[,;]?\s*every\s+\d+\s*(?:min(?:utes?)?|hours?|days?|secs?(?:onds?)?|weeks?)\b/gi, "")
    .replace(/[,;]?\s*(?:every\s+(?:morning|evening|night|day|week|hour)|hourly|daily|weekly|monthly)\b/gi, "")
    .replace(/[,;]?\s*(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/gi, "")
    // Strip question words/phrases EARLY — "what's", "what are the", "how about", etc.
    .replace(/\bwhat['\u2018\u2019]?s\b/gi, "")
    .replace(/\b(what\s+(?:is|are|were)|where\s+(?:is|are)|who\s+(?:is|are|was|were)|how\s+(?:about|is|are))\s+(?:the\s+)?/gi, "")
    // Strip "let's" first — apostrophe makes regex word boundaries tricky
    .replace(/let['\u2018\u2019]?s\b/gi, "")
    .replace(/\b(you can go|go|please|i want you to|i need you to|can you)\b/gi, "")
    // Must come BEFORE stripping "get" — matches "get the latest tech news" as a whole phrase
    .replace(/\bget\s+(?:the\s+)?(?:latest|recent|breaking|top|current)\s+(?:\w+\s+)?(?:news|headlines|articles)\b/gi, "")
    .replace(/\b(search for|look up|find|fetch|get|show me|give me)\b/gi, "")
    .replace(/\b(to learn about it|to learn|to know|to read|to see|to check)\b/gi, "")
    .replace(/\b(?:catch\s+(?:me\s+)?up|(?:get|check)\s+(?:me\s+)?(?:updated|up))\s*(?:on)?\b/gi, "")
    .replace(/\bsummarize\s+(?:the\s+)?(?:first|top|last|latest)?\s*\d*\s*(?:articles?|stories|headlines?)?\b/gi, "")
    .replace(/\busing\s+(?:the\s+)?\w+\s+tool\b/gi, "")
    .replace(/\b(?:first|top|last|latest)\s+\d+\b/gi, "")
    .replace(/\b(latest|recent|breaking|top|current)\b/gi, "")
    .replace(/\b(news|headlines|articles|stories)\b/gi, "")
    .replace(/\b(about|regarding|on|for)\s+(?:it|this|that|them)\s*$/gi, "")
    .replace(/\band\s+(?:email|send|mail)\b.*$/gi, "")
    // Strip trailing compound instructions from multi-step prompts
    // e.g., "AI news, using the llm summarize" → "AI news"
    .replace(/[,;]\s*(?:and\s+)?(?:then\s+)?(?:using|use|with)\s+(?:the\s+)?(?:llm|ai|gpt|model)\b.*$/gi, "")
    .replace(/[,;]\s*(?:and\s+)?(?:then\s+)?(?:summarize|analyze|send|email|forward|compile|create|generate)\b.*$/gi, "")
    .replace(/\band\s+(?:then\s+)?(?:using|use|with)\s+(?:the\s+)?(?:llm|ai)\b.*$/gi, "")
    .replace(/\band\s+(?:then\s+)?(?:summarize|analyze|send|forward)\b.*$/gi, "")
    // Strip filler/quantifier words that aren't topics
    .replace(/\b(some|any|all|few|more|every|many|much|several|updated?)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();

  // Words that look like topics but aren't — quantifiers, pronouns, filler, question words
  const topicNoiseWords = new Set([
    "some", "any", "all", "few", "more", "every", "many", "much", "several",
    "it", "its", "this", "that", "them", "their", "us", "me", "updated", "news", "headlines",
    "the", "a", "an", "on", "in", "at", "to", "for", "of", "new",
    "what", "whats", "what's", "how", "who", "where", "when", "why", "which",
    "is", "are", "was", "were", "do", "does", "did", "about"
  ]);

  function cleanTopic(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/\b(it|its|this|that|some|any|all|their|news|headlines)\b/gi, "").trim();
    if (cleaned.length < 3) return null;
    // Reject if ALL remaining words are noise
    const words = cleaned.split(/\s+/).filter(w => !topicNoiseWords.has(w.toLowerCase()) && w.length > 1);
    return words.length > 0 ? words.join(" ") : null;
  }

  // Extract specific topic patterns — match first "about/regarding/on/for" + topic
  // Strip "news" before matching so "news about X" → "about X" → captures "X"
  // Allow trailing punctuation (?!.) so "on stem cell?" still matches
  const forTopicMatch = stripped.replace(/\bnews\b/gi, "").trim();
  const topicMatch = forTopicMatch.match(/(?:about|regarding|on|for)\s+(?:the\s+)?([a-z0-9\s,'-]+?)(?:\s+to\s+(?:learn|know|read|see|check)|[?!.]*$)/i);
  const cleanedTopic = cleanTopic(topicMatch?.[1]);
  if (cleanedTopic) return cleanedTopic;

  // Fallback: try "about X" from original (but still clean it)
  const lowerTopicMatch = lower.match(/(?:about|regarding|on|for)\s+(?:the\s+)?([a-z0-9\s,'-]+?)(?:\s+to\s+(?:learn|know|read|see|check)|[?!.]*$)/i);
  const cleanedLowerTopic = cleanTopic(lowerTopicMatch?.[1]);
  if (cleanedLowerTopic) return cleanedLowerTopic;

  // Extract from "X news" — use stripped version to avoid "show me latest" noise
  const newsMatch = stripped.match(/([a-z0-9\s]+)\s+news/i) || lower.match(/([a-z0-9\s]+)\s+news/i);
  if (newsMatch) {
    const rejectPrefixes = new Set(["the", "latest", "breaking", "top", "show", "me", "get", "give", "some", "any", "all"]);
    const topic = newsMatch[1].trim().split(/\s+/).filter(w => !rejectPrefixes.has(w)).join(" ");
    if (topic.length > 2 && !topicNoiseWords.has(topic.toLowerCase())) {
      return topic;
    }
  }

  // Use the cleaned/stripped version if meaningful
  const rejectWords = new Set([
    "any", "some", "all", "the", "a", "an", "and", "or", "me", "my", "your", "about", "for", "on", "in",
    "what", "whats", "how", "who", "where", "when", "why", "which", "is", "are", "was", "were", "do", "does"
  ]);
  const words = stripped.split(/\s+/).filter(w => !rejectWords.has(w) && w.length > 1);
  if (words.length > 0 && words.length <= 6) {
    return words.join(" ");
  }

  return null;
}

// Filter headlines by topic
function filterByTopic(items, topic) {
  if (!topic) return items;

  // Filter out common/short words that match everything
  const stopWords = new Set(["the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "is", "it", "its", "get", "be", "do", "has", "was", "are", "by", "as", "my", "me", "we", "us", "new", "old", "big", "how", "why", "what"]);
  const keywords = topic.toLowerCase()
    .replace(/[,']/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return items;

  // Score-based filtering: require at least half of meaningful keywords to match,
  // or at least 2 keywords for multi-keyword topics. This prevents articles matching
  // on a single generic word like "security" from drowning out relevant results.
  const minMatchCount = keywords.length <= 2 ? 1 : Math.max(2, Math.ceil(keywords.length * 0.4));

  const scored = items.map(item => {
    const searchText = `${item.title} ${item.description || ''}`.toLowerCase();
    const matchCount = keywords.filter(kw => searchText.includes(kw)).length;
    return { item, matchCount };
  }).filter(s => s.matchCount >= minMatchCount);

  // Sort by relevance (most keyword matches first)
  scored.sort((a, b) => b.matchCount - a.matchCount);
  return scored.map(s => s.item);
}

async function scrapeArticle(url) {
  try {
    const html = await safeFetch(url, { 
      method: "GET",
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!html || typeof html !== 'string') return null;
    
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    return text.substring(0, 2000);
  } catch (err) {
    console.warn(`Failed to scrape ${url}:`, err.message);
    return null;
  }
}

async function summarizeArticle(title, content, signal) {
  if (!content) return null;
  
  const prompt = `You are a strict data processor. Summarize the following text in 2-3 sentences. 
If the text is extremely short, just rephrase the core fact. 
CRITICAL: DO NOT apologize. DO NOT say "I don't know". DO NOT mention your knowledge cutoff. Output ONLY the summary.

Title: ${title}

Content:
${content}

Summary (2-3 sentences):`;

try {
    // FIX: Isolate this call from the chat history and weather context
    const result = await llm(prompt, { 
      skipKnowledge: true,
      skipHistory: true, 
      systemOverride: "You are a strict data summarizer. Do not converse or apologize. Output ONLY the summary.",
      signal
    });
    
    if (result.success && result.data?.text) {
      return result.data.text.trim();
    }
    return null;
  } catch (err) {
    console.warn("LLM summarization failed:", err.message);
    return null;
  }
}

export async function news(request, options = {}) {
  try {
    const signal = request?.signal || options?.signal;
    const query = typeof request === "string" ? request : request?.text || "";
    // Article count: from context (compound pattern), or parsed from query text, or default 8
    const contextCount = typeof request === "object" ? request?.context?.articleCount : null;
    const textCountMatch = query.match(/\b(?:first|top|latest|last)\s+(\d+)\b|\b(\d+)\s+(?:articles?|stories|headlines?)\b/i);
    const articleCount = contextCount || (textCountMatch ? parseInt(textCountMatch[1] || textCountMatch[2], 10) : 8);

    // Extract topic and detect category
    const topic = extractTopic(query);
    const category = detectCategory(query);
    console.log(`📰 News tool - Topic: "${topic || 'general'}", Category: "${category || 'all'}"`);

    // Build feed list: general + category-specific if detected
    const feedsToFetch = { ...FEEDS };
    if (category && CATEGORY_FEEDS[category]) {
      Object.assign(feedsToFetch, CATEGORY_FEEDS[category]);
      console.log(`📰 Added ${Object.keys(CATEGORY_FEEDS[category]).length} category feeds for: ${category}`);
    }

    const results = [];
    const allItems = [];

    // Fetch all RSS feeds in parallel (with per-feed timeout)
    const feedEntries = Object.entries(feedsToFetch);
    const feedPromises = feedEntries.map(async ([name, url]) => {
      try {
        const feed = await Promise.race([
          parser.parseURL(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
        ]);
        const items = (feed.items || []).slice(0, 10).map(i => ({
          title: i.title,
          link: i.link,
          date: i.pubDate,
          description: i.contentSnippet || i.description,
          source: name
        }));
        return { source: name, items, error: null };
      } catch (err) {
        console.warn(`📰 Feed ${name} failed: ${err.message}`);
        return { source: name, error: err.message, items: [] };
      }
    });

    // Also scrape non-RSS sources in parallel with RSS feeds
    const scrapePromisesArr = Object.entries(SCRAPE_SOURCES).map(async ([name, source]) => {
      try {
        const items = await source.scraper();
        return { source: name, items, error: null };
      } catch (err) {
        console.warn(`📰 Scrape ${name} failed: ${err.message}`);
        return { source: name, error: err.message, items: [] };
      }
    });

    // Wait for both RSS feeds and scraped sources
    const [feedResults, webScrapeResults] = await Promise.all([
      Promise.all(feedPromises),
      Promise.all(scrapePromisesArr)
    ]);

    for (const result of [...feedResults, ...webScrapeResults]) {
      results.push(result);
      allItems.push(...result.items);
    }

    // ── Separate flash items from RSS items ──
    const flashSourceNames = new Set(Object.keys(SCRAPE_SOURCES));
    const flashItems = allItems.filter(i => flashSourceNames.has(i.source));
    const rssItems = allItems.filter(i => !flashSourceNames.has(i.source));

    // Filter out stale RSS articles (older than 7 days)
    // Flash items are always fresh (scraped just now)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
const freshRssItems = rssItems.filter(item => item.date ? new Date(item.date).getTime() > sevenDaysAgo : true);

    // Topic filter only applies to RSS items — flash headlines always show
    let filteredRssItems = topic ? filterByTopic(freshRssItems, topic) : freshRssItems;

    console.log(`📊 Total: ${allItems.length} (${flashItems.length} flash + ${rssItems.length} RSS), Fresh RSS: ${freshRssItems.length}, Filtered RSS: ${filteredRssItems.length}`);

    // If topic filtering eliminated most results, the topic is too specific for RSS feeds.
    // Fall back to web search via SerpAPI to find relevant news articles.
    if (topic && filteredRssItems.length < 3) {
      console.log(`📰 Topic "${topic}" too specific for RSS — augmenting with web search`);
      try {
        const serpKey = CONFIG.SERPAPI_KEY;
        if (serpKey) {
          const searchQuery = encodeURIComponent(`${topic} news ${new Date().getFullYear()}`);
          const serpUrl = `https://serpapi.com/search.json?q=${searchQuery}&tbm=nws&api_key=${serpKey}&num=10`;
          const resp = await safeFetch(serpUrl);
          const data = typeof resp === "string" ? JSON.parse(resp) : resp;
          const newsResults = data?.news_results || [];
          const searchItems = newsResults.map(r => ({
            title: r.title,
            link: r.link,
            date: r.date,
            description: r.snippet || "",
            source: r.source?.name || "web"
          }));
          if (searchItems.length > 0) {
            console.log(`📰 Web search found ${searchItems.length} news articles for "${topic}"`);
            filteredRssItems = [...searchItems, ...filteredRssItems];
          }
        }
      } catch (err) {
        console.warn(`📰 Web search fallback failed: ${err.message}`);
      }
    }

// Scrape and summarize top RSS articles (flash items are headline-only, no scraping)
    const summaries = [];
    const scrapePromises = filteredRssItems.slice(0, articleCount).map(async (article) => {
      if (signal?.aborted) throw new Error("Aborted"); // 👈 STOP SIGN
      console.log(`  Scraping: ${article.title}`);
      
      const content = await scrapeArticle(article.link);
      
      if (signal?.aborted) throw new Error("Aborted"); // 👈 STOP SIGN
      const textForSummary = content || article.description || null;
      
      if (textForSummary && textForSummary.length > 50) {
        // 👇 Pass the signal here!
        const summary = await summarizeArticle(article.title, textForSummary, signal);
        if (summary) {
          return { title: article.title, link: article.link, source: article.source, summary };
        }
      }
      return { title: article.title, link: article.link, source: article.source, summary: article.description || article.title };
    });

      const scrapeResults = await Promise.all(scrapePromises);
          summaries.push(...scrapeResults.filter(Boolean));
      if (signal?.aborted) throw new Error("Aborted"); // 👈 STOP SIGN
          let overallSynthesis = "";
          let htmlSynthesis = ""; // 👉 ADD THIS HERE!
          if (summaries.length > 0) {
      console.log(`🧠 Generating overall synthesis for ${summaries.length} articles...`);
      
try {
        // Fetch Lanou's specific personality and voice instructions
        const personalityCtx = await getPersonalityContext("chat");
        
        // 👉 ADD THIS LINE to build the text from the summaries!
        const combinedText = summaries.map(s => `Title: ${s.title}\nSummary: ${s.summary}`).join("\n\n");

        const synthesisPrompt = `
${personalityCtx}

Here are the latest news summaries${topic ? ` about ${topic}` : ''}. React to them in your own voice — not as a neutral reporter, but as someone who actually has thoughts and opinions about what's happening.

Write two paragraphs. No fluff, no hedging:
- First: what's actually going on? What's the crux of it, stripped of PR spin? If this contradicts or updates something you already knew, say so bluntly.
- Second: your take. Pick a side if you have one. Point out what's absurd, what's underreported, what the real implications are. If something annoys you, say it. If something is genuinely interesting, say why. Don't wrap up with a bland summary — end on your actual thought.

HARD RULES:
- No corporate-speak ("multifaceted", "complex landscape", "moving forward", "underscores the importance of")
- No meta-commentary about yourself ("As an AI, I find it fascinating...")
- No both-sidesing everything into mush
- Don't list facts you just read back at the reader — react to them
- If you have prior knowledge about this topic that makes the new info surprising or ironic, use it

NEW STORIES:
${combinedText}`;
        
        // FIX: Removed `skipKnowledge: true` so the agent's long-term passive 
        // knowledge is injected into the prompt, allowing it to form an evolving opinion.
        const synthesisResult = await llm(synthesisPrompt, { skipHistory: true, signal }); 
        
        if (synthesisResult.success && synthesisResult.data?.text) {
          // Keep the raw text clean for the Email tool
          overallSynthesis = synthesisResult.data.text.trim();
          
          // Create a separate variable specifically formatted for the UI Widget
          // 👉 REMOVE 'const' HERE
          htmlSynthesis = overallSynthesis
            .split(/\n+/)
            .filter(p => p.trim().length > 0)
            .map(p => `<p>${p.trim()}</p>`)
            .join("");
        }
      } catch (err) {
        console.warn("⚠️ Failed to generate overall synthesis:", err.message);
      }
    }

    // ── Source label formatting ──
    function formatSourceLabel(source) {
      return source.replace(/_flash$/, "").toUpperCase();
    }

    // ── Build HTML ──

    // Flash section: compact scrollable ticker of breaking headlines (always shown if items exist)
    const flashHtml = flashItems.length > 0 ? `
      <div class="news-flash-section">
        <div class="news-flash-header">⚡ Breaking News Flash</div>
        <div class="news-flash-list">
          ${flashItems.slice(0, 20).map(i => {
            const time = i.date ? new Date(i.date).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "";
            const src = formatSourceLabel(i.source);
            return `<div class="news-flash-item">
              <span class="flash-time">${time}</span>
              <span class="flash-source">${src}</span>
              <a href="${i.link}" target="_blank" class="flash-headline">${i.title}</a>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : "";

    // Summary cards (RSS articles only)
    const summaryCards = summaries.map(s => `
      <div class="news-summary-card">
        <div class="news-summary-header">
          <span class="news-source">${formatSourceLabel(s.source)}</span>
        </div>
        <h3 class="news-summary-title">${s.title}</h3>
        <p class="news-summary-text">${s.summary}</p>
        <a href="${s.link}" target="_blank" class="news-summary-link">Read full article →</a>
      </div>
    `).join("");

// RSS headline table
    const headlineTable = filteredRssItems.length > 0 ? `
      <details class="news-accordion">
        <summary class="accordion-header">
          <h3>${topic ? "Related Headlines" : "All Headlines"}</h3>
        </summary>
        <div class="ai-table-wrapper">
          <table class="ai-table">
            <thead>
              <tr><th>Source</th><th>Headline</th><th>Date</th></tr>
            </thead>
            <tbody>
              ${filteredRssItems.slice(0, 30).map(i => `
                <tr>
                  <td>${formatSourceLabel(i.source)}</td>
                  <td><a href="${i.link}" target="_blank">${i.title}</a></td>
                  <td>${i.date ? new Date(i.date).toLocaleDateString() : "-"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>
    ` : "";

const html = `
      <div class="news-container">
        ${topic ? `<div class="news-topic-banner">📰 News about: <strong>${topic}</strong></div>` : ""}
        
        ${overallSynthesis ? `
          <div class="news-synthesis-card">
            <div class="synthesis-header">🤖 AI Conclusion</div>
            <div class="synthesis-body">
               ${htmlSynthesis}
            </div>
          </div>
        ` : ""}

        ${flashHtml}

        ${summaries.length > 0 ? `
          <details class="news-accordion" open>
            <summary class="accordion-header">
              <h2>Top Stories</h2>
            </summary>
            <div class="news-summaries">
              ${summaryCards}
            </div>
          </details>
        ` : ""}
        
        ${headlineTable}
      </div>

      <style>

/* ── AI Synthesis Card ── */
  .news-synthesis-card {
    background: var(--bg-secondary);
    border-left: 4px solid var(--accent);
    padding: 1rem 1.5rem;
    border-radius: 4px;
    margin-bottom: 1rem;
  }
  .synthesis-header {
    font-weight: bold;
    color: var(--accent);
    margin-bottom: 0.5rem;
    font-size: 1.1rem;
  }
  .news-synthesis-card p {
    margin: 0;
    line-height: 1.6;
    color: var(--text-primary);
  }

/* ── Flash section ── */
  .news-flash-section {
    background: var(--bg-tertiary);
    border: 1px solid #e74c3c;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }
  .news-flash-header {
    background: #e74c3c;
    color: white;
    padding: 0.5rem 1rem;
    font-weight: 600;
    font-size: 0.95rem;
    letter-spacing: 0.5px;
  }
  .news-flash-list {
    max-height: 280px;
    overflow-y: auto;
    padding: 0.25rem 0;
  }
  .news-flash-item {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.35rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .news-flash-item:last-child {
    border-bottom: none;
  }
  .flash-time {
    color: var(--text-secondary);
    font-size: 0.75rem;
    min-width: 38px;
    flex-shrink: 0;
    font-family: monospace;
  }
  .flash-source {
    background: #e74c3c;
    color: white;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    font-size: 0.65rem;
    font-weight: 600;
    flex-shrink: 0;
    letter-spacing: 0.3px;
  }
  .flash-headline {
    color: var(--text-primary);
    text-decoration: none;
    flex: 1;
  }
  .flash-headline:hover {
    text-decoration: underline;
    opacity: 0.8;
  }

/* ── Topic banner ── */
  .news-topic-banner {
    background: var(--accent);
    color: white;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin-bottom: 0.5rem;
    font-size: 1.1rem;
    text-align: center;
  }

/* ── Main container ── */
  .news-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

/* ── Summary cards ── */
  .news-summaries {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: center;
  }
  .news-summaries h2 {
    width: 100%;
    text-align: center;
    margin-bottom: 1rem;
    color: var(--text-primary);
  }
  .news-summary-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.5rem;
    width: 420px;
    max-height: 260px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    text-align: left;
  }
  .news-summary-header {
    margin-bottom: 0.4rem;
  }
  .news-source {
    background: var(--accent);
    color: white;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 500;
  }
  .news-summary-title {
    margin: 0.4rem 0;
    font-size: 1.05rem;
    color: var(--text-primary);
  }
  .news-summary-text {
    margin: 0.5rem 0;
    line-height: 1.5;
    color: var(--text-secondary);
    font-size: 0.85rem;
    flex: 1;
    overflow: hidden;
  }
  .news-summary-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    font-size: 0.85rem;
  }
  .news-summary-link:hover {
    text-decoration: underline;
    opacity: 0.7;
  }

  /* ── Accordions (Dropdowns) ── */
  .news-accordion {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 1rem;
    overflow: hidden;
  }
  .accordion-header {
    cursor: pointer;
    padding: 1rem 1.5rem;
    background: var(--bg-tertiary);
    user-select: none;
    transition: background 0.2s;
  }
  .accordion-header:hover {
    background: var(--bg-primary);
  }
  .accordion-header h2, .accordion-header h3 {
    margin: 0;
    display: inline-block;
    color: var(--text-primary);
    font-size: 1.15rem;
  }
  /* Add a little padding to the content inside the dropdowns */
  .news-accordion .news-summaries {
    padding: 1.5rem;
    margin-bottom: 0;
  }
  .news-accordion .ai-table-wrapper {
    padding: 1rem;
    border: none;
  }
  .news-accordion[open] > .accordion-header {
    border-bottom: 1px solid var(--border);
  }
  
  /* Optional: Fix the old h2 centering rule since we moved the h2 into the summary */
  .news-summaries h2 {
    display: none; 
  }
      </style>
    `;

    // Store facts in passive knowledge system (awaited so we can report what was learned)
    let learnedFacts = [];
    try {
      learnedFacts = await extractFromNews(summaries, topic) || [];
    } catch (e) {
      console.warn("[news] Knowledge extraction failed:", e.message);
    }

    // ── Build plain-text version for WhatsApp / non-HTML channels ──
    // Prioritizes: AI synthesis + top story summaries. Flash news excluded.
// ── Build plain-text version ──
    const plainParts = [];
    
    const isHighPriority = (overallSynthesis + (topic || "")).toLowerCase().match(/(critical|urgent|war|cease fire|threat|danger)/);
    const headerEmoji = isHighPriority ? "🚨" : "📰";
    
    if (topic) {
      plainParts.push(`### ${headerEmoji} TOPIC: ${topic.toUpperCase()}\n\u200B`);
    }

    if (overallSynthesis) {
      const cleanSynthesis = overallSynthesis.replace(/\r/g, "");
      const styledSynthesis = cleanSynthesis
        .split('\n')
        .filter(p => p.trim())
        .map(p => p.replace(/([^.!?]*\b(threat|risk|fragile|skepticism|instability|crux|precarious)\b[^.!?]*[.!?])/gi, '**$1**'))
        .join('\n\n');
        
      plainParts.push(`### 🤖 AI ANALYSIS\n\n${styledSynthesis}\n\u200B`);
    }

    if (summaries.length > 0) {
      plainParts.push(`### 📋 TOP STORIES\n\u200B`);
      
      const storyLines = summaries.slice(0, 8).map((s, i) => {
        const src = s.source ? ` *[${s.source.toUpperCase()}]*` : "";
        const desc = s.summary ? `\n${s.summary.slice(0, 250).replace(/\n/g, ' ')}` : "";
        
        // We use \u200B (Zero Width Space) to "anchor" the newline so it doesn't collapse
        return `**${i + 1}. ${s.title.toUpperCase()}**${src}${desc}\n🔗 ${s.link}\n\u200B`;
      });
      
      plainParts.push(storyLines.join("\n"));
    }

    // Join sections with double newlines - we removed quadruple to stop CJQ glitch
    const plain = plainParts.length > 0 ? plainParts.join("\n\n") : undefined;

    return {
      tool: "news",
      success: true,
      final: true,
      data: {
        results,
        summaries,
        topic,
        totalItems: allItems.length,
        flashItems: flashItems.length,
        filteredItems: filteredRssItems.length,
        html,
        plain,
        preformatted: true,
        text: plain || html,
        learnedFacts
      },
      reasoning: `Fetched ${allItems.length} items (${flashItems.length} flash + ${rssItems.length} RSS), ${topic ? `filtered RSS to ${filteredRssItems.length} about "${topic}"` : "showing all"}, summarized top ${summaries.length} articles`
    };
  } catch (err) {
    return {
      tool: "news",
      success: false,
      final: true,
      error: err.message
    };
  }
}

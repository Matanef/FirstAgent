// server/tools/news.js
// COMPLETE FIX: News with topic extraction and filtering

import Parser from "rss-parser";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { safeFetch } from "../utils/fetch.js";
import { llm } from "./llm.js";
import { extractFromNews } from "../knowledge.js";

const parser = new Parser();

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── GENERAL NEWS FEEDS (40+) ──
const FEEDS = {
  // Israeli sources
  ynet: "https://www.ynet.co.il/Integration/StoryRss2.xml",
  n12: "https://www.mako.co.il/rss/news-israel.xml",
  jpost: "https://www.jpost.com/Rss/RssFeedsHeadlines.aspx",
  toi: "https://www.timesofisrael.com/feed/",
  walla: "https://rss.walla.co.il/feed/1",
  // International sources
  bbc: "http://feeds.bbci.co.uk/news/rss.xml",
  cnn: "http://rss.cnn.com/rss/edition.rss",
  guardian: "https://www.theguardian.com/world/rss",
  nyt: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  wapo: "https://feeds.washingtonpost.com/rss/world",
  npr: "https://feeds.npr.org/1001/rss.xml",
  ap: "https://rsshub.app/apnews/topics/apf-topnews",
  independent: "https://www.independent.co.uk/news/world/rss",
  skynews: "https://feeds.skynews.com/feeds/rss/world.xml",
  foxnews: "https://moxie.foxnews.com/google-publisher/latest.xml",
  dw: "https://rss.dw.com/rdf/rss-en-all",
  france24: "https://www.france24.com/en/rss",
  abc: "https://abcnews.go.com/abcnews/topstories",
  cbsnews: "https://www.cbsnews.com/latest/rss/main"
};

// ── CATEGORY-SPECIFIC FEEDS ──
const CATEGORY_FEEDS = {
  technology: {
    bbc_tech: "http://feeds.bbci.co.uk/news/technology/rss.xml",
    verge: "https://www.theverge.com/rss/index.xml",
    arstechnica: "https://feeds.arstechnica.com/arstechnica/index",
    hackernews: "https://hnrss.org/frontpage",
    techcrunch: "https://techcrunch.com/feed/",
    wired: "https://www.wired.com/feed/rss",
    engadget: "https://www.engadget.com/rss.xml",
  },
  science: {
    bbc_science: "http://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
    livescience: "https://www.livescience.com/feeds/all",
    sciencedaily: "https://www.sciencedaily.com/rss/all.xml",
    newscientist: "https://www.newscientist.com/section/news/feed/",
  },
  business: {
    bbc_business: "http://feeds.bbci.co.uk/news/business/rss.xml",
    cnbc: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    marketwatch: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    ft: "https://www.ft.com/?format=rss",
    wsj: "https://feeds.a.dj.com/rss/RSSWorldNews.xml",
  },
  sports: {
    bbc_sport: "http://feeds.bbci.co.uk/sport/rss.xml",
    espn: "https://www.espn.com/espn/rss/news",
    skysports: "https://www.skysports.com/rss/12040",
  },
  health: {
    bbc_health: "http://feeds.bbci.co.uk/news/health/rss.xml",
    medicalnewstoday: "https://www.medicalnewstoday.com/newsfeeds/rss",
    webmd: "https://rssfeeds.webmd.com/rss/rss.aspx?RSSSource=RSS_PUBLIC",
  },
  entertainment: {
    bbc_entertainment: "http://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
    variety: "https://variety.com/feed/",
    hollywoodreporter: "https://www.hollywoodreporter.com/feed/",
    rollingstone: "https://www.rollingstone.com/feed/",
  },
  politics: {
    bbc_politics: "http://feeds.bbci.co.uk/news/politics/rss.xml",
    politico: "https://rss.politico.com/politics-news.xml",
    thehill: "https://thehill.com/feed/",
  }
};

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

  // Words that look like topics but aren't — quantifiers, pronouns, filler
  const topicNoiseWords = new Set([
    "some", "any", "all", "few", "more", "every", "many", "much", "several",
    "it", "this", "that", "them", "us", "me", "updated", "news", "headlines",
    "the", "a", "an", "on", "in", "at", "to", "for", "of"
  ]);

  function cleanTopic(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/\b(it|this|that|some|any|all|news|headlines)\b/gi, "").trim();
    if (cleaned.length < 3) return null;
    // Reject if ALL remaining words are noise
    const words = cleaned.split(/\s+/).filter(w => !topicNoiseWords.has(w.toLowerCase()) && w.length > 1);
    return words.length > 0 ? words.join(" ") : null;
  }

  // Extract specific topic patterns — match first "about/regarding/on/for" + topic
  // Strip "news" before matching so "news about X" → "about X" → captures "X"
  const forTopicMatch = stripped.replace(/\bnews\b/gi, "").trim();
  const topicMatch = forTopicMatch.match(/(?:about|regarding|on|for)\s+(?:the\s+)?([a-z0-9\s,'-]+?)(?:\s+to\s+(?:learn|know|read|see|check)|$)/i);
  const cleanedTopic = cleanTopic(topicMatch?.[1]);
  if (cleanedTopic) return cleanedTopic;

  // Fallback: try "about X" from original (but still clean it)
  const lowerTopicMatch = lower.match(/(?:about|regarding|on|for)\s+(?:the\s+)?([a-z0-9\s,'-]+?)(?:\s+to\s+(?:learn|know|read|see|check)|$)/i);
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
  const rejectWords = new Set(["any", "some", "all", "the", "a", "an", "and", "or", "me", "my", "your", "about", "for", "on", "in"]);
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
  const stopWords = new Set(["the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "is", "it", "get", "be", "do", "has", "was", "are", "by", "as", "my", "me", "we", "us"]);
  const keywords = topic.toLowerCase()
    .replace(/[,]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return items;

  return items.filter(item => {
    const searchText = `${item.title} ${item.description || ''}`.toLowerCase();
    return keywords.some(keyword => searchText.includes(keyword));
  });
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

async function summarizeArticle(title, content) {
  if (!content) return null;
  
  const prompt = `Summarize this news article in 2-3 sentences. Be concise and factual.

Title: ${title}

Content:
${content}

Summary (2-3 sentences):`;

  try {
    const result = await llm(prompt);
    if (result.success && result.data?.text) {
      return result.data.text.trim();
    }
    return null;
  } catch (err) {
    console.warn("LLM summarization failed:", err.message);
    return null;
  }
}

export async function news(request) {
  try {
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
    const freshRssItems = rssItems.filter(item => {
      if (!item.date) return true;
      const pubDate = new Date(item.date).getTime();
      return !isNaN(pubDate) && pubDate > sevenDaysAgo;
    });

    // Topic filter only applies to RSS items — flash headlines always show
    const filteredRssItems = topic ? filterByTopic(freshRssItems, topic) : freshRssItems;

    console.log(`📊 Total: ${allItems.length} (${flashItems.length} flash + ${rssItems.length} RSS), Fresh RSS: ${freshRssItems.length}, Filtered RSS: ${filteredRssItems.length}`);

    // Scrape and summarize top RSS articles (flash items are headline-only, no scraping)
    const summaries = [];
    const scrapePromises = filteredRssItems.slice(0, articleCount).map(async (article) => {
      console.log(`  Scraping: ${article.title}`);
      const content = await scrapeArticle(article.link);
      const textForSummary = content || article.description || null;
      if (textForSummary && textForSummary.length > 50) {
        const summary = await summarizeArticle(article.title, textForSummary);
        if (summary) {
          return { title: article.title, link: article.link, source: article.source, summary };
        }
      }
      return { title: article.title, link: article.link, source: article.source, summary: article.description || article.title };
    });

    const scrapeResults = await Promise.all(scrapePromises);
    summaries.push(...scrapeResults.filter(Boolean));

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
      <div class="ai-table-wrapper">
        <h3>${topic ? "Related Headlines" : "All Headlines"}</h3>
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
    ` : "";

    const html = `
      <div class="news-container">
        ${topic ? `<div class="news-topic-banner">📰 News about: <strong>${topic}</strong></div>` : ""}
        ${flashHtml}
        ${summaries.length > 0 ? `
          <div class="news-summaries">
            <h2>Top Stories</h2>
            ${summaryCards}
          </div>
        ` : ""}
        ${headlineTable}
      </div>

      <style>

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
      </style>
    `;

    // Store facts in passive knowledge system (awaited so we can report what was learned)
    let learnedFacts = [];
    try {
      learnedFacts = await extractFromNews(summaries, topic) || [];
    } catch (e) {
      console.warn("[news] Knowledge extraction failed:", e.message);
    }

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
        preformatted: true,
        text: html,
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

// server/tools/news.js
// COMPLETE FIX: News with topic extraction and filtering

import Parser from "rss-parser";
import { safeFetch } from "../utils/fetch.js";
import { llm } from "./llm.js";

const parser = new Parser();

// ── GENERAL NEWS FEEDS ──
const FEEDS = {
  ynet: "https://www.ynet.co.il/Integration/StoryRss2.xml",
  kan: "https://www.kan.org.il/Rss.aspx?pid=News",
  n12: "https://www.mako.co.il/rss/news-israel.xml",
  jpost: "https://www.jpost.com/Rss/RssFeedsHeadlines.aspx",
  toi: "https://www.timesofisrael.com/feed/",
  bbc: "http://feeds.bbci.co.uk/news/rss.xml",
  cnn: "http://rss.cnn.com/rss/edition.rss",
  reuters: "http://feeds.reuters.com/reuters/topNews",
  aljazeera: "https://www.aljazeera.com/xml/rss/all.xml"
};

// ── CATEGORY-SPECIFIC FEEDS ──
const CATEGORY_FEEDS = {
  technology: {
    bbc_tech: "http://feeds.bbci.co.uk/news/technology/rss.xml",
    // verge: "https://www.theverge.com/rss/index.xml",          // stub
    // arstechnica: "https://feeds.arstechnica.com/arstechnica",  // stub
    // hackernews: "https://hnrss.org/frontpage",                 // stub
  },
  science: {
    bbc_science: "http://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
    // nature: "https://www.nature.com/nature.rss",               // stub
    // newscientist: "https://www.newscientist.com/feed/home",    // stub
  },
  business: {
    bbc_business: "http://feeds.bbci.co.uk/news/business/rss.xml",
    // bloomberg: "https://feeds.bloomberg.com/markets/news.rss", // stub
    // cnbc: "https://www.cnbc.com/id/100003114/device/rss/rss.html", // stub
  },
  sports: {
    bbc_sport: "http://feeds.bbci.co.uk/sport/rss.xml",
    // espn: "https://www.espn.com/espn/rss/news",               // stub
  },
  health: {
    bbc_health: "http://feeds.bbci.co.uk/news/health/rss.xml",
    // who: "https://www.who.int/feeds/entity/mediacentre/news/en/rss.xml", // stub
  },
  entertainment: {
    bbc_entertainment: "http://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
    // variety: "https://variety.com/feed/",                      // stub
  }
};

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
  
  // Remove common phrases
  let cleaned = lower
    .replace(/give me|show me|get|fetch|latest|recent|breaking|top/gi, '')
    .replace(/news|headlines|articles|stories/gi, '')
    .replace(/about|regarding|on|for/gi, '')
    .trim();
  
  // Extract specific topic patterns
  const topicMatch = lower.match(/(?:about|regarding|on|for)\s+([a-z0-9\s]+)$/i);
  if (topicMatch) {
    return topicMatch[1].trim();
  }
  
  // Extract from "X news"
  const newsMatch = lower.match(/([a-z0-9\s]+)\s+news/i);
  if (newsMatch) {
    const topic = newsMatch[1].trim();
    if (topic.length > 2 && !['the', 'latest', 'breaking', 'top'].includes(topic)) {
      return topic;
    }
  }
  
  // If we have a meaningful cleaned string
  if (cleaned.length > 2 && cleaned.split(/\s+/).length <= 4) {
    return cleaned;
  }
  
  return null;
}

// Filter headlines by topic
function filterByTopic(items, topic) {
  if (!topic) return items;
  
  const keywords = topic.toLowerCase().split(/\s+/);
  
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

    const feedResults = await Promise.all(feedPromises);
    for (const result of feedResults) {
      results.push(result);
      allItems.push(...result.items);
    }

    // FIX #4: Filter by topic if specified
    const filteredItems = topic ? filterByTopic(allItems, topic) : allItems;
    
    console.log(`📊 Total items: ${allItems.length}, Filtered: ${filteredItems.length}`);

    // Scrape and summarize top 3 filtered articles
    // Falls back to RSS description if scraping fails
    const summaries = [];
    const scrapePromises = filteredItems.slice(0, 3).map(async (article) => {
      console.log(`  Scraping: ${article.title}`);
      const content = await scrapeArticle(article.link);
      // Use scraped content, or fall back to RSS description
      const textForSummary = content || article.description || null;
      if (textForSummary && textForSummary.length > 50) {
        const summary = await summarizeArticle(article.title, textForSummary);
        if (summary) {
          return { title: article.title, link: article.link, source: article.source, summary };
        }
      }
      // If no content at all, create a minimal summary from the title
      return { title: article.title, link: article.link, source: article.source, summary: article.description || article.title };
    });

    const scrapeResults = await Promise.all(scrapePromises);
    summaries.push(...scrapeResults.filter(Boolean));

    // Build HTML
    const summaryCards = summaries.map(s => `
      <div class="news-summary-card">
        <div class="news-summary-header">
          <span class="news-source">${s.source.toUpperCase()}</span>
        </div>
        <h3 class="news-summary-title">${s.title}</h3>
        <p class="news-summary-text">${s.summary}</p>
        <a href="${s.link}" target="_blank" class="news-summary-link">Read full article →</a>
      </div>
    `).join('');

    const html = `
      <div class="news-container">
        ${topic ? `<div class="news-topic-banner">📰 News about: <strong>${topic}</strong></div>` : ''}
        
        ${summaries.length > 0 ? `
          <div class="news-summaries">
            <h2>Top Stories</h2>
            ${summaryCards}
          </div>
        ` : ''}
        
        <div class="ai-table-wrapper">
          <h3>${topic ? 'All Related Headlines' : 'All Headlines'}</h3>
          <table class="ai-table">
            <thead>
              <tr><th>Source</th><th>Headline</th><th>Date</th></tr>
            </thead>
            <tbody>
              ${filteredItems.slice(0, 20).map(i => `
                <tr>
                  <td>${i.source}</td>
                  <td><a href="${i.link}" target="_blank">${i.title}</a></td>
                  <td>${i.date ? new Date(i.date).toLocaleDateString() : "-"}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
      
      <style>
        .news-topic-banner {
          background: var(--accent);
          color: white;
          padding: 0.75rem 1rem;
          border-radius: 6px;
          margin-bottom: 1rem;
          font-size: 1.1rem;
        }
        .news-container {
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }
        .news-summaries {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .news-summary-card {
          background: var(--bg-tertiary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 1.5rem;
        }
        .news-summary-header {
          margin-bottom: 0.5rem;
        }
        .news-source {
          background: var(--accent);
          color: white;
          padding: 0.25rem 0.75rem;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 600;
        }
        .news-summary-title {
          margin: 0.5rem 0;
          font-size: 1.2rem;
          color: var(--text-primary);
        }
        .news-summary-text {
          margin: 1rem 0;
          line-height: 1.6;
          color: var(--text-secondary);
        }
        .news-summary-link {
          color: var(--accent);
          text-decoration: none;
          font-weight: 500;
        }
        .news-summary-link:hover {
          text-decoration: underline;
        }
      </style>
    `;

    return {
      tool: "news",
      success: true,
      final: true,
      data: { 
        results, 
        summaries,
        topic,
        totalItems: allItems.length,
        filteredItems: filteredItems.length,
        html
      },
      reasoning: `Fetched ${allItems.length} headlines, ${topic ? `filtered to ${filteredItems.length} about "${topic}"` : 'showing all'}, summarized top ${summaries.length} articles`
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

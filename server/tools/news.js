// server/tools/news.js (ENHANCED - Article scraping + LLM summarization)
import Parser from "rss-parser";
import { safeFetch } from "../utils/fetch.js";
import { llm } from "./llm.js";

const parser = new Parser();

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

// Scrape article content from URL
async function scrapeArticle(url) {
  try {
    const html = await safeFetch(url, { 
      method: "GET",
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!html || typeof html !== 'string') return null;
    
    // Simple text extraction (remove HTML tags)
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Take first 2000 characters for summarization
    return text.substring(0, 2000);
  } catch (err) {
    console.warn(`Failed to scrape ${url}:`, err.message);
    return null;
  }
}

// Generate summary using LLM
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
    const results = [];
    const scrapedArticles = [];

    // Fetch all RSS feeds
    for (const [name, url] of Object.entries(FEEDS)) {
      try {
        const feed = await parser.parseURL(url);

        const items = (feed.items || []).slice(0, 5).map(i => ({
          title: i.title,
          link: i.link,
          date: i.pubDate,
          source: name
        }));

        results.push({
          source: name,
          items,
          error: null
        });

        // Collect top articles for scraping
        if (items.length > 0) {
          scrapedArticles.push({
            title: items[0].title,
            link: items[0].link,
            source: name
          });
        }

      } catch (err) {
        results.push({
          source: name,
          error: err.message,
          items: []
        });
      }
    }

    // Scrape and summarize top 3 articles
    console.log(`📰 Scraping top 3 articles...`);
    const summaries = [];
    
    for (let i = 0; i < Math.min(3, scrapedArticles.length); i++) {
      const article = scrapedArticles[i];
      console.log(`  Scraping: ${article.title}`);
      
      const content = await scrapeArticle(article.link);
      if (content) {
        const summary = await summarizeArticle(article.title, content);
        if (summary) {
          summaries.push({
            title: article.title,
            link: article.link,
            source: article.source,
            summary
          });
        }
      }
    }

    // Build HTML with summary cards
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
        ${summaries.length > 0 ? `
          <div class="news-summaries">
            <h2>📰 Top Stories</h2>
            ${summaryCards}
          </div>
        ` : ''}
        
        <div class="ai-table-wrapper">
          <h3>All Headlines</h3>
          <table class="ai-table">
            <thead>
              <tr><th>Source</th><th>Headline</th><th>Date</th></tr>
            </thead>
            <tbody>
              ${results
                .map(r =>
                  r.items
                    .map(
                      i => `
                    <tr>
                      <td>${r.source}</td>
                      <td><a href="${i.link}" target="_blank">${i.title}</a></td>
                      <td>${i.date || "-"}</td>
                    </tr>
                  `
                    )
                    .join("")
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
      
      <style>
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

    const totalItems = results.reduce(
      (acc, r) => acc + (r.items ? r.items.length : 0),
      0
    );

    return {
      tool: "news",
      success: true,
      final: true,
      data: { 
        results, 
        summaries,
        html, 
        totalItems 
      },
      reasoning: `Fetched ${totalItems} headlines from ${results.length} sources, scraped and summarized top ${summaries.length} articles`
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

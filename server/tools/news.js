// server/tools/news.js
import Parser from "rss-parser";

const parser = new Parser();

// Add any RSS feeds you want here
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

export async function news(request) {
  try {
    const results = [];

    for (const [name, url] of Object.entries(FEEDS)) {
      try {
        const feed = await parser.parseURL(url);

        results.push({
          source: name,
          items: (feed.items || []).slice(0, 5).map(i => ({
            title: i.title,
            link: i.link,
            date: i.pubDate
          }))
        });
      } catch (err) {
        results.push({
          source: name,
          error: err.message,
          items: []
        });
      }
    }

    const html = `
      <div class="ai-table-wrapper">
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
    `;

    const totalItems = results.reduce(
      (acc, r) => acc + (r.items ? r.items.length : 0),
      0
    );

    return {
      tool: "news",
      success: true,
      final: true,
      data: { results, html, totalItems },
      reasoning: "Fetched live RSS headlines from multiple news sources."
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
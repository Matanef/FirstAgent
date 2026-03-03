// server/tools/shopping.js
// Product search via SerpAPI Google Shopping and DuckDuckGo fallback
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

/**
 * Extract product query from natural language
 * "buy a laptop stand" -> "laptop stand"
 * "find me wireless headphones under $50" -> "wireless headphones"
 */
function extractProductQuery(text) {
  let q = text
    .replace(/^(buy|shop|find|search|look)\s+(for\s+|me\s+)?(a\s+|an\s+|the\s+|some\s+)?/i, "")
    .replace(/\s+(on|from|at)\s+(amazon|ebay|walmart|google|online)\s*$/i, "")
    .replace(/\s+under\s+\$?\d+/i, "")
    .replace(/\s+around\s+\$?\d+/i, "")
    .replace(/\s+between\s+\$?\d+\s+and\s+\$?\d+/i, "")
    .trim();
  return q || text;
}

/**
 * Extract price constraints from query
 */
function extractPriceRange(text) {
  const lower = text.toLowerCase();
  const under = lower.match(/under\s+\$?(\d+)/);
  if (under) return { max: parseInt(under[1]) };
  const between = lower.match(/between\s+\$?(\d+)\s+and\s+\$?(\d+)/);
  if (between) return { min: parseInt(between[1]), max: parseInt(between[2]) };
  const around = lower.match(/around\s+\$?(\d+)/);
  if (around) {
    const val = parseInt(around[1]);
    return { min: Math.floor(val * 0.7), max: Math.ceil(val * 1.3) };
  }
  return null;
}

/**
 * Search Google Shopping via SerpAPI
 */
async function searchGoogleShopping(query) {
  if (!CONFIG.SERPAPI_KEY) return [];

  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&api_key=${CONFIG.SERPAPI_KEY}&num=15`;
  const data = await safeFetch(url);

  if (!data || !data.shopping_results) return [];

  return data.shopping_results.slice(0, 15).map(r => ({
    title: r.title || "Untitled",
    price: r.extracted_price || r.price || null,
    priceRaw: r.price || null,
    source: r.source || "Unknown",
    link: r.link || r.product_link || null,
    thumbnail: r.thumbnail || null,
    rating: r.rating || null,
    reviews: r.reviews || null,
    delivery: r.delivery || null
  }));
}

/**
 * Search Google Shopping organic results via regular SerpAPI (fallback)
 */
async function searchGoogleOrganic(query) {
  if (!CONFIG.SERPAPI_KEY) return [];

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query + " buy price")}&api_key=${CONFIG.SERPAPI_KEY}&num=10`;
  const data = await safeFetch(url);

  if (!data || !data.organic_results) return [];

  return data.organic_results
    .filter(r => r.snippet && /\$\d/.test(r.snippet))
    .slice(0, 8)
    .map(r => {
      const priceMatch = r.snippet.match(/\$[\d,]+\.?\d*/);
      return {
        title: r.title || "Untitled",
        price: priceMatch ? parseFloat(priceMatch[0].replace(/[$,]/g, "")) : null,
        priceRaw: priceMatch ? priceMatch[0] : null,
        source: new URL(r.link).hostname.replace("www.", ""),
        link: r.link,
        thumbnail: null,
        rating: null,
        reviews: null,
        delivery: null
      };
    });
}

/**
 * Filter products by price range
 */
function filterByPrice(products, priceRange) {
  if (!priceRange) return products;
  return products.filter(p => {
    if (p.price == null) return true; // keep items without a price
    if (priceRange.min && p.price < priceRange.min) return false;
    if (priceRange.max && p.price > priceRange.max) return false;
    return true;
  });
}

/**
 * Main shopping tool
 */
export async function shopping(query) {
  const text = typeof query === "string" ? query : (query?.text || query?.input || "");

  if (!text.trim()) {
    return {
      tool: "shopping",
      success: false,
      final: true,
      error: "Please specify what you'd like to search for. Example: 'find wireless headphones under $50'"
    };
  }

  try {
    const productQuery = extractProductQuery(text);
    const priceRange = extractPriceRange(text);

    console.log(`[shopping] Query: "${productQuery}", Price range:`, priceRange || "none");

    // Try Google Shopping first, then organic fallback
    let products = await searchGoogleShopping(productQuery);

    if (products.length === 0) {
      products = await searchGoogleOrganic(productQuery);
    }

    if (products.length === 0) {
      return {
        tool: "shopping",
        success: true,
        final: true,
        data: {
          text: `No products found for "${productQuery}". Try a more specific search term.`,
          query: productQuery,
          products: []
        }
      };
    }

    // Apply price filter
    if (priceRange) {
      products = filterByPrice(products, priceRange);
    }

    // Sort by price (lowest first), items without price at end
    products.sort((a, b) => {
      if (a.price == null && b.price == null) return 0;
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return a.price - b.price;
    });

    // Build summary text
    const summary = products.map((p, i) => {
      let line = `${i + 1}. **${p.title}**`;
      if (p.priceRaw) line += ` - ${p.priceRaw}`;
      line += ` (${p.source})`;
      if (p.rating) line += ` | ${p.rating}/5`;
      if (p.reviews) line += ` (${p.reviews} reviews)`;
      if (p.delivery) line += ` | ${p.delivery}`;
      return line;
    }).join("\n");

    const priceNote = priceRange
      ? ` (filtered: ${priceRange.min ? "$" + priceRange.min + "-" : "under "}$${priceRange.max || "any"})`
      : "";

    return {
      tool: "shopping",
      success: true,
      final: true,
      data: {
        query: productQuery,
        products,
        count: products.length,
        text: `**Product Search: "${productQuery}"${priceNote}**\n\nFound ${products.length} products:\n\n${summary}`
      }
    };

  } catch (err) {
    console.error("[shopping] Error:", err);
    return {
      tool: "shopping",
      success: false,
      final: true,
      error: `Shopping search failed: ${err.message}`
    };
  }
}

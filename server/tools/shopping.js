// server/tools/shopping.js
// Product search via SerpAPI Google Shopping — localized for Israeli stores
// Renders a horizontal carousel of product cards with coupon search links
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

// ── Israeli Store Mappings ──
// SerpAPI `gl=il` returns Hebrew store names; map them to known brands
const ISRAELI_STORE_MAP = {
  "ksp": "KSP", "ksp.co.il": "KSP",
  "zap": "Zap", "zap.co.il": "Zap",
  "ivory": "Ivory", "ivory.co.il": "Ivory",
  "bug": "Bug", "bug.co.il": "Bug",
  "yahav": "Yahav", "yahav.co.il": "Yahav",
  "tnage": "TnaGe", "tnaGe": "TnaGe",
  "aliexpress": "AliExpress", "aliexpress.com": "AliExpress",
  "amazon": "Amazon", "amazon.com": "Amazon",
  "ebay": "eBay", "ebay.com": "eBay",
  "bestbuy": "BestBuy", "bestbuy.com": "BestBuy",
};

/**
 * Normalize store/source name for display
 */
function normalizeStore(source) {
  if (!source) return "Unknown";
  const lower = source.toLowerCase().trim();
  // Direct map match
  for (const [key, name] of Object.entries(ISRAELI_STORE_MAP)) {
    if (lower.includes(key)) return name;
  }
  // Clean up domain-style names
  return source.replace(/^www\./, "").replace(/\.co\.il$/, "").replace(/\.com$/, "");
}

/**
 * Extract product query from natural language
 */
function extractProductQuery(text) {
  let q = text
    .replace(/^(buy|shop|find|search|look|compare)\s+(for\s+|me\s+)?(a\s+|an\s+|the\s+|some\s+)?/i, "")
    .replace(/\s+(on|from|at)\s+(amazon|ebay|walmart|google|online|ksp|zap|ivory|bug)\s*$/i, "")
    .replace(/\s+under\s+[₪$]?\d+/i, "")
    .replace(/\s+around\s+[₪$]?\d+/i, "")
    .replace(/\s+between\s+[₪$]?\d+\s+and\s+[₪$]?\d+/i, "")
    .replace(/\s+in\s+israel\s*$/i, "")
    .trim();
  return q || text;
}

/**
 * Extract price constraints (supports both $ and ₪)
 */
function extractPriceRange(text) {
  const lower = text.toLowerCase();
  const under = lower.match(/under\s+[₪$]?(\d[\d,]*)/);
  if (under) return { max: parseInt(under[1].replace(/,/g, "")) };
  const between = lower.match(/between\s+[₪$]?(\d[\d,]*)\s+and\s+[₪$]?(\d[\d,]*)/);
  if (between) return { min: parseInt(between[1].replace(/,/g, "")), max: parseInt(between[2].replace(/,/g, "")) };
  const around = lower.match(/around\s+[₪$]?(\d[\d,]*)/);
  if (around) {
    const val = parseInt(around[1].replace(/,/g, ""));
    return { min: Math.floor(val * 0.7), max: Math.ceil(val * 1.3) };
  }
  return null;
}

/**
 * Search Google Shopping via SerpAPI — Israeli localization
 */
async function searchGoogleShopping(query) {
  if (!CONFIG.SERPAPI_KEY) return [];

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    api_key: CONFIG.SERPAPI_KEY,
    gl: "il",
    hl: "en",
    location: "Israel",
    num: "20"
  });

  const data = await safeFetch(`https://serpapi.com/search.json?${params}`);
  if (!data || !data.shopping_results) return [];

  return data.shopping_results.slice(0, 20).map(r => ({
    title: r.title || "Untitled",
    price: r.extracted_price || null,
    priceRaw: r.price || null,
    source: normalizeStore(r.source),
    link: r.link || r.product_link || null,
    thumbnail: r.thumbnail || null,
    rating: r.rating || null,
    reviews: r.reviews || null,
    delivery: r.delivery || null
  }));
}

/**
 * Fallback: Regular Google organic results with price extraction
 */
async function searchGoogleOrganic(query) {
  if (!CONFIG.SERPAPI_KEY) return [];

  const params = new URLSearchParams({
    q: query + " buy price",
    api_key: CONFIG.SERPAPI_KEY,
    gl: "il",
    hl: "en",
    num: "10"
  });

  const data = await safeFetch(`https://serpapi.com/search.json?${params}`);
  if (!data || !data.organic_results) return [];

  return data.organic_results
    .filter(r => r.snippet && /[₪$]\d/.test(r.snippet))
    .slice(0, 8)
    .map(r => {
      const priceMatch = r.snippet.match(/[₪$][\d,]+\.?\d*/);
      let hostname = "Unknown";
      try { hostname = new URL(r.link).hostname.replace("www.", ""); } catch {}
      return {
        title: r.title || "Untitled",
        price: priceMatch ? parseFloat(priceMatch[0].replace(/[₪$,]/g, "")) : null,
        priceRaw: priceMatch ? priceMatch[0] : null,
        source: normalizeStore(hostname),
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
    if (p.price == null) return true;
    if (priceRange.min && p.price < priceRange.min) return false;
    if (priceRange.max && p.price > priceRange.max) return false;
    return true;
  });
}

/**
 * Build a Google search URL for coupons for a given store + product
 */
function buildCouponSearchUrl(productQuery, storeName) {
  const q = `${storeName} coupon discount code ${productQuery}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/**
 * Escape HTML special characters
 */
function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build the horizontal carousel HTML for product results
 */
function buildCarouselHTML(products, query, priceRange) {
  const priceNote = priceRange
    ? ` (filtered: ${priceRange.min ? "₪" + priceRange.min + "–" : "under "}₪${priceRange.max || "any"})`
    : "";

  const cards = products.map(p => {
    const thumbnail = p.thumbnail
      ? `<img class="shop-card-img" src="${esc(p.thumbnail)}" alt="${esc(p.title)}" loading="lazy" />`
      : `<div class="shop-card-img shop-card-img-placeholder">No Image</div>`;

    const priceDisplay = p.priceRaw || (p.price != null ? `₪${p.price}` : "Price N/A");
    const ratingHtml = p.rating
      ? `<span class="shop-card-rating">⭐ ${p.rating}${p.reviews ? ` (${p.reviews})` : ""}</span>`
      : "";
    const deliveryHtml = p.delivery ? `<span class="shop-card-delivery">${esc(p.delivery)}</span>` : "";
    const couponUrl = buildCouponSearchUrl(query, p.source);

    return `<div class="shop-card">
      ${thumbnail}
      <div class="shop-card-body">
        <div class="shop-card-title" title="${esc(p.title)}">${esc(p.title)}</div>
        <div class="shop-card-price">${esc(priceDisplay)}</div>
        <div class="shop-card-store">${esc(p.source)}</div>
        ${ratingHtml}
        ${deliveryHtml}
        <div class="shop-card-actions">
          <a class="shop-card-btn shop-card-btn-buy" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">View Deal</a>
          <a class="shop-card-btn shop-card-btn-coupon" href="${esc(couponUrl)}" target="_blank" rel="noopener noreferrer">Search Coupons</a>
        </div>
      </div>
    </div>`;
  }).join("\n");

  return `<div class="shop-carousel-container">
    <div class="shop-carousel-header">
      <span class="shop-carousel-title">Shopping: "${esc(query)}"${esc(priceNote)}</span>
      <span class="shop-carousel-count">${products.length} results</span>
    </div>
    <div class="shop-carousel-scroll">
      ${cards}
    </div>
    <div class="shop-carousel-hint">Scroll horizontally to see more results →</div>
  </div>`;
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
      error: "Please specify what you'd like to search for. Example: 'find wireless headphones under ₪200'"
    };
  }

  try {
    const productQuery = extractProductQuery(text);
    const priceRange = extractPriceRange(text);

    console.log(`[shopping] Query: "${productQuery}", Price range:`, priceRange || "none");

    // Try Google Shopping first (Israeli localization), then organic fallback
    let products = await searchGoogleShopping(productQuery);

    if (products.length === 0) {
      console.log("[shopping] No Google Shopping results, trying organic fallback...");
      products = await searchGoogleOrganic(productQuery);
    }

    if (products.length === 0) {
      return {
        tool: "shopping",
        success: true,
        final: true,
        data: {
          text: `No products found for "${productQuery}". Try a different search term or check SerpAPI key.`,
          query: productQuery,
          products: []
        }
      };
    }

    // Apply price filter
    if (priceRange) {
      const beforeCount = products.length;
      products = filterByPrice(products, priceRange);
      console.log(`[shopping] Price filter: ${beforeCount} → ${products.length} products`);
    }

    // Sort by price (lowest first), items without price at end
    products.sort((a, b) => {
      if (a.price == null && b.price == null) return 0;
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return a.price - b.price;
    });

    // Build HTML carousel
    const html = buildCarouselHTML(products, productQuery, priceRange);

    // Build plain-text fallback summary
    const summary = products.map((p, i) => {
      let line = `${i + 1}. ${p.title}`;
      if (p.priceRaw) line += ` - ${p.priceRaw}`;
      else if (p.price != null) line += ` - ₪${p.price}`;
      line += ` (${p.source})`;
      if (p.rating) line += ` | ${p.rating}/5`;
      if (p.link) line += `\n   ${p.link}`;
      return line;
    }).join("\n");

    const priceNote = priceRange
      ? ` (filtered: ${priceRange.min ? "₪" + priceRange.min + "–" : "under "}₪${priceRange.max || "any"})`
      : "";

    return {
      tool: "shopping",
      success: true,
      final: true,
      data: {
        html,
        query: productQuery,
        products,
        count: products.length,
        text: `Shopping: "${productQuery}"${priceNote} — ${products.length} results\n\n${summary}`,
        preformatted: true
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

// server/skills/deepResearch/landingPageScraper.js
// Phase 20D — aggressive landing-page HTML scrape fallback.
//
// Many academic publishers serve the full article body (abstract + methods +
// results + discussion + conclusion) as plain HTML on the landing page, even
// when the canonical PDF is gated behind a paywall. The article harvester's
// primary path fetches the PDF URL; this module is the fallback: given a
// landing-page URL, strip the HTML, pull the article body, and report whether
// extraction looks "full" (methods + results sections present) or
// "abstract-only" (only the abstract block was found).
//
// "Full" extractions short-circuit the manual-bridge offer — the user no
// longer needs to download those PDFs manually.
// "Abstract-only" extractions still flow to the bridge for the user's
// optional PDF upload.
//
// Allowed dependencies (per CLAUDE.md): axios + node built-ins only. No
// cheerio (banned in new tools). We use literal regex extraction on the HTML
// string — slower than DOM parsing but works for our extraction patterns.

import axios from "axios";

const BROWSER_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
});

// Hosts where we know the landing page contains the article body inline.
// Match against URL hostname; case-insensitive.
const KNOWN_LANDING_HOSTS = [
  "europepmc.org",
  "ncbi.nlm.nih.gov",
  "frontiersin.org",
  "biomedcentral.com",
  "bmcpsychiatry.biomedcentral.com",
  "jeatdisord.biomedcentral.com",
  "trialsjournal.biomedcentral.com",
  "journals.plos.org",
  "plos.org",
  "mdpi.com",
  "hindawi.com",
  "doi.org",         // resolves to publisher landing page
  "link.springer.com",
  "nature.com",
  "academic.oup.com",
  "tandfonline.com",
  "sciencedirect.com",
  "psychiatryonline.org",
  "cambridge.org",
];

export function isLandingPageHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return KNOWN_LANDING_HOSTS.some(h => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

// Convert a PDF/document URL to its likely landing-page URL.
// Examples:
//   .../article/MED/12345/pdf  → .../article/MED/12345
//   .../counter/pdf/10.1186/X  → .../articles/10.1186/X
//   .../articles/PMCNNN/pdf    → .../articles/PMCNNN
export function inferLandingUrl(url) {
  if (!url) return null;
  let out = String(url);
  // Strip trailing /pdf, /pdf/, ?download=pdf, .pdf
  out = out.replace(/\.pdf(\?[^#]*)?(#.*)?$/i, "$1$2");
  out = out.replace(/\/(?:track|counter)\/pdf\//i, "/articles/");
  out = out.replace(/\/(?:articlepdf|article\/pdf|pdf)(?:[/?#].*)?$/i, "");
  out = out.replace(/\/pdfdirect(?:[/?#].*)?$/i, "");
  out = out.replace(/\?download=pdf(&|$)/i, "$1").replace(/\?$/, "");
  if (out === url) return null;
  return out;
}

// Brutally strip HTML to plain text. No cheerio. We:
//   1. Cut out <script>, <style>, <noscript>, <nav>, <header>, <footer>, <aside>
//   2. Try to grab a <main>, <article>, or known article-body container if any
//   3. Replace remaining tags with whitespace
//   4. Decode common HTML entities
//   5. Normalize whitespace
function htmlToPlainText(html) {
  if (!html || typeof html !== "string") return "";
  let s = html;
  // Strip ignorable blocks
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<header[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  s = s.replace(/<form[\s\S]*?<\/form>/gi, " ");
  // Convert <br>, <p>, </p>, <div>, </div>, headings to newlines
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p\s*>/gi, "\n\n");
  s = s.replace(/<\/div\s*>/gi, "\n");
  s = s.replace(/<\/h[1-6]\s*>/gi, "\n\n");
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common entities
  s = s.replace(/&amp;/g, "&")
       .replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">")
       .replace(/&quot;/g, "\"")
       .replace(/&#39;/g, "'")
       .replace(/&apos;/g, "'")
       .replace(/&nbsp;/g, " ")
       .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
       .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  // Whitespace normalize
  s = s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Try to extract the article body from common container patterns. Returns
// either the inner HTML of the most specific match, or null to fall back to
// whole-page scrape.
function extractArticleContainer(html) {
  if (!html) return null;
  // Preferred selectors, in priority order. Use regex against `class=` and `id=`
  // attributes — DOM parsing would be cleaner but we can't import cheerio.
  const PATTERNS = [
    // europepmc full article
    /<div[^>]*\bclass="[^"]*\b(?:article-fulltext|abstract-section)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // ncbi.nlm pmc article
    /<div[^>]*\bclass="[^"]*\bjig-ncbiinpagenav\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // biomedcentral / springer
    /<main[^>]*\bid="main-content"[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*\bclass="[^"]*\barticle-body\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // frontiers
    /<div[^>]*\bclass="[^"]*\bJournalFullText\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*\bclass="[^"]*\bJournalAbstract\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // plos
    /<div[^>]*\bclass="[^"]*\barticle-text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // mdpi
    /<div[^>]*\bclass="[^"]*\bhtml-body\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // generic article containers (last resort, before whole-page)
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];
  for (const re of PATTERNS) {
    const m = html.match(re);
    if (m && m[1] && m[1].length >= 800) {
      return m[1];
    }
  }
  return null;
}

// Heuristic: does the extracted text look like a "full" article (has
// methods/results/discussion sections) or just an abstract?
const FULL_TEXT_MARKERS = [
  /\b(?:Methods|Materials and Methods|Methodology|Study Design)\b/i,
  /\b(?:Results|Findings|Outcome[s]?)\b/i,
  /\b(?:Discussion|Implications)\b/i,
];
const PAYWALL_MARKERS = [
  /\b(?:Get access to this content|Buy article|Purchase access|Subscribe to access|Sign in to view|Access through your institution)\b/i,
  /\b(?:You do not have access|institutional access required)\b/i,
];

function classifyExtraction(text) {
  if (!text) return { quality: "empty", fullText: false, length: 0 };
  const length = text.length;
  if (length < 800) return { quality: "thin", fullText: false, length };
  const paywalled = PAYWALL_MARKERS.some(re => re.test(text));
  const markerHits = FULL_TEXT_MARKERS.filter(re => re.test(text)).length;
  // Phase 20D — "full" means at least 2 of {Methods, Results, Discussion} AND
  // total length >= 5000c AND no paywall-gate language. Abstract pages have
  // ~1500-3000c and only "Abstract:" / "Background:" markers.
  if (markerHits >= 2 && length >= 5000 && !paywalled) {
    return { quality: "full-text", fullText: true, length };
  }
  if (length >= 1500 && !paywalled) {
    return { quality: "abstract", fullText: false, length };
  }
  return { quality: "thin", fullText: false, length };
}

/**
 * Fetch a landing-page URL and return the extracted body + classification.
 *
 * Returns:
 *   { ok: true,  text, quality: "full-text" | "abstract" | "thin" | "empty",
 *     fullText: boolean, length: number, landingUrl }
 *   { ok: false, error: string, landingUrl }
 */
export async function scrapeLandingPage(url, { topic, title, maxChars = 12000 } = {}) {
  if (!url) return { ok: false, error: "no-url" };
  if (!isLandingPageHost(url)) {
    return { ok: false, error: "unsupported-host", landingUrl: url };
  }
  const landingUrl = inferLandingUrl(url) || url;
  try {
    const res = await axios.get(landingUrl, {
      timeout: 18000,
      maxRedirects: 20,
      maxContentLength: 5 * 1024 * 1024,
      headers: BROWSER_HEADERS,
      // Accept HTML; we don't want a PDF binary back here.
      responseType: "text",
      transformResponse: [d => d],  // disable axios JSON-parsing
    });
    const ctype = String(res.headers?.["content-type"] || "").toLowerCase();
    if (!ctype.includes("html")) {
      return { ok: false, error: `non-html-response: ${ctype}`, landingUrl };
    }
    const html = String(res.data || "");
    if (html.length < 500) {
      return { ok: false, error: "html-too-short", landingUrl };
    }
    // Try the focused-container extraction first; fall back to whole-page.
    const container = extractArticleContainer(html);
    const rawText = htmlToPlainText(container || html);
    const text = rawText.slice(0, maxChars);
    const klass = classifyExtraction(text);
    return {
      ok: true,
      text,
      quality: klass.quality,
      fullText: klass.fullText,
      length: klass.length,
      landingUrl,
    };
  } catch (err) {
    return { ok: false, error: err?.message || "fetch-failed", landingUrl };
  }
}

// Test-only export for inline assertions in phase20SmokeTest
export const _internals = {
  htmlToPlainText,
  extractArticleContainer,
  classifyExtraction,
  KNOWN_LANDING_HOSTS,
  FULL_TEXT_MARKERS,
};

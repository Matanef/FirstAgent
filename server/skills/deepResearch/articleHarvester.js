// server/skills/deepResearch/articleHarvester.js
// Multi-source article harvester. Lifted from the original deepResearch.js fetch logic
// (Smart Domain Router: Semantic Scholar, ArXiv, Europe PMC, Wikipedia, SerpAPI) and
// extended with retry-once-on-network-error + 24h cache + priority_sources support.
//
// IMPORTANT: this module ONLY fetches + caches + scrapes raw text. Per-article LLM
// analysis happens in articleAnalyzer.js (separation of concerns).

import axios from "axios";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { CONFIG, PROJECT_ROOT } from "../../utils/config.js";
import { stripHtmlToText, extractPdfText } from "../../utils/obsidianUtils.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("articleHarvester", { consoleLevel: "warn" });

const CACHE_DIR = path.resolve(PROJECT_ROOT, "data", "research-cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const SOURCE_NAME_TO_FETCHER = {
  semanticscholar: fetchSemanticScholar,
  arxiv:           fetchArxiv,
  medicine:        fetchEuropePMC,
  europepmc:       fetchEuropePMC,
  general:         fetchWikipedia,
  wikipedia:       fetchWikipedia,
  web:             fetchSerpResults,
  core:            fetchCore,    // CORE open-access repository (core.ac.uk)
  doaj:            fetchDoaj,    // Directory of Open Access Journals (doaj.org)
};

// Smart domain router — same heuristics as legacy code.
function determineDomains(topic) {
  const lower = (topic || "").toLowerCase();
  const out = [];
  if (/\b(medicine|biology|health|disease|drug|clinical|vaccine|genetics|virus|cancer|therapy)\b/.test(lower)) out.push("medicine");
  if (/\b(physics|math|computer science|algorithm|quantum|astronomy|machine learning|ai|neural network)\b/.test(lower)) out.push("arxiv");
  if (/\b(market|cybersecurity|pure-play|business|stock|industry|startup|valuation|trend|economy|finance|company)\b/.test(lower)) out.push("web");
  if (CONFIG.CORE_API_KEY) out.push("core"); // CORE covers all academic fields
  if (out.length === 0) { out.push("web"); out.push("general"); }
  out.push("semanticscholar"); // baseline
  return [...new Set(out)];
}

/**
 * Normalize a title for near-duplicate detection (same story across hosts).
 * Lowercase, strip punctuation, collapse whitespace.
 */
export function normalizeTitleForDedup(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Harvest articles for a single prompt.
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} opts.topic                 the parent research topic
 * @param {number} opts.limit                 max articles to RETURN after dedupe (across providers)
 * @param {number} opts.perProvider           how many to ask each provider for
 * @param {string[]} [opts.prioritySources]   subject's priority_sources — if set, ONLY these providers are queried
 * @param {string[]} [opts.skipDomains]       hostnames to drop
 * @param {string[]} [opts.preferDomains]     hostnames to upweight in dedupe ordering
 * @param {Set<string>} [opts.seenUrls]       cross-prompt URL dedupe set (mutated in-place)
 * @param {Set<string>} [opts.seenTitles]     cross-prompt normalized-title dedupe set (mutated in-place)
 * @returns {Promise<Array<{url, title, content, domain, source, fetchedAt, fromCache}>>}
 */
export async function harvest(prompt, opts = {}) {
  const {
    topic = prompt,
    limit = 6,
    perProvider = 4,
    prioritySources = null,
    skipDomains = [],
    preferDomains = [],
    seenUrls = new Set(),
    seenTitles = new Set()
  } = opts;

  const skipSet   = new Set((skipDomains || []).map(s => s.toLowerCase()));
  const preferSet = new Set((preferDomains || []).map(s => s.toLowerCase()));

  // Choose providers — split priority_sources into named providers vs RSS feed URLs
  let providers;
  let rssUrls = [];

  if (Array.isArray(prioritySources) && prioritySources.length > 0) {
    const named = [];
    for (const s of prioritySources) {
      if (/^https?:\/\//i.test(s)) {
        rssUrls.push(s);
      } else {
        const fn = SOURCE_NAME_TO_FETCHER[String(s).toLowerCase()];
        if (fn) named.push({ name: String(s).toLowerCase(), fn });
      }
    }
    providers = named;
    // If no named providers AND no RSS URLs, fall back to smart domain router
    if (providers.length === 0 && rssUrls.length === 0) {
      providers = determineDomains(topic).map(n => ({ name: n, fn: SOURCE_NAME_TO_FETCHER[n] })).filter(p => p.fn);
    }
  } else {
    providers = determineDomains(topic).map(n => ({ name: n, fn: SOURCE_NAME_TO_FETCHER[n] })).filter(p => p.fn);
  }

  const settled = await Promise.allSettled(providers.map(p => withRetry(() => p.fn(prompt, perProvider)).then(rows => rows.map(r => ({ ...r, source: p.name })))));

  const collected = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && Array.isArray(s.value)) collected.push(...s.value);
  }

  // Fetch RSS feed URLs in parallel (from priority_sources that are actual URLs)
  if (rssUrls.length > 0) {
    log(`Fetching ${rssUrls.length} RSS feed(s) for topic "${topic}"`, "info");
    const rssSettled = await Promise.allSettled(rssUrls.map(url => fetchRssUrl(url, perProvider)));
    for (const r of rssSettled) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) collected.push(...r.value);
    }
  }

  // De-dupe by URL AND normalized title (cross-prompt aware), drop skipDomains
  const uniq = [];
  for (const item of collected) {
    if (!item?.url) continue;
    if (seenUrls.has(item.url)) continue;
    const host = safeHost(item.url);
    if (host && skipSet.has(host)) continue;
    // Title-based cross-host dedup (same story re-published on multiple domains)
    const normTitle = normalizeTitleForDedup(item.title);
    if (normTitle && seenTitles.has(normTitle)) continue;
    seenUrls.add(item.url);
    if (normTitle) seenTitles.add(normTitle);
    item.domain = item.domain || host;
    uniq.push(item);
  }

  // Sort: preferred hosts first, then arbitrary order
  uniq.sort((a, b) => {
    const ap = preferSet.has((a.domain || "").toLowerCase()) ? 1 : 0;
    const bp = preferSet.has((b.domain || "").toLowerCase()) ? 1 : 0;
    return bp - ap;
  });

  // For items without inline content (SerpAPI), scrape the page now.
  const out = [];
  for (const item of uniq.slice(0, limit * 2)) { // over-fetch then trim after scrape failures
    let content = item.content;
    let fromCache = false;
    if (!content) {
      const cached = await checkCache(item.url);
      if (cached?.content) {
        content = cached.content;
        fromCache = true;
      } else {
        content = await fetchPage(item.url);
        if (content) await writeCache(item.url, { url: item.url, content, fetchedAt: new Date().toISOString() });
      }
    }
    if (!content || content.length < 100) continue;
    out.push({
      url: item.url,
      title: item.title || "(untitled)",
      content,
      domain: item.domain || safeHost(item.url),
      source: item.source || "unknown",
      fetchedAt: new Date().toISOString(),
      fromCache
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Scan a local research library for matches. PDFs/TXTs whose filename mentions
 * any topic word are included.
 *
 * @param {string} topic
 * @param {object} [opts]
 * @param {number} [opts.maxResults=3]
 * @returns {Promise<Array<{url, title, content, domain, source, fetchedAt}>>}
 */
export async function scanLocalLibrary(topic, opts = {}) {
  const dir = process.env.RESEARCH_LIBRARY_PATH || CONFIG.RESEARCH_LIBRARY_PATH || null;
  const maxResults = opts.maxResults ?? 3;
  if (!dir) return [];
  let entries;
  try { entries = await fs.readdir(dir); }
  catch { return []; }

  const words = (topic || "").toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const matches = [];
  for (const entry of entries) {
    if (matches.length >= maxResults) break;
    if (!entry.endsWith(".pdf") && !entry.endsWith(".txt")) continue;
    const lower = entry.toLowerCase();
    if (!words.some(w => lower.includes(w))) continue;
    const fullPath = path.join(dir, entry);
    try {
      const content = entry.endsWith(".pdf")
        ? await extractPdfText(fullPath)
        : await fs.readFile(fullPath, "utf8");
      if (!content || content.length < 100) continue;
      matches.push({
        url: `local://${entry}`,
        title: entry.replace(/\.(pdf|txt)$/i, ""),
        content: content.slice(0, 8000),
        domain: "local-library",
        source: "local",
        fetchedAt: new Date().toISOString()
      });
    } catch {}
  }
  return matches;
}

// ───────────────────────────── fetchers ─────────────────────────────

async function fetchSemanticScholar(query, limit) {
  try {
    const headers = {};
    if (CONFIG.SEMANTIC_SCHOLAR_KEY) headers["x-api-key"] = CONFIG.SEMANTIC_SCHOLAR_KEY;
    const r = await axios.get("https://api.semanticscholar.org/graph/v1/paper/search", {
      params: { query, limit, fields: "title,abstract,url,year,authors,openAccessPdf,externalIds" },
      headers,
      timeout: 12000
    });
    return (r.data?.data || []).filter(x => x.abstract).map(x => {
      // Prefer open-access PDF URL so the scraper can fetch full text
      const oaUrl = x.openAccessPdf?.url;
      const doi = x.externalIds?.DOI;
      const url = oaUrl || x.url || (doi ? `https://doi.org/${doi}` : `https://semanticscholar.org/paper/${x.paperId}`);
      return {
        url,
        title: x.title,
        content: `Year: ${x.year || "Unknown"}\nAuthors: ${(x.authors || []).map(a => a.name).join(", ")}\nAbstract: ${x.abstract}`,
        domain: oaUrl ? safeHost(oaUrl) : "semanticscholar.org"
      };
    });
  } catch { return []; }
}

async function fetchArxiv(query, limit) {
  try {
    const safe = query.replace(/\s+/g, "+");
    const r = await axios.get(`http://export.arxiv.org/api/query?search_query=all:${safe}&start=0&max_results=${limit}`, { timeout: 12000 });
    const entries = r.data.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.map(e => {
      const t = e.match(/<title>([\s\S]*?)<\/title>/);
      const s = e.match(/<summary>([\s\S]*?)<\/summary>/);
      const id = e.match(/<id>([\s\S]*?)<\/id>/);
      return {
        url: id ? id[1].trim() : "",
        title: t ? t[1].trim().replace(/\n/g, " ") : "ArXiv Paper",
        content: s ? s[1].trim() : "",
        domain: "arxiv.org"
      };
    }).filter(x => x.url);
  } catch { return []; }
}

async function fetchEuropePMC(query, limit) {
  try {
    const r = await axios.get("https://www.ebi.ac.uk/europepmc/webservices/rest/search", {
      params: { query, format: "json", resultType: "core", pageSize: limit },
      timeout: 12000
    });
    const rows = r.data?.resultList?.result || [];
    return rows.filter(x => x.abstractText).map(x => ({
      url: `https://europepmc.org/article/MED/${x.pmid}`,
      title: x.title,
      content: `Journal: ${x.journalTitle || ""}\nAbstract: ${(x.abstractText || "").replace(/<[^>]+>/g, "")}`,
      domain: "europepmc.org"
    }));
  } catch { return []; }
}

async function fetchWikipedia(query, limit) {
  try {
    const r = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", list: "search", srsearch: query, utf8: "", format: "json", srlimit: limit },
      timeout: 10000
    });
    const rows = r.data?.query?.search || [];
    return rows.map(x => ({
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title)}`,
      title: x.title,
      content: (x.snippet || "").replace(/<[^>]+>/g, ""),
      domain: "wikipedia.org"
    }));
  } catch { return []; }
}

/**
 * CORE open-access repository — https://core.ac.uk
 * Returns peer-reviewed papers with direct download URLs (open access only).
 * Requires CORE_API_KEY in .env (free registration at https://core.ac.uk/services/api).
 */
async function fetchCore(query, limit) {
  if (!CONFIG.CORE_API_KEY) {
    log("CORE_API_KEY not set — skipping CORE fetch", "warn");
    return [];
  }
  console.log(`[articleHarvester] CORE: querying "${query.slice(0, 80)}" (limit ${limit})`);
  try {
    const r = await axios.get("https://api.core.ac.uk/v3/search/works", {
      params: { q: query, limit },
      headers: { "Authorization": `Bearer ${CONFIG.CORE_API_KEY}` },
      timeout: 15000
    });
    const results = (r.data?.results || []).filter(x => x.abstract || x.downloadUrl || x.fullTextUrl);
    console.log(`[articleHarvester] CORE: got ${results.length} results for "${query.slice(0, 60)}"`);
    return results.map(x => {
        // Prefer direct download link so the scraper gets full text
        const url = x.downloadUrl || x.fullTextUrl || `https://core.ac.uk/works/${x.id}`;
        const authorStr = (x.authors || [])
          .map(a => (typeof a === "string" ? a : a?.name || ""))
          .filter(Boolean).join(", ");
        return {
          url,
          title: x.title || "(untitled)",
          content: [
            x.abstract ? `Abstract: ${x.abstract}` : "",
            authorStr ? `Authors: ${authorStr}` : "",
            x.doi ? `DOI: ${x.doi}` : "",
            x.yearPublished ? `Year: ${x.yearPublished}` : ""
          ].filter(Boolean).join("\n"),
          domain: safeHost(url) || "core.ac.uk"
        };
      });
  } catch (err) {
    log(`CORE API error: ${err.message}`, "warn");
    return [];
  }
}

/**
 * Directory of Open Access Journals — https://doaj.org
 * All returned articles are guaranteed open access. No API key required for reads.
 * Rate limit: 2 req/s (5 queued). We stay well within this.
 */
async function fetchDoaj(query, limit) {
  console.log(`[articleHarvester] DOAJ: querying "${query.slice(0, 80)}" (limit ${limit})`);
  try {
    const encoded = encodeURIComponent(query);
    const r = await axios.get(`https://doaj.org/api/search/articles/${encoded}`, {
      params: { pageSize: Math.min(limit, 10) },
      timeout: 12000
    });
    const items = (r.data?.results || []).map(x => {
      const bib = x.bibjson || {};
      const links = bib.link || [];
      // Prefer full-text link; fall back to any link
      const fullText = links.find(l => l.type === "fulltext")?.url || links[0]?.url || "";
      const doi = (bib.identifier || []).find(i => i.type === "doi")?.id;
      const url = fullText || (doi ? `https://doi.org/${doi}` : "");
      if (!url) return null;
      const authorStr = (bib.author || []).map(a => a.name).filter(Boolean).join(", ");
      return {
        url,
        title: bib.title || "(untitled)",
        content: [
          bib.abstract ? `Abstract: ${bib.abstract}` : "",
          authorStr ? `Authors: ${authorStr}` : "",
          doi ? `DOI: ${doi}` : ""
        ].filter(Boolean).join("\n"),
        domain: safeHost(url) || "doaj.org"
      };
    }).filter(Boolean);
    console.log(`[articleHarvester] DOAJ: got ${items.length} results for "${query.slice(0, 60)}"`);
    return items;
  } catch (err) {
    console.log(`[articleHarvester] DOAJ error: ${err.message}`);
    log(`DOAJ API error: ${err.message}`, "warn");
    return [];
  }
}

async function fetchSerpResults(query, limit) {
  if (!CONFIG.SERPAPI_KEY) return [];
  try {
    const r = await axios.get("https://serpapi.com/search.json", {
      params: { q: query, api_key: CONFIG.SERPAPI_KEY, num: limit, engine: "google" },
      timeout: 15000
    });
    return (r.data?.organic_results || []).map(x => ({
      url: x.link,
      title: x.title,
      content: null, // forces page scrape
      domain: safeHost(x.link)
    })).filter(x => x.url);
  } catch { return []; }
}

/**
 * Phase 2F — fetch a page with retry on transient errors.
 * First attempt: 18s timeout. Retry (if ECONNRESET/ETIMEDOUT/5xx): 15s.
 * Returns stripped text (up to 8000 chars) or "" on failure.
 */
async function fetchPage(url) {
  try {
    return await withRetry(async () => {
      const r = await axios.get(url, {
        timeout: 18000,
        maxRedirects: 4,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LanouResearchBot/1.0; academic use)",
          "Accept": "text/html,application/xhtml+xml,*/*"
        },
        maxContentLength: 3 * 1024 * 1024  // 3MB — enough for large PDFs
      });
      const html = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      const text = stripHtmlToText(html);
      return smartSlice(text, url);
    }, 2, 2500);
  } catch (err) {
    log(`fetchPage failed (${url}): ${err.message}`, "warn");
    return "";
  }
}

/**
 * Smart content slice for large academic documents.
 *
 * For short content (≤ 8000 chars): return as-is.
 * For long content (PDFs, papers): extract abstract/intro + conclusion separately,
 * avoiding the "first 8000 chars is mostly table-of-contents" problem.
 *
 * Strategy:
 *  - Take the first 4500 chars (usually abstract + introduction)
 *  - Scan the last 40% of the document for conclusion/discussion/results
 *  - Combine, cap at 8500 chars total
 *
 * @param {string} text  Stripped plain text of the document
 * @param {string} url   Source URL (used to detect PDF)
 * @returns {string}
 */
function smartSlice(text, url = "") {
  const MAX = 8500;
  if (!text || text.length <= MAX) return text;

  // For shorter documents that are slightly over, just trim
  if (text.length <= MAX * 1.5) return text.slice(0, MAX);

  const front = text.slice(0, 4500);

  // Find a conclusion/discussion/results/findings section in the back half
  const backSearchStart = Math.floor(text.length * 0.55);
  const backText = text.slice(backSearchStart);
  const conclusionMarkers = [
    /\b(conclusion|conclusions|concluding\s+remarks)\b/i,
    /\b(discussion|discussions)\b/i,
    /\b(findings|results|implications)\b/i,
    /\b(summary|final\s+remarks)\b/i
  ];

  let conclusionStart = -1;
  for (const marker of conclusionMarkers) {
    const m = backText.search(marker);
    if (m !== -1 && (conclusionStart === -1 || m < conclusionStart)) {
      conclusionStart = m;
    }
  }

  let back = "";
  if (conclusionStart !== -1) {
    // Take up to 4000 chars starting from the conclusion heading
    back = "\n\n--- [Conclusion/Discussion excerpt] ---\n\n" +
           backText.slice(conclusionStart, conclusionStart + 4000);
  } else {
    // No conclusion heading found — take the last 3500 chars
    back = "\n\n--- [Document end excerpt] ---\n\n" +
           text.slice(text.length - 3500);
  }

  const combined = (front + back).slice(0, MAX + 500); // slight overage OK
  log(`smartSlice: ${text.length} chars → ${combined.length} chars (conclusion at ${conclusionStart >= 0 ? backSearchStart + conclusionStart : "n/a"})`, "info");
  return combined;
}

// ───────────────────────────── RSS fetcher ─────────────────────────

/**
 * Fetch and parse an RSS/Atom feed URL. Returns articles in the standard shape.
 * Works with both RSS 2.0 (<item>) and Atom 1.0 (<entry>) formats.
 * Uses only axios (no external XML parser needed — academic RSS feeds are simple).
 *
 * @param {string} url     Feed URL
 * @param {number} limit   Max items to return
 */
async function fetchRssUrl(url, limit = 5) {
  try {
    const r = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LanouResearchBot/1.0; academic use)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
      },
      responseType: "text"
    });
    const xml = typeof r.data === "string" ? r.data : "";
    if (!xml) return [];
    return parseRssXml(xml, url, limit);
  } catch (err) {
    log(`RSS fetch failed for ${url}: ${err.message}`, "warn");
    return [];
  }
}

/**
 * Minimal RSS/Atom parser using regex — sufficient for well-formed academic feeds.
 * Handles CDATA, HTML-encoded titles, and both RSS <item> and Atom <entry>.
 */
function parseRssXml(xml, feedUrl, limit) {
  const host = safeHost(feedUrl);
  const results = [];

  // Match <item> blocks (RSS) or <entry> blocks (Atom)
  const blockRe = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = blockRe.exec(xml)) !== null && results.length < limit) {
    const block = m[1] || m[2] || "";

    const title = rssStripHtml(rssExtractTag(block, "title"));
    // RSS: <link>url</link> or Atom: <link href="url"/>
    const link =
      rssExtractTag(block, "link") ||
      rssExtractAttr(block, "link", "href") ||
      feedUrl;
    const description =
      rssStripHtml(rssExtractTag(block, "description")) ||
      rssStripHtml(rssExtractTag(block, "summary")) ||
      rssStripHtml(rssExtractTag(block, "content")) ||
      "";

    // Skip items with neither a usable title nor content
    if (!title && !description) continue;

    // Only keep items that actually look like URLs (avoid picking up Atom <id> text)
    const cleanUrl = /^https?:\/\//i.test(link.trim()) ? link.trim() : feedUrl;

    results.push({
      url: cleanUrl,
      title: title || "(untitled)",
      content: description.slice(0, 2000), // cap abstract length
      domain: host,
      source: "rss"
    });
  }
  return results;
}

/** Extract the text content of the first matching XML tag, including CDATA sections. */
function rssExtractTag(xml, tag) {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>` +
    `|<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );
  const m = xml.match(re);
  return m ? (m[1] !== undefined ? m[1] : (m[2] || "")).trim() : "";
}

/** Extract an XML attribute value from a self-closing tag like <link href="..."/>. */
function rssExtractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

/** Strip HTML tags and decode common entities from RSS content. */
function rssStripHtml(s) {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────────── helpers ─────────────────────────────

async function withRetry(fn, attempts = 2, baseDelayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const transient = e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT" || e?.code === "ECONNABORTED" || (e?.response?.status >= 500);
      if (!transient || i === attempts - 1) break;
      await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function safeHost(url) {
  try { return new URL(url).hostname; }
  catch { return ""; }
}

async function checkCache(url) {
  try {
    const hash = crypto.createHash("md5").update(url).digest("hex");
    const p = path.join(CACHE_DIR, `${hash}.json`);
    const stat = await fs.stat(p);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
      await fs.unlink(p).catch(() => {});
      return null;
    }
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return null; }
}

async function writeCache(url, payload) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const hash = crypto.createHash("md5").update(url).digest("hex");
    await fs.writeFile(path.join(CACHE_DIR, `${hash}.json`), JSON.stringify(payload), "utf8");
  } catch {}
}

export const _internals = { determineDomains, fetchSemanticScholar, fetchArxiv, fetchEuropePMC, fetchWikipedia, fetchSerpResults, fetchPage, withRetry, fetchRssUrl, parseRssXml };

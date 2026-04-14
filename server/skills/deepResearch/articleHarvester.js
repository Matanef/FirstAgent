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

const CACHE_DIR = path.resolve(PROJECT_ROOT, "data", "research-cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const SOURCE_NAME_TO_FETCHER = {
  semanticscholar: fetchSemanticScholar,
  arxiv:           fetchArxiv,
  medicine:        fetchEuropePMC,
  europepmc:       fetchEuropePMC,
  general:         fetchWikipedia,
  wikipedia:       fetchWikipedia,
  web:             fetchSerpResults
};

// Smart domain router — same heuristics as legacy code.
function determineDomains(topic) {
  const lower = (topic || "").toLowerCase();
  const out = [];
  if (/\b(medicine|biology|health|disease|drug|clinical|vaccine|genetics|virus|cancer|therapy)\b/.test(lower)) out.push("medicine");
  if (/\b(physics|math|computer science|algorithm|quantum|astronomy|machine learning|ai|neural network)\b/.test(lower)) out.push("arxiv");
  if (/\b(market|cybersecurity|pure-play|business|stock|industry|startup|valuation|trend|economy|finance|company)\b/.test(lower)) out.push("web");
  if (out.length === 0) { out.push("web"); out.push("general"); }
  out.push("semanticscholar"); // baseline
  return [...new Set(out)];
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
 * @param {Set<string>} [opts.seenUrls]       cross-prompt dedupe set (mutated in-place)
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
    seenUrls = new Set()
  } = opts;

  const skipSet   = new Set((skipDomains || []).map(s => s.toLowerCase()));
  const preferSet = new Set((preferDomains || []).map(s => s.toLowerCase()));

  // Choose providers
  let providers;
  if (Array.isArray(prioritySources) && prioritySources.length > 0) {
    providers = prioritySources
      .map(s => String(s).toLowerCase())
      .map(s => ({ name: s, fn: SOURCE_NAME_TO_FETCHER[s] }))
      .filter(p => p.fn);
    if (providers.length === 0) providers = determineDomains(topic).map(n => ({ name: n, fn: SOURCE_NAME_TO_FETCHER[n] })).filter(p => p.fn);
  } else {
    providers = determineDomains(topic).map(n => ({ name: n, fn: SOURCE_NAME_TO_FETCHER[n] })).filter(p => p.fn);
  }

  const settled = await Promise.allSettled(providers.map(p => withRetry(() => p.fn(prompt, perProvider)).then(rows => rows.map(r => ({ ...r, source: p.name })))));

  const collected = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && Array.isArray(s.value)) collected.push(...s.value);
  }

  // De-dupe by URL (cross-prompt aware via shared seenUrls), drop skipDomains
  const uniq = [];
  for (const item of collected) {
    if (!item?.url) continue;
    if (seenUrls.has(item.url)) continue;
    const host = safeHost(item.url);
    if (host && skipSet.has(host)) continue;
    seenUrls.add(item.url);
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
    const r = await axios.get("https://api.semanticscholar.org/graph/v1/paper/search", {
      params: { query, limit, fields: "title,abstract,url,year,authors" },
      timeout: 12000
    });
    return (r.data?.data || []).filter(x => x.abstract).map(x => ({
      url: x.url || `https://semanticscholar.org/paper/${x.paperId}`,
      title: x.title,
      content: `Year: ${x.year || "Unknown"}\nAuthors: ${(x.authors || []).map(a => a.name).join(", ")}\nAbstract: ${x.abstract}`,
      domain: "semanticscholar.org"
    }));
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

async function fetchPage(url) {
  try {
    const r = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 3,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LanouResearchBot/1.0)",
        "Accept": "text/html,application/xhtml+xml"
      },
      maxContentLength: 500 * 1024
    });
    const html = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    return stripHtmlToText(html).slice(0, 8000);
  } catch { return ""; }
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

export const _internals = { determineDomains, fetchSemanticScholar, fetchArxiv, fetchEuropePMC, fetchWikipedia, fetchSerpResults, fetchPage, withRetry };

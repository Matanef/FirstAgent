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

// ───────────────────────────── keyword extractor ─────────────────────────
// Academic APIs (CORE, DOAJ, Semantic Scholar) expect KEYWORDS, not full
// sentences/questions. promptPlanner emits human-readable research prompts
// like "Expert opinions on how leaders can foster organizational resilience
// through effective..." which collapse recall in keyword-based search engines
// and even trip DOAJ's 400-char query limit.
//
// This function converts such a prompt into 3–6 content keywords by stripping
// stopwords/question-words and capping length. The original prompt is still
// shown to humans in the Obsidian notes; only the API query gets shortened.
const SEARCH_STOPWORDS = new Set([
  "a","an","the","and","or","but","of","in","on","at","to","for","with","by","from","as",
  "is","are","was","were","be","been","being","am","do","does","did","have","has","had",
  "what","which","who","whom","whose","when","where","why","how","whether",
  "this","that","these","those","their","them","they","it","its","our","your","you","we","i",
  "some","any","all","more","most","much","many","few","several","about","into","over","upon",
  "can","could","should","would","may","might","must","shall","will",
  "recent","latest","trends","expert","opinions","analysis","data-driven","data","driven",
  "contribute","contributing","influence","influences","impact","impacts","effective",
  "role","roles","developing","foster","quick","do","give","make","run"
]);

export function extractSearchKeywords(prompt, maxWords = 6) {
  if (!prompt || typeof prompt !== "string") return "";
  const cleaned = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ")
    .filter(t => t.length >= 3 && !SEARCH_STOPWORDS.has(t));
  // Preserve original ordering but dedupe
  const seen = new Set();
  const picked = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    picked.push(t);
    if (picked.length >= maxWords) break;
  }
  // Fallback: if stopword-stripping left us with nothing, take raw leading words
  if (picked.length < 2) {
    return cleaned.split(" ").slice(0, maxWords).join(" ");
  }
  return picked.join(" ");
}

// Browser-like headers — many academic APIs (CORE, oa.mg, etc.) sit behind
// Cloudflare. Default axios UA "axios/1.x" gets flagged as a bot and the
// endpoint returns 5xx (which Cloudflare uses as a bot deterrent). Sending a
// realistic User-Agent + Accept headers makes us pass the basic bot-detection
// fingerprint check. This is the same posture a human browser presents.
const BROWSER_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive"
});

// Phase 5H — publisher Referer headers. When the URL host is a known publisher
// that 403s without a same-origin Referer, inject one. Bypasses the basic bot
// check that some publishers apply on top of UA matching.
const PUBLISHER_REFERERS = {
  "academic.oup.com":         "https://academic.oup.com/",
  "onlinelibrary.wiley.com":  "https://onlinelibrary.wiley.com/",
  "karger.com":               "https://karger.com/",
  "tandfonline.com":          "https://www.tandfonline.com/",
  "www.tandfonline.com":      "https://www.tandfonline.com/",
  "sciencedirect.com":        "https://www.sciencedirect.com/",
  "www.sciencedirect.com":    "https://www.sciencedirect.com/",
  "link.springer.com":        "https://link.springer.com/",
  "www.cambridge.org":        "https://www.cambridge.org/core/",
  "cambridge.org":            "https://www.cambridge.org/core/",
  "jamanetwork.com":          "https://jamanetwork.com/",
  "nejm.org":                 "https://www.nejm.org/",
  "www.nejm.org":             "https://www.nejm.org/",
  "nature.com":               "https://www.nature.com/",
  "www.nature.com":           "https://www.nature.com/"
};

// Phase 5H — publishers known to hard-403 even with Referer. Skip the fetchPage
// round-trip entirely and go straight to Unpaywall/LibGen for these.
const KNOWN_HARDBLOCK_HOSTS = new Set([
  // Add hosts here if Referer isn't enough. Empty for now — we always try once.
]);

// Phase 5G — URL patterns that look like academic papers. Used to decide whether
// to fire deep-read enrichment (full PDF fetch + section extraction) on top of
// inline abstracts. Covers most major publishers and preprint servers.
const PAPER_LIKE_URL = /\.pdf(\?|$)|\/(?:abs|pdf|article|articles|paper|papers|works?|preprint|preprints|fulltext|full-text|publication|publications|content|view|reader)\/|nature\.com\/articles\/|sciencedirect\.com\/science\/article\/|link\.springer\.com\/article\/|tandfonline\.com\/doi\/|wiley\.com\/doi\/|cambridge\.org\/core\/journals\/|onlinelibrary\.wiley\.com\/doi\/|academic\.oup\.com\/[\w-]+\/article\/|karger\.com\/[\w-]+\/article\/|jamanetwork\.com\/journals\/|nejm\.org\/doi\/|pubmed\.ncbi\.nlm\.nih\.gov\/\d/i;

// CORE circuit-breaker — when the API returns repeated 5xx within a short
// window, freeze further calls for CORE_COOLDOWN_MS to avoid (a) hammering an
// already-struggling origin and (b) tripping Cloudflare rate-limit which
// turns 5xx into a longer-term 429 on our IP.
const CORE_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
const CORE_FAIL_WINDOW_MS = 60 * 1000;   // 1 min
const CORE_FAIL_THRESHOLD = 3;
let _coreCooldownUntil = 0;
const _coreRecentFailures = []; // timestamps of recent 5xx, pruned every check

function coreCircuitOpen() {
  return Date.now() < _coreCooldownUntil;
}
function recordCoreFailure(status) {
  if (status < 500 && status !== 429) return; // only count transient failures
  const now = Date.now();
  // Prune old failures
  while (_coreRecentFailures.length && now - _coreRecentFailures[0] > CORE_FAIL_WINDOW_MS) {
    _coreRecentFailures.shift();
  }
  _coreRecentFailures.push(now);
  if (_coreRecentFailures.length >= CORE_FAIL_THRESHOLD) {
    _coreCooldownUntil = now + CORE_COOLDOWN_MS;
    _coreRecentFailures.length = 0;
    console.log(`[articleHarvester] CORE circuit-breaker TRIPPED — ${CORE_FAIL_THRESHOLD} failures in ${CORE_FAIL_WINDOW_MS / 1000}s; cooling down for ${CORE_COOLDOWN_MS / 60000}min`);
  }
}

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
  googlescholar:   fetchGoogleScholar, // Google Scholar via SerpAPI (PDF links when available)
  openalex:        fetchOpenAlex,      // OpenAlex — multidisciplinary, ~250M works (no auth, polite-pool via mailto)
  osf:             fetchOsfPreprints,  // OSF Preprints — PsyArXiv, SocArXiv, etc. (no auth)
  academagic:      fetchAcademagic,    // Academagic — Hebrew + English academic PDFs (academagic.co.il, scrape-friendly)
};

// One-time startup diagnostic — surface which providers are actually wired in.
// Helps debug "Google Scholar missing" reports: if SERPAPI_KEY is absent, this
// makes it obvious in logs the provider is intentionally disabled.
(() => {
  const enabled = ["arxiv", "europepmc", "wikipedia", "doaj", "semanticscholar"];
  // OpenAlex — always enabled (no key required); polite-pool email upgrades rate limit 10/sec → 100k/day
  const openAlexEmail = CONFIG.OPENALEX_MAILTO || process.env.OPENALEX_MAILTO;
  enabled.push(openAlexEmail ? "openalex(polite)" : "openalex(anon)");
  if (!openAlexEmail) console.log("[harvester] OpenAlex anonymous pool — set OPENALEX_MAILTO=<email> in server/.env for 100k/day limit");
  // OSF Preprints — always enabled (no key required), topic-triggered routing only.
  enabled.push("osf");
  // Academagic — Hebrew + English academic PDFs, no auth, topic/language-triggered.
  enabled.push("academagic");
  if (CONFIG.CORE_API_KEY) enabled.push("core"); else console.log("[harvester] CORE DISABLED — set CORE_API_KEY in server/.env");
  if (CONFIG.SERPAPI_KEY) enabled.push("googlescholar", "web"); else console.log("[harvester] Google Scholar + SerpAPI web DISABLED — set SERPAPI_KEY in server/.env");
  // LibGen fallback is opt-in via env (paywall-bypass; user reads research/scihub-feasibility.md before enabling)
  const libgenOn = String(CONFIG.ENABLE_LIBGEN_FALLBACK || process.env.ENABLE_LIBGEN_FALLBACK || "").toLowerCase() === "true";
  if (libgenOn) enabled.push("libgen-fallback"); else console.log("[harvester] LibGen fallback DISABLED — set ENABLE_LIBGEN_FALLBACK=true in server/.env to enable");
  // Unpaywall — opt-in via email. Runs as DOI→OA-PDF lookup before LibGen fallback.
  const unpaywallEmail = CONFIG.UNPAYWALL_EMAIL || process.env.UNPAYWALL_EMAIL;
  if (unpaywallEmail) enabled.push("unpaywall"); else console.log("[harvester] Unpaywall DISABLED — set UNPAYWALL_EMAIL=<email> in server/.env to enable DOI→OA-PDF lookup");
  console.log(`[harvester] enabled providers: [${enabled.join(", ")}]`);

  // Deep-read mode startup status — async fetch, log when ready.
  (async () => {
    try {
      const { getStatus } = await import("./deepModeToggle.js");
      const s = await getStatus();
      let line;
      if (s.envForced)        line = `[harvester] deep-read mode: FORCED ${s.envValue.toUpperCase()} via DEEP_MODE in server/.env`;
      else if (s.override === "on")  line = `[harvester] deep-read mode: FORCED ON via runtime toggle (set ${s.setAt || "?"})`;
      else if (s.override === "off") line = `[harvester] deep-read mode: FORCED OFF via runtime toggle`;
      else                           line = `[harvester] deep-read mode: AUTO (research/thesis ON, article/indepth OFF) — toggle in chat: "deep mode on/off/auto/status"`;
      console.log(line);
    } catch { /* deepModeToggle not yet loadable on first import — fine */ }
  })();
})();

// Smart domain router — baseline open-access providers + topic-triggered extras.
function determineDomains(topic) {
  const lower = (topic || "").toLowerCase();
  const out = [];

  // Topic-triggered specialty providers
  if (/\b(medicine|biology|health|disease|drug|clinical|vaccine|genetics|virus|cancer|therapy)\b/.test(lower)) out.push("medicine");
  // arXiv: broadened to include software/engineering/CS-adjacent topics. Previously
  // "software architecture" topics missed all arXiv results because "software" wasn't
  // a trigger word.
  if (/\b(physics|math|computer\s+science|algorithm|quantum|astronomy|machine\s+learning|ai|neural\s+network|software|programming|engineering|robotics|cryptography|distributed\s+systems|compiler|dataset)\b/.test(lower)) out.push("arxiv");
  // Economics / finance / business — OpenAlex (in baseline) covers economics journals
  // well. SerpAPI 'web' kept for backwards compat but only fires if SERPAPI_KEY set.
  if (/\b(market|cybersecurity|pure-play|business|stock|industry|startup|valuation|trend|economy|finance|company|trading|equity|portfolio|macroeconomic|inflation|monetary|fiscal|recession|gdp)\b/.test(lower)) {
    if (CONFIG.SERPAPI_KEY) out.push("web");
    // OpenAlex already in baseline — no extra push needed
  }
  // Psychology / social-science / behavioral → OSF Preprints (covers PsyArXiv, SocArXiv).
  // PsyArXiv alone has ~50k psych preprints — fills the gap left by paywalled APA PsycNET.
  if (/\b(psycholog\w*|behavior\w*|cognit\w*|mental\s+health|psychiatr\w*|neurosci\w*|social\s+(?:science|psych)|developmental|clinical\s+psych|emotion|personality|therapy|counseling)\b/.test(lower)) {
    out.push("osf");
  }

  // Academagic — Hebrew/English academic-paper portal. Trigger conditions:
  //   1. ANY Hebrew character in topic → high-value source for Hebrew queries
  //      (currently the only Hebrew-language academic source we have)
  //   2. Topics in Academagic's strongest fields — psychology/behavioral/clinical/
  //      education/social-science/public-policy. Broadened to match the OSF trigger
  //      so "cognitive behavioral therapy" / "CBT" / "anxiety" route here too.
  const hasHebrew = /[֐-׿]/.test(topic || "");
  const academagicFields = /\b(education|psycholog\w*|psychiatr\w*|behavior\w*|cognit\w*|sociolog\w*|gerontolog\w*|neurosci\w*|mental\s+health|therapy|counseling|emotion|personality|public\s+(?:health|policy)|communication\s+disorders?|gender\s+studies|hebrew|israel|judaism|middle\s+east|anxiety|depression|trauma|PTSD|ADHD|autism|insomnia|addiction)\b/i.test(lower);
  if (hasHebrew || academagicFields) {
    out.push("academagic");
  }

  // Baseline open-access academic providers — always try these
  out.push("openalex");                        // OpenAlex — multidisciplinary, ~250M works, no auth
  if (CONFIG.CORE_API_KEY) out.push("core");   // CORE covers all academic fields
  out.push("doaj");                            // DOAJ — free, no key, no rate limit
  out.push("semanticscholar");                 // S2 — has its own 429 circuit breaker
  if (CONFIG.SERPAPI_KEY) out.push("googlescholar"); // Google Scholar via SerpAPI

  if (out.length === 0) { out.push("web"); out.push("general"); }
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
    tier = "article",        // tier drives deep-read mode default (research/thesis = ON)
    limit = 6,
    perProvider = 4,
    prioritySources = null,
    skipDomains = [],
    preferDomains = [],
    seenUrls = new Set(),
    seenTitles = new Set()
  } = opts;

  // Resolve deep-read mode for this tier (chat-toggle override > tier default).
  // Lazy-imported to avoid a circular dep at module load time.
  let _deepMode = false;
  try {
    const { isDeepModeForTier } = await import("./deepModeToggle.js");
    _deepMode = await isDeepModeForTier(tier);
  } catch { /* deepModeToggle missing or errored — default false */ }
  const deepMode = _deepMode;
  // Log only on first invocation per topic+tier to avoid 5x noise per run.
  if (deepMode && _lastDeepModeKey !== `${topic}|${tier}`) {
    console.log(`[harvester] deep-read mode ACTIVE for tier="${tier}" — full PDFs will be section-extracted`);
    _lastDeepModeKey = `${topic}|${tier}`;
  }

  const skipSet   = new Set((skipDomains || []).map(s => s.toLowerCase()));
  const preferSet = new Set((preferDomains || []).map(s => s.toLowerCase()));

  // Choose providers.
  //
  // Old behavior: if priority_sources was set on a subject record, it REPLACED
  // determineDomains() entirely. That broke topics whose stored subject had
  // stale/wrong priority_sources (e.g. CBT had business-journal RSS feeds from
  // a mis-bootstrap, blocking OpenAlex/OSF/EuropePMC).
  //
  // New behavior: priority_sources AUGMENTS determineDomains(). Topic-determined
  // providers always run; priority_sources adds RSS feeds + extra named providers.
  // Dedup by provider name. Keeps subject-specific RSS feeds working without
  // hiding the baseline providers.
  let rssUrls = [];
  const providerMap = new Map(); // name → { name, fn }

  // 1. Always include topic-determined providers (the main fix).
  for (const n of determineDomains(topic)) {
    const fn = SOURCE_NAME_TO_FETCHER[n];
    if (fn && !providerMap.has(n)) providerMap.set(n, { name: n, fn });
  }

  // 2. Augment with subject's priority_sources (RSS URLs + extra named providers).
  if (Array.isArray(prioritySources) && prioritySources.length > 0) {
    for (const s of prioritySources) {
      if (/^https?:\/\//i.test(s)) {
        rssUrls.push(s);
      } else {
        const lname = String(s).toLowerCase();
        const fn = SOURCE_NAME_TO_FETCHER[lname];
        if (fn && !providerMap.has(lname)) providerMap.set(lname, { name: lname, fn });
      }
    }
  }

  let providers = [...providerMap.values()];

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
  const itemsToProcess = uniq.slice(0, limit * 2);
  for (let itemIdx = 0; itemIdx < itemsToProcess.length; itemIdx++) {
    const item = itemsToProcess[itemIdx]; // over-fetch then trim after scrape failures
    // Progress log so silent hangs become visible (item N of M) — was flying
    // blind between fetchPage failures and the next vectorStore add.
    const itemTitle = (item.title || item.url || "").slice(0, 60);
    console.log(`[harvester] processing item ${itemIdx + 1}/${itemsToProcess.length}: ${itemTitle}`);
    let content = item.content;
    let fromCache = false;
    if (!content) {
      const cached = await checkCache(item.url);
      if (cached?.content) {
        content = cached.content;
        fromCache = true;
      } else {
        content = await fetchPage(item.url, { topic, title: item.title, deepMode });
        if (content) await writeCache(item.url, { url: item.url, content, fetchedAt: new Date().toISOString() });
      }
    } else if (deepMode && content.length < 3000 && PAPER_LIKE_URL.test(item.url || "")) {
      // Phase 5G — Deep-mode enrichment.
      // Old trigger: only fired when deepText.length > content.length (rarely true since
      // abstracts are dense and full PDFs get sliced to 8K chars after extraction).
      // New trigger: fire whenever (a) we have only abstract-level content (<3000 chars)
      // AND (b) URL is paper-like. Replaces unconditionally if PDF fetch succeeds.
      try {
        const deepText = await fetchPage(item.url, { topic, title: item.title, deepMode: true });
        if (deepText && deepText.length >= 1000) {
          content = deepText;
          await writeCache(item.url, { url: item.url, content, fetchedAt: new Date().toISOString(), deep: true });
          console.log(`[harvester] deep-read enrichment ✓ ${item.title?.slice(0, 50) || item.url.slice(0, 50)} → ${deepText.length}c (was ${item.content?.length || 0}c abstract)`);
        } else {
          // Phase 10E — deep-read returned nothing/thin; mark for the manual bridge.
          item._fetch_failed = true;
        }
      } catch {
        // Phase 10E — fetchPage threw. Article remains at abstract-level content.
        // Flag so manualBridge.collectBlockedSources can offer it for manual download.
        item._fetch_failed = true;
      }
    }
    // ── PAYWALL FALLBACK CHAIN ──
    // Original URL produced thin/empty content. If we have a DOI, try in order:
    //   1. Unpaywall   — legit OA copy (preferred; copyright-clean)
    //   2. LibGen      — paywall bypass (last resort; opt-in via ENABLE_LIBGEN_FALLBACK)
    if (!content || content.length < 500) {
      const doi = extractDoi(item.url, item.content);
      if (doi) {
        // 1. UNPAYWALL — legit OA-PDF lookup
        const unpaywallUrl = await fetchViaUnpaywall(doi);
        if (unpaywallUrl) {
          const oaContent = await fetchPage(unpaywallUrl, { topic, title: item.title, deepMode });
          if (oaContent && oaContent.length >= 500) {
            content = oaContent;
            item.url = unpaywallUrl;
            item.domain = safeHost(unpaywallUrl);
            item.source = `${item.source || "unknown"}+unpaywall`;
            await writeCache(unpaywallUrl, { url: unpaywallUrl, content, fetchedAt: new Date().toISOString(), via: "unpaywall" });
            console.log(`[harvester] unpaywall content ✓ ${(oaContent.length / 1024).toFixed(1)}KB for doi=${doi}`);
          } else {
            console.log(`[harvester] unpaywall got URL but fetchPage returned thin content for doi=${doi}`);
          }
        }

        // 2. LIBGEN — paywall bypass (only if Unpaywall miss + flag enabled)
        if ((!content || content.length < 500) && ENABLE_LIBGEN_FALLBACK) {
          const pdfUrl = await fetchViaLibgen(doi);
          if (pdfUrl) {
            const fallback = await fetchPage(pdfUrl, { topic, title: item.title, deepMode });
            if (fallback && fallback.length >= 500) {
              content = fallback;
              item.url = pdfUrl;
              item.domain = safeHost(pdfUrl);
              item.source = `${item.source || "unknown"}+libgen`;
              // Phase 12G — flag this as low-quality content. Libgen mirrors
              // often serve ad pages (~3-4KB) instead of the actual paper, but
              // they pass the >=500 char threshold. Mark these so the manual
              // bridge can correctly identify them as "still needs the user".
              item._used_libgen_fallback = true;
              if (fallback.length < 4000) item._fetch_failed = true;
              await writeCache(pdfUrl, { url: pdfUrl, content, fetchedAt: new Date().toISOString(), via: "libgen" });
              console.log(`[harvester] libgen-fallback content ✓ ${(fallback.length / 1024).toFixed(1)}KB for doi=${doi}${fallback.length < 4000 ? " (LOW QUALITY — likely ad page; bridge-eligible)" : ""}`);
            } else {
              console.log(`[harvester] libgen-fallback got URL but fetchPage returned thin content for doi=${doi}`);
              // Don't unset _fetch_failed — we know the original fetch failed
            }
          }
        }
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
      fromCache,
      // Phase 5A — propagate the structured citation metadata. Without this,
      // the synthesizer can't build a real citation index (was getting 0 entries
      // from 30 sources because cite was set by fetchers but stripped here).
      ...(item.cite ? { cite: item.cite } : {})
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

// ── Semantic Scholar rate-limit circuit breaker ─────────────────────────
// Unauthenticated S2 is limited to ~100 req per 5 min. When a 429 is seen we
// skip further S2 calls for S2_COOLDOWN_MS. Prevents the harvester from
// hammering S2 once rate-limited (every prompt was emitting a pointless 429).
const S2_COOLDOWN_MS = 5 * 60 * 1000;
let _s2CooldownUntil = 0;

async function fetchSemanticScholar(query, limit) {
  const kw = extractSearchKeywords(query);
  const now = Date.now();
  if (now < _s2CooldownUntil) {
    const remainSec = Math.ceil((_s2CooldownUntil - now) / 1000);
    console.log(`[articleHarvester] S2: cooldown (rate-limited, ${remainSec}s left) — skipping`);
    return [];
  }
  console.log(`[articleHarvester] S2: querying "${kw}" (limit ${limit})`);
  try {
    const headers = { ...BROWSER_HEADERS };
    if (CONFIG.SEMANTIC_SCHOLAR_KEY) headers["x-api-key"] = CONFIG.SEMANTIC_SCHOLAR_KEY;
    const r = await axios.get("https://api.semanticscholar.org/graph/v1/paper/search", {
      params: { query: kw, limit, fields: "title,abstract,url,year,authors,openAccessPdf,externalIds,venue,journal" },
      headers,
      timeout: 12000
    });
    const mapped = (r.data?.data || []).filter(x => x.abstract).map(x => {
      // Prefer open-access PDF URL so the scraper can fetch full text
      const oaUrl = x.openAccessPdf?.url;
      const doi = x.externalIds?.DOI;
      const url = oaUrl || x.url || (doi ? `https://doi.org/${doi}` : `https://semanticscholar.org/paper/${x.paperId}`);
      const authorList = (x.authors || []).map(a => a.name).filter(Boolean);
      const venue = x.journal?.name || x.venue || "";
      return {
        url,
        title: x.title,
        content: `Year: ${x.year || "Unknown"}\nAuthors: ${authorList.join(", ")}\nAbstract: ${x.abstract}`,
        domain: oaUrl ? safeHost(oaUrl) : "semanticscholar.org",
        cite: {
          authors: authorList,
          year: x.year || null,
          title: x.title || "",
          venue: venue,
          volume: x.journal?.volume || null,
          pages: x.journal?.pages || null,
          doi: doi || null
        }
      };
    });
    console.log(`[articleHarvester] S2: got ${mapped.length} results for "${kw}"`);
    return mapped;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) {
      _s2CooldownUntil = Date.now() + S2_COOLDOWN_MS;
      console.log(`[articleHarvester] S2 error: HTTP 429 — engaging ${Math.round(S2_COOLDOWN_MS / 60000)}min cooldown`);
    } else {
      console.log(`[articleHarvester] S2 error: ${status ? `HTTP ${status}` : err.message}`);
    }
    log(`Semantic Scholar error (query="${kw}"): ${err.message}`, "warn");
    if (rethrowIfTransient(err, "S2", kw) === null) return [];
  }
}

async function fetchArxiv(query, limit) {
  try {
    const safe = query.replace(/\s+/g, "+");
    const r = await axios.get(`http://export.arxiv.org/api/query?search_query=all:${safe}&start=0&max_results=${limit}`, { timeout: 12000, headers: { ...BROWSER_HEADERS, "Accept": "application/atom+xml,application/xml,*/*;q=0.9" } });
    const entries = r.data.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.map(e => {
      const t = e.match(/<title>([\s\S]*?)<\/title>/);
      const s = e.match(/<summary>([\s\S]*?)<\/summary>/);
      const id = e.match(/<id>([\s\S]*?)<\/id>/);
      // arXiv's <id> is the abs URL (e.g. http://arxiv.org/abs/1707.06202v1) which
      // serves the abstract HTML page only. Convert to the .pdf URL so any future
      // fetchPage() call (e.g. through paywall fallback) gets the actual paper text.
      // We keep the abstract from <summary> as inline content for the synthesizer's
      // fast path; the URL pointing at the PDF is for citation + on-demand full-read.
      let url = id ? id[1].trim() : "";
      const absMatch = url.match(/^(https?:\/\/arxiv\.org)\/abs\/(.+?)$/i);
      if (absMatch) url = `${absMatch[1].replace(/^http:/, "https:")}/pdf/${absMatch[2]}.pdf`;
      return {
        url,
        title: t ? t[1].trim().replace(/\n/g, " ") : "ArXiv Paper",
        content: s ? s[1].trim() : "",
        domain: "arxiv.org"
      };
    }).filter(x => x.url);
  } catch (err) {
    if (rethrowIfTransient(err, "arxiv", query) === null) return [];
  }
}

async function fetchEuropePMC(query, limit) {
  try {
    const r = await axios.get("https://www.ebi.ac.uk/europepmc/webservices/rest/search", {
      params: { query, format: "json", resultType: "core", pageSize: limit },
      headers: BROWSER_HEADERS,
      timeout: 12000
    });
    const rows = r.data?.resultList?.result || [];
    return rows.filter(x => x.abstractText).map(x => ({
      url: `https://europepmc.org/article/MED/${x.pmid}`,
      title: x.title,
      content: `Journal: ${x.journalTitle || ""}\nAbstract: ${(x.abstractText || "").replace(/<[^>]+>/g, "")}`,
      domain: "europepmc.org",
      cite: {
        authors: (x.authorList?.author || []).map(a => `${a.lastName || ""}, ${(a.initials || a.firstName || "").charAt(0)}.`).filter(s => s.length > 3),
        year: x.pubYear ? parseInt(x.pubYear, 10) : null,
        title: x.title || "",
        venue: x.journalTitle || "",
        volume: x.journalVolume || null,
        issue: x.issue || null,
        pages: x.pageInfo || null,
        doi: x.doi || null
      }
    }));
  } catch (err) {
    if (rethrowIfTransient(err, "europepmc", query) === null) return [];
  }
}

async function fetchWikipedia(query, limit) {
  try {
    const r = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", list: "search", srsearch: query, utf8: "", format: "json", srlimit: limit },
      headers: BROWSER_HEADERS,
      timeout: 10000
    });
    const rows = r.data?.query?.search || [];
    return rows.map(x => ({
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title)}`,
      title: x.title,
      content: (x.snippet || "").replace(/<[^>]+>/g, ""),
      domain: "wikipedia.org"
    }));
  } catch (err) {
    if (rethrowIfTransient(err, "wikipedia", query) === null) return [];
  }
}

/**
 * CORE open-access repository — https://core.ac.uk
 * Returns peer-reviewed papers with direct download URLs (open access only).
 * Requires CORE_API_KEY in .env (free registration at https://core.ac.uk/services/api).
 */
async function fetchCore(query, limit) {
  if (!CONFIG.CORE_API_KEY) {
    console.log(`[articleHarvester] CORE: CORE_API_KEY not set — skipping`);
    log("CORE_API_KEY not set — skipping CORE fetch", "warn");
    return [];
  }
  if (coreCircuitOpen()) {
    const remaining = Math.round((_coreCooldownUntil - Date.now()) / 1000);
    console.log(`[articleHarvester] CORE: circuit-breaker open (${remaining}s left) — skipping`);
    return [];
  }
  const kw = extractSearchKeywords(query);
  console.log(`[articleHarvester] CORE: querying "${kw}" (limit ${limit})`);
  try {
    const r = await axios.get("https://api.core.ac.uk/v3/search/works", {
      params: { q: kw, limit },
      headers: { ...BROWSER_HEADERS, "Authorization": `Bearer ${CONFIG.CORE_API_KEY}` },
      timeout: 15000
    });
    const results = (r.data?.results || []).filter(x => x.abstract || x.downloadUrl || x.fullTextUrl);
    console.log(`[articleHarvester] CORE: got ${results.length} results for "${kw}"`);
    return results.map(x => {
        // Prefer direct download link so the scraper gets full text
        const url = x.downloadUrl || x.fullTextUrl || `https://core.ac.uk/works/${x.id}`;
        const authorList = (x.authors || [])
          .map(a => (typeof a === "string" ? a : a?.name || ""))
          .filter(Boolean);
        const authorStr = authorList.join(", ");
        const venue = x.journals?.[0]?.title || x.publisher || "";
        return {
          url,
          title: x.title || "(untitled)",
          content: [
            x.abstract ? `Abstract: ${x.abstract}` : "",
            authorStr ? `Authors: ${authorStr}` : "",
            x.doi ? `DOI: ${x.doi}` : "",
            x.yearPublished ? `Year: ${x.yearPublished}` : ""
          ].filter(Boolean).join("\n"),
          domain: safeHost(url) || "core.ac.uk",
          cite: {
            authors: authorList,
            year: x.yearPublished || null,
            title: x.title || "",
            venue: venue,
            doi: x.doi || null
          }
        };
      });
  } catch (err) {
    const status = err?.response?.status;
    // On 5xx, peek at the response body — if it's a Cloudflare challenge HTML
    // page, our headers/IP got flagged. Useful to distinguish "API really down"
    // from "Cloudflare blocking us".
    let bodyHint = "";
    if (typeof status === "number" && status >= 500) {
      const body = err?.response?.data;
      const bodyStr = typeof body === "string" ? body : (body ? JSON.stringify(body).slice(0, 200) : "");
      if (/cloudflare|cf-ray|attention required|just a moment/i.test(bodyStr)) {
        bodyHint = " [Cloudflare challenge detected]";
      } else if (bodyStr) {
        bodyHint = ` body="${bodyStr.slice(0, 120).replace(/\s+/g, " ")}"`;
      }
    }
    console.log(`[articleHarvester] CORE error: ${status ? `HTTP ${status}` : err.message} (query="${kw}")${bodyHint}`);
    log(`CORE API error (query="${kw}"): ${err.message}`, "warn");
    recordCoreFailure(status || 0);
    if (rethrowIfTransient(err, "CORE", kw) === null) return [];
  }
}

/**
 * Directory of Open Access Journals — https://doaj.org
 * All returned articles are guaranteed open access. No API key required for reads.
 * Rate limit: 2 req/s (5 queued). We stay well within this.
 */
async function fetchDoaj(query, limit) {
  const kw = extractSearchKeywords(query);
  console.log(`[articleHarvester] DOAJ: querying "${kw}" (limit ${limit})`);
  try {
    const encoded = encodeURIComponent(kw);
    const r = await axios.get(`https://doaj.org/api/search/articles/${encoded}`, {
      params: { pageSize: Math.min(limit, 10) },
      headers: BROWSER_HEADERS,
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
      const authorList = (bib.author || []).map(a => a.name).filter(Boolean);
      const authorStr = authorList.join(", ");
      const venue = bib.journal?.title || "";
      const year = bib.year || bib.journal?.year || null;
      return {
        url,
        title: bib.title || "(untitled)",
        content: [
          bib.abstract ? `Abstract: ${bib.abstract}` : "",
          authorStr ? `Authors: ${authorStr}` : "",
          doi ? `DOI: ${doi}` : ""
        ].filter(Boolean).join("\n"),
        domain: safeHost(url) || "doaj.org",
        cite: {
          authors: authorList,
          year: year ? parseInt(year, 10) : null,
          title: bib.title || "",
          venue: venue,
          volume: bib.journal?.volume || null,
          issue: bib.journal?.number || null,
          pages: bib.start_page && bib.end_page ? `${bib.start_page}-${bib.end_page}` : null,
          doi: doi || null
        }
      };
    }).filter(Boolean);
    console.log(`[articleHarvester] DOAJ: got ${items.length} results for "${kw}"`);
    return items;
  } catch (err) {
    const status = err?.response?.status;
    console.log(`[articleHarvester] DOAJ error: ${status ? `HTTP ${status}` : err.message} (query="${kw}")`);
    log(`DOAJ API error (query="${kw}"): ${err.message}`, "warn");
    if (rethrowIfTransient(err, "DOAJ", kw) === null) return [];
  }
}

/**
 * Reconstruct a readable abstract from OpenAlex's inverted-index format.
 * OpenAlex stores abstracts as `{ word: [pos1, pos2, ...] }` for compactness.
 * This walks all positions, sorts them, and emits the original word order.
 */
function reconstructAbstract(invertedIdx) {
  if (!invertedIdx || typeof invertedIdx !== "object") return "";
  const positions = [];
  for (const [word, posList] of Object.entries(invertedIdx)) {
    if (!Array.isArray(posList)) continue;
    for (const p of posList) {
      if (typeof p === "number") positions.push([p, word]);
    }
  }
  if (positions.length === 0) return "";
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ");
}

/**
 * OpenAlex — multidisciplinary, ~250M works. Free, no API key.
 *
 * Including a `mailto` query param puts us in the "polite pool":
 * 100k requests/day instead of the 10/sec anonymous limit. Strongly recommended.
 *
 * Successor to Microsoft Academic Graph (which Microsoft sunset in Dec 2021).
 * Best free single source for general academic search; covers economics,
 * psychology, biomed, CS, etc.
 */
async function fetchOpenAlex(query, limit) {
  const kw = extractSearchKeywords(query);
  console.log(`[articleHarvester] OpenAlex: querying "${kw}" (limit ${limit})`);
  const mailto = CONFIG.OPENALEX_MAILTO || process.env.OPENALEX_MAILTO || null;
  try {
    const params = { search: kw, "per-page": Math.min(limit, 25) };
    if (mailto) params.mailto = mailto;
    const r = await axios.get("https://api.openalex.org/works", {
      params,
      headers: BROWSER_HEADERS,
      timeout: 12000
    });
    const works = r.data?.results || [];
    const items = works
      .filter(w => w.abstract_inverted_index) // drop metadata-only entries
      .map(w => {
        const oaPdf = w.open_access?.oa_url;
        const doi = (w.doi || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
        const url = oaPdf || (doi ? `https://doi.org/${doi}` : w.id);
        if (!url) return null;
        const authorList = (w.authorships || [])
          .map(a => a?.author?.display_name)
          .filter(Boolean);
        const authorStr = authorList.join(", ");
        const abstract = reconstructAbstract(w.abstract_inverted_index);
        const venue = w.host_venue?.display_name || w.primary_location?.source?.display_name;
        const biblio = w.biblio || {};
        return {
          url,
          title: w.title || w.display_name || "(untitled)",
          content: [
            abstract ? `Abstract: ${abstract}` : "",
            authorStr ? `Authors: ${authorStr}` : "",
            doi ? `DOI: ${doi}` : "",
            venue ? `Venue: ${venue}` : "",
            w.publication_year ? `Year: ${w.publication_year}` : "",
            typeof w.cited_by_count === "number" ? `Citations: ${w.cited_by_count}` : ""
          ].filter(Boolean).join("\n"),
          domain: oaPdf ? safeHost(oaPdf) : "openalex.org",
          cite: {
            authors: authorList,
            year: w.publication_year || null,
            title: w.title || w.display_name || "",
            venue: venue || "",
            volume: biblio.volume || null,
            issue: biblio.issue || null,
            pages: biblio.first_page && biblio.last_page ? `${biblio.first_page}-${biblio.last_page}` : null,
            doi: doi || null
          }
        };
      })
      .filter(Boolean);
    console.log(`[articleHarvester] OpenAlex: got ${items.length} results for "${kw}"${mailto ? "" : " (anonymous pool — set OPENALEX_MAILTO for higher limit)"}`);
    return items;
  } catch (err) {
    const status = err?.response?.status;
    console.log(`[articleHarvester] OpenAlex error: ${status ? `HTTP ${status}` : err.message} (query="${kw}")`);
    log(`OpenAlex error (query="${kw}"): ${err.message}`, "warn");
    if (rethrowIfTransient(err, "OpenAlex", kw) === null) return [];
  }
}

/**
 * OSF Preprints — covers PsyArXiv, SocArXiv, EarthArXiv, MarXiv, NutriXiv,
 * EconStor, and ~14 other preprint servers under the OSF umbrella.
 *
 * Best free source for psychology + social-science research (PsyArXiv alone
 * has ~50k preprints). Free, no auth.
 */
async function fetchOsfPreprints(query, limit) {
  const kw = extractSearchKeywords(query);
  console.log(`[articleHarvester] OSF: querying "${kw}" (limit ${limit})`);
  try {
    // OSF API doesn't support `filter[q]` (full-text) on /preprints/ — only specific
    // fields like filter[title], filter[description]. Confirmed via API error:
    // {"detail":"'q' is not a valid field for this endpoint."}.
    // We use filter[title] as the primary search; OSF returns matches when the title
    // contains any of the words. Embed param dropped (caused 502s); we use the inline
    // contributor + relationship data on the response instead.
    const r = await axios.get("https://api.osf.io/v2/preprints/", {
      params: {
        "filter[title]": kw,
        "page[size]": Math.min(limit, 10)
      },
      headers: BROWSER_HEADERS,
      timeout: 12000
    });
    const data = r.data?.data || [];
    const items = data.map(p => {
      const attrs = p.attributes || {};
      const description = attrs.description;
      if (!description) return null;
      const doi = attrs.preprint_doi || attrs.doi;
      // Without the embed, we don't have a direct download URL. Use the OSF preprint
      // page or DOI as the URL — fetchPage() will scrape the abstract page if needed,
      // but the inline `description` is already strong enough content for the synthesizer.
      const provider = p.relationships?.provider?.data?.id || "osf";
      const osfPageUrl = p.links?.html || p.links?.self
        || `https://osf.io/preprints/${provider}/${p.id}`;
      const url = doi
        ? `https://doi.org/${String(doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")}`
        : osfPageUrl;
      if (!url) return null;
      const year = attrs.date_published ? parseInt(String(attrs.date_published).slice(0, 4), 10) : null;
      // OSF preprints don't expose authors in the basic /preprints/ response without
      // embeds. We can't reliably get author names here, so cite is best-effort:
      // mark provider as the venue and leave authors empty (the synthesizer will
      // drop the citation marker per Phase 5A fallback policy).
      return {
        url,
        title: attrs.title || "(untitled preprint)",
        content: [
          `Abstract: ${description}`,
          `Provider: ${provider}`,
          doi ? `DOI: ${doi}` : "",
          attrs.date_published ? `Published: ${String(attrs.date_published).slice(0, 10)}` : ""
        ].filter(Boolean).join("\n"),
        domain: safeHost(url) || "osf.io",
        cite: {
          authors: [], // not in basic OSF response — would need embed=contributors which 502s
          year: year,
          title: attrs.title || "",
          venue: `${provider} (preprint)`,
          doi: doi || null
        }
      };
    }).filter(Boolean);
    console.log(`[articleHarvester] OSF: got ${items.length} results for "${kw}"`);
    return items;
  } catch (err) {
    const status = err?.response?.status;
    console.log(`[articleHarvester] OSF error: ${status ? `HTTP ${status}` : err.message} (query="${kw}")`);
    log(`OSF Preprints error (query="${kw}"): ${err.message}`, "warn");
    if (rethrowIfTransient(err, "OSF", kw) === null) return [];
  }
}

/**
 * Academagic — Hebrew/English academic-paper portal hosted in IL (academagic.co.il).
 *
 * Why it's worth including:
 *   - Robots-allowed (`User-agent: * Disallow:` confirms scrape OK)
 *   - Direct PDF iframe URLs on each article page (PDFs hosted on sofrim.org)
 *   - Strong Hebrew-language coverage (the closest thing to a Hebrew academic
 *     index that exists for free; fills a real gap in our current stack)
 *   - English coverage too, with bilingual abstracts
 *   - Free, no API key, no Cloudflare
 *
 * Flow: search results page → article page → iframe[src=*.pdf]
 * Two HTTP calls per result, capped to `limit`. Per-article fetch is parallel.
 */
async function fetchAcademagic(query, limit) {
  const kw = (query || "").trim();
  if (!kw) return [];
  console.log(`[articleHarvester] Academagic: querying "${kw}" (limit ${limit})`);
  try {
    // 1. Search results page (form submits to /results/?search_keyword=...)
    const search = await axios.get("https://academagic.co.il/results/", {
      params: { search_keyword: kw },
      headers: BROWSER_HEADERS,
      timeout: 12000,
      maxRedirects: 4
    });
    const html = typeof search.data === "string" ? search.data : "";

    // Extract unique article URLs from result list. The page repeats each link
    // 3-4 times (title EN, title HE, "לצפיה" view button) — dedup by URL.
    const linkRe = /href="(https:\/\/academagic\.co\.il\/article\/[^"#?]+\/?)"/g;
    const urls = new Set();
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      urls.add(m[1]);
      if (urls.size >= limit) break;
    }
    if (urls.size === 0) {
      console.log(`[articleHarvester] Academagic: 0 results for "${kw}"`);
      return [];
    }

    // 2. Fetch each article page in parallel; extract PDF URL + abstract.
    const articleUrls = [...urls].slice(0, limit);
    const items = await Promise.all(articleUrls.map(async (articleUrl) => {
      try {
        const ar = await axios.get(articleUrl, {
          headers: BROWSER_HEADERS,
          timeout: 10000,
          maxRedirects: 4
        });
        const ahtml = typeof ar.data === "string" ? ar.data : "";

        // PDF iframe: <iframe ... src="https://sofrim.org/...pdf#view=FitH">
        const pdfMatch = ahtml.match(/<iframe[^>]+src="([^"]+\.pdf[^"]*)"/i);
        if (!pdfMatch) return null;
        const pdfUrl = pdfMatch[1].replace(/#view=[^"]*$/, ""); // strip anchor

        // Title — grab the og:title or <title>. Decode HTML entities + strip
        // both the English "Academagic" branding AND the Hebrew "אקדמג'יק" suffix
        // (which were leaking into bibliography entries as "&#8211; אקדמג&#039;יק").
        const titleMatch = ahtml.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)
                       || ahtml.match(/<title>([^<]+)<\/title>/i);
        let title = decodeAndCleanScrapedText(titleMatch?.[1] || "");
        title = title.replace(/\s*[-–|]\s*Academagic.*$/i, "").trim();

        // Abstract — meta description usually carries it; fall back to first long <p>
        let abstract = "";
        const descMatch = ahtml.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
                       || ahtml.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
        if (descMatch) abstract = decodeAndCleanScrapedText(descMatch[1]);
        if (abstract.length < 50) {
          // Find first paragraph with substantial text
          const pMatch = ahtml.match(/<p[^>]*>([^<]{100,1000})<\/p>/);
          if (pMatch) abstract = decodeAndCleanScrapedText(pMatch[1]);
        }

        // Citation block — look for "Author (Year). Title. Journal." pattern
        const citeMatch = ahtml.match(/<p[^>]*>([A-Z][\w'\-]+(?:,\s*[A-Z]\.)+\s*\(\d{4}\)[^<]+)<\/p>/);
        const citation = decodeAndCleanScrapedText(citeMatch?.[1] || "");

        // Best-effort parse of the citation block into structured fields.
        // Format we expect: "Smith, J., & Jones, A. (2026). Title. Journal of X, 1(1), 1-11."
        let parsedCite = null;
        if (citation) {
          const yearMatch = citation.match(/\((\d{4})\)/);
          const authorsPart = yearMatch ? citation.slice(0, citation.indexOf("(")).trim().replace(/\.$/, "") : "";
          const afterYear = yearMatch ? citation.slice(citation.indexOf(")") + 1).trim().replace(/^\.\s*/, "") : "";
          // afterYear is "Title. Journal, vol(issue), pages."
          const titleVenueMatch = afterYear.match(/^([^.]+)\.\s*(.+)$/);
          const articleTitle = titleVenueMatch ? titleVenueMatch[1].trim() : afterYear.split(".")[0];
          const venuePart = titleVenueMatch ? titleVenueMatch[2].trim().replace(/\.$/, "") : "";
          const venueOnly = venuePart.split(",")[0].trim();
          // Authors: split by comma & "&"
          const authors = authorsPart.split(/,\s*&\s*|;\s*|,\s*(?=[A-Z][\w'-]+,)/).map(a => a.trim()).filter(Boolean);
          parsedCite = {
            authors: authors.map(decodeAndCleanScrapedText).filter(Boolean),
            year: yearMatch ? parseInt(yearMatch[1], 10) : null,
            title: decodeAndCleanScrapedText(articleTitle),
            venue: decodeAndCleanScrapedText(venueOnly),
            url: pdfUrl
          };
        }

        return {
          url: pdfUrl,
          title: title || "(untitled)",
          content: [
            abstract ? `Abstract: ${abstract}` : "",
            citation ? `Citation: ${citation}` : "",
            `Source: Academagic (${articleUrl})`
          ].filter(Boolean).join("\n"),
          domain: "academagic.co.il",
          cite: parsedCite
        };
      } catch {
        return null;
      }
    }));

    const valid = items.filter(Boolean);
    console.log(`[articleHarvester] Academagic: got ${valid.length} results for "${kw}" (PDFs hosted on sofrim.org)`);
    return valid;
  } catch (err) {
    const status = err?.response?.status;
    console.log(`[articleHarvester] Academagic error: ${status ? `HTTP ${status}` : err.message} (query="${kw}")`);
    log(`Academagic error (query="${kw}"): ${err.message}`, "warn");
    if (rethrowIfTransient(err, "Academagic", kw) === null) return [];
  }
}

// ── UNPAYWALL DOI → OA-PDF LOOKUP ──────────────────────────────────────────
// Free DOI service that finds legitimate open-access versions of paywalled
// papers (~150M DOIs indexed). Email is REQUIRED by their terms — they use it
// as a throttle key + contact for abuse cases. No account/signup needed.
const UNPAYWALL_CACHE_DIR = path.resolve(PROJECT_ROOT, "data", "research-cache", "unpaywall");
const UNPAYWALL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function unpaywallCacheGet(doi) {
  try {
    const hash = crypto.createHash("md5").update(doi).digest("hex");
    const p = path.join(UNPAYWALL_CACHE_DIR, `${hash}.json`);
    const stat = await fs.stat(p);
    if (Date.now() - stat.mtimeMs > UNPAYWALL_CACHE_TTL_MS) {
      await fs.unlink(p).catch(() => {});
      return null;
    }
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return null; }
}
async function unpaywallCacheSet(doi, payload) {
  try {
    await fs.mkdir(UNPAYWALL_CACHE_DIR, { recursive: true });
    const hash = crypto.createHash("md5").update(doi).digest("hex");
    await fs.writeFile(path.join(UNPAYWALL_CACHE_DIR, `${hash}.json`), JSON.stringify(payload), "utf8");
  } catch {}
}

/**
 * Look up a DOI on Unpaywall and return the best free-to-read URL, or null.
 * Prefers a direct PDF if available; falls back to the landing page URL.
 * Caches positive AND negative results for 30 days.
 */
async function fetchViaUnpaywall(doi) {
  const email = CONFIG.UNPAYWALL_EMAIL || process.env.UNPAYWALL_EMAIL;
  if (!email || !doi) return null;

  const cached = await unpaywallCacheGet(doi);
  if (cached?.oaUrl) {
    console.log(`[harvester] unpaywall cache HIT for doi=${doi} → ${cached.oaUrl}`);
    return cached.oaUrl;
  }
  if (cached?.miss) return null;

  const start = Date.now();
  try {
    const r = await axios.get(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`, {
      params: { email },
      headers: BROWSER_HEADERS,
      timeout: 10000
    });
    const data = r.data || {};
    let oaUrl = null;
    if (data.is_oa) {
      oaUrl = data.best_oa_location?.url_for_pdf
        || data.best_oa_location?.url
        || (data.oa_locations || []).find(loc => loc?.url_for_pdf)?.url_for_pdf
        || (data.oa_locations || [])[0]?.url
        || null;
    }
    const ms = Date.now() - start;
    if (oaUrl) {
      console.log(`[harvester] unpaywall ✓ doi=${doi} → ${safeHost(oaUrl)} (${ms}ms, host_type=${data.best_oa_location?.host_type || "?"})`);
      await unpaywallCacheSet(doi, { oaUrl, hostType: data.best_oa_location?.host_type, fetchedAt: new Date().toISOString() });
      return oaUrl;
    }
    console.log(`[harvester] unpaywall ✗ doi=${doi} (no OA version found, ${ms}ms)`);
    await unpaywallCacheSet(doi, { miss: true, fetchedAt: new Date().toISOString() });
    return null;
  } catch (err) {
    const status = err?.response?.status;
    console.log(`[harvester] unpaywall error doi=${doi}: ${status ? `HTTP ${status}` : err.message}`);
    return null; // soft fail — don't break the harvest if Unpaywall is hiccuping
  }
}

/**
 * Google Scholar via SerpAPI (engine=google_scholar).
 * Google Scholar itself has no public API and aggressive anti-bot, but SerpAPI
 * provides a reliable wrapper that exposes PDF links via the `resources` field.
 *
 * Returns up to `limit` results, prioritizing entries with a direct PDF link.
 */
async function fetchGoogleScholar(query, limit) {
  if (!CONFIG.SERPAPI_KEY) {
    console.log(`[articleHarvester] GScholar: SERPAPI_KEY not set — skipping`);
    return [];
  }
  const kw = extractSearchKeywords(query);
  console.log(`[articleHarvester] GScholar: querying "${kw}" (limit ${limit})`);
  try {
    const r = await axios.get("https://serpapi.com/search.json", {
      params: {
        q: kw,
        api_key: CONFIG.SERPAPI_KEY,
        engine: "google_scholar",
        num: Math.min(limit, 10)
      },
      timeout: 15000
    });
    const organic = r.data?.organic_results || [];
    const items = organic.map(x => {
      // Prefer a direct PDF link surfaced in `resources` — Scholar often
      // exposes free full-text PDFs hosted on university repositories.
      const pdfResource = (x.resources || []).find(res => (res.file_format || "").toUpperCase() === "PDF");
      const pdfUrl = pdfResource?.link;
      const url = pdfUrl || x.link;
      if (!url) return null;
      const authors = (x.publication_info?.authors || []).map(a => a.name).filter(Boolean).join(", ");
      const snippet = x.snippet || "";
      return {
        url,
        title: x.title || "(untitled)",
        content: [
          snippet ? `Abstract: ${snippet}` : "",
          authors ? `Authors: ${authors}` : "",
          x.publication_info?.summary ? `Venue: ${x.publication_info.summary}` : ""
        ].filter(Boolean).join("\n"),
        domain: pdfUrl ? safeHost(pdfUrl) : "scholar.google.com"
      };
    }).filter(Boolean);
    console.log(`[articleHarvester] GScholar: got ${items.length} results for "${kw}" (${items.filter(i => /\.pdf/i.test(i.url)).length} with direct PDF)`);
    if (items.length === 0) {
      // Diagnostic: zero results may indicate query phrasing issue, SerpAPI quota,
      // or Scholar blocking. Surface enough context to debug "Scholar missing" reports.
      const rawCount = (r.data?.organic_results || []).length;
      const errMsg = r.data?.error;
      console.log(`[harvester] GScholar 0 results — raw organic_results=${rawCount}${errMsg ? ` SerpAPI error: ${errMsg}` : ""}`);
    }
    return items;
  } catch (err) {
    const status = err?.response?.status;
    console.log(`[articleHarvester] GScholar error: ${status ? `HTTP ${status}` : err.message} (query="${kw}")`);
    log(`Google Scholar (SerpAPI) error (query="${kw}"): ${err.message}`, "warn");
    if (rethrowIfTransient(err, "GScholar", kw) === null) return [];
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
async function fetchPage(url, opts = {}) {
  const { topic = "", title = "", deepMode = false } = opts;
  const isPdf = /\.pdf(\?|$)/i.test(url);
  const short = url.length > 80 ? url.slice(0, 77) + "..." : url;

  // Phase 5H — short-circuit known hardblock hosts (skip fetchPage round-trip,
  // let the harvest loop's Unpaywall/LibGen fallback handle it).
  const host = safeHost(url).toLowerCase();
  if (KNOWN_HARDBLOCK_HOSTS.has(host)) {
    console.log(`[articleHarvester] fetch skipped (hardblock host: ${host}) — defer to Unpaywall/LibGen: ${short}`);
    return "";
  }

  try {
    return await withRetry(async () => {
      // Phase 5H — inject Referer for known publishers that 403 without same-origin Referer
      const extraHeaders = {};
      if (PUBLISHER_REFERERS[host]) {
        extraHeaders["Referer"] = PUBLISHER_REFERERS[host];
        extraHeaders["Sec-Fetch-Site"] = "same-origin";
        extraHeaders["Sec-Fetch-Mode"] = "navigate";
        extraHeaders["Sec-Fetch-Dest"] = isPdf ? "document" : "document";
      }

      // axios's `timeout` only covers initial connect, NOT response body stream.
      // A server that drip-feeds bytes hangs forever under maxContentLength.
      // Phase 6A/E — adaptive abort:
      //   - 45s base hard cap (was 30s — too tight for slow large-PDF servers)
      //   - 60s if we received ANY response data (still streaming, just slowly)
      //   - 45s if zero bytes received (server unreachable / stuck)
      const HARD_CAP_MS    = 45_000;  // base abort if no bytes received
      const STREAM_CAP_MS  = 60_000;  // extended abort if bytes are arriving
      const abortCtl = new AbortController();
      let receivedBytes = 0;
      let abortReason = "no-response";

      const hardAbortId = setTimeout(() => {
        abortReason = receivedBytes > 0
          ? `slow-stream (${(receivedBytes / 1024).toFixed(1)}KB received)`
          : "no-bytes-received";
        // If we got bytes, give it the extended cap.
        if (receivedBytes > 0) {
          setTimeout(() => abortCtl.abort(), STREAM_CAP_MS - HARD_CAP_MS);
        } else {
          abortCtl.abort();
        }
      }, HARD_CAP_MS);

      let r;
      try {
        r = await axios.get(url, {
          timeout: 18000,
          signal: abortCtl.signal,
          maxRedirects: 4,
          headers: {
            ...BROWSER_HEADERS,
            "Accept": "text/html,application/xhtml+xml,application/pdf,*/*",
            ...extraHeaders
          },
          maxContentLength: 3 * 1024 * 1024,
          // Track bytes received so the abort can distinguish slow-stream from no-response
          onDownloadProgress: (e) => { receivedBytes = e?.loaded || receivedBytes; }
        });
      } catch (err) {
        if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED" || /aborted/i.test(err?.message || "")) {
          console.log(`[articleHarvester] fetchPage aborted: ${abortReason} (${short})`);
        }
        throw err;
      } finally {
        clearTimeout(hardAbortId);
      }
      const html = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      const rawBytes = Buffer.byteLength(html, "utf8");
      const text = stripHtmlToText(html);

      // Deep-mode path: extract abstract + LLM-chosen middle section + conclusion.
      // Falls back to smartSlice on any failure / short text.
      let sliced;
      if (deepMode && topic && text && text.length > 6000) {
        try {
          const sections = extractKeySections(text);
          if (sections.toc.length >= 2) {
            const middleName = await pickRelevantSection(topic, title, sections.toc);
            sliced = buildDeepCombined(sections, middleName, title);
          } else {
            sliced = smartSlice(text, url);
          }
        } catch (err) {
          console.log(`[harvester] deep-read failed (${err.message}) — falling back to smartSlice`);
          sliced = smartSlice(text, url);
        }
      } else {
        sliced = smartSlice(text, url);
      }

      if (isPdf || rawBytes > 150 * 1024) {
        console.log(`[articleHarvester] fetch ✓ ${(rawBytes / 1024).toFixed(0)}KB → text ${text.length}ch → slice ${sliced.length}ch${deepMode ? " [deep]" : ""}: ${short}`);
      }
      return sliced;
    }, 2, 2500);
  } catch (err) {
    console.log(`[articleHarvester] fetch ✗ ${err.message} (${short})`);
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
/**
 * Phase 5F — strip Obsidian callout syntax from source text BEFORE the LLM
 * sees it. This prevents the synthesizer from learning to mimic the broken
 * `> [!info]` patterns in its own output.
 */
function sanitizeSourceText(text) {
  if (!text) return text;
  return String(text)
    .replace(/^>\s*\[!\w+\][^\n]*\n/gim, "")    // strip callout headers like "> [!info] Title"
    .replace(/^\s*Info\s*$/gim, "")             // standalone "Info" lines
    .replace(/^\s*\[!\w+\]\s*$/gim, "")         // standalone "[!type]" lines
    .replace(/\n{3,}/g, "\n\n");                // collapse blank-line runs
}

function smartSlice(text, url = "") {
  text = sanitizeSourceText(text); // Phase 5F — strip leaked callouts
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

// ───────────────────────────── deep-read mode ─────────────────────────

// Headings we recognize as section anchors. Order matters for normalization
// (longer / more specific patterns first).
const SECTION_HEADINGS = [
  "Abstract",
  "Introduction",
  "Background",
  "Related Work",
  "Literature Review",
  "Materials and Methods",
  "Methodology",
  "Methods",
  "Approach",
  "Experimental Setup",
  "Experiments",
  "Evaluation",
  "Results",
  "Findings",
  "Analysis",
  "Discussion",
  "Implications",
  "Limitations",
  "Future Work",
  "Conclusion",
  "Conclusions",
  "Concluding Remarks",
  "Summary",
  "References",
  "Bibliography",
  "Acknowledgments",
  "Appendix"
];

/**
 * Walk the text looking for section headings. Returns:
 *   {
 *     toc: [{ name, start, end }],   // section name + char offsets
 *     abstract:   string             // labeled-or-front section (~1500c)
 *     conclusion: string             // labeled conclusion section (~2000c)
 *   }
 *
 * Headings can appear in three common formats: ALL CAPS on own line ("RESULTS"),
 * Title Case ("Results"), numbered ("4. Results"). All matched with i flag.
 */
function extractKeySections(text) {
  text = sanitizeSourceText(text); // Phase 5F — strip leaked callouts
  const toc = [];
  if (!text || typeof text !== "string") return { toc: [], abstract: "", conclusion: "" };

  // Build a regex that matches any heading from our list when on a line by
  // itself OR after a number/dot prefix. We allow up to ~3 leading whitespace
  // chars and a trailing colon or period.
  const headingPattern = SECTION_HEADINGS.map(h => h.replace(/\s+/g, "\\s+")).join("|");
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:\\d+\\.?\\s+|[IVX]+\\.?\\s+)?(${headingPattern})\\s*[:.\\n]`,
    "gim"
  );

  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim().replace(/\s+/g, " ");
    // Heading position = start of the matched heading word (skip any leading whitespace/numbering)
    const headingStart = m.index + m[0].toLowerCase().indexOf(name.toLowerCase());
    toc.push({ name: titleCase(name), start: headingStart, end: -1, headingEnd: headingStart + name.length, body: "" });
  }
  // Compute end offsets + populate each section's body text.
  for (let i = 0; i < toc.length; i++) {
    toc[i].end = (i + 1 < toc.length) ? toc[i + 1].start : text.length;
    toc[i].body = text.slice(toc[i].headingEnd, toc[i].end).trim();
  }

  // Find labeled abstract / conclusion by name.
  const findByName = (names) => {
    const lc = names.map(n => n.toLowerCase());
    return toc.find(t => lc.includes(t.name.toLowerCase()));
  };
  const abstractEntry = findByName(["Abstract"]);
  const conclusionEntry = findByName(["Conclusion", "Conclusions", "Concluding Remarks", "Summary"]);

  // Abstract content: labeled section, OR (fallback) first 1500 chars.
  let abstract;
  if (abstractEntry) {
    const body = text.slice(abstractEntry.headingEnd, abstractEntry.end).trim();
    abstract = body.slice(0, 1500);
  } else {
    abstract = text.slice(0, 1500);
  }

  // Conclusion content: labeled section, OR (fallback) last 2000 chars.
  let conclusion;
  if (conclusionEntry) {
    const body = text.slice(conclusionEntry.headingEnd, conclusionEntry.end).trim();
    conclusion = body.slice(0, 2000);
  } else {
    conclusion = text.slice(Math.max(0, text.length - 2000));
  }

  return { toc, abstract, conclusion };
}

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Heuristic-by-paper-type fallback (per user) when the LLM section-pick fails:
 *   - Empirical paper (has Methods+Results) → Results
 *   - Review paper (no Results) → Discussion (or Analysis)
 *   - Default → longest non-trivial middle section
 */
function heuristicSectionPick(toc) {
  const has = (name) => toc.some(t => t.name.toLowerCase().includes(name));
  if (has("results") || has("findings")) {
    if (has("methods") || has("methodology")) return "Results";
    return "Results";
  }
  if (has("discussion")) return "Discussion";
  if (has("analysis")) return "Analysis";
  if (has("literature review")) return "Discussion";
  // Default: longest middle section (excluding Intro/Abstract/Conclusion/References)
  const skip = new Set(["abstract", "introduction", "references", "bibliography",
                        "acknowledgments", "appendix", "conclusion", "conclusions",
                        "concluding remarks", "summary"]);
  const candidates = toc.filter(t => !skip.has(t.name.toLowerCase()));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  return candidates[0].name;
}

/**
 * Ask the LLM which section is most relevant to the research topic.
 * Tiny call: just topic + title + heading list. ~1-3s.
 * Falls back to heuristic on any failure.
 */
async function pickRelevantSection(topic, title, toc) {
  const tocNames = toc.map(t => t.name);
  if (tocNames.length === 0) return null;

  // Filter out abstract/conclusion/references — those are handled separately.
  const skipForLLM = new Set(["abstract", "conclusion", "conclusions", "concluding remarks",
                              "summary", "references", "bibliography", "acknowledgments"]);
  const middleNames = tocNames.filter(n => !skipForLLM.has(n.toLowerCase()));
  if (middleNames.length === 0) {
    return heuristicSectionPick(toc);
  }
  if (middleNames.length === 1) return middleNames[0]; // no choice to make

  const prompt = `Research topic: "${topic}"
Paper title: "${title || "(untitled)"}"
Sections in this paper (excluding Abstract/Conclusion which we always read):
${middleNames.map(n => `- ${n}`).join("\n")}

Of those sections, which ONE is most likely to contain evidence specifically relevant to "${topic}"?

Return JSON only:
{ "section": "<exact-name-from-list>", "reason": "<one short sentence>" }`;

  // Pin to qwen2.5:7b — same reason as thesisSynthesizer (don't drift with chat-persona model swaps)
  const SYNTH_MODEL = process.env.SYNTHESIZER_MODEL || "qwen2.5:7b";
  try {
    const res = await llm(prompt, {
      timeoutMs: 15000,
      format: "json",
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.2, num_ctx: 1024 }
    });
    const txt = res?.data?.text || "";
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch {
      const mm = txt.match(/\{[\s\S]*\}/);
      if (mm) { try { parsed = JSON.parse(mm[0]); } catch { parsed = null; } }
    }
    const picked = parsed?.section ? String(parsed.section).trim() : null;
    if (picked && middleNames.some(n => n.toLowerCase() === picked.toLowerCase())) {
      const reason = parsed.reason ? ` — ${String(parsed.reason).slice(0, 80)}` : "";
      console.log(`[harvester] deep-read picked: "${picked}"${reason}`);
      return picked;
    }
    // LLM picked something not in the list — fallback
    const fallback = heuristicSectionPick(toc);
    console.log(`[harvester] deep-read fallback: heuristic → "${fallback || "(none)"}" (LLM pick "${picked || "?"}" not in TOC)`);
    return fallback;
  } catch (err) {
    const fallback = heuristicSectionPick(toc);
    console.log(`[harvester] deep-read LLM-pick failed (${err.message}); heuristic → "${fallback || "(none)"}"`);
    return fallback;
  }
}

// Lazy LLM import to avoid a top-of-file module load issue.
let _llmFn = null;
async function llm(prompt, opts) {
  if (!_llmFn) {
    const mod = await import("../../tools/llm.js");
    _llmFn = mod.llm;
  }
  return _llmFn(prompt, opts);
}

/**
 * Build the final content string for the synthesizer in deep mode:
 *   abstract (1500c) + chosen middle section (5000c) + conclusion (2000c) ≈ 8500c
 */
function buildDeepCombined(sections, middleName, title) {
  const { toc, abstract, conclusion } = sections;
  const MIDDLE_MAX = 5000;
  let middleText = "";
  if (middleName) {
    const entry = toc.find(t => t.name.toLowerCase() === middleName.toLowerCase());
    if (entry) {
      // Re-resolve from text: caller passed slices so we need to use the toc indices
      // against the original text. But we don't have text here — sections.abstract/conclusion
      // are already extracted. So we need extractKeySections to also return original text
      // OR the middle slice. Cleanest: have extractKeySections also store originalText.
      // (handled below via the workaround: middle is passed in via toc.body if present)
      middleText = (entry.body || "").slice(0, MIDDLE_MAX);
    }
  }
  const parts = [
    `--- [Abstract] ---\n${abstract}`,
    middleText ? `\n\n--- [${middleName}] ---\n${middleText}` : "",
    `\n\n--- [Conclusion] ---\n${conclusion}`
  ];
  const combined = parts.filter(Boolean).join("");
  console.log(`[harvester] deep-read combined: abstract(${abstract.length}c) + ${middleName || "no-middle"}(${middleText.length}c) + conclusion(${conclusion.length}c) = ${combined.length}c`);
  return combined.slice(0, 9000);
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
        ...BROWSER_HEADERS,
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

const LIBGEN_CACHE_DIR = path.resolve(PROJECT_ROOT, "data", "research-cache", "libgen");
const LIBGEN_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// LibGen mirrors. Order matters: try the most-reliably-reachable mirror first.
// Many ISPs (including Bezeq/IL) block libgen.is + libgen.rs at the DNS/IP layer
// while leaving libgen.li reachable. Putting .li first saves ~30s/DOI on networks
// where the others are blocked.
const LIBGEN_BASES = ["https://libgen.li", "https://libgen.is", "https://libgen.rs"];
const ENABLE_LIBGEN_FALLBACK = String(CONFIG.ENABLE_LIBGEN_FALLBACK || process.env.ENABLE_LIBGEN_FALLBACK || "").toLowerCase() === "true";

// One-shot per-run deep-mode log key (topic|tier). Prevents 5x noise.
let _lastDeepModeKey = "";

// Soft circuit-breaker for LibGen — when all mirrors fail in a row, the network/DNS
// is likely blocking us. Skip further LibGen attempts for this run so we stop
// burning ~36s per DOI on doomed connection attempts.
const LIBGEN_FAILURE_BREAK_THRESHOLD = 3; // consecutive full-mirror-set misses
let _libgenConsecutiveFailures = 0;
let _libgenBlockedForRun = false;

/** Extract a DOI string from a URL or content blob, if present. */
function extractDoi(url, content) {
  // DOI regex per Crossref recommendation: 10.<registrant>/<suffix>
  const RE = /\b10\.\d{4,9}\/[\w.\-;()\/:]+/i;
  const m1 = (url || "").match(RE);
  if (m1) return m1[0].replace(/[.,;)\]]+$/, "");
  const m2 = (content || "").match(RE);
  if (m2) return m2[0].replace(/[.,;)\]]+$/, "");
  return null;
}

/** Cache LibGen DOI→PDF-URL mappings for 30 days. */
async function libgenCacheGet(doi) {
  try {
    const hash = crypto.createHash("md5").update(doi).digest("hex");
    const p = path.join(LIBGEN_CACHE_DIR, `${hash}.json`);
    const stat = await fs.stat(p);
    if (Date.now() - stat.mtimeMs > LIBGEN_CACHE_TTL_MS) {
      await fs.unlink(p).catch(() => {});
      return null;
    }
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return null; }
}
async function libgenCacheSet(doi, payload) {
  try {
    await fs.mkdir(LIBGEN_CACHE_DIR, { recursive: true });
    const hash = crypto.createHash("md5").update(doi).digest("hex");
    await fs.writeFile(path.join(LIBGEN_CACHE_DIR, `${hash}.json`), JSON.stringify(payload), "utf8");
  } catch {}
}

/**
 * LibGen scimag DOI lookup → returns a direct PDF URL (or null).
 * Tries each LIBGEN_BASES mirror in turn. Caches result for 30 days.
 *
 * Strategy:
 *   1. POST/GET search: <base>/scimag/?q=<doi>
 *   2. Find the first <a href="ads.php?doi=..."> on the result page
 *   3. Follow the ads page; pick the first PDF mirror link
 */
async function fetchViaLibgen(doi) {
  if (!ENABLE_LIBGEN_FALLBACK || !doi) return null;
  if (_libgenBlockedForRun) {
    return null; // Already concluded LibGen is unreachable in this run; don't waste time.
  }
  const cached = await libgenCacheGet(doi);
  if (cached?.pdfUrl) {
    console.log(`[harvester] libgen-fallback cache HIT for doi=${doi} → ${cached.pdfUrl}`);
    return cached.pdfUrl;
  }
  if (cached?.miss) {
    // Negative cache — don't re-probe a known-miss DOI for 30 days
    return null;
  }

  for (const base of LIBGEN_BASES) {
    const start = Date.now();
    const host = safeHost(base);
    try {
      // Different libgen forks expose scimag at different URLs:
      //   libgen.li         → /ads.php?doi=<doi>          (direct article page)
      //   libgen.is/.rs/.bz → /scimag/?q=<doi>            (search → ads.php link)
      // libgen.li was confirmed working from Bezeq/IL (Oct 2026); .is/.rs are
      // ISP-blocked there. Different ISPs may flip the picture.
      let adsUrl;
      if (host === "libgen.li") {
        adsUrl = `${base}/ads.php?doi=${encodeURIComponent(doi)}`;
      } else {
        // .is / .rs flow: search scimag first, then follow ads.php link from results.
        const search = await axios.get(`${base}/scimag/`, {
          params: { q: doi },
          timeout: 12000,
          headers: BROWSER_HEADERS,
          maxRedirects: 4
        });
        const html = typeof search.data === "string" ? search.data : "";
        if (/Just a moment\.\.\./i.test(html) || /<title>Attention Required/i.test(html)) {
          console.log(`[harvester] libgen-fallback ${host} returned Cloudflare challenge — skipping`);
          continue;
        }
        const adsMatch = html.match(/href=["'](ads\.php\?doi=[^"'#]+)["']/i);
        if (!adsMatch) {
          console.log(`[harvester] libgen-fallback ${host}: no scimag entry for doi=${doi}`);
          continue;
        }
        adsUrl = `${base}/scimag/${adsMatch[1].replace(/^\//, "")}`;
      }

      const ads = await axios.get(adsUrl, {
        timeout: 12000,
        headers: BROWSER_HEADERS,
        maxRedirects: 4
      });
      const adsHtml = typeof ads.data === "string" ? ads.data : "";

      // Find a download URL. Three patterns we look for, in order:
      //   1. Relative get.php?md5=...&key=... (libgen.li) — resolve to absolute
      //   2. External https URL ending in .pdf
      //   3. Any external link to known mirrors (library.lol, booksdl.*, libgen.*)
      let pdfUrl = null;

      // Pattern 1: relative get.php (libgen.li uses this; redirects 307 → cdn?.booksdl.lc → real PDF)
      const getMatch = adsHtml.match(/href=["'](get\.php\?[^"'#]+)["']/i);
      if (getMatch) {
        pdfUrl = `${base}/${getMatch[1].replace(/^\//, "")}`;
      }

      // Pattern 2: explicit .pdf href
      if (!pdfUrl) {
        const pdfMatch = adsHtml.match(/href=["'](https?:\/\/[^"']+\.pdf[^"']*)["']/i);
        if (pdfMatch) pdfUrl = pdfMatch[1];
      }

      // Pattern 3: known mirror domains
      if (!pdfUrl) {
        const altMatch = adsHtml.match(/href=["'](https?:\/\/(?:library\.lol|cdn\d?\.booksdl\.(?:org|lc)|libgen\.[a-z]+)[^"']+)["']/i);
        if (altMatch) pdfUrl = altMatch[1];
      }

      if (!pdfUrl) {
        console.log(`[harvester] libgen-fallback ${host}: ads page has no PDF mirror for doi=${doi}`);
        continue;
      }

      const ms = Date.now() - start;
      console.log(`[harvester] libgen-fallback ✓ doi=${doi} → ${safeHost(pdfUrl) || host} (${ms}ms)`);
      await libgenCacheSet(doi, { pdfUrl, source: host, fetchedAt: new Date().toISOString() });
      _libgenConsecutiveFailures = 0; // success — reset breaker
      return pdfUrl;
    } catch (err) {
      const status = err?.response?.status;
      console.log(`[harvester] libgen-fallback ${host} failed (${status || err?.code || err?.message}) for doi=${doi}`);
      // try next mirror
    }
  }
  // All mirrors miss — negative-cache so we don't reprobe for 30 days
  await libgenCacheSet(doi, { miss: true, fetchedAt: new Date().toISOString() });
  console.log(`[harvester] libgen-fallback ✗ all mirrors miss for doi=${doi}`);
  // Soft circuit-breaker: if 3 DOIs in a row all miss every mirror, the network
  // can't reach LibGen at all (DNS block / Cloudflare). Stop trying for this run.
  _libgenConsecutiveFailures += 1;
  if (_libgenConsecutiveFailures >= LIBGEN_FAILURE_BREAK_THRESHOLD) {
    _libgenBlockedForRun = true;
    console.log(`[harvester] libgen-fallback DISABLED for this run — ${LIBGEN_FAILURE_BREAK_THRESHOLD} consecutive total-miss DOIs (mirrors unreachable from this network)`);
  }
  return null;
}


/**
 * Retry helper with exponential-with-jitter backoff.
 * Retries only on transient errors: connection reset/timeout/aborted, or HTTP 5xx.
 * 4xx errors fast-fail (no retry).
 *
 * Default: 3 attempts, baseDelay 2000ms → delays before retry are
 *   attempt 2: ~2s ± 0-500ms
 *   attempt 3: ~4s ± 0-500ms
 *   attempt 4: ~8s ± 0-500ms (only if attempts ≥ 4)
 *
 * @param {Function} fn        async function to retry
 * @param {number} attempts    total attempts (incl. first)
 * @param {number} baseDelayMs base delay multiplier
 * @param {object} [opts]      { label?: string }  // logged on retry/failure
 */
/**
 * Classify an axios error: transient (worth retrying) or permanent (give up).
 * Transient: connection-level errors + HTTP 5xx + 429 (rate limit).
 * Permanent: HTTP 4xx (except 429), schema/parse errors.
 */
function isTransientError(err) {
  if (!err) return false;
  if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ECONNABORTED" || err.code === "ENOTFOUND") return true;
  const status = err?.response?.status;
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;
  return false;
}

/**
 * Helper for fetcher catch blocks: rethrow if transient (so outer withRetry can retry),
 * otherwise log and return null (caller converts to empty-results array).
 */
function rethrowIfTransient(err, providerLabel, query) {
  const status = err?.response?.status;
  const code = err?.code;
  if (isTransientError(err)) {
    console.log(`[harvester] ${providerLabel} transient error (${status || code}) on "${query}" — will retry`);
    throw err;
  }
  console.log(`[harvester] ${providerLabel} permanent error (${status || code || err?.message}) on "${query}" — degrading without it`);
  return null;
}

async function withRetry(fn, attempts = 3, baseDelayMs = 2000, opts = {}) {
  const label = opts.label || "retry";
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const transient =
        e?.code === "ECONNRESET" ||
        e?.code === "ETIMEDOUT" ||
        e?.code === "ECONNABORTED" ||
        (typeof status === "number" && status >= 500);
      if (!transient || i === attempts - 1) break;
      const expDelay = baseDelayMs * Math.pow(2, i);
      const jitter = Math.floor(Math.random() * 500);
      const delay = expDelay + jitter;
      console.log(`[harvester] ${label} attempt ${i + 1}/${attempts} failed (${status || e?.code || "err"}); retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Decode common HTML entities + strip Academagic's "– אקדמג'יק" branding suffix.
 * Used by the Academagic scraper to clean title/abstract/citation strings before
 * they reach the citation index and the bibliography.
 */
function decodeAndCleanScrapedText(s) {
  if (!s || typeof s !== "string") return "";
  let out = s;
  // Common HTML entities (decimal + named) — covers the &#8211;/&#039;/&amp; patterns
  // we saw in saved markdown.
  const ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ",
    "&hellip;": "…", "&mdash;": "—", "&ndash;": "–", "&lsquo;": "‘", "&rsquo;": "’",
    "&ldquo;": "“", "&rdquo;": "”", "&laquo;": "«", "&raquo;": "»"
  };
  for (const [ent, repl] of Object.entries(ENTITIES)) {
    out = out.split(ent).join(repl);
  }
  // Numeric entities: &#NNNN; and &#xHHHH;
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
    const code = parseInt(n, 16);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
  // Strip the "– אקדמג'יק" branding suffix Academagic appends to every title.
  // Variants: " – אקדמג׳יק", "– אקדמג'יק", with the apostrophe in different forms.
  out = out.replace(/\s*[-–|]\s*אקדמ[גג'׳]?[יי]?[קק]\s*$/u, "");
  // Tidy whitespace
  return out.replace(/\s+/g, " ").trim();
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

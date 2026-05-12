// server/skills/deepResearch/altSourceFinder.js
// Phase 20F — alt-source pre-bridge fallback.
//
// Called from articleHarvester.js when the primary fetch + landing-html scrape
// both come up short for an article. Before declaring `_fetch_failed = true`,
// search a small set of OA-friendly mirrors by title:
//   - ResearchGate publication search → first hit's landing page
//   - academia.edu search → first hit's landing page
//   - PLOS ONE direct DOI (if DOI prefix 10.1371)
//   - Crossref → fetch `link` field with OA mirrors
//
// Each candidate URL is reached with axios + Mozilla UA, then handed to the
// landing-page scraper for actual extraction. Returns the first usable
// (≥1500 chars) result.
//
// Politeness: we never hit the same alt-source within 8s, and we cap total
// candidates per article at 3.
//
// Allowed dependencies (per CLAUDE.md): axios + node built-ins only.

import axios from "axios";
import { scrapeLandingPage } from "./landingPageScraper.js";

const BROWSER_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
});

// Per-host throttle: never hit the same alt source twice within 8s.
const HOST_COOLDOWN_MS = 8000;
const _lastHostHit = new Map();
function takeHostSlot(host) {
  const now = Date.now();
  const last = _lastHostHit.get(host) || 0;
  if (now - last < HOST_COOLDOWN_MS) return false;
  _lastHostHit.set(host, now);
  return true;
}

// Reset per-run state (called by deepResearch index at run start)
export function resetAltSourceState() {
  _lastHostHit.clear();
}

// ── Candidate generators ──────────────────────────────────────────────────

// PLOS direct DOI → article page (only works for 10.1371 prefix).
function plosCandidate({ doi }) {
  if (!doi) return null;
  if (!doi.startsWith("10.1371/")) return null;
  return {
    label: "plos",
    url: `https://journals.plos.org/plosone/article?id=${encodeURIComponent(doi)}`,
    host: "journals.plos.org",
  };
}

// ResearchGate publication search by title. The result page lists candidates
// with their own /publication/N links; we extract the first such link from
// the search-result HTML.
async function researchgateCandidate({ title }) {
  if (!title || title.length < 10) return null;
  const host = "www.researchgate.net";
  if (!takeHostSlot(host)) return null;
  try {
    const searchUrl = `https://${host}/search/publication?q=${encodeURIComponent(title.slice(0, 120))}`;
    const res = await axios.get(searchUrl, {
      timeout: 12000,
      maxRedirects: 5,
      headers: BROWSER_HEADERS,
      responseType: "text",
      transformResponse: [d => d],
      validateStatus: s => s >= 200 && s < 400,
    });
    const html = String(res.data || "");
    // Find the first publication link
    const m = html.match(/href="(\/publication\/[^"]+)"/);
    if (!m) return null;
    return {
      label: "researchgate",
      url: `https://${host}${m[1]}`,
      host,
    };
  } catch {
    return null;
  }
}

// academia.edu title search. Pattern is similar to researchgate.
async function academiaCandidate({ title }) {
  if (!title || title.length < 10) return null;
  const host = "www.academia.edu";
  if (!takeHostSlot(host)) return null;
  try {
    const searchUrl = `https://${host}/search?q=${encodeURIComponent(title.slice(0, 120))}`;
    const res = await axios.get(searchUrl, {
      timeout: 12000,
      maxRedirects: 5,
      headers: BROWSER_HEADERS,
      responseType: "text",
      transformResponse: [d => d],
      validateStatus: s => s >= 200 && s < 400,
    });
    const html = String(res.data || "");
    // academia.edu paper landing links look like /NNNN/Title_Of_Paper
    const m = html.match(/href="https:\/\/[^"]*academia\.edu\/(\d+)\/[^"]+"/);
    if (!m) return null;
    return {
      label: "academia",
      url: `https://${host}/${m[1]}`,
      host,
    };
  } catch {
    return null;
  }
}

// Crossref `link` field: many DOIs publish their OA copy directly via Crossref.
async function crossrefOaCandidate({ doi }) {
  if (!doi) return null;
  const host = "api.crossref.org";
  if (!takeHostSlot(host)) return null;
  try {
    const res = await axios.get(`https://${host}/works/${encodeURIComponent(doi)}`, {
      timeout: 10000,
      headers: { "Accept": "application/json" },
      validateStatus: s => s >= 200 && s < 400,
    });
    const links = res.data?.message?.link || [];
    // Prefer text-mining-friendly OA links
    const pref = links.find(l => /unspecified|application\/pdf/i.test(l["content-type"] || l["intended-application"] || ""));
    const pick = pref || links[0];
    if (!pick?.URL) return null;
    let pickHost;
    try { pickHost = new URL(pick.URL).hostname; } catch { return null; }
    return {
      label: "crossref-oa",
      url: pick.URL,
      host: pickHost,
    };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Try a small set of alt-source mirrors. Returns the first usable
 * (>= 1500c) extraction or null.
 *
 * @param {{ title: string, doi: string|null, originalUrl: string, topic: string }}
 * @returns {Promise<{ok: true, text: string, length: number, quality: string, sourceLabel: string, sourceUrl: string} | null>}
 */
export async function findAltSource({ title, doi, originalUrl, topic }) {
  const candidates = [];
  const plos = plosCandidate({ doi });
  if (plos) candidates.push(plos);
  const crossref = await crossrefOaCandidate({ doi });
  if (crossref && crossref.host !== safeHost(originalUrl)) candidates.push(crossref);
  const rg = await researchgateCandidate({ title });
  if (rg) candidates.push(rg);
  const ac = await academiaCandidate({ title });
  if (ac) candidates.push(ac);

  // Cap total candidates per article — protect runtime
  const tried = candidates.slice(0, 3);
  for (const c of tried) {
    try {
      const scraped = await scrapeLandingPage(c.url, { topic, title });
      if (scraped.ok && scraped.length >= 1500) {
        return {
          ok: true,
          text: scraped.text,
          length: scraped.length,
          quality: scraped.quality,
          fullText: scraped.fullText,
          sourceLabel: c.label,
          sourceUrl: c.url,
        };
      }
    } catch { /* try next */ }
  }
  return null;
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}

export const _internals = {
  plosCandidate,
  takeHostSlot,
  HOST_COOLDOWN_MS,
};

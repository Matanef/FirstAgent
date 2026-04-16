// server/skills/deepResearch/paperUpgrader.js
// Phase 2A — Given a harvested article, try to locate and fetch the underlying
// research paper (PDF or full-text HTML), returning upgraded content.
//
// Scan priority:
//   1. ArXiv ID in text/URL → direct open-access PDF
//   2. DOI in text → Unpaywall (free OA PDF lookup, no API key needed)
//   3. DOI → doi.org landing page (HTML fallback)
//   4. Direct .pdf href in article body
//
// Phase 2E: Large PDFs are chunked into overlapping segments that fit qwen2.5:7b's
// 4096-token context so the analyzer can process them piece-by-piece.
//
// ISOLATION: this module only imports Node built-ins + axios + obsidianUtils. No
// other deepResearch modules are imported.

import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import axios from "axios";
import { PROJECT_ROOT } from "../../utils/config.js";
import { extractPdfText } from "../../utils/obsidianUtils.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("paperUpgrader", { consoleLevel: "warn" });

const PDF_CACHE_DIR = path.resolve(PROJECT_ROOT, "data", "pdf-cache");

// ── Regex patterns ────────────────────────────────────────────────────────

// DOI pattern — matches 10.XXXX/... up to the next whitespace/quote/angle-bracket
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>\])\u0000-\u001F]{4,80})/g;

// ArXiv — matches arxiv.org/abs/XXXX or arxiv.org/pdf/XXXX in text or URLs
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/([\d]{4}\.\d{4,5}(?:v\d+)?)/gi;

// ScienceDaily journal reference block:
//   "Journal Reference: … DOI: 10.XXXX/..."
const SCIENCEDAILY_DOI_RE = /(?:doi|DOI)[:\s]+\s*(10\.\d{4,}\/[^\s<"']{4,80})/g;

// Bare .pdf links in article HTML/text
const PDF_LINK_RE = /https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?/gi;

// ── Chunk helper (Phase 2E) ───────────────────────────────────────────────

/**
 * Split large text into overlapping segments sized for qwen2.5:7b's context.
 * Each chunk is at most `maxChars` chars; consecutive chunks share `overlapChars`.
 *
 * Safe default: 3800 chars ≈ ~950 tokens, leaves ~3100 tokens for prompt + answer
 * inside a 4096-token num_ctx budget.
 *
 * @param {string} text
 * @param {number} [maxChars=3800]
 * @param {number} [overlapChars=400]
 * @returns {string[]}
 */
export function chunkText(text, maxChars = 3800, overlapChars = 400) {
  if (!text || text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxChars));
    start += maxChars - overlapChars;
  }
  return chunks;
}

// ── Network helpers ───────────────────────────────────────────────────────

async function ensureCacheDir() {
  await fs.mkdir(PDF_CACHE_DIR, { recursive: true });
}

function hashUrl(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 14);
}

const AX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; academic-research-bot/1.0)",
  "Accept": "*/*"
};

/** Download binary bytes (for PDFs). Returns Buffer or throws. */
async function downloadBinary(url, timeoutMs = 40000) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: timeoutMs,
    headers: { ...AX_HEADERS, Accept: "application/pdf,*/*" },
    maxRedirects: 6
  });
  return Buffer.from(res.data);
}

/** Download page as text (for HTML landing pages). Returns string or throws. */
async function downloadText(url, timeoutMs = 18000) {
  const res = await axios.get(url, {
    responseType: "text",
    timeout: timeoutMs,
    headers: { ...AX_HEADERS, Accept: "text/html,application/xhtml+xml,*/*" },
    maxRedirects: 6
  });
  return String(res.data || "");
}

/**
 * Fetch a PDF from `pdfUrl`, cache it under PDF_CACHE_DIR, extract text.
 * Returns extracted text or null.
 */
async function fetchPdfContent(pdfUrl) {
  try {
    await ensureCacheDir();
    const cacheFile = path.join(PDF_CACHE_DIR, `${hashUrl(pdfUrl)}.pdf`);

    // Cache hit?
    let usedCache = false;
    try { await fs.access(cacheFile); usedCache = true; } catch {}

    if (!usedCache) {
      log(`Downloading PDF: ${pdfUrl}`, "info");
      const buf = await downloadBinary(pdfUrl, 45000);
      if (buf.length < 500) { log(`PDF too small (${buf.length}b) — skipping`, "warn"); return null; }
      await fs.writeFile(cacheFile, buf);
    } else {
      log(`PDF cache hit: ${pdfUrl}`, "info");
    }

    const text = await extractPdfText(cacheFile);
    if (!text || text.startsWith("[PDF")) {
      log(`PDF extraction returned empty/error for ${pdfUrl}`, "warn");
      return null;
    }
    return text;
  } catch (err) {
    log(`fetchPdfContent failed (${pdfUrl}): ${err.message}`, "warn");
    return null;
  }
}

/**
 * Unpaywall free API — look up open-access PDF URL for a DOI.
 * No API key required; policy requires an email contact.
 * Returns PDF URL string or null.
 */
async function unpaywallLookup(doi) {
  const email = "research-lanou@local.agent";
  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
    const res = await axios.get(url, { timeout: 12000 });
    const data = res.data;
    // Best OA location has a direct PDF link?
    if (data?.best_oa_location?.url_for_pdf) return data.best_oa_location.url_for_pdf;
    // HTML landing page that might link to PDF?
    if (data?.best_oa_location?.url)         return data.best_oa_location.url;
    // Any oa_location with a PDF?
    for (const loc of data?.oa_locations || []) {
      if (loc.url_for_pdf) return loc.url_for_pdf;
    }
    return null;
  } catch (err) {
    log(`Unpaywall lookup failed for ${doi}: ${err.message}`, "warn");
    return null;
  }
}

/** Minimal HTML→text (no cheerio). Strips tags, decodes basic entities. */
function stripBasicHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Attempt to upgrade a harvested article to its underlying research paper.
 *
 * Tries in order: arXiv → DOI+Unpaywall → DOI landing page → bare .pdf link.
 * Returns null if nothing useful was found (caller keeps original content).
 *
 * @param {object} article   { url, title, content, domain, source }
 * @returns {Promise<{content:string, pdfUrl:string, doi:string|null, source:"pdf"|"html"}|null>}
 */
export async function upgradeArticle(article) {
  const text = String(article.content || "");
  const articleUrl = String(article.url || "");

  // ── 1. ArXiv ID (always open-access) ─────────────────────────────────
  ARXIV_RE.lastIndex = 0;
  const arxivInText = ARXIV_RE.exec(text);
  ARXIV_RE.lastIndex = 0;
  const arxivInUrl  = ARXIV_RE.exec(articleUrl);
  const arxivMatch  = arxivInText || arxivInUrl;
  if (arxivMatch) {
    const id = arxivMatch[1];
    const pdfUrl = `https://arxiv.org/pdf/${id}.pdf`;
    log(`ArXiv hit ${id} in article "${article.title?.slice(0,60)}"`, "info");
    const pdfContent = await fetchPdfContent(pdfUrl);
    if (pdfContent) return { content: pdfContent, pdfUrl, doi: null, source: "pdf" };
  }

  // ── 2. DOI extraction ─────────────────────────────────────────────────
  // ScienceDaily has its own DOI pattern in the "Journal Reference" block
  SCIENCEDAILY_DOI_RE.lastIndex = 0;
  const sdMatch = SCIENCEDAILY_DOI_RE.exec(text);
  DOI_RE.lastIndex = 0;
  const doiMatch = sdMatch || DOI_RE.exec(text);

  if (doiMatch) {
    const rawDoi = doiMatch[1].replace(/[.,;)\]]+$/, ""); // strip trailing punctuation
    log(`DOI found: ${rawDoi}`, "info");

    // 2a. Unpaywall
    const oaUrl = await unpaywallLookup(rawDoi);
    if (oaUrl) {
      const looksLikePdf = /\.pdf(\?|$)/i.test(oaUrl) || /\/pdf\//i.test(oaUrl);
      if (looksLikePdf) {
        const pdfContent = await fetchPdfContent(oaUrl);
        if (pdfContent) return { content: pdfContent, pdfUrl: oaUrl, doi: rawDoi, source: "pdf" };
      } else {
        // HTML OA landing page
        try {
          const html = await downloadText(oaUrl, 20000);
          const stripped = stripBasicHtml(html);
          if (stripped.length > 600) {
            return { content: stripped, pdfUrl: oaUrl, doi: rawDoi, source: "html" };
          }
        } catch {}
      }
    }

    // 2b. doi.org redirect → HTML landing page fallback
    try {
      const doiUrl = `https://doi.org/${rawDoi}`;
      const html = await downloadText(doiUrl, 15000);
      const stripped = stripBasicHtml(html);
      if (stripped.length > 600) {
        return { content: stripped, pdfUrl: doiUrl, doi: rawDoi, source: "html" };
      }
    } catch (err) {
      log(`doi.org fallback failed for ${rawDoi}: ${err.message}`, "warn");
    }
  }

  // ── 3. Bare .pdf link in article body ─────────────────────────────────
  PDF_LINK_RE.lastIndex = 0;
  const pdfLinkMatch = PDF_LINK_RE.exec(text);
  if (pdfLinkMatch) {
    const pdfUrl = pdfLinkMatch[0];
    log(`Direct PDF link in article: ${pdfUrl}`, "info");
    const pdfContent = await fetchPdfContent(pdfUrl);
    if (pdfContent) return { content: pdfContent, pdfUrl, doi: null, source: "pdf" };
  }

  return null; // No upgrade found
}

// server/skills/deepResearch/datasetHarvester.js
// Phase 7A — Empirical-methodology dataset harvester.
//
// Mirrors articleHarvester's architecture: provider fan-out, retry-on-network-error,
// 24h cache, normalized record shape. But where articles return prose for LLM
// summarization, datasets return structured row data + schema for tableAnalyst
// to compute its own statistics.
//
// Returns a normalized Dataset record:
//   { id, title, doi, repository, authors, year, description,
//     files: [{ name, url, format, sizeBytes, downloadUrl }],
//     topicMatch, cite, metadataOnly }
//
// Providers (12, ordered by topic class):
//   figshare, openalexDatasets, dryad, dataverse, osf, datagov, zenodo,
//   icpsr (metadata-only), hdx, worldbank, oecd, fred (key required), whoGho

import axios from "axios";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { CONFIG, PROJECT_ROOT } from "../../utils/config.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("datasetHarvester", { consoleLevel: "warn" });

const CACHE_DIR = path.resolve(PROJECT_ROOT, "data", "research-cache", "datasets");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_SIZE_LIMIT_FULL = 25 * 1024 * 1024;   // ≤25MB → read all rows
const STRATIFIED_SLABS = 5;
const STRATIFIED_ROWS_PER_SLAB = 2000;           // 5 × 2000 = 10K rows max for huge files
const ALLOWED_FORMATS = new Set(["csv", "tsv", "json", "xlsx", "xls"]);
const SKIP_FORMATS = new Set(["dta", "sav", "por", "rds", "rdata", "parquet", "h5", "hdf5", "nc"]);

const POLITE_EMAIL = CONFIG.UNPAYWALL_EMAIL || CONFIG.OPENALEX_MAILTO || process.env.UNPAYWALL_EMAIL || "";
const ZENODO_UA = `deepResearch/1.0 (mailto:${POLITE_EMAIL || "research@local"})`;

const BROWSER_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive"
});

// ── topic classifier ────────────────────────────────────────────────────────
// Coarse classification → drives provider ordering. NOT exclusive: every class
// still gets the always-on providers (figshare, openalex, dryad).
const TOPIC_CLASSES = {
  finance: /\b(market\w*|stock\w*|econom\w*|finance|financial|gdp|inflation\w*|monetary|fiscal|recession|equit\w*|portfolio\w*|bond\w*|currenc\w*|trade|tariff\w*|unemploy\w*|cpi|interest\s*rate|federal\s*reserve|central\s*bank)\b/i,
  health:  /\b(disease\w*|drug\w*|clinical|vaccine\w*|cancer\w*|diabetes|cardiovascular|epidemiolog\w*|public\s*health|mortalit\w*|morbidit\w*|patient\w*|treatment\w*|therap\w*|hospital\w*)\b/i,
  psych:   /\b(psycholog\w*|behavior\w*|cognit\w*|mental\s*health|psychiatr\w*|neurosci\w*|emotion\w*|personalit\w*|anxiety|depression|trauma|ptsd|adhd|autism|cbt)\b/i,
  gov:     /\b(census|policy|polic\w*|government|election\w*|voter\w*|crime|education|housing|welfare|tax\w*|regulation\w*|public\s*service)\b/i,
  engineering: /\b(engineer\w*|materials?|fatigue|structural|aerospace|robotic\w*|control\s*systems|fluid\s*dynamics|thermal|manufactur\w*|circuit\w*|signal\s*processing)\b/i,
  climate: /\b(climate|emission\w*|temperature\w*|warming|carbon|biodiversit\w*|ecosystem\w*|pollution|renewable|sustainab\w*)\b/i,
};

function classifyTopic(topic) {
  const lower = (topic || "").toLowerCase();
  const classes = [];
  for (const [name, re] of Object.entries(TOPIC_CLASSES)) {
    if (re.test(lower)) classes.push(name);
  }
  return classes;
}

// ── cache helpers ───────────────────────────────────────────────────────────
async function ensureCacheDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
}
function cacheKey(provider, query) {
  return crypto.createHash("sha1").update(`${provider}::${query}`).digest("hex").slice(0, 16);
}
async function readCache(key) {
  try {
    const p = path.join(CACHE_DIR, `${key}.json`);
    const stat = await fs.stat(p);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}
async function writeCache(key, data) {
  try {
    await ensureCacheDir();
    await fs.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(data), "utf8");
  } catch (err) { log(`cache write fail: ${err.message}`, "warn"); }
}

async function withRetry(fn, attempts = 2, delayMs = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const transient = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(err.message || "");
      if (!transient || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function normalizeFormat(s) {
  if (!s) return "";
  const m = String(s).toLowerCase().match(/(csv|tsv|json|xlsx|xls|dta|sav|por|rds|rdata|parquet|h5|hdf5|nc|txt|zip|pdf)/);
  return m ? m[1] : String(s).toLowerCase();
}

function safeAxios(url, opts = {}) {
  return axios.get(url, {
    timeout: 25000,
    headers: { ...BROWSER_HEADERS, ...(opts.headers || {}) },
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400,
    ...opts
  });
}

// ── PROVIDER: figshare ──────────────────────────────────────────────────────
// item_type=3 filters to datasets only.
async function fetchFigshare(query, limit) {
  const url = `https://api.figshare.com/v2/articles/search`;
  // Phase 10G — figshare returns 400 with `order: "relevance"` (their recent
  // API change: `order` requires a paired `order_direction` and "relevance"
  // is no longer accepted as a value). Drop the `order` field and let
  // figshare default-sort. UA goes through "User-Agent" not the polite-pool
  // mailto-marked one, since they reject malformed `mailto:` strings.
  const body = { search_for: query, page_size: limit, item_type: 3 };
  console.log(`[datasetHarvester] figshare: querying "${query}" (limit ${limit})`);
  const res = await axios.post(url, body, {
    timeout: 20000,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; deepResearch/1.0)"
    },
    validateStatus: s => s >= 200 && s < 500
  });
  if (res.status >= 400) {
    log(`figshare returned ${res.status} — body: ${JSON.stringify(res.data || "").slice(0, 200)}`, "warn");
    return [];
  }
  const items = Array.isArray(res.data) ? res.data : [];
  const out = [];
  for (const item of items.slice(0, limit)) {
    let files = [];
    // Fetch detail for files list (figshare search doesn't include files)
    try {
      const detailRes = await safeAxios(`https://api.figshare.com/v2/articles/${item.id}`);
      const detailFiles = detailRes.data?.files || [];
      files = detailFiles.map(f => ({
        name: f.name,
        url: f.download_url,
        downloadUrl: f.download_url,
        format: normalizeFormat(f.name?.split(".").pop()),
        sizeBytes: f.size || 0
      })).filter(f => ALLOWED_FORMATS.has(f.format));
    } catch (err) {
      log(`figshare detail ${item.id}: ${err.message}`, "warn");
    }
    if (files.length === 0) continue;
    out.push(buildRecord({
      id: `figshare:${item.id}`,
      title: item.title?.replace(/<[^>]+>/g, "") || "(untitled)",
      doi: item.doi || "",
      repository: "figshare",
      authors: (item.authors || []).map(a => a.full_name || a.name).filter(Boolean),
      year: item.published_date ? new Date(item.published_date).getFullYear() : null,
      description: item.description?.replace(/<[^>]+>/g, "").slice(0, 600) || "",
      files,
      url: item.url_public_html || `https://figshare.com/articles/${item.id}`
    }));
  }
  console.log(`[datasetHarvester] figshare: got ${out.length} datasets with usable files`);
  return out;
}

// Phase 9C — catalog cruft that OpenAlex labels as type:dataset but isn't
// actually a dataset (Faculty Opinions records, R package metadata, search
// strategies, supplementary tables, etc.). Drop these — they pollute the
// metadata-only list and crowd out real findings.
const OPENALEX_CRUFT_TITLE_PATTERNS = [
  /^Faculty Opinions recommendation/i,
  /^Search Strategy/i,
  /^Excluded Studies/i,
  /^Qualitative synthesis of results/i,
  /^Supplementary (Material|Table|Data|File)/i,
  /^metadat:\s*Meta-Analysis/i,                       // R package
  /^HSAUR:/i,                                          // R package
  /\bcran\.package\b/i,                                // CRAN package metadata
  /^Variations in Teachers'/i,                         // teacher-training records that hit on the keyword "behavioral" but are off-topic
];
function isOpenAlexCruft(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  for (const re of OPENALEX_CRUFT_TITLE_PATTERNS) if (re.test(t)) return true;
  return false;
}

// ── PROVIDER: OpenAlex (datasets filter) ────────────────────────────────────
async function fetchOpenAlexDatasets(query, limit) {
  const mailto = POLITE_EMAIL ? `&mailto=${encodeURIComponent(POLITE_EMAIL)}` : "";
  // Phase 9C — pull more than `limit` so we have headroom to filter cruft.
  const fetchSize = Math.min(limit * 3, 25);
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=type:dataset&per_page=${fetchSize}${mailto}`;
  console.log(`[datasetHarvester] openalex: querying "${query}" (fetching ${fetchSize}, capping at ${limit})`);
  const res = await safeAxios(url);
  const items = res.data?.results || [];
  const out = [];
  let crufted = 0;
  for (const w of items) {
    if (out.length >= limit) break;
    const title = w.display_name || w.title || "";
    if (isOpenAlexCruft(title)) { crufted++; continue; }
    // OpenAlex doesn't surface file URLs directly — record as metadataOnly + DOI link.
    const doi = (w.doi || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
    out.push(buildRecord({
      id: `openalex:${w.id?.split("/").pop()}`,
      title,
      doi,
      repository: "openalex",
      authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean).slice(0, 5),
      year: w.publication_year,
      description: (w.abstract_inverted_index ? reconstructAbstract(w.abstract_inverted_index) : "").slice(0, 600),
      files: [],
      url: doi ? `https://doi.org/${doi}` : (w.id || ""),
      metadataOnly: true
    }));
  }
  console.log(`[datasetHarvester] openalex: got ${out.length} dataset records (metadata-only)${crufted > 0 ? `, dropped ${crufted} catalog-cruft entries` : ""}`);
  return out;
}
function reconstructAbstract(inv) {
  if (!inv || typeof inv !== "object") return "";
  const positions = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) positions.push([i, word]);
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(p => p[1]).join(" ");
}

// ── PROVIDER: Dryad ─────────────────────────────────────────────────────────
async function fetchDryad(query, limit) {
  const url = `https://datadryad.org/api/v2/search?q=${encodeURIComponent(query)}&per_page=${limit}`;
  console.log(`[datasetHarvester] dryad: querying "${query}" (limit ${limit})`);
  const res = await safeAxios(url);
  const items = res.data?._embedded?.["stash:datasets"] || [];
  const out = [];
  for (const ds of items.slice(0, limit)) {
    const versionsHref = ds._links?.["stash:versions"]?.href;
    let files = [];
    try {
      if (versionsHref) {
        const vRes = await safeAxios(`https://datadryad.org${versionsHref}`);
        const versions = vRes.data?._embedded?.["stash:versions"] || [];
        const latest = versions[versions.length - 1];
        const filesHref = latest?._links?.["stash:files"]?.href;
        if (filesHref) {
          const fRes = await safeAxios(`https://datadryad.org${filesHref}`);
          const dryadFiles = fRes.data?._embedded?.["stash:files"] || [];
          files = dryadFiles.map(f => {
            const dl = f._links?.["stash:download"]?.href;
            return {
              name: f.path,
              url: dl ? `https://datadryad.org${dl}` : "",
              downloadUrl: dl ? `https://datadryad.org${dl}` : "",
              format: normalizeFormat(f.path?.split(".").pop()),
              sizeBytes: f.size || 0
            };
          }).filter(f => ALLOWED_FORMATS.has(f.format) && f.downloadUrl);
        }
      }
    } catch (err) { log(`dryad files: ${err.message}`, "warn"); }
    if (files.length === 0) continue;
    const doi = (ds.identifier || "").replace(/^doi:/, "");
    out.push(buildRecord({
      id: `dryad:${doi}`,
      title: ds.title || "(untitled)",
      doi,
      repository: "dryad",
      authors: (ds.authors || []).map(a => `${a.firstName || ""} ${a.lastName || ""}`.trim()).filter(Boolean),
      year: ds.publicationDate ? new Date(ds.publicationDate).getFullYear() : null,
      description: ds.abstract?.slice(0, 600) || "",
      files,
      url: doi ? `https://doi.org/${doi}` : ""
    }));
  }
  console.log(`[datasetHarvester] dryad: got ${out.length} datasets with usable files`);
  return out;
}

// ── PROVIDER: Harvard Dataverse ─────────────────────────────────────────────
async function fetchDataverse(query, limit) {
  const url = `https://dataverse.harvard.edu/api/search?q=${encodeURIComponent(query)}&type=dataset&per_page=${limit}`;
  console.log(`[datasetHarvester] dataverse: querying "${query}" (limit ${limit})`);
  const res = await safeAxios(url);
  const items = res.data?.data?.items || [];
  const out = [];
  for (const it of items.slice(0, limit)) {
    let files = [];
    try {
      const dsId = it.global_id || it.identifier;
      if (dsId) {
        const fRes = await safeAxios(
          `https://dataverse.harvard.edu/api/datasets/:persistentId/versions/:latest?persistentId=${encodeURIComponent(dsId)}`
        );
        const dvFiles = fRes.data?.data?.files || [];
        files = dvFiles.map(f => {
          const fid = f.dataFile?.id;
          const fname = f.label || f.dataFile?.filename || "";
          const fmt = f.dataFile?.contentType?.split("/").pop() || normalizeFormat(fname.split(".").pop());
          return {
            name: fname,
            url: fid ? `https://dataverse.harvard.edu/api/access/datafile/${fid}` : "",
            downloadUrl: fid ? `https://dataverse.harvard.edu/api/access/datafile/${fid}` : "",
            format: normalizeFormat(fmt),
            sizeBytes: f.dataFile?.filesize || 0
          };
        }).filter(f => ALLOWED_FORMATS.has(f.format) && f.downloadUrl);
      }
    } catch (err) { log(`dataverse files: ${err.message}`, "warn"); }
    if (files.length === 0) continue;
    out.push(buildRecord({
      id: `dataverse:${it.global_id || it.identifier || it.entity_id}`,
      title: it.name || "(untitled)",
      doi: (it.global_id || "").replace(/^doi:/, ""),
      repository: "dataverse",
      authors: it.authors || [],
      year: it.published_at ? new Date(it.published_at).getFullYear() : null,
      description: (it.description || "").slice(0, 600),
      files,
      url: it.url || ""
    }));
  }
  console.log(`[datasetHarvester] dataverse: got ${out.length} datasets with usable files`);
  return out;
}

// ── PROVIDER: OSF API ───────────────────────────────────────────────────────
async function fetchOsfData(query, limit) {
  // OSF's search API: filter[category]=data narrows to dataset projects.
  const url = `https://api.osf.io/v2/nodes/?filter[category]=data&filter[tags]=${encodeURIComponent(query)}&page[size]=${limit}`;
  console.log(`[datasetHarvester] osf: querying "${query}" (limit ${limit})`);
  let items = [];
  try {
    const res = await safeAxios(url);
    items = res.data?.data || [];
  } catch (err) {
    // Fallback: try a free-text search if tag filter is too narrow
    try {
      const altUrl = `https://api.osf.io/v2/search/?q=${encodeURIComponent(query)}&page[size]=${limit}`;
      const altRes = await safeAxios(altUrl);
      items = (altRes.data?.data || []).filter(d => d.attributes?.category === "data");
    } catch { /* swallow */ }
  }
  const out = [];
  for (const node of items.slice(0, limit)) {
    const a = node.attributes || {};
    out.push(buildRecord({
      id: `osf:${node.id}`,
      title: a.title || "(untitled)",
      doi: "",
      repository: "osf",
      authors: [],     // OSF requires extra contributor fetch; skip for v1
      year: a.date_created ? new Date(a.date_created).getFullYear() : null,
      description: (a.description || "").slice(0, 600),
      files: [],       // file fetch on OSF is heavy (per-storage); v1 = metadataOnly
      url: node.links?.html || `https://osf.io/${node.id}`,
      metadataOnly: true
    }));
  }
  console.log(`[datasetHarvester] osf: got ${out.length} dataset records (metadata-only)`);
  return out;
}

// ── PROVIDER: Data.gov (CKAN) ───────────────────────────────────────────────
async function fetchDataGov(query, limit) {
  const url = `https://catalog.data.gov/api/3/action/package_search?q=${encodeURIComponent(query)}&fq=res_format:CSV&rows=${limit}`;
  console.log(`[datasetHarvester] datagov: querying "${query}" (limit ${limit})`);
  // Phase 10G — data.gov 404s constantly without authentication.
  // DATAGOV_API_KEY (from api.data.gov free tier) lifts the rate limit and
  // unblocks the catalog endpoint. Sent via X-Api-Key header per data.gov docs.
  const apiKey = CONFIG.DATAGOV_API_KEY || process.env.DATAGOV_API_KEY;
  const headers = { ...BROWSER_HEADERS };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  let res;
  try {
    res = await axios.get(url, {
      timeout: 20000, headers, maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 500
    });
  } catch (err) {
    log(`datagov network error: ${err.message}`, "warn");
    return [];
  }
  if (res.status >= 400) {
    // 404/403 → endpoint or rate-limit issue. Skip silently this round.
    if (!apiKey) log(`datagov ${res.status} — set DATAGOV_API_KEY in server/.env to unlock (free at api.data.gov)`, "warn");
    return [];
  }
  const items = res.data?.result?.results || [];
  const out = [];
  for (const it of items.slice(0, limit)) {
    const resources = it.resources || [];
    const files = resources.map(r => ({
      name: r.name || r.url?.split("/").pop() || "",
      url: r.url,
      downloadUrl: r.url,
      format: normalizeFormat(r.format),
      sizeBytes: parseInt(r.size, 10) || 0
    })).filter(f => ALLOWED_FORMATS.has(f.format) && f.downloadUrl);
    if (files.length === 0) continue;
    out.push(buildRecord({
      id: `datagov:${it.id || it.name}`,
      title: it.title || "(untitled)",
      doi: "",
      repository: "datagov",
      authors: [it.organization?.title].filter(Boolean),
      year: it.metadata_modified ? new Date(it.metadata_modified).getFullYear() : null,
      description: (it.notes || "").slice(0, 600),
      files,
      url: `https://catalog.data.gov/dataset/${it.name}`
    }));
  }
  console.log(`[datasetHarvester] datagov: got ${out.length} datasets with CSV resources`);
  return out;
}

// ── PROVIDER: Zenodo ────────────────────────────────────────────────────────
async function fetchZenodo(query, limit) {
  const url = `https://zenodo.org/api/records?q=${encodeURIComponent(query)}&size=${limit}&type=dataset`;
  console.log(`[datasetHarvester] zenodo: querying "${query}" (limit ${limit})`);
  // Zenodo 403s on generic UA — must use polite UA with contact email.
  const res = await axios.get(url, {
    timeout: 20000,
    headers: { "User-Agent": ZENODO_UA, "Accept": "application/json" },
    validateStatus: s => s >= 200 && s < 500
  });
  if (res.status === 403) {
    console.log(`[datasetHarvester] zenodo: 403 (UA "${ZENODO_UA}" rejected — set UNPAYWALL_EMAIL with valid contact)`);
    return [];
  }
  const hits = res.data?.hits?.hits || [];
  const out = [];
  for (const h of hits.slice(0, limit)) {
    const md = h.metadata || {};
    const files = (h.files || []).map(f => ({
      name: f.key,
      url: f.links?.self || "",
      downloadUrl: f.links?.self || "",
      format: normalizeFormat((f.key || "").split(".").pop()),
      sizeBytes: f.size || 0
    })).filter(f => ALLOWED_FORMATS.has(f.format) && f.downloadUrl);
    if (files.length === 0) continue;
    out.push(buildRecord({
      id: `zenodo:${h.id}`,
      title: md.title || "(untitled)",
      doi: md.doi || "",
      repository: "zenodo",
      authors: (md.creators || []).map(c => c.name).filter(Boolean),
      year: md.publication_date ? new Date(md.publication_date).getFullYear() : null,
      description: (md.description || "").replace(/<[^>]+>/g, "").slice(0, 600),
      files,
      url: h.links?.html || ""
    }));
  }
  console.log(`[datasetHarvester] zenodo: got ${out.length} datasets with usable files`);
  return out;
}

// ── PROVIDER: ICPSR (metadata-only) ─────────────────────────────────────────
// ICPSR has no public JSON API; we scrape the search results page for metadata.
// All ICPSR records flagged metadataOnly:true — the agent cites methodology
// without pulling rows (rows require institutional login).
async function fetchIcpsr(query, limit) {
  const url = `https://www.icpsr.umich.edu/web/ICPSR/search/studies?start=0&sort=score%20desc&ARCHIVE=ICPSR&PUBLISH_STATUS=PUBLISHED&q=${encodeURIComponent(query)}&rows=${limit}`;
  console.log(`[datasetHarvester] icpsr: querying "${query}" (limit ${limit})`);
  let html;
  try {
    const res = await safeAxios(url);
    html = res.data;
  } catch (err) {
    log(`icpsr fetch: ${err.message}`, "warn");
    return [];
  }
  // Lightweight scrape: ICPSR study cards have titles in <h3 class="title"> wrapping <a> with study URL.
  // Pull (title, url) pairs; skip if regex fails.
  const out = [];
  const re = /<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const studyUrl = m[1].startsWith("http") ? m[1] : `https://www.icpsr.umich.edu${m[1]}`;
    const title = m[2].trim().replace(/\s+/g, " ");
    out.push(buildRecord({
      id: `icpsr:${studyUrl.split("/").pop()}`,
      title,
      doi: "",
      repository: "icpsr",
      authors: [],
      year: null,
      description: "",  // study-page scrape would inflate cost; skip in v1
      files: [],
      url: studyUrl,
      metadataOnly: true
    }));
  }
  console.log(`[datasetHarvester] icpsr: got ${out.length} study records (metadata-only)`);
  return out;
}

// ── PROVIDER: HDX (Humanitarian Data Exchange — CKAN) ───────────────────────
async function fetchHdx(query, limit) {
  const url = `https://data.humdata.org/api/3/action/package_search?q=${encodeURIComponent(query)}&rows=${limit}`;
  console.log(`[datasetHarvester] hdx: querying "${query}" (limit ${limit})`);
  const res = await safeAxios(url);
  const items = res.data?.result?.results || [];
  const out = [];
  for (const it of items.slice(0, limit)) {
    const files = (it.resources || []).map(r => ({
      name: r.name || "",
      url: r.url,
      downloadUrl: r.url,
      format: normalizeFormat(r.format),
      sizeBytes: parseInt(r.size, 10) || 0
    })).filter(f => ALLOWED_FORMATS.has(f.format) && f.downloadUrl);
    if (files.length === 0) continue;
    out.push(buildRecord({
      id: `hdx:${it.id || it.name}`,
      title: it.title || "(untitled)",
      doi: "",
      repository: "hdx",
      authors: [it.organization?.title].filter(Boolean),
      year: it.metadata_modified ? new Date(it.metadata_modified).getFullYear() : null,
      description: (it.notes || "").slice(0, 600),
      files,
      url: `https://data.humdata.org/dataset/${it.name}`
    }));
  }
  console.log(`[datasetHarvester] hdx: got ${out.length} datasets with usable files`);
  return out;
}

// ── PROVIDER: World Bank Open Data ──────────────────────────────────────────
// Indicator-search API. Returns indicator metadata + per-country time series
// downloadable as JSON. We treat each indicator hit as a "dataset" whose file
// is the JSON endpoint URL.
async function fetchWorldBank(query, limit) {
  const url = `https://api.worldbank.org/v2/sources/2/indicators?per_page=${limit * 3}&format=json`;
  // No proper search param — pull a page and filter by name match.
  console.log(`[datasetHarvester] worldbank: querying "${query}" (filtered scan)`);
  let items = [];
  try {
    const res = await safeAxios(url);
    items = (Array.isArray(res.data) && res.data[1]) || [];
  } catch (err) {
    log(`worldbank fetch: ${err.message}`, "warn");
    return [];
  }
  const q = query.toLowerCase();
  const matches = items.filter(it => (it.name || "").toLowerCase().includes(q.split(" ")[0]));
  const out = [];
  for (const it of matches.slice(0, limit)) {
    const dataUrl = `https://api.worldbank.org/v2/country/all/indicator/${it.id}?format=json&per_page=20000`;
    out.push(buildRecord({
      id: `worldbank:${it.id}`,
      title: `${it.name} — World Bank indicator ${it.id}`,
      doi: "",
      repository: "worldbank",
      authors: [it.sourceOrganization || "World Bank"],
      year: new Date().getFullYear(),
      description: (it.sourceNote || "").slice(0, 600),
      files: [{
        name: `${it.id}.json`,
        url: dataUrl,
        downloadUrl: dataUrl,
        format: "json",
        sizeBytes: 0
      }],
      url: `https://data.worldbank.org/indicator/${it.id}`
    }));
  }
  console.log(`[datasetHarvester] worldbank: got ${out.length} indicators matching "${q.split(" ")[0]}"`);
  return out;
}

// ── PROVIDER: OECD SDMX ─────────────────────────────────────────────────────
// OECD's API requires knowing the dataset code. We use the dataflow endpoint
// to find dataflows whose name matches the query, then return CSV download URLs.
async function fetchOecd(query, limit) {
  const url = `https://stats.oecd.org/restsdmx/sdmx.ashx/GetDataStructure/ALL`;
  console.log(`[datasetHarvester] oecd: querying "${query}" (dataflow scan)`);
  // OECD's dataflow scan is heavy; v1 returns empty if the topic doesn't have
  // a clear OECD dataflow. We rely on the topic classifier to only invoke OECD
  // for finance/gov topics.
  // For the MVP, expose two well-known dataflows when finance/gov topics fire:
  //   - SNA_TABLE1 (national accounts), MEI (main economic indicators)
  // and let the agent decide relevance via tableAnalyst.
  const knownDataflows = [
    { id: "MEI", name: "Main Economic Indicators" },
    { id: "SNA_TABLE1", name: "National Accounts" },
    { id: "PRICES_CPI", name: "Consumer Price Indices" }
  ];
  const q = query.toLowerCase();
  const matches = knownDataflows.filter(d => d.name.toLowerCase().split(" ").some(w => q.includes(w)));
  const out = [];
  for (const df of matches.slice(0, limit)) {
    const csvUrl = `https://stats.oecd.org/sdmx-json/data/${df.id}/all/all?dimensionAtObservation=allDimensions`;
    out.push(buildRecord({
      id: `oecd:${df.id}`,
      title: `OECD ${df.name} (${df.id})`,
      doi: "",
      repository: "oecd",
      authors: ["OECD"],
      year: new Date().getFullYear(),
      description: `OECD ${df.name} dataflow.`,
      files: [{ name: `${df.id}.json`, url: csvUrl, downloadUrl: csvUrl, format: "json", sizeBytes: 0 }],
      url: `https://data.oecd.org/${df.id}.htm`
    }));
  }
  console.log(`[datasetHarvester] oecd: got ${out.length} dataflows`);
  return out;
}

// ── PROVIDER: FRED (key required) ───────────────────────────────────────────
async function fetchFred(query, limit) {
  const apiKey = CONFIG.FRED_API_KEY || process.env.FRED_API_KEY;
  if (!apiKey) return [];
  const url = `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(query)}&limit=${limit}&api_key=${apiKey}&file_type=json`;
  console.log(`[datasetHarvester] fred: querying "${query}" (limit ${limit})`);
  let items = [];
  try {
    const res = await safeAxios(url);
    items = res.data?.seriess || [];
  } catch (err) {
    log(`fred fetch: ${err.message}`, "warn");
    return [];
  }
  const out = [];
  for (const s of items.slice(0, limit)) {
    const obsUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&api_key=${apiKey}&file_type=json`;
    out.push(buildRecord({
      id: `fred:${s.id}`,
      title: s.title || s.id,
      doi: "",
      repository: "fred",
      authors: ["Federal Reserve Bank of St. Louis"],
      year: s.last_updated ? new Date(s.last_updated).getFullYear() : null,
      description: (s.notes || "").slice(0, 600),
      files: [{
        name: `${s.id}.json`,
        url: obsUrl,
        downloadUrl: obsUrl,
        format: "json",
        sizeBytes: 0
      }],
      url: `https://fred.stlouisfed.org/series/${s.id}`
    }));
  }
  console.log(`[datasetHarvester] fred: got ${out.length} series`);
  return out;
}

// ── PROVIDER: WHO Global Health Observatory ─────────────────────────────────
async function fetchWhoGho(query, limit) {
  const url = `https://ghoapi.azureedge.net/api/Indicator?$top=${limit * 3}`;
  console.log(`[datasetHarvester] whoGho: scanning indicators for "${query}"`);
  let items = [];
  try {
    const res = await safeAxios(url);
    items = res.data?.value || [];
  } catch (err) {
    log(`whoGho fetch: ${err.message}`, "warn");
    return [];
  }
  const q = query.toLowerCase();
  const matches = items.filter(it => (it.IndicatorName || "").toLowerCase().includes(q.split(" ")[0]));
  const out = [];
  for (const it of matches.slice(0, limit)) {
    const dataUrl = `https://ghoapi.azureedge.net/api/${it.IndicatorCode}`;
    out.push(buildRecord({
      id: `who:${it.IndicatorCode}`,
      title: it.IndicatorName,
      doi: "",
      repository: "whoGho",
      authors: ["World Health Organization"],
      year: new Date().getFullYear(),
      description: it.IndicatorName,
      files: [{ name: `${it.IndicatorCode}.json`, url: dataUrl, downloadUrl: dataUrl, format: "json", sizeBytes: 0 }],
      url: `https://www.who.int/data/gho/data/indicators/indicator-details/GHO/${it.IndicatorCode}`
    }));
  }
  console.log(`[datasetHarvester] whoGho: got ${out.length} indicators`);
  return out;
}

// ── record + file helpers ───────────────────────────────────────────────────
function buildRecord({ id, title, doi, repository, authors, year, description, files, url, metadataOnly = false }) {
  return {
    id,
    title: (title || "").replace(/\s+/g, " ").trim(),
    doi: doi || "",
    repository,
    authors: Array.isArray(authors) ? authors.filter(Boolean) : [],
    year: year || null,
    description: description || "",
    files: Array.isArray(files) ? files : [],
    url: url || "",
    metadataOnly: !!metadataOnly,
    topicMatch: null,             // filled in by tableAnalyst
    cite: {
      authors: Array.isArray(authors) ? authors.filter(Boolean) : [],
      year: year || null,
      title: title || "",
      venue: prettyRepoName(repository),
      doi: doi || "",
      url: url || ""
    },
    fetchedAt: new Date().toISOString()
  };
}

function prettyRepoName(repo) {
  return ({
    figshare: "Figshare", openalex: "OpenAlex", dryad: "Dryad Digital Repository",
    dataverse: "Harvard Dataverse", osf: "Open Science Framework", datagov: "Data.gov",
    zenodo: "Zenodo", icpsr: "ICPSR", hdx: "Humanitarian Data Exchange",
    worldbank: "World Bank Open Data", oecd: "OECD Statistics", fred: "FRED — St. Louis Fed",
    whoGho: "WHO Global Health Observatory"
  })[repo] || repo;
}

// ── topic-aware provider ordering ───────────────────────────────────────────
const PROVIDER_REGISTRY = {
  figshare: fetchFigshare,
  openalex: fetchOpenAlexDatasets,
  dryad: fetchDryad,
  dataverse: fetchDataverse,
  osf: fetchOsfData,
  datagov: fetchDataGov,
  zenodo: fetchZenodo,
  icpsr: fetchIcpsr,
  hdx: fetchHdx,
  worldbank: fetchWorldBank,
  oecd: fetchOecd,
  fred: fetchFred,
  whoGho: fetchWhoGho
};

const ALWAYS_ON = ["figshare", "openalex", "dryad"];

const TOPIC_PROVIDER_BIAS = {
  finance:     ["fred", "worldbank", "oecd", "datagov", "dataverse", "zenodo"],
  health:      ["whoGho", "datagov", "hdx", "dryad", "icpsr", "osf"],
  psych:       ["osf", "icpsr", "dataverse", "dryad", "zenodo"],
  gov:         ["datagov", "dataverse", "icpsr", "worldbank"],
  engineering: ["zenodo", "dataverse"],
  climate:     ["zenodo", "worldbank", "hdx", "dataverse"]
};

function pickProviders(topic, cap = 6) {
  const classes = classifyTopic(topic);
  const ordered = [...ALWAYS_ON];
  // Round-robin interleave across matched classes so multi-class topics
  // (e.g. "therapy" hits both health and psych) get fair representation
  // instead of one class saturating the cap.
  if (classes.length > 0) {
    const queues = classes.map(c => [...(TOPIC_PROVIDER_BIAS[c] || [])]);
    let progressed = true;
    while (progressed && ordered.length < cap) {
      progressed = false;
      for (const q of queues) {
        while (q.length) {
          const p = q.shift();
          if (!ordered.includes(p)) {
            ordered.push(p);
            progressed = true;
            break;
          }
        }
        if (ordered.length >= cap) break;
      }
    }
  }
  // Top up with any remaining providers if we're still under cap.
  for (const p of Object.keys(PROVIDER_REGISTRY)) {
    if (!ordered.includes(p) && ordered.length < cap) ordered.push(p);
  }
  return ordered.slice(0, cap);
}

// ── public entry point ──────────────────────────────────────────────────────
// Phase 9C — providers that benefit from a topic-root fallback query.
// figshare / dryad / dataverse have less granular topical indexing than
// OpenAlex, so a narrow prompt query like "CBT for eating disorders" often
// returns 0 hits even when broader topic searches would find real datasets.
// Strategy: if the narrow query returns 0 with downloadable files, retry
// the same provider with the topic root.
const TOPIC_ROOT_FALLBACK_PROVIDERS = new Set(["figshare", "dryad", "dataverse"]);

/**
 * Harvest datasets relevant to a research prompt.
 *
 * @param {string} query
 * @param {object} opts
 * @param {string} opts.topic       parent research topic (drives provider ordering)
 * @param {number} opts.limit       max datasets returned (across providers)
 * @param {number} opts.perProvider how many to ask each provider for
 * @param {Set<string>} [opts.seenIds] cross-prompt id dedupe set (mutated in-place)
 * @returns {Promise<Dataset[]>}
 */
export async function harvest(query, opts = {}) {
  const {
    topic = query,
    limit = 5,
    perProvider = 3,
    seenIds = new Set()
  } = opts;

  const providers = pickProviders(topic, 6);
  console.log(`[datasetHarvester] providers for topic "${topic.slice(0, 50)}": [${providers.join(", ")}]`);

  // Per-provider cache
  const cached = await Promise.all(providers.map(async name => {
    const key = cacheKey(name, query);
    const c = await readCache(key);
    return c ? { name, rows: c, fromCache: true } : { name, rows: null, fromCache: false, key };
  }));

  // Fetch live for the misses
  const liveTasks = cached
    .filter(c => !c.fromCache)
    .map(async c => {
      const fn = PROVIDER_REGISTRY[c.name];
      if (!fn) return { name: c.name, rows: [], fromCache: false };
      try {
        let rows = await withRetry(() => fn(query, perProvider));
        // Phase 9C — topic-root fallback for repositories with sparse topical
        // indexing. If the narrow query returned 0 datasets-with-files, retry
        // with the broader topic and keep whichever is bigger.
        if (TOPIC_ROOT_FALLBACK_PROVIDERS.has(c.name) &&
            rows.filter(r => !r.metadataOnly && (r.files || []).length > 0).length === 0 &&
            topic && topic !== query) {
          console.log(`[datasetHarvester] ${c.name}: 0 usable from "${query.slice(0, 40)}" — retrying with topic root "${topic.slice(0, 40)}"`);
          try {
            const fallback = await withRetry(() => fn(topic, perProvider));
            const fallbackUsable = fallback.filter(r => !r.metadataOnly && (r.files || []).length > 0).length;
            if (fallbackUsable > 0) {
              console.log(`[datasetHarvester] ${c.name}: topic-root fallback got ${fallbackUsable} usable dataset(s)`);
              rows = fallback;
            }
          } catch (err) {
            log(`${c.name} topic-root fallback failed: ${err.message}`, "warn");
          }
        }
        await writeCache(c.key, rows);
        return { name: c.name, rows, fromCache: false };
      } catch (err) {
        log(`${c.name} failed: ${err.message}`, "warn");
        return { name: c.name, rows: [], fromCache: false };
      }
    });

  const live = await Promise.all(liveTasks);
  const results = [...cached.filter(c => c.fromCache), ...live];

  // Flatten + dedup by id
  const all = [];
  for (const r of results) {
    for (const ds of (r.rows || [])) {
      if (seenIds.has(ds.id)) continue;
      seenIds.add(ds.id);
      all.push(ds);
    }
  }

  // Prioritize datasets with downloadable files first, then metadataOnly.
  all.sort((a, b) => (a.metadataOnly === b.metadataOnly ? 0 : a.metadataOnly ? 1 : -1));

  const final = all.slice(0, limit);
  console.log(`[datasetHarvester] harvest done: ${final.length}/${all.length} datasets (cap=${limit}, ${final.filter(d => d.metadataOnly).length} metadata-only)`);
  return final;
}

// ── file download + parse ───────────────────────────────────────────────────
/**
 * Download a dataset file and return the parsed rows.
 * Implements the size-based strategy:
 *   - ≤25MB: read fully
 *   - >25MB: stratified slabs (5×2K rows from evenly-spaced offsets)
 *   - skipped formats: returns null with reason
 *
 * @returns {Promise<{rows: object[], headers: string[], sampling: string, totalBytes: number} | null>}
 */
export async function downloadAndParse(file) {
  if (!file || !file.downloadUrl) return null;
  if (SKIP_FORMATS.has(file.format)) {
    console.log(`[datasetHarvester] format=${file.format} skipped (planned for Phase 7H)`);
    return null;
  }
  if (!ALLOWED_FORMATS.has(file.format)) {
    console.log(`[datasetHarvester] format=${file.format} unsupported`);
    return null;
  }

  // Probe size with HEAD when we don't have it yet (best-effort).
  let sizeBytes = file.sizeBytes || 0;
  if (!sizeBytes) {
    try {
      const head = await axios.head(file.downloadUrl, { timeout: 10000, headers: BROWSER_HEADERS });
      sizeBytes = parseInt(head.headers?.["content-length"] || "0", 10) || 0;
    } catch { /* best-effort only */ }
  }

  if (sizeBytes > FILE_SIZE_LIMIT_FULL) {
    return await downloadStratified(file, sizeBytes);
  }
  return await downloadFull(file, sizeBytes);
}

async function downloadFull(file, sizeBytes) {
  try {
    const res = await axios.get(file.downloadUrl, {
      timeout: 60000,
      headers: BROWSER_HEADERS,
      maxRedirects: 5,
      responseType: file.format === "xlsx" || file.format === "xls" ? "arraybuffer" : "text",
      maxContentLength: 60 * 1024 * 1024,    // 60MB hard cap on body size
      validateStatus: s => s >= 200 && s < 400
    });
    const body = res.data;
    const parsed = await parseByFormat(body, file.format);
    if (!parsed) return null;
    return { ...parsed, sampling: "full", totalBytes: sizeBytes || 0 };
  } catch (err) {
    log(`download ${file.downloadUrl}: ${err.message}`, "warn");
    return null;
  }
}

async function downloadStratified(file, sizeBytes) {
  // For text formats, use HTTP Range to grab N slabs at evenly-spaced byte offsets.
  // Each slab is read until the next newline boundary so we don't split a row.
  if (file.format !== "csv" && file.format !== "tsv" && file.format !== "json") {
    // For xlsx/xls, range-fetching binary doesn't help; return null to skip.
    console.log(`[datasetHarvester] stratified sampling not supported for format=${file.format} on >25MB file — skipping`);
    return null;
  }
  const slabBytes = STRATIFIED_ROWS_PER_SLAB * 200;  // ~200 bytes per row heuristic
  const offsets = Array.from({ length: STRATIFIED_SLABS }, (_, i) =>
    Math.floor((sizeBytes / STRATIFIED_SLABS) * i)
  );
  const slabs = [];
  for (const start of offsets) {
    try {
      const end = Math.min(start + slabBytes - 1, sizeBytes - 1);
      const res = await axios.get(file.downloadUrl, {
        timeout: 30000,
        headers: { ...BROWSER_HEADERS, Range: `bytes=${start}-${end}` },
        responseType: "text",
        validateStatus: s => s >= 200 && s < 400
      });
      slabs.push(String(res.data || ""));
    } catch (err) {
      log(`stratified slab @${start}: ${err.message}`, "warn");
    }
  }
  if (slabs.length === 0) return null;
  // Reassemble: take the first slab whole (has the header), then for subsequent
  // slabs drop everything before the first newline (partial row from byte cut).
  const header = slabs[0].split(/\r?\n/)[0];
  const reassembled = [header, ...slabs.flatMap((s, i) => {
    const lines = s.split(/\r?\n/);
    if (i === 0) return lines.slice(1);
    return lines.slice(1, lines.length - 1); // drop first (partial) and last (partial)
  })].join("\n");

  const parsed = parseByFormat(reassembled, file.format);
  if (!parsed) return null;
  console.log(`[datasetHarvester] stratified sample: ${slabs.length} slabs, ${parsed.rows.length} rows recovered`);
  return { ...parsed, sampling: "stratified", totalBytes: sizeBytes };
}

// ── format parsers ──────────────────────────────────────────────────────────
async function parseByFormat(body, format) {
  try {
    if (format === "csv") return parseCsv(body, ",");
    if (format === "tsv") return parseCsv(body, "\t");
    if (format === "json") return parseJsonRows(body);
    if (format === "xlsx" || format === "xls") return await parseXlsx(body);
  } catch (err) {
    log(`parse fail (${format}): ${err.message}`, "warn");
  }
  return null;
}

// Quote-aware CSV/TSV mini-parser. Handles "double ""quoted"" fields", embedded newlines.
function parseCsv(text, delim) {
  if (typeof text !== "string") text = String(text || "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch;
    } else {
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === delim) { row.push(field); field = ""; continue; }
      if (ch === "\n") {
        row.push(field); rows.push(row);
        row = []; field = "";
        continue;
      }
      if (ch === "\r") continue;
      field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return null;
  const headers = rows[0].map(h => String(h).trim()).map((h, i) => h || `col${i + 1}`);
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === "") continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = rows[r][c] ?? "";
    data.push(obj);
  }
  return { headers, rows: data };
}

function parseJsonRows(body) {
  const txt = typeof body === "string" ? body : JSON.stringify(body);
  const data = JSON.parse(txt);
  // Heuristic: find the first array-of-objects in the structure.
  const arr = findArrayOfObjects(data);
  if (!arr) return null;
  const headers = [...new Set(arr.flatMap(o => Object.keys(o || {})))];
  return { headers, rows: arr };
}

function findArrayOfObjects(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === "object" && !Array.isArray(node[0])) return node;
    return null;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) {
      const found = findArrayOfObjects(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// xlsx is loaded lazily via dynamic import. If the package isn't installed in
// this environment, the parser no-ops with a log line — the harvester just
// skips xlsx files and continues with the CSV/JSON ones in the same dataset.
let _xlsxModule = null;
let _xlsxLoadAttempted = false;
async function loadXlsx() {
  if (_xlsxLoadAttempted) return _xlsxModule;
  _xlsxLoadAttempted = true;
  try {
    _xlsxModule = (await import("xlsx")).default || (await import("xlsx"));
  } catch {
    console.log(`[datasetHarvester] xlsx package not installed — .xlsx files will be skipped (install 'xlsx' to enable)`);
    _xlsxModule = null;
  }
  return _xlsxModule;
}

async function parseXlsx(body) {
  const XLSX = await loadXlsx();
  if (!XLSX) return null;
  try {
    const wb = XLSX.read(body, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return null;
    const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
    if (!json.length) return null;
    return { headers: Object.keys(json[0]), rows: json };
  } catch (err) {
    log(`xlsx parse: ${err.message} — skipping`, "warn");
    return null;
  }
}

// ── exports ─────────────────────────────────────────────────────────────────
export const _internals = {
  classifyTopic,
  pickProviders,
  parseCsv,
  parseJsonRows,
  ALLOWED_FORMATS,
  SKIP_FORMATS,
  TOPIC_PROVIDER_BIAS
};

// server/skills/deepResearch/sourceDirectory.js
// CRUD for data/research-sources.json with lazy migration from the legacy flat schema
// to the richer subject-graph schema (keywords, aliases, relatedSubjects, connectivity, …).
//
// The file lives at PROJECT_ROOT/data/research-sources.json. All writes are atomic
// (tmp-file + rename) and serialized via a tiny in-process queue so concurrent skill
// invocations don't clobber each other.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { PROJECT_ROOT } from "../../utils/config.js";

const SOURCES_FILE = path.resolve(PROJECT_ROOT, "data", "research-sources.json");

const DEFAULT_FILE = {
  _meta: {
    created: new Date().toISOString(),
    version: 2,
    description: "Subject-to-source mappings. Auto-updated by deepResearch skill."
  },
  subjects: {}
};

// ── tiny serialized writer ─────────────────────────────────────────────────
let _busy = false;
const _queue = [];
async function _withLock(fn) {
  if (_busy) await new Promise(r => _queue.push(r));
  _busy = true;
  try { return await fn(); }
  finally {
    _busy = false;
    const next = _queue.shift();
    if (next) next();
  }
}

// ── slug helper ────────────────────────────────────────────────────────────
export function slugify(topic) {
  if (!topic) return "untitled";
  // Keep ASCII letters/digits and Hebrew block. Collapse everything else to '-'.
  let s = String(topic).toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\u0590-\u05FF]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 60) {
    const hash = crypto.createHash("sha1").update(topic).digest("hex").slice(0, 6);
    s = s.slice(0, 53) + "-" + hash;
  }
  return s || "untitled";
}

// ── schema migration ──────────────────────────────────────────────────────
function migrateSubject(slug, raw) {
  // Already new-shape? Detect by presence of `slug` or `keywords`.
  if (raw && (raw.slug || Array.isArray(raw.keywords))) {
    return {
      slug:             raw.slug || slug,
      topic:            raw.topic || slug,
      aliases:          raw.aliases || [],
      keywords:         Array.isArray(raw.keywords) ? raw.keywords : [],
      relatedSubjects:  Array.isArray(raw.relatedSubjects) ? raw.relatedSubjects : [],
      priority_sources: Array.isArray(raw.priority_sources) ? raw.priority_sources : [],
      domains:          normalizeDomains(raw.domains),
      types:            Array.isArray(raw.types) ? raw.types : [],
      connectivity:     typeof raw.connectivity === "number" ? raw.connectivity : 0,
      relatedness:      raw.relatedness || {},
      depth:            raw.depth || null,
      lastResearched:   raw.lastResearched || null,
      sourceCount:      typeof raw.sourceCount === "number" ? raw.sourceCount : 0,
      createdFrom:      raw.createdFrom || null
    };
  }
  // Legacy flat shape: { topic, lastResearched, sourceCount, domains:[string], types:[string] }
  return {
    slug,
    topic:            raw?.topic || slug,
    aliases:          [],
    keywords:         [], // unknown — populated on next research run
    relatedSubjects:  [],
    priority_sources: [],
    domains:          normalizeDomains(raw?.domains),
    types:            Array.isArray(raw?.types) ? raw.types : [],
    connectivity:     0,
    relatedness:      {},
    depth:            null,
    lastResearched:   raw?.lastResearched || null,
    sourceCount:      typeof raw?.sourceCount === "number" ? raw.sourceCount : 0,
    createdFrom:      null
  };
}

function normalizeDomains(d) {
  if (!Array.isArray(d)) return [];
  return d.map(item => {
    if (typeof item === "string") return { host: item, hits: 1, trustScore: 0.5 };
    if (item && typeof item === "object") {
      return {
        host: item.host || "",
        hits: typeof item.hits === "number" ? item.hits : 1,
        trustScore: typeof item.trustScore === "number" ? item.trustScore : 0.5
      };
    }
    return null;
  }).filter(Boolean);
}

// ── load / save ────────────────────────────────────────────────────────────

/**
 * Load research-sources.json. Lazily migrates each subject to the v2 shape
 * but does NOT write back — call save() to persist migrations.
 *
 * @returns {Promise<{_meta:object, subjects: Record<string, object>}>}
 */
export async function load() {
  let raw;
  try {
    const txt = await fs.readFile(SOURCES_FILE, "utf8");
    raw = JSON.parse(txt);
  } catch {
    raw = JSON.parse(JSON.stringify(DEFAULT_FILE));
  }
  if (!raw || typeof raw !== "object") raw = JSON.parse(JSON.stringify(DEFAULT_FILE));
  if (!raw._meta || typeof raw._meta !== "object") raw._meta = { ...DEFAULT_FILE._meta };
  if (!raw.subjects || typeof raw.subjects !== "object") raw.subjects = {};

  const migrated = { _meta: { ...raw._meta, version: 2 }, subjects: {} };
  for (const [slug, val] of Object.entries(raw.subjects)) {
    migrated.subjects[slug] = migrateSubject(slug, val);
  }
  return migrated;
}

async function _writeAtomic(data) {
  await fs.mkdir(path.dirname(SOURCES_FILE), { recursive: true });
  const tmp = `${SOURCES_FILE}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  // Windows EPERM workaround
  for (let i = 0; i < 3; i++) {
    try { await fs.rename(tmp, SOURCES_FILE); return; }
    catch (e) {
      if (e.code === "EPERM" && i < 2) { await new Promise(r => setTimeout(r, 50 * (i + 1))); continue; }
      try { await fs.unlink(tmp); } catch {}
      throw e;
    }
  }
}

// ── Phase 1E: inverse keyword index ──────────────────────────────────────
/**
 * Build the top-level keywordIndex from all subjects.
 * Maps each keyword token → sorted array of slugs that list it.
 * Only tokens with length ≥ 3 are indexed.
 *
 * @param {Record<string,object>} subjects
 * @returns {Record<string, string[]>}
 */
export function buildKeywordIndex(subjects) {
  const idx = {};

  function addToken(token, slug) {
    if (!token || token.length < 3) return;
    if (!idx[token]) idx[token] = [];
    if (!idx[token].includes(slug)) idx[token].push(slug);
  }

  for (const [slug, subj] of Object.entries(subjects || {})) {
    const phrases = [
      ...(subj.keywords || []),
      ...(subj.aliases || [])
    ];
    for (const kw of phrases) {
      const clean = String(kw || "").toLowerCase().trim();
      if (!clean) continue;
      // Index the full phrase (spaces collapsed → single token, e.g. "darkmatter")
      const compacted = clean.replace(/[^\p{L}\p{N}]+/gu, "");
      addToken(compacted, slug);
      // Also index each individual word (e.g. "dark", "matter") for single-word lookups
      for (const word of clean.split(/\s+/)) {
        const w = word.replace(/[^\p{L}\p{N}]/gu, "");
        addToken(w, slug);
      }
    }
  }

  // Sort each slug list for deterministic output
  for (const k of Object.keys(idx)) idx[k].sort();
  return idx;
}

/**
 * Look up which slugs are tagged with a given keyword token.
 *
 * @param {string} keyword   raw keyword (will be normalized)
 * @returns {Promise<string[]>}
 */
export async function lookupKeyword(keyword) {
  const data = await load();
  const token = String(keyword || "").toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "");
  return (data.keywordIndex || {})[token] || [];
}

export async function save(data) {
  return await _withLock(async () => {
    if (!data || typeof data !== "object") throw new Error("save: data must be object");
    if (!data.subjects || typeof data.subjects !== "object") data.subjects = {};
    // Rebuild inverse index on every write
    data.keywordIndex = buildKeywordIndex(data.subjects);
    data._meta = { ...(data._meta || {}), version: 2, lastWritten: new Date().toISOString() };
    await _writeAtomic(data);
    return true;
  });
}

/**
 * Read-modify-write helper. The mutator receives the loaded object and may
 * either mutate in place or return a new object. Result is persisted atomically.
 */
export async function update(mutator) {
  return await _withLock(async () => {
    const data = await load();
    const next = (await mutator(data)) || data;
    // Rebuild inverse index on every write
    next.keywordIndex = buildKeywordIndex(next.subjects || {});
    next._meta = { ...(next._meta || {}), version: 2, lastWritten: new Date().toISOString() };
    await _writeAtomic(next);
    return next;
  });
}

/**
 * Get a subject by slug (already migrated).
 */
export async function getSubject(slug) {
  const data = await load();
  return data.subjects[slug] || null;
}

/**
 * Insert or merge a subject. Existing fields are preserved unless overwritten.
 */
export async function upsertSubject(slug, patch) {
  return await update(data => {
    const existing = data.subjects[slug] || migrateSubject(slug, { topic: patch?.topic || slug });
    data.subjects[slug] = {
      ...existing,
      ...patch,
      slug,
      // Merge nested fields rather than overwrite if patch provided arrays.
      aliases:          mergeUnique(existing.aliases, patch?.aliases),
      keywords:         mergeUnique(existing.keywords, patch?.keywords),
      types:            mergeUnique(existing.types, patch?.types),
      priority_sources: mergeUnique(existing.priority_sources, patch?.priority_sources),
      relatedSubjects:  patch?.relatedSubjects ?? existing.relatedSubjects,
      relatedness:      { ...(existing.relatedness || {}), ...(patch?.relatedness || {}) },
      domains:          mergeDomains(existing.domains, patch?.domains)
    };
    return data;
  });
}

function mergeUnique(a, b) {
  if (!Array.isArray(a)) a = [];
  if (!Array.isArray(b)) return a;
  const seen = new Set(a.map(String));
  const out = [...a];
  for (const x of b) {
    const k = String(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

function mergeDomains(existing, incoming) {
  const map = new Map();
  for (const d of normalizeDomains(existing)) map.set(d.host, { ...d });
  for (const d of normalizeDomains(incoming)) {
    if (map.has(d.host)) {
      const cur = map.get(d.host);
      cur.hits = (cur.hits || 0) + (d.hits || 1);
      cur.trustScore = Math.max(cur.trustScore || 0, d.trustScore || 0);
    } else {
      map.set(d.host, { ...d });
    }
  }
  return Array.from(map.values());
}

/**
 * Update connectivity & relatedness after a research run completes.
 *
 * @param {string} slug
 * @param {object} args
 * @param {number} args.connectivity         absolute new value (compute upstream)
 * @param {Record<string,number>} args.relatedness   { otherSlug: proximity 0..1 }
 */
export async function updateGraph(slug, { connectivity, relatedness } = {}) {
  return await update(data => {
    const subj = data.subjects[slug];
    if (!subj) return data;
    if (typeof connectivity === "number") subj.connectivity = connectivity;
    if (relatedness && typeof relatedness === "object") {
      subj.relatedness = { ...(subj.relatedness || {}), ...relatedness };
      // Keep relatedSubjects array aligned (top by proximity)
      subj.relatedSubjects = Object.entries(subj.relatedness)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([s, p]) => ({ slug: s, proximity: p }));
    }
    return data;
  });
}

/**
 * Returns true if this is the test/dev fixture path. Useful for tests.
 */
export function getPath() { return SOURCES_FILE; }

// Synchronous existence check (used by some quick paths)
export function fileExists() { return fsSync.existsSync(SOURCES_FILE); }

export const _internals = { migrateSubject, normalizeDomains, mergeDomains, mergeUnique, buildKeywordIndex };

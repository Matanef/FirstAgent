// server/skills/deepResearch/subjectBootstrapper.js
// When subjectMatcher.rank() returns nothing, create a new subject entry seeded
// from the 2–3 nearest existing subjects (lower threshold than the matcher uses).
//
// IMPORTANT: this is a bounded-loop helper, NOT a recursive skill call. The
// orchestrator (deepResearch/index.js) calls this once and then re-runs the
// matcher exactly once. This prevents runaway depth.

import { rank } from "./subjectMatcher.js";
import { upsertSubject, slugify } from "./sourceDirectory.js";

/**
 * Bootstrap a new subject from nearest-neighbor metadata.
 *
 * @param {string} topic                  the user's raw topic string
 * @param {object} extracted              keywordExtractor.extract() result
 * @param {Record<string,object>} subjects  current subjects map (already loaded by caller)
 * @returns {Promise<{slug:string, subject:object, neighbors:string[]}>}
 */
export async function bootstrap(topic, extracted, subjects) {
  const slug = slugify(topic);

  // Find loose neighbors (lower threshold than the strict matcher).
  const neighbors = rank(extracted, subjects, { limit: 3, maxCandidates: 6, minScore: 0.05 });

  // Aggregate metadata from neighbors.
  const aggTypes = new Set();
  const aggPriority = new Set();
  const aggDomains = new Map();
  let depth = null;
  let createdFrom = null;

  for (const n of neighbors) {
    const s = n.subject || {};
    (s.types || []).forEach(t => aggTypes.add(t));
    (s.priority_sources || []).forEach(p => aggPriority.add(p));
    for (const d of (s.domains || [])) {
      const k = d.host;
      if (!k) continue;
      const cur = aggDomains.get(k) || { host: k, hits: 0, trustScore: 0 };
      cur.hits += d.hits || 1;
      cur.trustScore = Math.max(cur.trustScore, d.trustScore || 0);
      aggDomains.set(k, cur);
    }
    if (!depth && s.depth) depth = s.depth;
    if (!createdFrom) createdFrom = n.slug;
  }

  const initialKeywords = unique([
    ...(extracted.tokens || []),
    ...(extracted.phrases || []).flatMap(p => String(p).toLowerCase().split(/\s+/))
  ]).filter(k => k && k.length >= 2).slice(0, 30);

  const patch = {
    topic,
    keywords:         initialKeywords,
    aliases:          [],
    types:            [...aggTypes],
    priority_sources: [...aggPriority],
    domains:          [...aggDomains.values()],
    relatedSubjects:  neighbors.map(n => ({ slug: n.slug, proximity: Math.min(1, n.score / 5) })),
    relatedness:      Object.fromEntries(neighbors.map(n => [n.slug, Math.min(1, n.score / 5)])),
    depth,
    createdFrom
  };

  await upsertSubject(slug, patch);

  return {
    slug,
    subject: { slug, ...patch },
    neighbors: neighbors.map(n => n.slug)
  };
}

function unique(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

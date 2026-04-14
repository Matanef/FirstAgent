// server/skills/deepResearch/subjectMatcher.js
// Score subject entries from research-sources.json against extracted keywords.
// Returns top-N closest matches (default 6, max 12).
//
// Score formula (per plan):
//   score = 3 * exactTopicContainsPhrase
//         + 2 * jaccardSimilarity(extracted.tokens, subject.keywords)
//         + 2 * bigramOverlapCount(extracted.bigrams, subject.keywords)
//         + 1 * domainAffinity(subject.types, inferredType(extracted))
//         + 0.5 * recencyBoost(lastResearched)
//         - 1 * staleness(lastResearched > 90 days)

import { _internals as kwInternals } from "./keywordExtractor.js";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS  = 60 * 24 * 60 * 60 * 1000;

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bigramOverlap(extractedBigrams, subjectKeywords) {
  if (!extractedBigrams?.length || !subjectKeywords?.length) return 0;
  const subjSet = new Set(subjectKeywords.map(k => String(k).toLowerCase()));
  let hits = 0;
  for (const bg of extractedBigrams) {
    // Either the full bigram is a keyword, or both halves are.
    if (subjSet.has(bg)) { hits++; continue; }
    const [a, b] = bg.split(" ");
    if (subjSet.has(a) && subjSet.has(b)) hits++;
  }
  return hits;
}

function inferType(extracted) {
  // Light heuristics on extracted phrases/tokens.
  const text = [...(extracted.tokens || []), ...(extracted.phrases || [])].join(" ").toLowerCase();
  if (/\b(study|paper|research|trial|cohort|meta-analysis|abstract)\b/.test(text)) return "academic";
  if (/\b(market|stock|finance|earnings|valuation|revenue)\b/.test(text)) return "finance";
  if (/\b(disease|symptom|treatment|patient|clinical|medical|health)\b/.test(text)) return "medicine";
  if (/\b(law|legal|court|statute|ruling|jurisdiction)\b/.test(text)) return "legal";
  if (/\b(code|algorithm|software|api|programming|debug)\b/.test(text)) return "technical";
  return "general";
}

function domainAffinity(subjectTypes, inferredType) {
  if (!Array.isArray(subjectTypes) || subjectTypes.length === 0) return 0;
  const set = new Set(subjectTypes.map(t => String(t).toLowerCase()));
  if (set.has(inferredType)) return 1;
  // Partial match: academic ↔ medicine ↔ legal share scholarly affinity
  const scholarly = new Set(["academic", "medicine", "legal"]);
  if (scholarly.has(inferredType) && [...set].some(t => scholarly.has(t))) return 0.5;
  return 0;
}

function recencyBoost(lastResearched) {
  if (!lastResearched) return 0;
  const ms = Date.parse(lastResearched);
  if (isNaN(ms)) return 0;
  const age = Date.now() - ms;
  if (age < SIXTY_DAYS_MS) return 1 - (age / SIXTY_DAYS_MS); // 1 → 0 over 60 days
  return 0;
}

function staleness(lastResearched) {
  if (!lastResearched) return 0;
  const ms = Date.parse(lastResearched);
  if (isNaN(ms)) return 0;
  return Date.now() - ms > NINETY_DAYS_MS ? 1 : 0;
}

function exactPhraseHits(extracted, topic) {
  if (!topic || !extracted?.phrases?.length) return 0;
  const t = topic.toLowerCase();
  let hits = 0;
  for (const p of extracted.phrases) {
    if (p && t.includes(p.toLowerCase())) hits++;
  }
  return hits;
}

/**
 * Pre-tokenize a subject's searchable text (topic + aliases + keywords).
 */
function subjectTokens(subject) {
  const text = [subject.topic, ...(subject.aliases || []), ...(subject.keywords || [])].join(" ");
  return kwInternals.dropStopwords(kwInternals.tokenize(text), kwInternals.detectLanguage(text));
}

/**
 * Score subjects and return top-N.
 *
 * @param {object} extracted   { tokens, bigrams, phrases, language }
 * @param {Record<string, object>} subjects  subjects map from sourceDirectory.load()
 * @param {object} [opts]
 * @param {number} [opts.limit=6]            return at most N matches
 * @param {number} [opts.maxCandidates=12]   pre-rank pool size
 * @param {number} [opts.minScore=0.5]       drop matches below this score
 * @returns {Array<{slug:string, score:number, subject:object}>}
 */
export function rank(extracted, subjects, opts = {}) {
  const limit         = opts.limit ?? 6;
  const maxCandidates = opts.maxCandidates ?? 12;
  const minScore      = opts.minScore ?? 0.5;
  if (!subjects || typeof subjects !== "object") return [];

  const inferredType = inferType(extracted);

  const scored = [];
  for (const [slug, subject] of Object.entries(subjects)) {
    if (!subject) continue;
    const subjTokens = subjectTokens(subject);
    const score =
      3   * exactPhraseHits(extracted, subject.topic) +
      2   * jaccard(extracted.tokens || [], subjTokens) +
      2   * bigramOverlap(extracted.bigrams || [], subjTokens) +
      1   * domainAffinity(subject.types, inferredType) +
      0.5 * recencyBoost(subject.lastResearched) -
      1   * staleness(subject.lastResearched);
    if (score >= minScore) scored.push({ slug, score, subject });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreaker: higher sourceCount wins, then more recent
    const ac = a.subject.sourceCount || 0, bc = b.subject.sourceCount || 0;
    if (bc !== ac) return bc - ac;
    return Date.parse(b.subject.lastResearched || 0) - Date.parse(a.subject.lastResearched || 0);
  });

  return scored.slice(0, Math.min(maxCandidates, scored.length)).slice(0, limit);
}

export const _internals = { jaccard, bigramOverlap, inferType, domainAffinity, recencyBoost, staleness, exactPhraseHits, subjectTokens };

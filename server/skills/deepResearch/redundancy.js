// server/skills/deepResearch/redundancy.js
// Cheap, deterministic redundancy detection for the thesis synthesizer.
//
// Two functions:
//   - jaccardSimilarity(a, b)        → 0..1 word-overlap on word sets
//   - splitParagraphs(text)          → array of { idx, text, words: Set }
//   - findDuplicateOpenings(...)     → flag sections whose first sentence is too similar
//   - findDuplicateParagraphs(...)   → flag paragraphs that repeat across sections
//
// Used by thesisSynthesizer.js Phase 5B (cross-section redundancy killer).

const STOPWORDS = new Set([
  "a","an","the","and","or","but","of","at","by","for","with","about","against",
  "between","into","through","during","before","after","above","below","to","from",
  "up","down","in","out","on","off","over","under","is","am","are","was","were","be",
  "been","being","have","has","had","do","does","did","this","that","these","those",
  "i","me","my","we","our","you","your","he","him","his","she","her","it","its",
  "they","them","their","what","which","who","whom","as","because","until","also",
  "if","then","while","not","no","so","than","such","both","each","few","more","most",
  "other","some","very","can","will","just","should","now","there","here","when",
  "where","why","how","all","any","every"
]);

/** Tokenize text into a set of content words (lowercase, no stopwords, length ≥ 3). */
export function contentWords(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w))
  );
}

/** Jaccard similarity on content-word sets. Returns 0..1. */
export function jaccardSimilarity(a, b) {
  const setA = a instanceof Set ? a : contentWords(a);
  const setB = b instanceof Set ? b : contentWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersect = 0;
  for (const w of setA) if (setB.has(w)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** Get the first complete sentence (or up to 200 chars). */
export function firstSentence(text) {
  if (!text) return "";
  const m = String(text).match(/[^.!?\n]+[.!?]/);
  return (m ? m[0] : String(text).slice(0, 200)).trim();
}

/**
 * Identify sections whose first sentence is too similar to a previous section's
 * first sentence. Returns indices that need a rewrite.
 */
export function findDuplicateOpenings(sectionTexts, threshold = 0.55) {
  const dups = [];
  const openings = sectionTexts.map(t => contentWords(firstSentence(t)));
  for (let i = 1; i < openings.length; i++) {
    for (let j = 0; j < i; j++) {
      const sim = jaccardSimilarity(openings[i], openings[j]);
      if (sim >= threshold) {
        dups.push({ section: i, duplicateOf: j, similarity: sim });
        break; // one match is enough
      }
    }
  }
  return dups;
}

/** Split a section's text into paragraphs (double-newline separated). */
export function splitParagraphs(text) {
  if (!text) return [];
  return String(text)
    .split(/\n\s*\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map((p, i) => ({ idx: i, text: p, words: contentWords(p) }));
}

/**
 * Find paragraphs that repeat (Jaccard ≥ threshold) across sections.
 * Returns: [{ later: { sectionIdx, paraIdx, text }, earlier: { ... }, similarity }]
 *
 * `sections` is array of { heading, text }.
 * Only flags pairs where the LATER occurrence should be rewritten/removed.
 */
export function findDuplicateParagraphs(sections, threshold = 0.5, minWords = 25) {
  const all = [];
  sections.forEach((sec, sectionIdx) => {
    const paras = splitParagraphs(sec.text);
    paras.forEach(p => {
      if (p.words.size >= minWords) {
        all.push({ sectionIdx, sectionHeading: sec.heading, paraIdx: p.idx, text: p.text, words: p.words });
      }
    });
  });

  const dups = [];
  for (let i = 1; i < all.length; i++) {
    for (let j = 0; j < i; j++) {
      // Don't flag duplicates within the same section (those are the writer's intent)
      if (all[i].sectionIdx === all[j].sectionIdx) continue;
      const sim = jaccardSimilarity(all[i].words, all[j].words);
      if (sim >= threshold) {
        dups.push({
          later: { sectionIdx: all[i].sectionIdx, sectionHeading: all[i].sectionHeading, paraIdx: all[i].paraIdx, text: all[i].text },
          earlier: { sectionIdx: all[j].sectionIdx, sectionHeading: all[j].sectionHeading, paraIdx: all[j].paraIdx, text: all[j].text },
          similarity: sim
        });
        break; // one match per paragraph is enough; tag for rewrite
      }
    }
  }
  return dups;
}

// Exposed for tests
export const _internals = { contentWords, jaccardSimilarity, firstSentence };

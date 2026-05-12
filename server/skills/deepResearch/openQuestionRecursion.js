// server/skills/deepResearch/openQuestionRecursion.js
// Phase 20N — [depth:thesis-deep] super-tier open-questions recursion.
//
// After the 8 primary prompts complete, each prompt's `conclusion.md` has an
// "Open questions surfaced" section with 3-5 questions per prompt — so ~25-40
// open questions total. This module:
//
//   1. Collects all open questions from prompt conclusions.
//   2. Globally ranks them by recurrence frequency × average source quality
//      of the surfacing prompt's articles.
//   3. Picks the top 4-5 (the user requested 4-5 specifically).
//   4. Runs ONE supplementary harvest (6-8 articles total) targeting those
//      questions as a unified follow-up query.
//   5. Returns the supplementary harvest results to be folded into the
//      thesis synthesizer's "Future Directions" section.
//
// Runtime cost: ~5-8 minutes added to the normal thesis runtime. Triggered
// only when tier === "thesis-deep".
//
// Allowed dependencies (per CLAUDE.md): no external libs — uses harvesters
// already in the deepResearch skill.

import { llm } from "../../tools/llm.js";

const SYNTH_MODEL = process.env.SYNTHESIZER_MODEL || "qwen2.5:7b";
const TOP_K = 5;   // user requested 4-5; pick 5

/**
 * Walk through promptResults and gather (question, sourcePromptIndex, weight)
 * tuples. The weight is the average relevance score of the prompt's articles
 * — higher-quality prompts surface higher-quality questions.
 */
export function collectOpenQuestions(promptResults) {
  const out = [];
  for (const p of (promptResults || [])) {
    // Phase 20N-fix — `conclusionWriter.write()` returns the conclusion under
    // `p.conclusion.openQuestions`. The original code read the wrong path
    // (`p.conclusionMeta.openQuestions`) which always evaluated empty, so the
    // recursion logged "no open questions surfaced" even when real questions
    // had been written into each prompt's conclusion.md.
    const qs = p?.conclusion?.openQuestions || p?.conclusionMeta?.openQuestions || p?.openQuestions || [];
    const avgRel = (() => {
      const rels = (p?.analyses || []).map(a => Number(a?.analysis?.relevance) || 0).filter(r => r > 0);
      if (!rels.length) return 0.5;
      return rels.reduce((s, r) => s + r, 0) / rels.length;
    })();
    for (const q of qs) {
      if (!q || typeof q !== "string") continue;
      const cleaned = q.trim().replace(/^[-*]\s*/, "");
      if (cleaned.length < 15) continue;
      out.push({ question: cleaned, promptIndex: p.promptIndex, weight: avgRel });
    }
  }
  return out;
}

// Build a normalized key (lowercase, dedup-friendly) so paraphrased
// duplicates ("what are the long-term effects?" vs "What are long-term
// effects?") collapse to one.
function questionKey(q) {
  return q.toLowerCase()
    .replace(/[?.!,;:]+/g, "")
    .replace(/\b(what|how|are|is|the|of|in|for|to|a|an|on|with|can|do|does|will|by|from|at)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Dedupe (by normalized key) and rank questions by recurrence frequency ×
 * mean weight. Returns the top N.
 */
export function rankOpenQuestions(collected, { topN = TOP_K } = {}) {
  const buckets = new Map();
  for (const item of collected) {
    const k = questionKey(item.question);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, { canonical: item.question, occurrences: 0, weightSum: 0, prompts: new Set() });
    const b = buckets.get(k);
    b.occurrences++;
    b.weightSum += item.weight;
    b.prompts.add(item.promptIndex);
  }
  const ranked = [...buckets.values()]
    .map(b => ({
      question: b.canonical,
      score: b.occurrences * (b.weightSum / Math.max(1, b.occurrences)),
      occurrences: b.occurrences,
      avgWeight: b.weightSum / Math.max(1, b.occurrences),
      sourcePrompts: [...b.prompts],
    }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, topN);
}

/**
 * Ask the LLM to synthesize a SINGLE deep follow-up search query that
 * covers the top open questions. We do one harvest with this query rather
 * than 5 separate harvests — cheaper and the harvester naturally diversifies.
 */
export async function buildDeepFollowupQuery(rankedQuestions, topic) {
  if (!rankedQuestions || rankedQuestions.length === 0) return null;
  const list = rankedQuestions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
  const prompt = `You are designing a follow-up research search query for a thesis on "${topic}".

The thesis just completed its main literature review. The following ${rankedQuestions.length} open questions emerged from synthesizing those sources:

${list}

Design ONE search query (5-12 words, no quotes) that would surface academic literature directly addressing the COMMON THREAD across these questions. Focus on what they share — typically a mechanism, future-direction, or open-controversy theme.

Output ONLY the query, no preamble, no explanation.`;
  try {
    const res = await llm(prompt, {
      timeoutMs: 30000,
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 2048, num_predict: 40 }
    });
    const q = String(res?.data?.text || "").trim().replace(/^["'`]+|["'`]+$/g, "").split("\n")[0];
    if (q && q.length >= 5 && q.length <= 200) return q;
    return null;
  } catch {
    return null;
  }
}

/**
 * Public entry: run the deep follow-up harvest pass.
 *
 * Inputs:
 *   - promptResults: the main pipeline's per-prompt results
 *   - articleHarvester: the harvester module (avoids circular imports)
 *   - articleAnalyzer: the analyzer module
 *   - topic, topicSlug, constraints
 *   - emitProgress: progress emitter
 *
 * Returns: { followupQuery, rankedQuestions, deepArticles, analyses } or null
 *          when nothing useful was collected.
 */
export async function runDeepFollowup({
  promptResults, articleHarvester, articleAnalyzer,
  topic, topicSlug, constraints,
  emitProgress = () => {},
  signal = null,
}) {
  const collected = collectOpenQuestions(promptResults);
  if (collected.length === 0) {
    console.log(`[openQuestionRecursion] no open questions surfaced — skipping deep follow-up`);
    return null;
  }
  const ranked = rankOpenQuestions(collected, { topN: TOP_K });
  if (ranked.length === 0) return null;
  console.log(`[openQuestionRecursion] ranked top ${ranked.length} open questions from ${collected.length} raw collected`);
  emitProgress(`🔁 thesis-deep: ranked ${ranked.length} top open questions from ${collected.length} surfaced`);

  const followupQuery = await buildDeepFollowupQuery(ranked, topic);
  if (!followupQuery) {
    console.log(`[openQuestionRecursion] LLM follow-up query synthesis failed — using simplest concat`);
    return { rankedQuestions: ranked, followupQuery: null, deepArticles: [], analyses: [] };
  }
  console.log(`[openQuestionRecursion] follow-up query: "${followupQuery}"`);
  emitProgress(`🔁 thesis-deep: harvesting follow-up — "${followupQuery.slice(0, 80)}"`);

  // Harvest 6-8 articles for the follow-up. Use the existing harvester API.
  // Phase 20N-fix — articleHarvester.harvest signature is
  //   harvest(prompt, opts)  — positional first arg, options second.
  // The original code passed everything in one object, which made `topic`
  // an object too and crashed downstream with
  //   "(topic || \"\").toLowerCase is not a function".
  let deepArticles = [];
  try {
    deepArticles = await articleHarvester.harvest(followupQuery, {
      topic,
      tier: "thesis-deep",
      limit: 8,
      signal,
    });
  } catch (err) {
    console.log(`[openQuestionRecursion] harvest failed: ${err.message}`);
    return { rankedQuestions: ranked, followupQuery, deepArticles: [], analyses: [] };
  }

  // Analyze each harvested article. We use the same per-article analyzer.
  const analyses = [];
  for (let i = 0; i < deepArticles.length; i++) {
    const article = deepArticles[i];
    try {
      const r = await articleAnalyzer.analyze({
        article,
        topic,
        topicSlug,
        promptIndex: "deep",      // string prompt index → renders as ".../deep/article-N.md"
        articleIndex: i + 1,
        constraints,
      });
      analyses.push({ ...r, article });
    } catch (err) {
      console.log(`[openQuestionRecursion] analyzer failed for deep-article-${i + 1}: ${err.message}`);
    }
  }
  emitProgress(`🔁 thesis-deep: ${analyses.length} follow-up articles analyzed`);

  return { rankedQuestions: ranked, followupQuery, deepArticles, analyses };
}

export const _internals = { questionKey, TOP_K };

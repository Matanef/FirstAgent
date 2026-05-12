// server/skills/deepResearch/promptPlanner.js
// Generate a tier-sized queue of search prompts from the topic + extracted keywords + related subjects.
// LLM-driven with deterministic fallback.

import { llm } from "../../tools/llm.js";
const SYNTH_MODEL = process.env.SYNTHESIZER_MODEL || "qwen2.5:7b";

// Tier → number of prompts (matches the plan).
// Phase 20N — `thesis-deep` matches `thesis` here (8 main-pipeline prompts).
// The "deep" part comes from the supplementary open-questions harvest that
// runs AFTER the main 8 prompts complete, not from more primary prompts.
const TIER_COUNTS = {
  article: 4,
  indepth: 5,
  research: 5,
  thesis: 8,
  "thesis-deep": 8
};

const ANGLES = [
  "Definitions and fundamentals",
  "Recent developments and trends",
  "Expert opinions and analysis",
  "Data, statistics, and evidence",
  "Controversies and debates",
  "Historical context",
  "Comparative analysis",
  "Future outlook"
];

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  return null;
}

/**
 * Build the prompt queue.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {object} args.extracted          keywordExtractor.extract() result
 * @param {Array<{slug,subject}>} args.relatedMatches  subjectMatcher.rank() top-N
 * @param {"article"|"indepth"|"research"|"thesis"|"thesis-deep"} args.tier
 * @returns {Promise<Array<{id:string, query:string, angle:string}>>}
 */
export async function build({ topic, extracted, relatedMatches = [], tier = "article" }) {
  const count = TIER_COUNTS[tier] || TIER_COUNTS.article;
  const phrases = (extracted?.phrases || []).slice(0, 5);
  const relatedTopics = relatedMatches.map(m => m.subject?.topic).filter(Boolean).slice(0, 3);

  // Deterministic seed — each query uses a SINGLE modifier (multi-word "X and Y"
  // modifiers act as boolean-AND for some search backends, narrowing to ~zero).
  // Ordered so the most useful angles come first — important for lower tiers
  // capped at 4-5 prompts.
  const seed = [
    topic,                       // p1: bare topic
    `${topic} review`,           // p2: existing literature
    `${topic} meta-analysis`,    // p3: aggregate evidence
    `${topic} efficacy`,         // p4: does it work
    `${topic} applications`,     // p5: where used
    `${topic} criticism`,        // p6: pushback
    `${topic} history`,          // p7: background
    `${topic} statistics`        // p8: data
  ];

  // High-quality phrases from the keywordExtractor get inserted as additional
  // seed candidates. Multi-word phrases (2+ words) tend to be more discriminative
  // than the angle suffixes — push them in slots 1-3 (after the bare topic).
  const phraseSeeds = phrases
    .filter(p => p && typeof p === "string" && p.split(/\s+/).length >= 2)
    .filter(p => p.toLowerCase() !== (topic || "").toLowerCase())
    .slice(0, 2);
  if (phraseSeeds.length > 0) {
    seed.splice(1, 0, ...phraseSeeds);
  }

  // LLM pass — diverse sub-questions. If we get any valid queries, use them
  // first; if we got fewer than `count`, top up with seed queries.
  const llmQueries = await diversifyViaLLM(topic, phrases, relatedTopics, count);
  let finalQueries;
  if (llmQueries && llmQueries.length > 0) {
    if (llmQueries.length >= count) {
      finalQueries = llmQueries.slice(0, count);
    } else {
      // Top up with seed queries that aren't already in llmQueries
      const existing = new Set(llmQueries.map(q => q.toLowerCase()));
      const filler = seed.filter(q => !existing.has(q.toLowerCase()));
      finalQueries = [...llmQueries, ...filler].slice(0, count);
      console.log(`[promptPlanner] LLM gave ${llmQueries.length}/${count} queries; topped up with ${count - llmQueries.length} seed queries`);
    }
  } else {
    finalQueries = seed.slice(0, count);
    console.log(`[promptPlanner] LLM diversify failed/empty — using deterministic seed`);
  }

  return finalQueries.map((q, i) => ({
    id: `p${i + 1}`,
    query: q,
    angle: ANGLES[i] || "General"
  }));
}

/**
 * Validate a generated sub-question. Reject AND-modifiers, near-duplicates of
 * the topic, and queries outside the 2-8 word band.
 */
function isValidSubQuery(q, topic) {
  if (!q || typeof q !== "string") return false;
  const trimmed = q.trim().replace(/^["'`]|["'`]$/g, "");
  if (!trimmed) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 2 || wordCount > 8) return false;
  // " and " / " & " in the middle of a phrase usually indicates a boolean-AND
  // modifier that narrows search results to ~zero.
  if (/\s+(and|&)\s+/i.test(trimmed)) return false;
  if (trimmed.toLowerCase() === (topic || "").toLowerCase()) return false;
  return true;
}

async function diversifyViaLLM(topic, phrases, relatedTopics, count) {
  const phrasesLine = phrases.length ? phrases.join(" • ") : "(none extracted)";
  const relatedLine = relatedTopics.length ? relatedTopics.join(" • ") : "(none)";

  // Two worked examples — give the LLM concrete demonstrations of "good"
  // sub-question generation across two distinct domains so it doesn't
  // over-fit to a single field.
  const examples = `
WORKED EXAMPLE 1 — for topic "cognitive behavioral therapy":
[
  "CBT efficacy meta-analysis",
  "CBT for PTSD veterans",
  "CBT vs SSRI depression",
  "internet-delivered CBT",
  "CBT homework adherence",
  "third-wave CBT critique",
  "group CBT adolescents",
  "CBT chronic pain"
]

WORKED EXAMPLE 2 — for topic "quantum computing":
[
  "quantum error correction",
  "superconducting qubits",
  "quantum supremacy benchmarks",
  "post-quantum cryptography",
  "variational quantum algorithms",
  "trapped-ion quantum gates",
  "quantum hardware noise",
  "NISQ era applications"
]`;

  const prompt = `You are planning a multi-source academic literature search.

TOPIC: "${topic}"

Sub-concepts/aspects extracted from the user's request: ${phrasesLine}
Related subjects already in the knowledge base: ${relatedLine}

Your job: generate exactly ${count} DISTINCT search queries that probe DIFFERENT
sub-areas, populations, applications, methods, or controversies within this topic.
Each query should target a substantially different research thread that has its
own academic literature.

PREFER:
- Topic + specific population:       "CBT for PTSD veterans"
- Topic + specific comparison:       "CBT vs SSRI depression"
- Topic + specific method/setting:   "group CBT adolescents"
- Topic + specific outcome metric:   "CBT homework adherence"
- Topic + specific controversy:      "third-wave CBT critique"

AVOID:
- Multi-word boolean-AND modifiers ("controversies and debates", "history and background") — these narrow search to ~zero results.
- Vague single suffixes ("review", "analysis") on their own — too broad to differentiate prompts.
- Restating the topic verbatim (the harvester already runs the bare topic as p1).
${examples}

RULES:
- Each query: 2-6 words.
- Preserve the original topic language (do not translate).
- ${count} queries, no duplicates, no quotes around the query.
- Return JSON only.

Output schema: { "queries": ["string", ...] }`;

  try {
    const res = await llm(prompt, {
      timeoutMs: 25000,
      format: "json",
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.55, num_ctx: 4096 }
    });
    const parsed = safeJsonParse(res?.data?.text || "");
    let raw = [];
    if (parsed && Array.isArray(parsed.queries)) raw = parsed.queries;
    else if (Array.isArray(parsed)) raw = parsed;
    else return null;

    // Validate + dedupe
    const seen = new Set();
    const cleaned = [];
    for (const q of raw) {
      const s = String(q || "").trim().replace(/^["'`]|["'`]$/g, "");
      if (!isValidSubQuery(s, topic)) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(s);
    }
    if (cleaned.length > 0) {
      console.log(`[promptPlanner] LLM diversify: ${cleaned.length}/${raw.length} queries kept after validation → ${JSON.stringify(cleaned.slice(0, count))}`);
    }
    return cleaned.length > 0 ? cleaned : null;
  } catch {}
  return null;
}

export const TIER_COUNTS_EXPORTED = TIER_COUNTS;

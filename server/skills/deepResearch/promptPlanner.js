// server/skills/deepResearch/promptPlanner.js
// Generate a tier-sized queue of search prompts from the topic + extracted keywords + related subjects.
// LLM-driven with deterministic fallback.

import { llm } from "../../tools/llm.js";

// Tier → number of prompts (matches the plan).
const TIER_COUNTS = {
  article: 3,
  indepth: 4,
  research: 4,
  thesis: 8
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
 * @param {"article"|"indepth"|"research"|"thesis"} args.tier
 * @returns {Promise<Array<{id:string, query:string, angle:string}>>}
 */
export async function build({ topic, extracted, relatedMatches = [], tier = "article" }) {
  const count = TIER_COUNTS[tier] || TIER_COUNTS.article;
  const phrases = (extracted?.phrases || []).slice(0, 5);
  const relatedTopics = relatedMatches.map(m => m.subject?.topic).filter(Boolean).slice(0, 3);

  // LLM pass — diverse angles
  const llmQueries = await diversifyViaLLM(topic, phrases, relatedTopics, count);
  if (llmQueries && llmQueries.length >= count) {
    return llmQueries.slice(0, count).map((q, i) => ({
      id: `p${i + 1}`,
      query: q,
      angle: ANGLES[i] || "General"
    }));
  }

  // Deterministic fallback
  const seed = [
    topic,
    `${topic} latest research`,
    `${topic} analysis`,
    `${topic} expert opinion`,
    `${topic} history and background`,
    `${topic} controversies and debates`,
    `${topic} data and statistics`,
    `${topic} future trends`
  ];
  return seed.slice(0, count).map((q, i) => ({
    id: `p${i + 1}`,
    query: q,
    angle: ANGLES[i] || "General"
  }));
}

async function diversifyViaLLM(topic, phrases, relatedTopics, count) {
  const phraseHint = phrases.length ? `Key phrases the user implied: ${phrases.join(", ")}.` : "";
  const relatedHint = relatedTopics.length ? `Related topics already in the knowledge base: ${relatedTopics.join("; ")}.` : "";

  const prompt = `Generate exactly ${count} diverse search queries for researching: "${topic}"

${phraseHint}
${relatedHint}

Each query should target a distinct angle:
${ANGLES.slice(0, count).map((a, i) => `${i + 1}. ${a}`).join("\n")}

Rules:
- Each query is 4–12 words.
- Preserve the original topic language (do not translate).
- No duplicates.
- Return JSON only.

Output schema: { "queries": ["string", ...] }`;

  try {
    const res = await llm(prompt, {
      timeoutMs: 20000,
      format: "json",
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.5, num_ctx: 2048 }
    });
    const parsed = safeJsonParse(res?.data?.text || "");
    if (parsed && Array.isArray(parsed.queries)) {
      return parsed.queries.map(q => String(q || "").trim()).filter(q => q.length > 0);
    }
    if (Array.isArray(parsed)) {
      return parsed.map(q => String(q || "").trim()).filter(q => q.length > 0);
    }
  } catch {}
  return null;
}

export const TIER_COUNTS_EXPORTED = TIER_COUNTS;

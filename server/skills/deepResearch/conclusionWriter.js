// server/skills/deepResearch/conclusionWriter.js
// Per-prompt conclusion writer. Given the article analyses for one prompt:
//   1. LLM pass to extract commonalities, contradictions, and lines of reasoning.
//   2. Build a per-prompt vector collection (research-{slug}-p{N}-articles) for later RAG.
//   3. Write {VAULT_JOURNAL_ROOT}/Research/{topicSlug}/{N}/conclusion.md.

import { llm } from "../../tools/llm.js";
import { writeNote, buildFrontmatter, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";
import {
  createCollection,
  addDocument,
  deleteCollection
} from "../../utils/vectorStore.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("conclusionWriter", { consoleLevel: "warn" });

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * Build the per-prompt vector collection name.
 */
export function articlesCollectionName(topicSlug, promptIndex) {
  return `research-${topicSlug}-p${promptIndex}-articles`;
}

/**
 * Write the conclusion for one prompt + index article analyses into a vector collection.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.topicSlug
 * @param {number} args.promptIndex
 * @param {object} args.promptSpec               { id, query, angle }
 * @param {Array}  args.analyses                 articleAnalyzer.analyze() results: {relativePath, analysis, frontmatter}
 * @param {object} args.constraints
 * @returns {Promise<{relativePath:string, conclusion:object, collectionName:string}>}
 */
export async function write({ topic, topicSlug, promptIndex, promptSpec, analyses, constraints }) {
  // Build the vector collection (delete old if same name, then re-create — we
  // own this prompt's slot for this run).
  const collectionName = articlesCollectionName(topicSlug, promptIndex);
  try { deleteCollection(collectionName); } catch {}
  createCollection(collectionName);

  for (const a of analyses) {
    const meta = a.frontmatter || {};
    // Phase 3A — richer RAG blob: include entities and key facts so vector search
    // can match on specific names, numbers, and findings — not just the summary sentence.
    const entitiesLine = (a.analysis.entities || []).length
      ? `\nKey entities: ${a.analysis.entities.join(", ")}`
      : "";
    const factsBlock = (a.analysis.facts || []).map(f => `- ${f}`).join("\n");
    const blob = [
      `Title: ${(meta.title || "").replace(/^"|"$/g, "")}`,
      `Summary: ${a.analysis.summary}`,
      entitiesLine,
      factsBlock ? `\nFacts:\n${factsBlock}` : ""
    ].filter(Boolean).join("\n");

    try {
      await addDocument(collectionName, blob, {
        title: meta.title,
        url: meta.url,
        domain: meta.domain,
        source: meta.source,
        relevance: a.analysis.relevance,
        stance: a.analysis.stance,
        entities: a.analysis.entities || [],
        facts: (a.analysis.facts || []).slice(0, 5),
        articlePath: a.relativePath,
        // Phase 3A — include paper upgrade metadata so RAG knows if this came from a real paper
        paper_url:    meta.paper_url || null,
        paper_doi:    meta.paper_doi || null,
        promptIndex
      });
    } catch (err) {
      log(`addDocument failed for ${meta.url}: ${err.message}`, "warn");
    }
  }

  // LLM-extracted commonalities / contradictions / reasoning.
  const conclusion = await synthesizeConclusion(topic, promptSpec, analyses);

  // Write conclusion.md
  const fm = buildFrontmatter({
    title: `"Conclusion: ${promptSpec.query}"`,
    type: "research-prompt-conclusion",
    parent: `[[${topicSlug}]]`,
    prompt: promptIndex,
    angle: promptSpec.angle || "",
    query: promptSpec.query,
    article_count: analyses.length,
    avg_relevance: avg(analyses.map(a => a.analysis.relevance)),
    created: new Date().toISOString(),
    tags: ["research-conclusion", topicSlug]
  });

  const articleLinks = analyses.map((a, i) => `- [[${a.relativePath.replace(/\.md$/, "")}|Article ${i + 1}: ${(a.frontmatter?.title || "").replace(/^"|"$/g, "")}]]`).join("\n");

  const body = `# Conclusion — Prompt ${promptIndex}: ${promptSpec.query}

> [!summary] What this prompt established
> ${conclusion.summary || "_(no summary)_"}

## Commonalities across sources
${formatList(conclusion.commonalities)}

## Contradictions and disagreements
${formatList(conclusion.contradictions)}

## Lines of reasoning
${formatList(conclusion.reasoning)}

## Open questions surfaced
${formatList(conclusion.openQuestions)}

## Source articles (${analyses.length})
${articleLinks || "_(none)_"}
`;

  const relativePath = `${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${promptIndex}/conclusion.md`;
  await writeNote(relativePath, fm + body);

  return { relativePath, conclusion, collectionName };
}

async function synthesizeConclusion(topic, promptSpec, analyses) {
  // Phase 2F — exclude articles that failed all LLM analysis attempts
  const usable = analyses.filter(a => a.analysis?.quality !== "failed");
  if (usable.length === 0) {
    const failedCount = analyses.length - usable.length;
    log(`synthesizeConclusion: all ${failedCount} analyses are quality=failed for prompt "${promptSpec.query}"`, "warn");
    return { summary: "No usable sources were found for this prompt.", commonalities: [], contradictions: [], reasoning: [], openQuestions: [] };
  }
  if (usable.length < analyses.length) {
    log(`synthesizeConclusion: excluded ${analyses.length - usable.length} quality=failed analyses, using ${usable.length}/${analyses.length}`, "warn");
  }

  const blocks = usable.map((a, i) => {
    const t = a.frontmatter?.title?.replace(/^"|"$/g, "") || `Article ${i + 1}`;
    const facts = (a.analysis.facts || []).slice(0, 5).map(f => `  - ${f}`).join("\n");
    return `[Article ${i + 1}] ${t}\n  Summary: ${a.analysis.summary}\n  Stance: ${a.analysis.stance}\n  Facts:\n${facts}`;
  }).join("\n\n");

  const prompt = `Research topic: "${topic}"
Prompt under review: "${promptSpec.query}" (angle: ${promptSpec.angle || "general"})

Source analyses:
"""
${blocks.slice(0, 5500)}
"""

Identify across these sources:
- summary: 1–2 sentences capturing what this prompt's evidence collectively shows
- commonalities: 2–6 claims that multiple sources agree on
- contradictions: 0–4 explicit disagreements between sources (include source numbers if possible)
- reasoning: 2–5 logical chains that connect the evidence to conclusions
- openQuestions: 0–4 questions the evidence did NOT answer

Return JSON only:
{
  "summary": "string",
  "commonalities": ["string", ...],
  "contradictions": ["string", ...],
  "reasoning": ["string", ...],
  "openQuestions": ["string", ...]
}`;

  try {
    const res = await llm(prompt, {
      timeoutMs: 45000,
      format: "json",
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 8192 }
    });
    const parsed = safeJsonParse(res?.data?.text || "");
    if (parsed && typeof parsed === "object") {
      return {
        summary:        String(parsed.summary || "").trim(),
        commonalities:  arrOf(parsed.commonalities),
        contradictions: arrOf(parsed.contradictions),
        reasoning:      arrOf(parsed.reasoning),
        openQuestions:  arrOf(parsed.openQuestions)
      };
    }
  } catch {}

  // Fallback: build a very basic summary
  return {
    summary: `Synthesis failed; ${analyses.length} sources collected for "${promptSpec.query}".`,
    commonalities: [],
    contradictions: [],
    reasoning: [],
    openQuestions: []
  };
}

function arrOf(x) { return Array.isArray(x) ? x.map(s => String(s || "").trim()).filter(Boolean) : []; }
function avg(xs) { if (!xs.length) return 0; return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)); }
function formatList(xs) { return (xs && xs.length) ? xs.map(x => `- ${x}`).join("\n") : "_(none)_"; }

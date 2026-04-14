// server/skills/deepResearch/articleAnalyzer.js
// Per-article LLM analysis pass. For each harvested article:
//   1. Extract 3–7 facts + 1-line summary + relevance score (LLM, format:'json' best-effort)
//   2. Write a Markdown note with frontmatter to: {VAULT_JOURNAL_ROOT}/Research/{topicSlug}/{N}/article-{K}.md
//   3. Return a structured analysis object for downstream synthesis

import { llm } from "../../tools/llm.js";
import { writeNote, buildFrontmatter, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * Analyze a single article via LLM and write the per-article note.
 *
 * @param {object} args
 * @param {object} args.article       harvest() result item
 * @param {string} args.topic
 * @param {string} args.topicSlug
 * @param {number} args.promptIndex   1-based prompt number
 * @param {number} args.articleIndex  1-based article number within the prompt
 * @param {object} args.constraints   loadAgentConstraints() result
 * @returns {Promise<{relativePath:string, analysis:object, frontmatter:object}>}
 */
export async function analyze({ article, topic, topicSlug, promptIndex, articleIndex, constraints }) {
  const minFacts = constraints?.research?.minFactsPerArticle || 3;
  const text = (article.content || "").slice(0, 3500);

  const prompt = `Analyze this source for the research topic "${topic}".

Source title: ${article.title}
Source URL: ${article.url}

Source text:
"""
${text}
"""

Tasks:
1. Extract ${minFacts}-7 specific factual claims, statistics, or definitions relevant to the topic. If the source is irrelevant, return relevance=0 and empty facts.
2. Write a 1-sentence summary capturing the source's contribution.
3. Score relevance to "${topic}" on a 0-1 scale.
4. List up to 5 named entities mentioned (people, organizations, products, places).

Return JSON only:
{
  "summary": "string (1 sentence)",
  "relevance": 0.0,
  "facts": ["string", ...],
  "entities": ["string", ...],
  "stance": "supportive | critical | neutral | mixed"
}`;

  let analysis = null;
  try {
    const res = await llm(prompt, {
      timeoutMs: 30000,
      format: "json",
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.2, num_ctx: 4096 }
    });
    analysis = safeJsonParse(res?.data?.text || "");
  } catch {}

  if (!analysis || typeof analysis !== "object") {
    analysis = { summary: "(analysis unavailable)", relevance: 0.5, facts: [], entities: [], stance: "neutral" };
  }
  // Normalize
  analysis.summary  = String(analysis.summary || "").trim() || "(no summary)";
  analysis.relevance = clamp01(analysis.relevance);
  analysis.facts    = Array.isArray(analysis.facts) ? analysis.facts.map(s => String(s || "").trim()).filter(Boolean).slice(0, 7) : [];
  analysis.entities = Array.isArray(analysis.entities) ? analysis.entities.map(s => String(s || "").trim()).filter(Boolean).slice(0, 5) : [];
  analysis.stance   = ["supportive", "critical", "neutral", "mixed"].includes(analysis.stance) ? analysis.stance : "neutral";

  // Build the markdown note
  const frontmatterFields = {
    title: `"${article.title.replace(/"/g, "'")}"`,
    type: "research-source",
    parent: `[[${topicSlug}]]`,
    prompt: promptIndex,
    article: articleIndex,
    url: article.url,
    domain: article.domain || "",
    source: article.source || "",
    relevance: analysis.relevance,
    stance: analysis.stance,
    fetched: article.fetchedAt || new Date().toISOString(),
    tags: ["research-source", topicSlug, article.source || "unknown"].filter(Boolean)
  };
  const fm = buildFrontmatter(frontmatterFields);

  const factsBlock = analysis.facts.length
    ? analysis.facts.map(f => `- ${f}`).join("\n")
    : "_No discrete facts extracted._";
  const entitiesBlock = analysis.entities.length
    ? analysis.entities.map(e => `\`${e}\``).join(" · ")
    : "_(none)_";

  const body = `# ${article.title}

> [!info] Source metadata
> - **URL:** <${article.url}>
> - **Domain:** ${article.domain || "n/a"}
> - **Provider:** ${article.source || "unknown"}
> - **Relevance to "${topic}":** ${(analysis.relevance * 100).toFixed(0)}%
> - **Stance:** ${analysis.stance}

## Summary
${analysis.summary}

## Extracted facts
${factsBlock}

## Named entities
${entitiesBlock}

## Raw excerpt (first 1500 chars)
\`\`\`
${(article.content || "").slice(0, 1500).replace(/```/g, "ʼʼʼ")}
\`\`\`
`;

  const relativePath = `${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${promptIndex}/article-${articleIndex}.md`;
  await writeNote(relativePath, fm + body);

  return { relativePath, analysis, frontmatter: frontmatterFields };
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

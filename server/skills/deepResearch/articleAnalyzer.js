// server/skills/deepResearch/articleAnalyzer.js
// Per-article LLM analysis pass. For each harvested article:
//   1. Extract 3–7 facts + 1-line summary + relevance score (LLM, format:'json' best-effort)
//   2. Write a Markdown note with frontmatter to: {VAULT_JOURNAL_ROOT}/Research/{topicSlug}/{N}/article-{K}.md
//   3. Return a structured analysis object for downstream synthesis

import { llm } from "../../tools/llm.js";
import { writeNote, buildFrontmatter, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";
import { upgradeArticle, chunkText } from "./paperUpgrader.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("articleAnalyzer", { consoleLevel: "warn" });

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
  const thinMinChars = constraints?.research?.thinArticleMinChars || 800;
  const thinMinFacts = constraints?.research?.thinArticleMinFacts || 2;

  // Phase 2B/2C — thin-article detection: try to upgrade to the real paper
  // before running the analysis.
  let activeArticle = article;
  let upgraded = false;
  const contentLen = (article.content || "").length;
  if (contentLen < thinMinChars) {
    log(`Thin article (${contentLen} chars) — attempting paper upgrade: ${article.url}`, "info");
    try {
      const up = await upgradeArticle(article);
      if (up && up.content && up.content.length > contentLen) {
        log(`Upgraded "${article.title?.slice(0, 60)}" via ${up.source} (${up.content.length} chars, doi=${up.doi || "n/a"})`, "info");
        activeArticle = {
          ...article,
          content: up.content,
          upgradedPdfUrl: up.pdfUrl,
          upgradedDoi:    up.doi,
          upgradedSource: up.source
        };
        upgraded = true;
      }
    } catch (err) {
      log(`upgradeArticle failed for ${article.url}: ${err.message}`, "warn");
    }
  }

  // Phase 2E — chunk large content and analyze each piece, merging facts.
  const fullText = String(activeArticle.content || "");
  const chunks   = chunkText(fullText, 3800, 400);
  const multiChunk = chunks.length > 1;

  if (multiChunk) {
    log(`Chunked analysis: ${chunks.length} chunks for "${article.title?.slice(0, 60)}"`, "info");
  }

  /**
   * Analyze one text segment. Returns a raw analysis object.
   */
  async function analyzeChunk(chunkText, chunkIdx) {
    const analysisPrompt = `Analyze this source excerpt (${multiChunk ? `chunk ${chunkIdx + 1}/${chunks.length}` : "full text"}) for the research topic "${topic}".

Source title: ${activeArticle.title}
Source URL: ${activeArticle.url}

Source text:
"""
${chunkText}
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

    // Phase 2F — first attempt
    try {
      const res = await llm(analysisPrompt, {
        timeoutMs: 30000,
        format: "json",
        skipKnowledge: true,
        skipLanguageDetection: true,
        options: { temperature: 0.2, num_ctx: 4096 }
      });
      const parsed = safeJsonParse(res?.data?.text || "");
      if (parsed) return parsed;
    } catch (err) {
      const isTimeout = /aborted|timed? ?out|timeout/i.test(err.message || "");
      if (isTimeout) {
        log(`analyzeChunk timeout chunk=${chunkIdx}, retrying with smaller ctx`, "warn");
      } else {
        log(`analyzeChunk error chunk=${chunkIdx}: ${err.message}`, "warn");
        return null; // non-transient — don't retry
      }
    }
    // Phase 2F — one retry with reduced context and lower temperature
    try {
      const res = await llm(analysisPrompt, {
        timeoutMs: 25000,
        format: "json",
        skipKnowledge: true,
        skipLanguageDetection: true,
        options: { temperature: 0.15, num_ctx: 3072 }
      });
      return safeJsonParse(res?.data?.text || "");
    } catch (err) {
      log(`analyzeChunk retry also failed chunk=${chunkIdx}: ${err.message}`, "warn");
      return null;
    }
  }

  // Run analysis on each chunk sequentially (respect 7B model limits)
  const chunkResults = [];
  for (let i = 0; i < chunks.length; i++) {
    const r = await analyzeChunk(chunks[i], i);
    if (r && typeof r === "object") chunkResults.push(r);
  }

  // Merge chunk results into a single analysis object
  let analysis = null;
  if (chunkResults.length > 0) {
    const allFacts    = [...new Set(chunkResults.flatMap(r => arrOf(r.facts)))].slice(0, 10);
    const allEntities = [...new Set(chunkResults.flatMap(r => arrOf(r.entities)))].slice(0, 8);
    const avgRelevance = chunkResults.reduce((sum, r) => sum + (Number(r.relevance) || 0), 0) / chunkResults.length;
    // Prefer the summary from the highest-relevance chunk
    const bestChunk   = chunkResults.reduce((best, r) => (Number(r.relevance) || 0) > (Number(best.relevance) || 0) ? r : best, chunkResults[0]);
    const stances     = chunkResults.map(r => r.stance).filter(Boolean);
    const stanceCounts = {};
    for (const s of stances) stanceCounts[s] = (stanceCounts[s] || 0) + 1;
    const dominantStance = Object.entries(stanceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "neutral";

    analysis = {
      summary:   String(bestChunk.summary || "").trim() || "(no summary)",
      relevance: avgRelevance,
      facts:     allFacts,
      entities:  allEntities,
      stance:    dominantStance
    };
  }

  if (!analysis || typeof analysis !== "object") {
    // Phase 2F — mark as failed so conclusionWriter can exclude from synthesis
    analysis = { summary: "(analysis unavailable)", relevance: 0, facts: [], entities: [], stance: "neutral", quality: "failed" };
    log(`All chunk analyses failed for "${article.title?.slice(0, 60)}" — marking quality=failed`, "warn");
  }

  // Normalize
  analysis.summary   = String(analysis.summary  || "").trim() || "(no summary)";
  analysis.relevance = clamp01(analysis.relevance);
  analysis.facts     = Array.isArray(analysis.facts) ? analysis.facts.map(s => String(s || "").trim()).filter(Boolean).slice(0, 10) : [];
  analysis.entities  = Array.isArray(analysis.entities) ? analysis.entities.map(s => String(s || "").trim()).filter(Boolean).slice(0, 8) : [];
  analysis.stance    = ["supportive", "critical", "neutral", "mixed"].includes(analysis.stance) ? analysis.stance : "neutral";

  // Phase 2C: if facts are still too thin after analysis, try upgrade now (post-analysis)
  if (!upgraded && analysis.facts.length < thinMinFacts && analysis.relevance < 0.3) {
    log(`Post-analysis upgrade attempt (facts=${analysis.facts.length} relevance=${analysis.relevance.toFixed(2)}): ${article.url}`, "info");
    try {
      const up = await upgradeArticle(article);
      if (up && up.content && up.content.length > contentLen) {
        log(`Post-analysis upgrade succeeded via ${up.source}`, "info");
        // Quick single-chunk re-analyze
        const reanalysis = await analyzeChunk(up.content.slice(0, 3800), 0);
        if (reanalysis && Array.isArray(reanalysis.facts) && reanalysis.facts.length > analysis.facts.length) {
          analysis = {
            summary:   String(reanalysis.summary || "").trim() || analysis.summary,
            relevance: clamp01(reanalysis.relevance) || analysis.relevance,
            facts:     [...new Set([...analysis.facts, ...arrOf(reanalysis.facts)])].slice(0, 10),
            entities:  [...new Set([...analysis.entities, ...arrOf(reanalysis.entities)])].slice(0, 8),
            stance:    reanalysis.stance || analysis.stance
          };
          activeArticle = { ...article, content: up.content, upgradedPdfUrl: up.pdfUrl, upgradedDoi: up.doi };
          upgraded = true;
        }
      }
    } catch (err) {
      log(`Post-analysis upgradeArticle failed: ${err.message}`, "warn");
    }
  }

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
    tags: ["research-source", topicSlug, article.source || "unknown"].filter(Boolean),
    ...(upgraded && activeArticle.upgradedPdfUrl ? {
      paper_url:    activeArticle.upgradedPdfUrl,
      paper_doi:    activeArticle.upgradedDoi || null,
      paper_source: activeArticle.upgradedSource || "pdf"
    } : {}),
    chunk_count: chunks.length
  };
  const fm = buildFrontmatter(frontmatterFields);

  const factsBlock = analysis.facts.length
    ? analysis.facts.map(f => `- ${f}`).join("\n")
    : "_No discrete facts extracted._";
  const entitiesBlock = analysis.entities.length
    ? analysis.entities.map(e => `\`${e}\``).join(" · ")
    : "_(none)_";

  const upgradeCallout = upgraded && activeArticle.upgradedPdfUrl
    ? `\n> [!success] Paper upgraded\n> Original article was thin. Fetched underlying ${activeArticle.upgradedSource === "pdf" ? "PDF" : "full-text"} via ${activeArticle.upgradedDoi ? `DOI \`${activeArticle.upgradedDoi}\`` : activeArticle.upgradedPdfUrl}.\n`
    : "";

  const chunkNote = chunks.length > 1
    ? `\n> [!note] Large source — analyzed in ${chunks.length} chunks\n`
    : "";

  const body = `# ${article.title}
${upgradeCallout}${chunkNote}
> [!info] Source metadata
> - **URL:** <${article.url}>
> - **Domain:** ${article.domain || "n/a"}
> - **Provider:** ${article.source || "unknown"}
> - **Relevance to "${topic}":** ${(analysis.relevance * 100).toFixed(0)}%
> - **Stance:** ${analysis.stance}${upgraded && activeArticle.upgradedPdfUrl ? `\n> - **Paper PDF:** <${activeArticle.upgradedPdfUrl}>` : ""}

## Summary
${analysis.summary}

## Extracted facts
${factsBlock}

## Named entities
${entitiesBlock}

## Raw excerpt (first 1500 chars)
\`\`\`
${(activeArticle.content || article.content || "").slice(0, 1500).replace(/```/g, "ʼʼʼ")}
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

function arrOf(x) {
  return Array.isArray(x) ? x.map(s => String(s || "").trim()).filter(Boolean) : [];
}

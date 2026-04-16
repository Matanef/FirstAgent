// server/skills/deepResearch/thesisSynthesizer.js
// Chunked academic synthesis. Outline → section-by-section, with per-section RAG over
// the conclusions vector collection. Post-pass: third-person lint + targeted rewrite +
// deterministic bibliography.

import { llm } from "../../tools/llm.js";
import { writeNote, buildFrontmatter, resolveWikilinks, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("thesisSynthesizer", { consoleLevel: "warn" });
import {
  createCollection,
  addDocument,
  search as vectorSearch,
  deleteCollection
} from "../../utils/vectorStore.js";
import {
  TIER_BUDGETS,
  buildOutlineSections,
  sectionPrompt,
  lint,
  buildBibliography,
  aiUsageFooter,
  wordCount
} from "../../utils/writingRules.js";

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export function conclusionsCollectionName(topicSlug) {
  return `research-${topicSlug}-conclusions`;
}

/**
 * Index per-prompt conclusions into a vector collection so each section can RAG over them.
 *
 * @param {string} topicSlug
 * @param {Array}  promptResults   [{promptIndex, promptSpec, conclusion, relativePath}]
 * @returns {Promise<string>} collection name
 */
export async function indexConclusions(topicSlug, promptResults) {
  const name = conclusionsCollectionName(topicSlug);
  try { deleteCollection(name); } catch {}
  createCollection(name);
  for (const pr of promptResults) {
    const c = pr.conclusion || {};
    const blob = `Prompt ${pr.promptIndex}: ${pr.promptSpec.query}
Angle: ${pr.promptSpec.angle || ""}

Summary: ${c.summary || ""}

Commonalities:
${(c.commonalities || []).map(x => `- ${x}`).join("\n")}

Contradictions:
${(c.contradictions || []).map(x => `- ${x}`).join("\n")}

Reasoning chains:
${(c.reasoning || []).map(x => `- ${x}`).join("\n")}

Open questions:
${(c.openQuestions || []).map(x => `- ${x}`).join("\n")}`;
    // Phase 3A — richer metadata for section-level RAG:
    // Include article counts, entity roster, and fact samples so section
    // generation can retrieve the most relevant evidence per claim.
    const allEntities = [...new Set((pr.analyses || []).flatMap(a => a.analysis?.entities || []))].slice(0, 15);
    const topFacts    = (pr.analyses || []).flatMap(a => (a.analysis?.facts || []).slice(0, 2)).slice(0, 10);
    try {
      await addDocument(name, blob, {
        promptIndex: pr.promptIndex,
        query: pr.promptSpec.query,
        angle: pr.promptSpec.angle,
        conclusionPath: pr.conclusionPath || pr.relativePath,
        article_count: (pr.analyses || []).length,
        entities: allEntities,
        top_facts: topFacts
      });
    } catch (err) {
      log(`indexing prompt ${pr.promptIndex} failed: ${err.message}`, "warn");
    }
  }
  return name;
}

/**
 * Build the outline JSON. Falls back to a deterministic outline derived from
 * TIER_BUDGETS if the LLM JSON pass fails.
 */
export async function buildOutline({ topic, tier, promptResults }) {
  const baseSections = buildOutlineSections(tier);
  const conclusionDigest = promptResults.map(p =>
    `[Prompt ${p.promptIndex}] ${p.promptSpec.query}\n  Summary: ${(p.conclusion?.summary || "").slice(0, 250)}`
  ).join("\n\n").slice(0, 4000);

  const prompt = `Plan an academic ${tier}-tier write-up on "${topic}".

Required section list (use these IDs and headings exactly, in this order):
${baseSections.map(s => `- id="${s.id}" heading="${s.heading}" word_budget=${s.word_budget}`).join("\n")}

Per-prompt conclusions to draw from:
${conclusionDigest}

For each section, return:
- thesis_claim: ONE specific arguable claim that the section will defend (1 sentence)
- source_prompt_ids: which prompt numbers (e.g. [1,3]) primarily inform this section

Return JSON only, in this exact shape:
{
  "title": "string",
  "abstract_hint": "string (1 sentence)",
  "sections": [
    { "id": "intro", "heading": "Introduction", "word_budget": 250, "thesis_claim": "...", "source_prompt_ids": [1] }
  ]
}`;

  let parsed = null;
  try {
    // 90s timeout — outline is critical for per-section thesis claims; qwen2.5:7b + JSON mode
    // commonly takes 30-45s on local hardware, and 35s was below the floor causing silent fallback.
    const res = await llm(prompt, {
      timeoutMs: 90000,
      format: "json",
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 6000 }
    });
    parsed = safeJsonParse(res?.data?.text || "");
  } catch {}

  if (!parsed || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    parsed = {
      title: topic,
      abstract_hint: `Comprehensive ${tier} on ${topic}`,
      sections: baseSections.map(s => ({ ...s, thesis_claim: "", source_prompt_ids: [] }))
    };
  }

  // Heal: ensure outline contains every required section in order.
  const byId = new Map((parsed.sections || []).map(s => [s.id, s]));
  parsed.sections = baseSections.map(s => ({
    ...s,
    thesis_claim: byId.get(s.id)?.thesis_claim || "",
    source_prompt_ids: Array.isArray(byId.get(s.id)?.source_prompt_ids) ? byId.get(s.id).source_prompt_ids : []
  }));

  return parsed;
}

/**
 * Synthesize one section.
 */
async function writeSection({ topic, tier, section, prevSummaries, constraints, knownCitationUrls, conclusionsCollection }) {
  // RAG over conclusions
  let snippets = [];
  if (conclusionsCollection) {
    try {
      const results = await vectorSearch(conclusionsCollection, section.thesis_claim || section.heading, 4);
      snippets = results.map(r => r.text);
    } catch (err) {
      log(`vector search failed for section ${section.id}: ${err.message}`, "warn");
    }
  }

  const prompt = sectionPrompt({
    topic,
    tier,
    section,
    relevantSnippets: snippets,
    previousHeadings: prevSummaries,
    constraints,
    knownCitationUrls
  });

// Force the local LLM to expand the text and use Obsidian syntax
const expansionDirectives = `\n\nCRITICAL STRUCTURE RULES FOR THIS SECTION:
- Length: You MUST write at least ${constraints.writing.minParagraphsPerSection || 3} dense paragraphs.
- Bullets: You MUST include exactly ${constraints.writing.minBulletsPerSection || 5} technical bullet points.
- Obsidian Links: You MUST wrap at least 4 important domain concepts in double brackets to create wikilinks. Example: "The effects of [[Gravitational Lensing]] on..."
- Tone: ${constraints.writing.tone}. Target: ${section.word_budget} words.
- Focus strictly on the domains: ${constraints.research.domainLock?.join(", ")}.`;

const finalPrompt = prompt + expansionDirectives;

  try {
    const res = await llm(finalPrompt, {
      timeoutMs: 90000,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.35, num_ctx: 8192 }
    });
    return String(res?.data?.text || "").trim();
  } catch (err) {
    log(`section "${section.id}" write failed: ${err.message}`, "warn");
    return `_(synthesis failed for this section: ${err.message})_`;
  }
}

/**
 * Phase 1C — expand or trim a section to hit its word budget.
 *
 * Fires only when the draft is outside the [60%, 150%] window around the target.
 * One attempt; returns original text if the LLM call fails or produces nothing.
 *
 * @param {string} text         The section body already written.
 * @param {object} section      { heading, word_budget, thesis_claim }
 * @param {string} topic        Parent research topic.
 * @param {string} tier         Tier name.
 * @returns {Promise<string>}
 */
async function adjustSectionLength(text, section, topic, tier) {
  const current = wordCount(text);
  const target   = section.word_budget || 300;
  const ratio    = current / target;

  if (ratio >= 0.6 && ratio <= 1.5) return text; // within acceptable window

  const action = ratio < 0.6 ? "expand" : "trim";
  const delta  = Math.abs(target - current);

  const expandInstr = `The text is too short (${current} words, target ${target}).
Expand it by approximately ${delta} words. Add depth, examples, technical detail, and analysis.
Do NOT pad with filler — every added sentence must advance the argument.`;

  const trimInstr = `The text is too long (${current} words, target ${target}).
Trim approximately ${delta} words. Remove repetition, over-explanation, and weak filler sentences.
Preserve all key facts, citations, and technical content.`;

  const adjPrompt = `You are editing one section of an academic ${tier} on the topic: "${topic}".
Section heading: "${section.heading}"
Core claim: "${section.thesis_claim || "(see heading)"}"

${action === "expand" ? expandInstr : trimInstr}

Rules:
- Keep third-person voice only.
- Keep all [[wikilinks]] intact.
- Keep all citation URLs intact.
- Output ONLY the rewritten section body (no heading, no preamble).

Section text to ${action}:
"""
${text.slice(0, 6000)}
"""`;

  try {
    const res = await llm(adjPrompt, {
      timeoutMs: 90000,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 8192 }
    });
    const adjusted = String(res?.data?.text || "").trim();
    if (adjusted.length > 50) return adjusted;
  } catch (err) {
    log(`adjustSectionLength(${action}) failed for "${section.heading}": ${err.message}`, "warn");
  }
  return text;
}

/**
 * Targeted rewrite of a single offending paragraph (third-person violation).
 */
async function rewriteParagraph(paragraph, reason) {
  const prompt = `Rewrite the paragraph below to remove the issue: ${reason}.
Rules:
- Keep meaning, length (±20%), and academic tone identical.
- Use ONLY third-person voice (no I/we/our/my/us).
- No contractions.
- Output the rewritten paragraph ONLY, no preamble.

Paragraph:
"""
${paragraph}
"""`;
  try {
    const res = await llm(prompt, {
      timeoutMs: 30000,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.2, num_ctx: 2048 }
    });
    return String(res?.data?.text || "").trim() || paragraph;
  } catch {
    return paragraph;
  }
}

/**
 * Top-level synthesis driver.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.topicSlug
 * @param {string} args.tier
 * @param {Array}  args.promptResults
 * @param {object} args.constraints
 * @returns {Promise<{relativePath:string, wordCount:number, lintReport:object, vectorCollection:string}>}
 */
export async function synthesize({ topic, topicSlug, cleanTitle, tier, promptResults, constraints }) {
  // Final title precedence: caller-supplied cleanTitle (LLM-derived in orchestrator)
  // > outline's own title > raw topic. cleanTitle is what users see in the H1 + frontmatter.
  const finalTitle = (cleanTitle && cleanTitle.trim()) || topic;

  // 1. Build conclusions vector collection.
  const conclusionsCollection = await indexConclusions(topicSlug, promptResults);

  // 2. Build outline.
  const outline = await buildOutline({ topic, tier, promptResults });

  // 3. Collect known citation URLs from harvested article frontmatter (deterministic guardrail).
  const articleNotes = promptResults.flatMap(p => (p.analyses || []).map(a => a.frontmatter || {}));
  // Phase 3A — prefer upgraded paper URL; fall back to original article URL.
  // Both are registered as "known" so the lint pass doesn't strip them.
  const knownCitationUrls = [...new Set(
    articleNotes.flatMap(n => [n.paper_url, n.url].filter(Boolean))
  )];

  // 4. Section-by-section synthesis.
  const writtenSections = [];
  const prevSummaries = [];
  for (const section of outline.sections) {
    log(`step=writeSection id="${section.id}" heading="${section.heading}" budget=${section.word_budget}`, "info");
    let text = await writeSection({
      topic,
      tier,
      section,
      prevSummaries,
      constraints,
      knownCitationUrls,
      conclusionsCollection
    });
    const rawWords = wordCount(text);
    // Phase 1C: one expand/trim pass if section is significantly off budget
    text = await adjustSectionLength(text, section, topic, tier);
    const finalWords = wordCount(text);
    log(`step=writeSection id="${section.id}" done words=${finalWords} (raw=${rawWords} budget=${section.word_budget})`, "info");
    writtenSections.push({ section, text });
    // 1-line summary fed into the next section's anti-duplication context.
    const firstSentence = (text.match(/[^.!?]+[.!?]/) || [text.slice(0, 160)])[0].trim();
    prevSummaries.push({ heading: section.heading, summary_1liner: firstSentence });
  }

  // 5. Assemble draft.
  const headerFm = buildFrontmatter({
    title: `"${finalTitle}"`,
    type: "research-thesis",
    tier,
    parent: `[[${topicSlug}]]`,
    prompt_count: promptResults.length,
    article_count: articleNotes.length,
    created: new Date().toISOString(),
    tags: ["research-thesis", topicSlug, tier]
  });

  let draft = `# ${finalTitle}\n\n`;
  for (const { section, text } of writtenSections) {
    draft += `## ${section.heading}\n\n${text}\n\n`;
  }

  // 6. Bibliography (deterministic).
  draft += buildBibliography(articleNotes);

  // 7. AI usage footer for non-thesis tiers (thesis already gets its own section).
  if (TIER_BUDGETS[tier]?.aiAcknowledgment === "footer") {
    draft += aiUsageFooter();
  }

  // 8. Lint pass.
  let lintReport = lint(draft, { tier, knownUrls: knownCitationUrls });

  // 9. Targeted rewrite for first-person violations (one pass, capped).
  if (lintReport.offendingParagraphs.length > 0) {
    let rewritten = draft;
    for (const op of lintReport.offendingParagraphs.slice(0, 6)) {
      const replacement = await rewriteParagraph(op.paragraph, op.reason);
      if (replacement && replacement !== op.paragraph) {
        rewritten = rewritten.replace(op.paragraph, replacement);
      }
    }
    draft = rewritten;
    lintReport = lint(draft, { tier, knownUrls: knownCitationUrls });
  }

  // 10. Strip stray (non-known) citation URLs.
  if (lintReport.strayCitations?.length > 0) {
    for (const c of lintReport.strayCitations) {
      // Remove the URL portion but keep the phrase as plain text.
      const re = new RegExp(`\\[${escapeRegex(c.phrase)}\\]\\(${escapeRegex(c.url)}\\)`, "g");
      draft = draft.replace(re, c.phrase);
    }
    lintReport = lint(draft, { tier, knownUrls: knownCitationUrls });
  }

  // 11. Persist.
  const relativePath = `${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${topicSlug}.md`;
  await writeNote(relativePath, headerFm + draft);

  // 12. Phase 1D — stub creation for all [[wikilinks]] in the thesis.
  //     resolveWikilinks() checks each link against the vault, creates
  //     Stubs/<LinkTitle>.md for any that don't already resolve.
  let createdStubs = [];
  try {
    createdStubs = await resolveWikilinks(draft);
  } catch (err) {
    log(`resolveWikilinks failed: ${err.message}`, "warn");
  }

  return {
    relativePath,
    wordCount: wordCount(draft),
    lintReport,
    vectorCollection: conclusionsCollection,
    outline,
    createdStubs
  };
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// server/skills/deepResearch/thesisSynthesizer.js
// Chunked academic synthesis. Outline → section-by-section, with per-section RAG over
// the conclusions vector collection. Post-pass: third-person lint + targeted rewrite +
// deterministic bibliography.

import { llm } from "../../tools/llm.js";
import { writeNote, buildFrontmatter, resolveWikilinks, enrichWithWikilinks, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";
import { createLogger } from "../../utils/logger.js";

// Phase 6F — pin synthesizer model. The chat agent's default LLM model can be
// swapped (e.g. dolphin-llama3 for hacker-persona chat), but academic synthesis
// needs a less literal, more verbose model. qwen2.5:7b was the model all of
// Phase 5/6's prompt tuning was developed against — switching to dolphin caused
// prompt-template leakage (the model copies directive bullets verbatim into
// output) and dramatic verbosity drop. Override per-call here so research
// quality is decoupled from chat-persona model swaps.
//
// Override via env: SYNTHESIZER_MODEL=<model-name>
const SYNTH_MODEL = process.env.SYNTHESIZER_MODEL || "qwen2.5:7b";

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
import {
  buildCitationIndex,
  renderReferencesSection,
  renderCitationsForPrompt,
  lintStrayCitations
} from "./citations.js";
import {
  jaccardSimilarity,
  firstSentence,
  findDuplicateParagraphs,
  contentWords
} from "./redundancy.js";

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * Phase 5F — final markdown linter. The LLM occasionally leaks broken Obsidian
 * callout syntax (`> [!info]`, standalone "Info" lines, lone `>` blockquotes),
 * inline bullets without preceding blank lines, and other markdown breakage.
 * Strip / fix these so the final paper renders cleanly.
 */
function sanitizeOutputMarkdown(text) {
  if (!text) return text;
  let out = String(text);
  let calloutsDemoted = 0;
  let blockquotesStripped = 0;
  let bulletsFixed = 0;
  let promptLeaksStripped = 0;

  // 0. Phase 6F — STRIP PROMPT-TEMPLATE LEAKAGE.
  //    Less-aligned models (e.g. dolphin-llama3) copy directive scaffolding from
  //    our prompt verbatim into the output. Detect and remove the leaked patterns:
  const PROMPT_LEAK_PATTERNS = [
    // Length-floor instruction copied verbatim
    /^[\s>]*To reach the floor length requirement,[^\n]+\n+/gim,
    /^[\s>]*To reach the (?:required )?length(?: of at least \d+ words)?,[^\n]+\n+/gim,
    // Directive bullet headers turned into output sections
    /^[\s>]*\*\*(?:Adding more specific examples\/numbers from cited sources|Probing implications|Expanding analysis depth|Comparisons between different types|Retrieved source material)[^*\n]*\*\*\s*:?\s*\n+/gim,
    // Standalone literal "[]" placeholders (empty-bracket source-material markers)
    /^[\s>]*\[\]\s*$/gm,
    // "Rewritten Passage:" / "Original Passage:" — leakage from rewrite-prompt scaffolding
    /^[\s>]*"?(?:Rewritten Passage|Original Passage|Output Section|Section to rewrite)"?\s*:?\s*\n+/gim,
    // Trailing structure-rules sections that became output ("**Technical Bullet Points:**", "**Obsidian Wikilinks:**", etc.)
    // Two patterns: (a) bounded by next `## Heading` (b) trailing to end of string.
    // JS regex doesn't support \Z, hence both forms. The header line allows colon+asterisks
    // in either order to handle both `**Title:**` and `**Title**:` styles.
    /\n+[ \t]*\*{1,2}(?:Technical Bullet Points?|Obsidian Wikilinks?|Wikilinks?|Bullet Points?)[\s\S]{0,5}?\n[\s\S]*?(?=\n[ \t]*##[ \t])/gi,
    /\n+[ \t]*\*{1,2}(?:Technical Bullet Points?|Obsidian Wikilinks?|Wikilinks?|Bullet Points?)[\s\S]{0,5}?\n[\s\S]*$/gi,
    // Directive sentences that snuck into prose
    /\bDO NOT (?:pad with filler|copy any example terms|use Obsidian callout)[^.\n]*\.?/g,
    /\bYou MUST (?:write|wrap|include|expand)[^.\n]*\.?/g,
    // Literal placeholder phrases the user spotted
    /\[insert\s+(?:topic|category|year|name|finding|number|effect[\s-]?size)[^\]]*\]/gi,
    /\[(?:YOUR|your)\s+[A-Z\s]+(?:HERE|TBD)?\]/g,
  ];
  for (const re of PROMPT_LEAK_PATTERNS) {
    out = out.replace(re, (m) => { promptLeaksStripped++; return ""; });
  }

  // 1. Demote FULL Obsidian callout blocks to plain markdown.
  //    Catches all four common LLM patterns:
  //      a) Header-only: "> [!info] Title\nbody body body"
  //      b) Full block:  "> [!info] Title\n> body line\n> body line"
  //      c) Mixed:       "> [!info] Title\n> body\nbody continuation"
  //      d) Orphan tag:  "[!info] Title\nbody"
  //
  //    All become: "**Title**\n\nbody body body"
  out = out.replace(
    /^[ \t]*(?:>\s*)?\[!(\w+)\][ \t]*([^\n]*)((?:\n[ \t]*>[^\n]*)*)/gim,
    (_, _type, title, blockBody) => {
      calloutsDemoted++;
      const cleanTitle = (title || "").trim();
      // Strip the `> ` prefix from each continuation line in the captured block body.
      const bodyLines = (blockBody || "")
        .split(/\n/)
        .filter(Boolean)
        .map(l => l.replace(/^[ \t]*>[ \t]?/, ""))
        .filter(l => l.trim().length > 0);
      const bodyText = bodyLines.length > 0 ? "\n" + bodyLines.join("\n") : "";
      return (cleanTitle ? `\n**${cleanTitle}**\n` : "\n") + bodyText + "\n";
    }
  );

  // 2. Strip standalone "Info" / "INFO" / "Note" lines (callout headers that
  //    lost their `> [!type]` prefix entirely).
  out = out.replace(/^\s*(Info|INFO|Note|NOTE|Warning|WARNING|Tip|TIP|Important|IMPORTANT)\s*$/gm, "");

  // 3. Strip ALL remaining `> `-prefixed lines that aren't a clean structured
  //    blockquote. After step 1 demoted callouts, any remaining `> ` lines are
  //    either malformed callout leftovers or LLM-mimicked source-paper quotes.
  //    For an academic synthesis these add nothing — strip them.
  const lines = out.split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*>/.test(ln)) {
      // Strip the `> ` prefix and keep the inner text as a plain line
      const inner = ln.replace(/^\s*>[ \t]?/, "");
      if (inner.trim().length === 0) {
        blockquotesStripped++;
        continue; // drop empty `> `
      }
      kept.push(inner);
      blockquotesStripped++;
      continue;
    }
    kept.push(ln);
  }
  out = kept.join("\n");

  // 4. Insert blank line before bullet items that are stuck onto the previous
  //    line. Pattern: "...sentence. - **Bold**:" → "...sentence.\n\n- **Bold**:"
  out = out.replace(/([.!?])\s+(-\s+\*\*[^*]+\*\*)/g, (_, p, b) => { bulletsFixed++; return `${p}\n\n${b}`; });
  out = out.replace(/([.!?])\s+(-\s+[A-Z])/g, (_, p, b) => { bulletsFixed++; return `${p}\n\n${b}`; });

  // 5. Ensure bullet items each start on their own line
  //    Pattern: "...item one. - item two" → "...item one.\n- item two"
  out = out.replace(/(- [^\n]+)\s+- /g, (_, b) => { bulletsFixed++; return `${b}\n- `; });

  // 6. Collapse runs of blank lines (3+ → 2)
  out = out.replace(/\n{3,}/g, "\n\n");

  // 7. Visibility — log what we cleaned so we can verify the sanitizer ran
  if (calloutsDemoted || blockquotesStripped || bulletsFixed || promptLeaksStripped) {
    console.log(`[thesisSynthesizer] sanitize: ${calloutsDemoted} callout(s) demoted, ${blockquotesStripped} blockquote line(s) stripped, ${bulletsFixed} stuck bullet(s) fixed, ${promptLeaksStripped} prompt-leak(s) stripped`);
  } else {
    console.log(`[thesisSynthesizer] sanitize: clean — no callouts, blockquotes, stuck bullets, or prompt leaks`);
  }

  return out.trim() + "\n";
}

/**
 * Phase 6A — diagnostic snapshot. Logs the structural shape of the draft at
 * each transform stage so we can pinpoint exactly which pass strips newlines.
 */
function snapshotDraft(stage, draft) {
  const len = draft?.length || 0;
  const breaks = (draft?.match(/\n\n/g) || []).length;
  const h2s = (draft?.match(/^##\s/gm) || []).length;
  const lines = draft?.split(/\n/).length || 0;
  console.log(`[thesisSynthesizer] DRAFT[${stage}]: ${len}c, ${lines} lines, ${breaks} ¶ breaks, ${h2s} H2 headings`);
}

/**
 * Phase 6A — defensive paragraph reflow. Even if upstream passes strip
 * newlines, this final pass restores enough structure for Obsidian/markdown
 * renderers to work correctly. Belt-and-suspenders against the wall-of-text bug.
 *
 * Operations (idempotent):
 *  1. Force `\n\n` before every heading marker (#, ##, ###...)
 *  2. Force `\n\n` between sentences that have no break but contain `## ` markers
 *  3. Force `\n\n` before bullet lists that follow non-list content
 *  4. Ensure `\n\n` between consecutive paragraphs
 *  5. Collapse runs of 3+ blank lines to 2
 *  6. Ensure file ends with single trailing newline
 */
function reflowParagraphs(draft) {
  if (!draft) return draft;
  let out = String(draft);

  // 1. Most critical: any heading marker (# through ######) MUST start its own
  //    line and have a blank line before it. Catches the "# Title ## Abstract"
  //    collapse pattern.
  out = out.replace(/([^\n])\s*(#{1,6}\s+)/g, "$1\n\n$2");

  // 2. Bullet lists: ensure `- bullet` starts a new line, with blank before
  //    the first bullet if the previous content was prose.
  //    Pattern: "...sentence. - item one - item two" → break each onto its line.
  out = out.replace(/([.!?])\s+(- [A-Z*])/g, "$1\n\n$2");
  out = out.replace(/(- [^\n]+?)\s+(- [A-Z*])/g, "$1\n$2");

  // 3. Numbered lists: same pattern
  out = out.replace(/([.!?])\s+(\d+\.\s+[A-Z*])/g, "$1\n\n$2");

  // 4. Bold-emphasis paragraph headers: " **Key:** body **Next:** body"
  //    → "**Key:** body\n\n**Next:** body"
  out = out.replace(/([.!?])\s+(\*\*[A-Z][^*]{2,40}:\*\*)/g, "$1\n\n$2");

  // 5. Ensure references list entries each on own line: " 1. Smith... 2. Jones..."
  //    Only matches at start of bibliography (after `## References` heading)
  out = out.replace(/(\.\s+(?:https?:\/\/\S+\.?\s+)?)(\d+\.\s+[A-Z])/g, "$1\n$2");

  // 6. Collapse runs of blank lines (3+ → 2)
  out = out.replace(/\n{3,}/g, "\n\n");

  // 7. Trailing newline
  return out.trim() + "\n";
}

/**
 * Phase 5F — strip a leading H1/H2/H3 heading from the section body if the LLM
 * added one duplicating the section title. Called per-section right after
 * composition so the document assembler's `## Heading` doesn't end up next to
 * a duplicate `### Heading` from the LLM.
 */
function stripDuplicateLeadingHeading(sectionText, sectionHeading) {
  if (!sectionText || !sectionHeading) return sectionText;
  const lines = sectionText.split(/\r?\n/);
  let stripped = 0;
  while (lines.length > 0) {
    const first = lines[0].trim();
    // Match "# X", "## X", "### X" where X is similar to sectionHeading
    const m = first.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!m) break;
    const headingText = m[1].toLowerCase().replace(/[^\w\s]/g, "").trim();
    const expected = sectionHeading.toLowerCase().replace(/[^\w\s]/g, "").trim();
    // Strip if it matches the section title exactly OR contains it
    if (headingText === expected || headingText.includes(expected) || expected.includes(headingText)) {
      lines.shift();
      stripped++;
      // Also strip the blank line that usually follows a heading
      if (lines.length > 0 && lines[0].trim() === "") lines.shift();
    } else {
      break;
    }
  }
  return stripped > 0 ? lines.join("\n") : sectionText;
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
    // 180s timeout — outline is critical for per-section thesis claims; qwen2.5:7b + JSON mode
    // commonly takes 30-45s on local hardware, but bigger context (8 prompts → many conclusions
    // packed in) can push it past 90s under load. 180s gives enough headroom without hanging forever.
    const res = await llm(prompt, {
      timeoutMs: 180000,
      format: "json",
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 6000, num_predict: 2048 }
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
// Phase 5E — section-specific synthesis directives. Replaces generic "dense paragraphs"
// with concrete cognitive demands appropriate to each section's role in an academic paper.
const SECTION_SYNTHESIS_DIRECTIVES = {
  abstract:    "State the paper's CLAIM, METHODS, KEY FINDINGS, and IMPLICATIONS in 3-4 sentences. No filler.",
  introduction:"Frame the research QUESTION. Identify the GAP in current literature. Preview what this paper contributes. Do NOT summarize all findings here.",
  litreview:   "GROUP sources by stance/finding. COMPARE methodologies across studies. IDENTIFY contradictions or replication failures. DO NOT just list studies sequentially. Use comparative language: 'In contrast to X, Y found...', 'Whereas Z used method A, B used method C and reached different conclusions because...'",
  methodology: "Describe the ACTUAL pipeline used in this narrative literature review (NOT a systematic review). DO NOT claim PRISMA, inclusion/exclusion criteria, or data extraction tables — we don't do those. DO describe: number of providers queried, number of sub-questions probed, source dedup strategy, vector embedding for retrieval. Include a short LIMITATIONS sub-discussion: open-access bias, single-reviewer, no formal quality scoring.",
  results:     "REPORT specific numbers, effect sizes, sample sizes from the cited sources. CONTRAST findings across studies. CALL OUT contradictions. AVOID: 'Several studies have shown X' (vague). PREFER: '(Author, Year) found a 47% reduction (n=240); (Author2, Year) reported a similar 40% reduction (n=180). However, (Author3, Year) found no effect in older adults (n=85), suggesting...'",
  discussion: "INTERPRET findings: WHY do studies disagree? WHAT mechanism explains the strongest effects? WHAT do critics say? Do not just re-state the Results. Bring in cross-disciplinary perspectives where relevant.",
  conclusion: "Synthesize ONE clear take-away. Identify 2-3 SPECIFIC open questions for future research. Do NOT restate the abstract.",
  future_work:"List concrete future research directions, each with a justification of WHY it matters and what method would address it.",
  ai_ack:     "Acknowledge that this paper was synthesized by an LLM agent. Be specific about which steps were AI-assisted and which were deterministic."
};

function pickSynthesisDirective(section) {
  const id = String(section?.id || "").toLowerCase();
  const heading = String(section?.heading || "").toLowerCase();
  for (const [key, val] of Object.entries(SECTION_SYNTHESIS_DIRECTIVES)) {
    if (id.includes(key) || heading.includes(key)) return val;
  }
  // Fallback for sections we didn't anticipate
  return "Provide DEEP analysis: compare findings, identify contradictions, explain mechanisms. Do not just list facts.";
}

/**
 * Phase 5C — strip systematic-review-only language from the Methodology section.
 * Our pipeline is a NARRATIVE literature review, not a systematic one. Any time
 * the LLM drifts and claims PRISMA / inclusion criteria / data extraction tables,
 * downgrade the language to honest narrative-review terms.
 */
function honestifyMethodology(text) {
  if (!text) return text;
  let out = String(text);
  // 1. Replace "systematic review" with "narrative literature review"
  out = out.replace(/\b[Ss]ystematic\s+review\b/g, "narrative literature review");
  out = out.replace(/\bPRISMA\s+(flow\s+diagram|protocol|guidelines?)?\b/gi, "");
  out = out.replace(/\b[Ii]nclusion\s+(?:and\s+)?[Ee]xclusion\s+criteria\b/g, "source-selection heuristics");
  out = out.replace(/\b[Dd]ata\s+extraction\s+table\b/g, "semantic chunk index");
  out = out.replace(/\bquality\s+(?:assessment|scoring)\s+(?:protocol|tool|instrument)?\b/gi, "informal relevance scoring");
  // 2. Drop sentences that reference PRISMA flow / cohen's kappa / inter-rater
  out = out.replace(/[^.]*\b(PRISMA|Cochrane|Cohen'?s\s+kappa|inter-rater\s+reliability)\b[^.]*\./gi, "");
  // 3. Tidy up double spaces and orphan punctuation
  out = out.replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").replace(/\(\s*\)/g, "");
  return out.trim();
}

// Phase 5B — pre-emptive guardrail against the model's go-to filler openings.
const FORBIDDEN_OPENINGS = [
  "Cognitive Behavioral Therapy remains a cornerstone",
  "It has been widely shown that",
  "Numerous studies have demonstrated",
  "In recent years, there has been growing interest in",
  "It is well known that",
  "This section will discuss",
  "This section explores"
];

async function writeSection({ topic, tier, section, prevSummaries, constraints, knownCitationUrls, citationsPrompt, citationIndex, conclusionsCollection }) {
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

  const synthesisDirective = pickSynthesisDirective(section);

  // Phase 5A: include the structured citation list and demand the LLM uses
  // EXACT (Author, Year) form from the list — never invent author names.
  const citationsBlock = citationsPrompt
    ? `\n\nAVAILABLE CITATIONS (use ONLY these — never invent author names):\n${citationsPrompt}\n\nWhen you reference a study, use the EXACT in-text form shown in the list, e.g. "(Smith & Jones, 2023)". If you cannot attribute a claim to one of these citations, REPHRASE it as general knowledge with NO parenthetical citation. NEVER write "[5]", "Source 1", "(Author, Year)" placeholders, or made-up author names.`
    : `\n\nNo structured citations available. Write claims as general knowledge — DO NOT invent (Author, Year) parentheticals.`;

  // Phase 5B: tell the model to avoid its filler openings + previously-used openings.
  const recentOpenings = (prevSummaries || []).map(p => p?.opening).filter(Boolean).slice(-5);
  const openingGuardrail = `\n\nDO NOT start this section with any of these stock openings:\n${FORBIDDEN_OPENINGS.map(o => `  - "${o}..."`).join("\n")}` +
    (recentOpenings.length > 0
      ? `\nALSO avoid repeating these openings already used in earlier sections:\n${recentOpenings.map(o => `  - "${o.slice(0, 80)}..."`).join("\n")}`
      : "");

  // Phase 6D — bake length floor into FIRST prompt so we don't waste retries.
  const wordFloor = Math.floor((section.word_budget || 600) * 0.85);
  const expansionDirectives = `\n\n=== LENGTH REQUIREMENT (HARD FLOOR — read carefully) ===
This section's target is ${section.word_budget} words. You MUST write AT LEAST ${wordFloor} words.
A draft shorter than ${wordFloor} words is a FAILURE — it will be sent back for revision and waste minutes.
Track your length as you go. If you find yourself wrapping up before ${wordFloor} words, you have not gone deep enough.

To reach the floor, EXPAND by:
- Quoting specific numbers / effect sizes / sample sizes from the cited sources (e.g. "n=240, p<.05")
- Comparing methodologies across studies in detail
- Identifying contradictions or replication failures and explaining why they happened
- Probing implications and underlying mechanisms (the WHY, not just the WHAT)
- Adding a paragraph specifically about LIMITATIONS of the cited evidence

DO NOT pad with filler ("Numerous studies have...", "It has been widely shown...").
Add only genuine analytical content.

=== ANALYSIS DEPTH ===
${synthesisDirective}

=== STRUCTURE RULES FOR THIS SECTION ===
- Length: AT LEAST ${wordFloor} words (target ${section.word_budget}). Aim for at least ${constraints.writing.minParagraphsPerSection || 3} dense paragraphs.
- Bullets: You MUST include exactly ${constraints.writing.minBulletsPerSection || 5} technical bullet points.
- Obsidian Links: You MUST wrap at least 4 important domain concepts (proper nouns, technical terms specific to "${topic}") in double brackets to create wikilinks. Use concepts that ACTUALLY appear in this section's content — do NOT copy any example terms from these instructions.
- Tone: ${constraints.writing.tone}.
- Focus strictly on the domains: ${constraints.research.domainLock?.join(", ")}.

=== MARKDOWN OUTPUT RULES (Phase 5 — quality fix) ===
- DO NOT add a heading at the start of your output. The section title "${section.heading}" is added by the document assembler — duplicating it produces "## ${section.heading}\\n### ${section.heading}" which renders broken.
- Start your output with the FIRST PARAGRAPH directly.
- DO NOT use Obsidian callout syntax in ANY form. Forbidden patterns include:
  - \`> [!info] Title\`, \`> [!note]\`, \`> [!tip]\`, \`> [!warning]\`, etc.
  - Lines starting with \`>\` for any reason (no blockquotes, no callouts).
  - Bare \`[!info]\` markers.
  Reason: Obsidian renders callout BODIES in larger/bolder text, producing a
  "wall of text" effect that ruins readability. For emphasis, use \`**bold**\`
  inline or a plain bold heading like \`**Key Findings:**\` followed by a
  normal paragraph or bulleted list.
- Bullet lists MUST be preceded by a blank line. End the prior sentence with a period + newline + newline + bullet. NOT "...result. - bullet" on the same line.
- After every bullet block, leave a blank line before resuming prose.${citationsBlock}${openingGuardrail}`;

  const finalPrompt = prompt + expansionDirectives;

  // Phase 5D + 6D — explicit num_predict so the model doesn't quit early.
  // qwen2.5:7b often produces 1.5-1.7 tokens/word; 1.8x was borderline tight.
  // Bumped to 2.2x so even verbose sections have ample headroom.
  const numPredict = Math.ceil((section.word_budget || 600) * 2.2);

  let text = "";
  try {
    const res = await llm(finalPrompt, {
      timeoutMs: 600000,
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.35, num_ctx: 8192, num_predict: numPredict }
    });
    text = String(res?.data?.text || "").trim();
  } catch (err) {
    log(`section "${section.id}" write failed: ${err.message}`, "warn");
    return `_(synthesis failed for this section: ${err.message})_`;
  }

  // Phase 5D — retry once if section came back at < 75% of budget AND we have
  // budget headroom. Probably a premature stop, not a true short answer.
  const initialWords = wordCount(text);
  const minRequired = Math.floor((section.word_budget || 600) * 0.75);
  if (initialWords > 50 && initialWords < minRequired) {
    console.log(`[thesisSynthesizer] section "${section.id}" came back short (${initialWords}w of ${section.word_budget} budget; min ${minRequired}); retrying with explicit length push`);
    const retryPrompt = `Your previous draft of the "${section.heading}" section was only ${initialWords} words but the budget is ${section.word_budget}w. The section was cut short. Rewrite it to AT LEAST ${Math.floor(section.word_budget * 0.85)}w by:
- Expanding analysis depth (mechanism, comparisons, contradictions)
- Adding more specific examples / numbers from cited sources
- Probing implications

DO NOT pad with filler ("Numerous studies have...", "It has been shown..."). Add genuine analytical content.

Previous (short) draft to expand:
"""${text}"""

Rewrite as a fuller, deeper section now:`;
    try {
      const retryRes = await llm(retryPrompt, {
        timeoutMs: 600000,
        model: SYNTH_MODEL,
        skipKnowledge: true,
        skipLanguageDetection: true,
        options: { temperature: 0.4, num_ctx: 8192, num_predict: numPredict }
      });
      const retryText = String(retryRes?.data?.text || "").trim();
      if (wordCount(retryText) > initialWords) {
        text = retryText;
        console.log(`[thesisSynthesizer] section "${section.id}" retry succeeded: ${wordCount(retryText)}w (was ${initialWords}w)`);
      }
    } catch { /* retry is best-effort */ }
  }

  return text;
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
      timeoutMs: 240000,
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 8192, num_predict: Math.ceil((section.word_budget || 600) * 1.8) }
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
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.2, num_ctx: 2048, num_predict: 600 }
    });
    return String(res?.data?.text || "").trim() || paragraph;
  } catch {
    return paragraph;
  }
}

/**
 * Polish pass — two-stage critique + targeted repair for research/thesis tiers.
 *
 * Stage 1 (critique): LLM identifies 3–6 specific weak spots (unclear sentences,
 *                     weak transitions, unsupported claims). Returns JSON list.
 * Stage 2 (repair):   For each identified spot, rewrite just that paragraph
 *                     (bounded, targeted — not a full rewrite of the article).
 *
 * Rationale: small local models (qwen2.5:7b) are measurably better at critiquing
 * text than generating it from scratch. A second-pass self-critique over the
 * already-written draft catches exactly the kind of wobbly claims and rough
 * transitions that appear in long single-pass generations.
 *
 * Gated to research/thesis tiers because it adds ~3–5 LLM calls; not worth it
 * for article/indepth where the draft is already compact.
 */
async function polishDraft({ draft, topic, tier }) {
  const MAX_CRITIQUE_INPUT = 12000; // what we send to the critic
  const inputSample = draft.length <= MAX_CRITIQUE_INPUT
    ? draft
    : draft.slice(0, MAX_CRITIQUE_INPUT);

  const critiquePrompt = `You are a HARSH academic editor reviewing a ${tier}-level draft on "${topic}".
You are reading this paper to grade it. Be ruthless — find the weak spots.

Identify 3–8 SPECIFIC weak spots in the draft below. For each, quote the exact
problematic sentence or short paragraph (≤ 240 chars) and state the problem.

Categories of problems to LOOK FOR (Phase 5E — synthesis depth):
- **Summarizing instead of synthesizing**: paragraphs that list studies one-by-one
  ("Study A showed X. Study B showed Y. Study C showed Z.") without comparing or
  contrasting them.
- **Surface mention without analysis**: a topic is named ("VR is being integrated
  into CBT") but never analyzed (what evidence? what limitations? what mechanism?).
- **Unsupported assertion**: a claim with no citation and no logical justification.
- **Mechanism gap**: a finding stated without explaining why it works (e.g. "ACT
  focuses on mindfulness" — but why is it better for X? what changes neurally?).
- **Redundancy**: same point repeated across paragraphs/sections (e.g. "homework
  adherence" mentioned 5 times).
- **Filler openings**: clichés like "Cognitive Behavioral Therapy remains a
  cornerstone of modern psychotherapy", "Numerous studies have shown...".
- **First-person**: "I", "we", "our", "in this study" (this is a literature review,
  not original research — third person only).
- **Jargon without definition**: technical term used without context.
- **Weak transition**: paragraphs that don't connect to each other logically.
- **Stray broken citation**: "[5]", "Source 1", "(Author, Year)" placeholders.

Do NOT comment on anything that is already good. Do NOT suggest a rewrite here —
just identify and name the problem. If nothing is seriously wrong, return an empty
issues array.

Draft (may be truncated):
"""
${inputSample}
"""

Return JSON only:
{
  "issues": [
    { "excerpt": "exact quote from the draft (≤ 240 chars)", "reason": "short problem description (one of the categories above)" }
  ]
}`;

  let critique = null;
  try {
    const res = await llm(critiquePrompt, {
      timeoutMs: 180000,
      format: "json",
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.25, num_ctx: 8192, num_predict: 1500 }
    });
    critique = safeJsonParse(res?.data?.text || "");
  } catch (err) {
    log(`polish critique failed: ${err.message}`, "warn");
    return null;
  }

  const issues = Array.isArray(critique?.issues) ? critique.issues.slice(0, 6) : [];
  if (issues.length === 0) {
    console.log(`[thesisSynthesizer] polish: critic found no issues — skipping repair`);
    return draft;
  }
  console.log(`[thesisSynthesizer] polish: critic flagged ${issues.length} issue(s) — repairing...`);

  // Stage 2: repair each flagged excerpt (sequentially — local LLM)
  let repaired = draft;
  for (let i = 0; i < issues.length; i++) {
    const { excerpt, reason } = issues[i] || {};
    if (!excerpt || typeof excerpt !== "string" || excerpt.length < 20) continue;
    // Only attempt repair if the excerpt actually appears in the draft
    if (!repaired.includes(excerpt)) continue;

    const repairPrompt = `Rewrite the passage below to fix this issue: ${reason}.

Rules (Phase 5E — DEEPEN, don't just reword):
- If the issue is "summarizing instead of synthesizing": GROUP studies, COMPARE methods, IDENTIFY contradictions. Do not just reorder the same sentences.
- If the issue is "surface mention without analysis": ADD the analysis (what evidence? what mechanism? what limitation?). Cite a specific source if possible.
- If the issue is "mechanism gap": ADD the missing causal explanation.
- If the issue is "redundancy": rewrite to make a DIFFERENT point — something not already said earlier in the document.
- If the issue is "filler opening": replace with a substantive claim or question.
- If the issue is "first-person": switch to third-person ("the literature shows", "evidence suggests").
- Keep approximate length (±30%) unless the fix requires more depth (in which case, expand up to 50%).
- Preserve any [[wikilinks]] and URLs intact.
- Preserve any (Author, Year) citations intact (do NOT invent new ones).
- Output the rewritten passage ONLY — no preamble, no quotation marks.

Passage:
"""
${excerpt}
"""`;
    try {
      const res = await llm(repairPrompt, {
        timeoutMs: 150000,
        model: SYNTH_MODEL,
        skipKnowledge: true,
        skipLanguageDetection: true,
        options: { temperature: 0.25, num_ctx: 3072, num_predict: 800 }
      });
      const replacement = String(res?.data?.text || "").trim();
      if (replacement && replacement.length > 20 && replacement !== excerpt) {
        repaired = repaired.replace(excerpt, replacement);
        console.log(`[thesisSynthesizer] polish: repaired ${i + 1}/${issues.length} (${reason.slice(0, 50)})`);
      }
    } catch (err) {
      log(`polish repair ${i + 1} failed: ${err.message}`, "warn");
    }
  }

  return repaired;
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

  console.log(`[thesisSynthesizer] ▶ starting synthesis: tier=${tier} prompts=${promptResults.length} topic="${String(topic).slice(0, 60)}"`);

  // 1. Build conclusions vector collection.
  const conclusionsCollection = await indexConclusions(topicSlug, promptResults);
  console.log(`[thesisSynthesizer] ✓ conclusions indexed (collection=${conclusionsCollection})`);

  // 2. Build outline.
  console.log(`[thesisSynthesizer] ⏳ building outline (LLM pass 1/N)...`);
  const outline = await buildOutline({ topic, tier, promptResults });
  console.log(`[thesisSynthesizer] ✓ outline built: ${outline.sections?.length || 0} sections`);

  // 3. Collect known citation URLs from harvested article frontmatter (deterministic guardrail).
  const articleNotes = promptResults.flatMap(p => (p.analyses || []).map(a => a.frontmatter || {}));
  // Phase 3A — prefer upgraded paper URL; fall back to original article URL.
  // Both are registered as "known" so the lint pass doesn't strip them.
  const knownCitationUrls = [...new Set(
    articleNotes.flatMap(n => [n.paper_url, n.url].filter(Boolean))
  )];

  // Phase 5A — build the structured citation index.
  // Each entry: { id, inText: "(Smith & Jones, 2023)", apa: "<full APA entry>", cite, ... }
  // The synthesizer uses this to ground in-text citations and emit a real
  // References section instead of a URL dump.
  const citationIndex = buildCitationIndex(articleNotes);
  const citationsPrompt = renderCitationsForPrompt(citationIndex, 30);
  console.log(`[thesisSynthesizer] citation index built: ${citationIndex.length} structured entries from ${articleNotes.length} sources`);

  // 4. Section-by-section synthesis.
  const writtenSections = [];
  const prevSummaries = [];
  const totalSections = outline.sections.length;
  for (let idx = 0; idx < outline.sections.length; idx++) {
    const section = outline.sections[idx];
    console.log(`[thesisSynthesizer] ⏳ composing section ${idx + 1}/${totalSections}: "${section.heading}" (budget=${section.word_budget}w)`);
    log(`step=writeSection id="${section.id}" heading="${section.heading}" budget=${section.word_budget}`, "info");
    let text = await writeSection({
      topic,
      tier,
      section,
      prevSummaries,
      constraints,
      knownCitationUrls,
      citationsPrompt, // Phase 5A — structured APA citations to use in-text
      citationIndex,   // Phase 5A — for post-section lint of stray refs
      conclusionsCollection
    });
    // Phase 5F — strip duplicate leading heading. The LLM often adds
    // "### Literature Review" inside the Literature Review section, on top of
    // the "## Literature Review" the assembler adds.
    text = stripDuplicateLeadingHeading(text, section.heading);

    const rawWords = wordCount(text);
    // Phase 1C: one expand/trim pass if section is significantly off budget
    text = await adjustSectionLength(text, section, topic, tier);
    text = stripDuplicateLeadingHeading(text, section.heading); // adjustment pass might re-add it

    // Phase 5B — opening dedup. If this section's first sentence is too similar
    // to any earlier section's opening, force a rewrite of the opening only.
    const myOpening = firstSentence(text);
    const myOpeningWords = contentWords(myOpening);
    const dupSection = prevSummaries.find(p => {
      if (!p.openingWords) return false;
      const sim = jaccardSimilarity(myOpeningWords, p.openingWords);
      return sim >= 0.55;
    });
    if (dupSection && myOpening) {
      console.log(`[thesisSynthesizer] section ${idx + 1} opening duplicates section "${dupSection.heading}" opening — rewriting opener`);
      try {
        const otherOpenings = prevSummaries.map(p => p.opening).filter(Boolean).slice(-5);
        const rewritePrompt = `The "${section.heading}" section starts with an opening sentence too similar to other sections. Rewrite ONLY the first 1-2 sentences (keep the rest of the section unchanged). The new opening MUST take a different angle and MUST NOT repeat any of these openings:
${otherOpenings.map(o => `  - "${o.slice(0, 100)}..."`).join("\n")}

Section to rewrite (preserve all body content; change only the opening):
"""
${text}
"""

Output the COMPLETE rewritten section (with new opening + unchanged body):`;
        const rewriteRes = await llm(rewritePrompt, {
          timeoutMs: 240000,
          model: SYNTH_MODEL,
          skipKnowledge: true,
          skipLanguageDetection: true,
          options: { temperature: 0.45, num_ctx: 8192, num_predict: Math.ceil((section.word_budget || 600) * 1.6) }
        });
        const rewritten = String(rewriteRes?.data?.text || "").trim();
        if (rewritten && wordCount(rewritten) >= wordCount(text) * 0.8) {
          text = rewritten;
          console.log(`[thesisSynthesizer] opening rewritten for section ${idx + 1}`);
        }
      } catch (err) {
        console.log(`[thesisSynthesizer] opening rewrite failed (${err.message}) — keeping original`);
      }
    }

    // Phase 5C — methodology honesty pass (narrative ≠ systematic review)
    if (/method/i.test(section.id || section.heading || "")) {
      const honest = honestifyMethodology(text);
      if (honest !== text) {
        console.log(`[thesisSynthesizer] methodology honesty pass: stripped systematic-review claims`);
        text = honest;
      }
    }

    const finalWords = wordCount(text);
    console.log(`[thesisSynthesizer] ✓ section ${idx + 1}/${totalSections} done: ${finalWords}w (raw=${rawWords}, budget=${section.word_budget})`);
    log(`step=writeSection id="${section.id}" done words=${finalWords} (raw=${rawWords} budget=${section.word_budget})`, "info");
    writtenSections.push({ section, text });
    // 1-line summary fed into the next section's anti-duplication context.
    const finalOpening = firstSentence(text);
    prevSummaries.push({
      heading: section.heading,
      summary_1liner: finalOpening,
      opening: finalOpening,
      openingWords: contentWords(finalOpening)
    });
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

  snapshotDraft("assembled", draft);

  // 8. Lint pass.
  console.log(`[thesisSynthesizer] ⏳ linting draft...`);
  let lintReport = lint(draft, { tier, knownUrls: knownCitationUrls });

  // 9. Targeted rewrite for first-person violations (one pass, capped).
  if (lintReport.offendingParagraphs.length > 0) {
    console.log(`[thesisSynthesizer] ⏳ rewriting ${Math.min(6, lintReport.offendingParagraphs.length)} first-person paragraph(s)...`);
    let rewritten = draft;
    for (const op of lintReport.offendingParagraphs.slice(0, 6)) {
      const replacement = await rewriteParagraph(op.paragraph, op.reason);
      if (replacement && replacement !== op.paragraph) {
        rewritten = rewritten.replace(op.paragraph, replacement);
      }
    }
    draft = rewritten;
    snapshotDraft("first-person-rewrite", draft);
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

  // 10b. Polish pass — ONLY for research + thesis tiers (expensive for lower tiers).
  //      The model critiques its own draft to surface weak claims, unclear
  //      sentences, and missing transitions, then applies targeted repair.
  //      Not a full rewrite — just a focused patch over rough spots.
  if (tier === "research" || tier === "thesis") {
    try {
      console.log(`[thesisSynthesizer] ⏳ polish pass (${tier} tier — critique + targeted repair)...`);
      const polished = await polishDraft({ draft, topic, tier });
      if (polished && polished.trim().length > draft.length * 0.6) {
        draft = polished;
        snapshotDraft("polished", draft);
        lintReport = lint(draft, { tier, knownUrls: knownCitationUrls });
        console.log(`[thesisSynthesizer] ✓ polish pass applied (${wordCount(draft)}w after)`);
      } else {
        console.log(`[thesisSynthesizer] ⚠ polish pass produced no usable output — keeping original draft`);
      }
    } catch (err) {
      console.log(`[thesisSynthesizer] ⚠ polish pass failed (non-fatal): ${err.message}`);
      log(`polishDraft failed: ${err.message}`, "warn");
    }
  }

  // ── Phase 5B — paragraph-level cross-section dedup ──
  // Find paragraphs that repeat across sections (e.g. "homework adherence" copy-pasted
  // 5×) and drop the LATER occurrence. Cheap deterministic Jaccard, no LLM needed.
  try {
    const dups = findDuplicateParagraphs(writtenSections.map(s => ({ heading: s.section.heading, text: s.text })), 0.5, 25);
    if (dups.length > 0) {
      console.log(`[thesisSynthesizer] redundancy: ${dups.length} cross-section paragraph duplicate(s) detected`);
      // Drop the later paragraph from each duplicate pair. We rebuild draft from writtenSections.
      const dropSet = new Set(dups.map(d => `${d.later.sectionIdx}:${d.later.paraIdx}`));
      writtenSections.forEach((s, secIdx) => {
        const paras = String(s.text).split(/\n\s*\n+/);
        const kept = paras.filter((_, pIdx) => !dropSet.has(`${secIdx}:${pIdx}`));
        if (kept.length < paras.length) {
          s.text = kept.join("\n\n");
          console.log(`[thesisSynthesizer] redundancy: dropped ${paras.length - kept.length} paragraph(s) from "${s.section.heading}"`);
        }
      });
      // Rebuild draft from deduped sections.
      draft = writtenSections.map(s => `## ${s.section.heading}\n\n${s.text}`).join("\n\n");
      snapshotDraft("redundancy-deduped", draft);
    } else {
      console.log(`[thesisSynthesizer] redundancy: no cross-section paragraph duplicates`);
    }
  } catch (err) {
    console.log(`[thesisSynthesizer] redundancy pass failed (non-fatal): ${err.message}`);
  }

  // ── Phase 5A — citation lint + References emission ──
  // Strip stray invented citations ([5], "Source 1", made-up "(Smith, 2019)" not in index)
  // then append the deterministic APA References section.
  try {
    const lintResult = lintStrayCitations(draft, citationIndex);
    if (lintResult.issues.length > 0) {
      const counts = {};
      for (const issue of lintResult.issues) counts[issue.pattern] = (counts[issue.pattern] || 0) + 1;
      console.log(`[thesisSynthesizer] citation lint: stripped ${lintResult.issues.length} stray ref(s) — ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      draft = lintResult.cleanText;
    }
    if (citationIndex.length > 0) {
      const refSection = renderReferencesSection(citationIndex);
      // Replace any existing "## References" / "## Bibliography" block, otherwise append.
      //
      // CRITICAL: JS regex does NOT support `\Z` end-of-string anchor — it treats it
      // as a literal `Z`, which caused the previous regex to stop at the first "Z"
      // character, leaving most of the old bibliography orphaned (the user's "13-30
      // restart" numbering bug). Fix: match from heading to TRUE end-of-string by
      // greedy `[\s\S]*$` with `m` flag off (so `$` = end-of-string).
      //
      // References/Bibliography is always the LAST section before the optional
      // aiUsageFooter — safe to replace from heading through end of document.
      const refHeadingRe = /(^|\n)##[ \t]+(?:References|Bibliography)[ \t]*[\s\S]*$/i;
      if (refHeadingRe.test(draft)) {
        draft = draft.replace(refHeadingRe, "\n\n" + refSection.trim() + "\n");
        console.log(`[thesisSynthesizer] References section replaced with ${citationIndex.length} APA entries (old bibliography fully removed)`);
      } else {
        draft = draft.trimEnd() + "\n\n" + refSection;
        console.log(`[thesisSynthesizer] References section appended with ${citationIndex.length} APA entries`);
      }
    }
    snapshotDraft("citation-linted", draft);
  } catch (err) {
    console.log(`[thesisSynthesizer] citation lint/References emit failed (non-fatal): ${err.message}`);
  }

  // ── Phase 5F — final markdown linter (strip leaked Obsidian callouts) ──
  draft = sanitizeOutputMarkdown(draft);
  snapshotDraft("sanitized", draft);

  // ── Phase 6A — defensive paragraph reflow (fixes wall-of-text) ──
  // Ensures heading markers, bullets, and paragraph breaks are properly
  // separated — even if upstream passes silently stripped newlines.
  draft = reflowParagraphs(draft);
  snapshotDraft("reflowed", draft);

  // 11. Persist.
  // 11a. Wikilink enrichment — the synthesizer LLM doesn't generate [[wikilinks]],
  //      so without this pass the article saves with 0 stubs created. Run a small
  //      LLM pass to wrap key concepts in [[...]], then save the enriched draft.
  console.log(`[thesisSynthesizer] ⏳ enriching draft with wikilinks...`);
  let enrichedDraft = draft;
  try {
    enrichedDraft = await enrichWithWikilinks(draft, { noteTitle: topicSlug, label: "thesisSynthesizer" });
  } catch (err) {
    console.log(`[thesisSynthesizer] ⚠ wikilink enrichment failed (non-fatal): ${err.message}`);
  }

  console.log(`[thesisSynthesizer] ⏳ writing final article to disk...`);
  const relativePath = `${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${topicSlug}.md`;
  await writeNote(relativePath, headerFm + enrichedDraft);
  console.log(`[thesisSynthesizer] ✓ article saved: ${relativePath} (${wordCount(enrichedDraft)}w)`);

  // 12. Phase 1D — stub creation for all [[wikilinks]] in the thesis.
  //     resolveWikilinks() checks each link against the vault, creates
  //     Stubs/<LinkTitle>.md for any that don't already resolve.
  let createdStubs = [];
  try {
    createdStubs = await resolveWikilinks(enrichedDraft);
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

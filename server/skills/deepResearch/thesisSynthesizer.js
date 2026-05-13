// server/skills/deepResearch/thesisSynthesizer.js
// Chunked academic synthesis. Outline → section-by-section, with per-section RAG over
// the conclusions vector collection. Post-pass: third-person lint + targeted rewrite +
// deterministic bibliography.

import { llm } from "../../tools/llm.js";
import { writeNote, buildFrontmatter, resolveWikilinks, enrichWithWikilinks, getVaultPath, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";
import { createLogger } from "../../utils/logger.js";
import path from "path";
import fs from "fs/promises";

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
// Phase 9E — optional heavyweight model used ONLY for section composition
// (the prose-quality bottleneck). Falls back to SYNTH_MODEL if unset.
// Suggested values for 8GB VRAM:
//   qwen2.5:14b-instruct-q3_K_S  (~6.5GB, same family, best continuity)
//   phi-4:14b-q3_K_M             (~6.5GB, strong academic prose)
// Phase 18A — AVOID reasoning models (deepseek-r1:8b, qwq) for section
// composition. Their <think>...</think> traces eat the num_predict budget,
// causing sections to come back short or mid-sentence-truncated even after
// length-push retries. Use them only for planner/decomposer stages, not prose.
const SYNTH_HEAVY_MODEL = process.env.SYNTH_HEAVY_MODEL || SYNTH_MODEL;
const HEAVY_NUM_CTX = parseInt(process.env.SYNTH_HEAVY_NUM_CTX || "6144", 10);

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
  lintStrayCitations,
  rescueMalformedAuthors
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

  // 5b. Phase 18D — fix numbered-list blank-line splitting. The CBT thesis
  // run had Abstract list items rendered as:
  //   `1.\n\n**Eating Disorders:** ...`
  //   `2.\n\n**Trauma:** ...`
  // — the LLM emitted the marker on its own line, then a blank line, then
  // the bold content on a new paragraph, breaking ordered-list rendering.
  // Join `^N.<eol><blank-line>**Bold**` → `N. **Bold**` so it renders as
  // a single list item.
  out = out.replace(/^(\d+)\.\s*\n\s*\n(\*\*)/gm, (_, n, b) => { bulletsFixed++; return `${n}. ${b}`; });
  // Same fix when the next line is a non-bold capitalized word.
  out = out.replace(/^(\d+)\.\s*\n\s*\n([A-Z][a-z])/gm, (_, n, w) => { bulletsFixed++; return `${n}. ${w}`; });

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
// ── Phase 19H — renumber broken ordered lists ─────────────────────────────
// LLMs occasionally skip an index (`1.`, `3.`, `4.`) or restart counting
// mid-block. Walk the document and sequentially renumber any contiguous run
// of `^\d+\.\s` lines. A "run" continues across blank lines and through
// indented continuation paragraphs; it breaks on a non-blank, non-list,
// non-indented-continuation line.
function renumberOrderedLists(draft) {
  if (!draft) return draft;
  const lines = String(draft).split("\n");
  const out = [];
  let runActive = false;
  let runIndex = 0;
  let totalRenumbered = 0;
  let firstNumberSeen = null;
  // Track recent list-item indices so we can detect "is this still the same list?"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*)(\d+)\.(\s+\S[\s\S]*)$/);
    if (m) {
      const [, indent, , rest] = m;
      // Top-level list items only (no nesting renumber)
      if (indent.length === 0) {
        if (!runActive) {
          runActive = true;
          runIndex = 1;
          firstNumberSeen = parseInt(m[2], 10);
        } else {
          runIndex++;
        }
        const expected = String(runIndex);
        if (m[2] !== expected) totalRenumbered++;
        out.push(`${expected}.${rest}`);
        continue;
      }
    }
    // Blank line or indented continuation — keep the run alive
    if (/^\s*$/.test(line) || /^\s{2,}\S/.test(line)) {
      out.push(line);
      continue;
    }
    // Any other line ends the run
    if (runActive) {
      runActive = false;
      runIndex = 0;
      firstNumberSeen = null;
    }
    out.push(line);
  }
  if (totalRenumbered > 0) {
    console.log(`[thesisSynthesizer] renumberOrderedLists: corrected ${totalRenumbered} list index(es)`);
  }
  return out.join("\n");
}

function reflowParagraphs(draft) {
  if (!draft) return draft;
  let out = String(draft);

  // Phase 14C — REJOIN numbered/bulleted list markers separated from their bold
  // content. Pattern: `1.\n\n**Title:** body` → `1. **Title:** body`. Without
  // this, Obsidian renders "1." alone on its own line and "**Title:** body" as
  // a separate paragraph (orphan-number artifact in the user's screenshot).
  // Run BEFORE the heading-injection rule because the heading rule's `\n\n`
  // insertion can create the very pattern we're trying to fix.
  // Allow trailing whitespace after the marker (e.g. `- \n\n**X**`).
  out = out.replace(/^(\s*\d+\.)[ \t]*\n{1,}[ \t]*(\*\*)/gm, "$1 $2");
  out = out.replace(/^(\s*[-*])[ \t]*\n{1,}[ \t]*(\*\*)/gm, "$1 $2");

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
  abstract:    "Write as a SINGLE flowing paragraph (150-250 words). NO bullet lists, NO sub-headings, NO 'Key Findings:' or 'Limitations:' headers — those are amateurish in an abstract. Cover (in order): the research question, the methods used (narrative literature review, plus quantitative analysis if datasets were analyzed), the principal findings stated as ONE narrative thread, and the implications. End with a single sentence stating limitations (in narrative form, NOT a bullet list).",
  introduction:"Use a Problem-Gap-Hook structure: (1) state THE PROBLEM (why this topic matters now); (2) identify the GAP in existing literature (what's been done, what hasn't, what's contradicted); (3) state the HOOK — your specific contribution. You MUST include exactly ONE sentence beginning with 'This paper examines' OR 'This review investigates' OR 'This study analyzes' that names the central research question explicitly. Do NOT summarize findings here. Do NOT include a 'Key Findings' bullet list. Do NOT mention textbook fundamentals (the reader knows what the topic is).",
  litreview:   "GROUP sources by stance/finding. COMPARE methodologies across studies. IDENTIFY contradictions or replication failures. DO NOT just list studies sequentially. Use comparative language: 'In contrast to X, Y found...', 'Whereas Z used method A, B used method C and reached different conclusions because...'",
  methodology: "Write the methodology in the voice of a HUMAN researcher describing how the review was conducted. NEVER use these LLM-pipeline terms: 'semantic-chunk indexing', 'deterministic aggregation', 'query expansion', 'vector embedding', 'vector store', 'RAG', 'pipeline'. They are red flags that suggest AI-generated text and will fail an academic review. Use this structure with H3 subheadings:\n\n### Literature Search\nDescribe the search as a multi-database keyword search. Name the academic databases by their actual names (OpenAlex, Semantic Scholar, CORE, DOAJ, Europe PMC, Dryad, Figshare, OSF, Zenodo). State the keywords/themes used. Report retrieval counts (e.g., 'X records identified, Y unique after deduplication').\n\n### Source Screening\nDescribe inclusion criteria in academic terms: peer-reviewed sources, open-access availability, English/Hebrew language, publication year range, topical relevance to the research questions. State the screening process narratively.\n\n### Quantitative Analysis (only if datasets were analyzed — see QUANTITATIVE FINDINGS block; if that block is empty, OMIT this subheading entirely)\nList datasets by repository and N. Name statistical methods in academic terms ('descriptive statistics', 'group-mean comparisons', 'frequency tabulation'). State that no inferential testing was performed.\n\n### Limitations\nNote: open-access bias, single-reviewer screening, narrative (not systematic) review, no formal quality scoring, no inferential statistics. If charts were generated, mention the per-finding honesty labels.\n\nThis is a NARRATIVE LITERATURE REVIEW, not a systematic review or meta-analysis. NEVER claim PRISMA, inclusion/exclusion tables, inter-rater reliability, Cohen's kappa, or formal data extraction. State 'Quantitative Analysis' subheading ONLY if real datasets were analyzed; otherwise omit it and DO NOT invent participant counts, observations, or sample sizes.",
  results:     "REPORT specific numbers, effect sizes, sample sizes. You MUST embed at least 2 quantitative findings from the QUANTITATIVE FINDINGS block (with figure references like ![[charts/X.svg]] and effect-size labels) BEFORE writing prose summary of the literature. AFTER the embedded findings, contrast literature findings across studies. CALL OUT contradictions. AVOID: 'Several studies have shown X' (vague). PREFER: '(Author, Year) found a 47% reduction (n=240); (Author2, Year) reported a similar 40% reduction (n=180). However, (Author3, Year) found no effect in older adults (n=85), suggesting...'",
  discussion: "INTERPRET findings: for each quantitative finding from the dataset analysis, state whether it CONVERGES with or CONTRADICTS the cited literature, and discuss implications. WHY do results disagree? WHAT mechanism explains the strongest effects? WHAT do critics say? Do not just re-state the Results — this is your ORIGINAL ANALYSIS. Bring in cross-disciplinary perspectives where relevant.",
  conclusion: "Synthesize ONE clear take-away (literature + datasets together). Identify 2-3 SPECIFIC open questions for future research. Do NOT restate the abstract.",
  future_work:"List concrete future research directions, each with a justification of WHY it matters and what method (literature pull / dataset analysis / new study) would address it.",
  ai_ack:     "Acknowledge that this paper was synthesized by an LLM agent. Be specific about which steps were AI-assisted (literature retrieval, schema interpretation, prose synthesis) and which were deterministic (statistical aggregation, chart rendering, citation formatting)."
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
  // Phase 8A — DON'T translate "inclusion/exclusion criteria" to "source-selection
  // heuristics" anymore; the latter sounds AI-generated. Just leave the academic
  // phrasing intact — we DO have inclusion criteria (open-access, English/Hebrew, peer-reviewed).
  out = out.replace(/\b[Dd]ata\s+extraction\s+table\b/g, "source-summary table");
  out = out.replace(/\bquality\s+(?:assessment|scoring)\s+(?:protocol|tool|instrument)?\b/gi, "informal relevance scoring");
  // 2. Drop sentences that reference PRISMA flow / cohen's kappa / inter-rater
  out = out.replace(/[^.]*\b(PRISMA|Cochrane|Cohen'?s\s+kappa|inter-rater\s+reliability)\b[^.]*\./gi, "");
  // Phase 14E — drop sentences that name fabricated databases the pipeline
  // never actually used. Real harvest providers: OpenAlex, CORE, DOAJ, S2,
  // OSF Preprints, Academagic, Figshare, Dryad. LLMs commonly invent these:
  let fabStripped = 0;
  out = out.replace(
    /[^.]*\b(PubMed|PsycINFO|PsycInfo|MEDLINE|Web\s+of\s+Science|Embase|Scopus|Cochrane\s+Library|EBSCO(?:host)?|ProQuest)\b[^.]*\./gi,
    () => { fabStripped++; return ""; }
  );
  if (fabStripped > 0) {
    // Prepend a single honest provenance sentence to the section so the
    // methodology still reads coherently after sentence-level removal.
    const honest = "The literature was harvested via OpenAlex, CORE, DOAJ, Semantic Scholar, OSF Preprints, and Academagic across multiple sub-questions, with deep-PDF reads on accessible open-access articles. ";
    out = honest + out.trimStart();
    console.log(`[thesisSynthesizer] honestifyMethodology: stripped ${fabStripped} fabricated-database sentence(s); prepended honest provenance line`);
  }
  // 3. Tidy up double spaces and orphan punctuation
  out = out.replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").replace(/\(\s*\)/g, "");
  return out.trim();
}

// ── Phase 8A — banned LLM-pipeline jargon in Methodology ───────────────────
// Catches phrasing that screams "the AI is describing itself" (the C- grade
// professor flagged this as suspected academic dishonesty). Each phrase has a
// safe academic substitute. Applied to Methodology sections only.
const PIPELINE_JARGON_SUBSTITUTIONS = [
  // "semantic-chunk indexing" / "semantic chunk index" → "indexed source excerpts"
  [/\bsemantic[\s-]?chunk(?:[\s-]?indexing|[\s-]?index|[\s-]?retrieval)?\b/gi, "indexed source excerpts"],
  // "deterministic aggregation" → "descriptive aggregation"
  [/\bdeterministic\s+aggregation\b/gi, "descriptive aggregation"],
  // "extensive query expansion" / "query expansion" — describe as multi-database keyword search
  [/\b(?:extensive\s+)?query\s+expansion\b/gi, "multi-database keyword search"],
  // "vector embedding for retrieval" / "vector store" / "RAG"
  [/\bvector\s+embedding(?:s)?\s+(?:for\s+)?(?:retrieval|search|index(?:ing)?)?\b/gi, "indexed source excerpts"],
  [/\bvector\s+(?:store|index|database|db)\b/gi, "source-excerpt index"],
  [/\bRAG\b/g, "retrieval over indexed sources"],
  [/\b(?:deterministic|programmatic)\s+(?:JS|JavaScript|Python|aggregation|computation)(?:\s+over\s+(?:full|all)\s+rows)?\b/gi, "descriptive statistical aggregation"],
  [/\brendered\s+programmatically\b/gi, "rendered with charting software"],
  [/\bharvest(?:ed|ing)?\s+(?:articles|sources|datasets)\b/gi, "retrieved sources"],
  [/\bsub-questions?\s+probed\b/gi, "research questions investigated"],
  // "narrative-review pipeline" — drop "pipeline"
  [/\bpipeline\b/gi, "process"],
];
const PIPELINE_JARGON_DETECT = new RegExp(
  PIPELINE_JARGON_SUBSTITUTIONS.map(([re]) => re.source).join("|"),
  "i"
);

function dejargonMethodology(text) {
  if (!text) return { text, replacements: 0 };
  let out = String(text);
  let replacements = 0;
  for (const [re, repl] of PIPELINE_JARGON_SUBSTITUTIONS) {
    const before = out;
    out = out.replace(re, repl);
    if (out !== before) replacements++;
  }
  if (replacements > 0) {
    console.log(`[thesisSynthesizer] dejargon: rewrote ${replacements} pipeline-jargon term(s) in methodology`);
  }
  return { text: out, replacements };
}

// ── Phase 8D — strip "Key Findings:" / "Limitations:" bullet sections ──────
// The professor flagged these as "amateurish" — they belong in slide decks,
// not research papers. Strip them everywhere EXCEPT inside the Conclusion
// (where a brief findings recap is acceptable).
function stripStockBulletSections(text, sectionHeading) {
  if (!text) return text;
  const isConclusion = /conclusion|summary|future/i.test(sectionHeading || "");
  if (isConclusion) return text;
  const original = String(text);
  let out = original;
  let stripped = 0;
  // Pattern: **Key Findings:** (or "Key Takeaways", "Limitations", etc.) followed
  // by a bullet list, optionally separated by blank lines. Stops at the next
  // non-bullet/non-blank line (paragraph) OR at a heading.
  const PATTERNS = [
    // **Key Findings:** / **Key Findings**: / "Key Findings:" — colon may sit
    // inside or outside the bold-asterisks. Followed by 1+ bullet lines.
    // (Don't eat trailing blank lines — leaving them lets the next pattern's
    // `\n+` anchor match the NEXT stock-bullet block on the same scan.)
    /\n+\*{1,2}(?:Key\s+(?:Findings?|Takeaways?|Points?)|Limitations?|Implications?|Highlights?|Summary)\s*:?\s*\*{0,2}\s*:?\s*\n+(?:[-*]\s+[^\n]+\n)+/gi,
    // Bare-line (no bold) variant: "Key Findings:\n- ..."
    /\n+(?:Key\s+(?:Findings?|Takeaways?|Points?)|Limitations?)\s*:\s*\n+(?:[-*]\s+[^\n]+\n)+/gi
  ];
  for (const re of PATTERNS) {
    out = out.replace(re, (match) => {
      // Phase 14A — 60% cap guard (defense in depth). If a single stock-bullet
      // strip would consume more than 60% of the section, abort the strip.
      if (match.length > original.length * 0.6) {
        console.warn(`[thesisSynthesizer] stockBullets: ABORT strip on "${sectionHeading}" — match is ${match.length}c of ${original.length}c (>60%); preserving content`);
        return match;
      }
      stripped++;
      return "\n\n";
    });
  }
  if (stripped) console.log(`[thesisSynthesizer] stockBullets: stripped ${stripped} Key-Findings/Limitations bullet block(s) from "${sectionHeading}"`);
  return out;
}

// ── Phase 10I + 12D — strip conversational preambles ──────────────────────
// Patterns like "Okay, here is an expanded section based on..." are model
// scaffolding that leaks when the LLM is told to "rewrite/expand". Phase 12D
// extends the opener list (deepseek-r1 produces "It targets...", "Based on
// the provided...", "Below is a synthesis...") and allows colon-terminators
// (Lit Review preambles end with ":" not ".").
function stripConversationalPreamble(text) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  // Common preamble openers — case-insensitive match at section start.
  const preamblePattern = /^[\s>]*(?:Okay,?|Sure,?|Certainly,?|Of\s+course,?|Alright,?|Here\s+is|Here's|Below\s+is|It\s+targets|It\s+aims|Aiming\s+for|This\s+synthesis|This\s+piece|This\s+section\s+(?:will|aims|presents|offers)|The\s+following|Based\s+on\s+the\s+provided|Drawing\s+(?:upon|from))\s[^.\n!?:]{0,400}[.!?:][\s\n]*(?:---[\s\n]*)?/i;
  const m = out.match(preamblePattern);
  if (m) {
    out = out.slice(m[0].length).trimStart();
    stripped++;
  }
  if (stripped) console.log(`[thesisSynthesizer] preamble: stripped LLM scaffolding`);
  return out;
}

// ── Phase 12A — strip ```markdown / ```md fence wrappers ──────────────────
// deepseek-r1 wraps section output as:
//   ```markdown
//   # Title
//   ``` content content content
//   ## subsection
//   ```
// Causing chaos in the saved doc. Strip:
//   - leading ```markdown / ```md / ``` openers (any indent)
//   - orphan ``` lines that aren't paired (no language hint, ALONE on a line)
//   - inline ``` that appears immediately before regular prose (not closing a real code block)
function stripMarkdownFences(text) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  // Strip ```markdown or ```md openers (alone on a line)
  out = out.replace(/^[\s>]*```(?:markdown|md)[\s>]*$/gim, () => { stripped++; return ""; });
  // Phase 18C — strip MyST / Jupyter-Book directives that look like code fences
  // but are actually unrendered markup (```{figure}, ```{bibliography},
  // ```{math}, ```{admonition}, etc.). The LLM emits these for academic
  // formatting it has seen in training data, but we don't render MyST and the
  // unclosed opener swallows everything until the next fence — in the CBT
  // run, the Discussion → Conclusion → References sections were all eaten by
  // an unclosed ```{figure} opener at the start of Discussion. Strategy:
  // strip the entire directive block (opening ```{...} line to its matching
  // ``` close, OR to end-of-section if unclosed). Conservative: only target
  // known MyST directive names, leave real fenced code blocks alone.
  out = out.replace(
    /^[\s>]*```\{(?:figure|bibliography|math|admonition|note|warning|tip|important|caution|toctree|csv-table|list-table|tabbed|panels|grid)\}[^\n]*\n[\s\S]*?(?:^[\s>]*```\s*$|(?=^##\s)|(?=^---\s*$)|$)/gm,
    () => { stripped++; return ""; }
  );
  // Strip orphan ``` lines (alone on a line, no content, no language)
  out = out.replace(/^[\s>]*```\s*$/gm, () => { stripped++; return ""; });
  // Strip inline ``` that appears at the start of a line followed by prose
  // (deepseek often emits "``` content..." mid-paragraph)
  out = out.replace(/^[\s>]*```\s+(?=\S)/gm, () => { stripped++; return ""; });
  // Phase 18C — final safety net: if we still have an odd number of ``` markers
  // (an unclosed opener that survived all earlier passes), strip the LAST
  // unmatched opener so it doesn't swallow content downstream.
  const fenceCount = (out.match(/^```/gm) || []).length;
  if (fenceCount % 2 === 1) {
    // Find and remove the last `^```` line (the unmatched opener at the end).
    const lines = out.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^```/.test(lines[i])) {
        lines.splice(i, 1);
        stripped++;
        break;
      }
    }
    out = lines.join("\n");
  }
  // Collapse the resulting blank-line storm
  out = out.replace(/\n{3,}/g, "\n\n");
  if (stripped) console.log(`[thesisSynthesizer] markdownFences: stripped ${stripped} fence(s)`);
  return out;
}

// ── Phase 12B — strip """ triple-quote heredoc markers ────────────────────
// My prompt scaffolding uses `"""` to wrap section drafts. Some models echo
// these markers into the output. Strip lines that are nothing but `"""`.
function stripTripleQuotes(text) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  out = out.replace(/^[\s>]*"""[\s>]*$/gm, () => { stripped++; return ""; });
  out = out.replace(/\n{3,}/g, "\n\n");
  if (stripped) console.log(`[thesisSynthesizer] tripleQuotes: stripped ${stripped}`);
  return out;
}

// ── Phase 13I — Abstract subsection guard ────────────────────────────────
// The Abstract should be a single flowing paragraph (per the directive). When
// the LLM emits subsections like "### 1. Effectiveness Across Conditions" it
// usually means it treated the section like a whole document outline, which
// causes truncation at end-of-budget (saw "Methodological Considerations" cut
// in the latest run). Detect subsection structure and force a flat rewrite.
async function flattenAbstractIfNeeded(text, topic) {
  if (!text) return text;
  const sectionH3Count = (text.match(/^###\s+/gm) || []).length;
  const numberedListCount = (text.match(/^\s*[*-]\s+\*\*\d+\./gm) || []).length;
  if (sectionH3Count < 2 && numberedListCount < 3) return text;
  console.log(`[thesisSynthesizer] flattenAbstract: detected ${sectionH3Count} H3 + ${numberedListCount} numbered items — forcing flat rewrite`);

  const prompt = `The text below is the Abstract of a research paper on "${topic}". An abstract MUST be a single flowing paragraph (150-250 words) — NO subsections, NO bullet lists, NO numbered headings. Rewrite it as ONE narrative paragraph that preserves all the substantive findings (specific numbers, conditions, mechanisms) but flows as continuous prose.

Abstract (currently structured with subsections — flatten it):
"""
${text}
"""

Output the flattened abstract as a single paragraph. Do not output ANY heading lines, bullets, or section markers.`;
  try {
    const res = await llm(prompt, {
      timeoutMs: 90000,
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 4096, num_predict: 600 }
    });
    const out = String(res?.data?.text || "").trim();
    // Sanity: should have NO ### markers and be reasonably long
    if (out && (out.match(/^###\s+/gm) || []).length === 0 && out.length > 200) {
      return out;
    }
    log(`flattenAbstract: rewrite still has structure — keeping original`, "warn");
  } catch (err) {
    log(`flattenAbstract: ${err.message} — keeping original`, "warn");
  }
  return text;
}

// ── Phase 13A — strip H1 (`# `) inside section bodies ────────────────────
// The document-level H1 is owned by the assembler at draft start. When the
// LLM emits its own `# Title` mid-section (treating the section as a whole
// document), it breaks the outline. Strip H1 lines from section body
// entirely (don't demote — they're usually duplicate document titles).
function stripSectionH1s(text, sectionHeading) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  out = out.replace(/^#\s+(?!#)([^\n]+)$/gm, (match, headingText) => {
    stripped++;
    return "";   // delete the H1 line entirely
  });
  if (stripped) console.log(`[thesisSynthesizer] H1strip: removed ${stripped} stray H1 from "${sectionHeading}"`);
  return out.replace(/\n{3,}/g, "\n\n");
}

// ── Phase 13B — strip fabricated bibliography blocks ──────────────────────
// The LLM sometimes emits its own "References:" or "Bibliography:" block at
// the end of a section (esp. Results, Discussion) with fabricated entries.
// The real bibliography is appended later by the deterministic citation
// emitter. Detect "References:\n- Author... (N entries)" inside section body
// and strip the whole block.
function stripFabricatedBibliography(text, sectionHeading) {
  if (!text) return text;
  const original = String(text);
  let out = original;
  let stripped = 0;
  // Phase 14A — TIGHTENED patterns:
  //   1. Bullet line must contain a real author signature: surname-comma-initial
  //      (`Smith, J.`) or surname-amp-or-and (`Smith & Jones` / `Smith and Jones`).
  //      The old `[A-Z][^\n]{20,500}` matched any prose bullet starting with a
  //      capital, which over-ate study-summary bullets in the Lit Review.
  //   2. Anchor: the "References:" / "Bibliography:" line must NOT be followed
  //      by a paragraph of prose before the bullets — `\n+` allows blank lines
  //      only, not text. (No textual change required; `\n+` already enforces
  //      whitespace-only.)
  //   3. The whole match is capped: if it would consume >60% of the section,
  //      we abort the strip (preserve content over cleanliness) and warn.
  const AUTHOR_BULLET = "[-*]\\s+[A-Z][\\p{L}'\\-]+,\\s*[A-Z]\\.[^\\n]{0,500}";
  const AUTHOR_BULLET_AMP = "[-*]\\s+[A-Z][\\p{L}'\\-]+\\s+(?:&|and)\\s+[A-Z][\\p{L}'\\-]+[^\\n]{0,500}";
  // Header alt allows colon both INSIDE the bold (`**References:**`) and OUTSIDE
  // (`**References**:`), plus plain `References:` and `## References`.
  const REF_HEADER = "(?:#{0,3}\\s*)?(?:\\*\\*)?References?:?(?:\\s*Cited)?:?(?:\\*\\*)?\\s*:?\\s*";
  const BIB_HEADER = "(?:#{0,3}\\s*)?(?:\\*\\*)?Bibliography:?(?:\\*\\*)?\\s*:?\\s*";
  const refBlockPatterns = [
    new RegExp(
      `\\n+${REF_HEADER}\\n+(?:(?:${AUTHOR_BULLET}|${AUTHOR_BULLET_AMP})\\n+){3,}`,
      "giu"
    ),
    new RegExp(
      `\\n+${BIB_HEADER}\\n+(?:(?:${AUTHOR_BULLET}|${AUTHOR_BULLET_AMP})\\n+){3,}`,
      "giu"
    ),
  ];
  for (const re of refBlockPatterns) {
    out = out.replace(re, (match) => {
      // Phase 14A — 60% cap guard: abort strip if it would consume too much.
      if (match.length > original.length * 0.6) {
        console.warn(`[thesisSynthesizer] fabricatedBib: ABORT strip on "${sectionHeading}" — match is ${match.length}c of ${original.length}c (>60%); preserving content`);
        return match;
      }
      stripped++;
      return "\n\n";
    });
  }
  if (stripped) console.log(`[thesisSynthesizer] fabricatedBib: stripped ${stripped} fabricated bibliography block(s) from "${sectionHeading}"`);
  return out;
}

// ── Phase 13C — strip orphan numeric citation markers `[N]`, `[N, M]` ────
// When the LLM partially constructs a numeric-ref scheme but the matching
// numeric reference list got stripped (or never existed), the in-text `[5]`
// and `[5, 6]` markers are orphan trash. We use APA in-text style; numeric
// markers should never appear in the final prose.
function stripOrphanNumericRefs(text) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  // Match `[N]`, `[N, M]`, `[N-M]`, `[N, M, P]` between word-content (not at
  // start of line — avoid stripping bullet markers).
  out = out.replace(/(\w[^\n]{0,50}?)\[\d+(?:[,\s\-]+\d+)*\](?=[\s.,;:)])/g, (m, prefix) => {
    stripped++;
    return prefix;
  });
  if (stripped) console.log(`[thesisSynthesizer] orphanNumericRefs: stripped ${stripped} bracketed numeric ref(s)`);
  return out;
}

// ── Phase 15H — no-charts provenance note ─────────────────────────────────
// When a run retrieves N datasets but all are metadata-only (no parseable
// rows or files), no charts can be produced. The user wonders why a previous
// run had a chart and this one didn't. Surface it in the saved file.
// Exported for smoke testing.
export function buildNoChartsNote(datasetCount, parseableCount = 0) {
  if (!datasetCount || datasetCount < 1) return "";
  if (parseableCount > 0) return "";   // charts present, no note needed
  return [
    `> [!note] No charts in this run`,
    `> ${datasetCount} dataset(s) were retrieved but all were metadata-only (no parseable rows or files).`,
    `> This is expected variance — different sub-questions route to different providers each run.`,
    `> Future runs may produce charts when sub-questions hit dataset-rich providers like figshare or dryad.`,
    "",
    ""
  ].join("\n");
}

// ── Phase 14F — bridge-skip warning callout ────────────────────────────────
// Renders an Obsidian warning callout for the top of the saved thesis when
// the manual-bridge gate fired (`OFFER`) but couldn't actually pause the
// pipeline (missing conversationId). Surfaces the failure to the user the
// moment they open the note. Exported for smoke testing.
export function buildBridgeSkipCallout(notice, vaultRel) {
  if (!notice || !notice.count) return "";
  const sample = (notice.blocked || []).slice(0, 8).map(b => {
    const url = (b.url || "").slice(0, 80);
    const kind = b.kind || "source";
    return `> - **${kind}**: \`${url}\``;
  }).join("\n");
  const more = notice.count > 8 ? `\n> - …and ${notice.count - 8} more` : "";
  return [
    `> [!warning] Manual Bridge Skipped — ${notice.count} source(s) unfilled`,
    `> The pipeline detected ${notice.count} blocked source(s) (paywalls, redirect loops, fetch failures) but could not pause for manual upload because no conversationId was attached to this run.`,
    `> To recover them: drop PDF/CSV files into \`${vaultRel}/_pending/\` and re-run with`,
    `> \`[depth:thesis] continue ${vaultRel.split("/").pop()} bridge\`.`,
    `>`,
    `> First blocked sources:`,
    sample + more,
    "",
    ""
  ].join("\n");
}

// ── Phase 15B — detect LLM-error sentinel strings ─────────────────────────
// `server/tools/llm.js` returns `{success:false, data:{text:"The language model
// encountered an error: ${err.message}"}}` on timeout/abort. Without an explicit
// guard, callers that consume `.data.text` blindly write the error string into
// the saved markdown (the CBT thesis run had this leak mid-Results).
const LLM_ERROR_SENTINELS = [
  /The language model encountered an error[:\s]/i,
  /LLM request aborted or timed out/i,
  /\(synthesis failed for this section/i,
];
export function looksLikeLlmError(text) {
  if (!text || typeof text !== "string" || text.length < 20) return false;
  return LLM_ERROR_SENTINELS.some(re => re.test(text));
}

// ── Phase 15E — strip model meta-commentary parentheticals ────────────────
// Patterns like `(given the hypothetical year 2026 reference, likely intended
// as a placeholder for illustrative examples)` leak from the model talking
// ABOUT its prompt instead of using it. Strip these without touching legit
// parentheticals like `(p<.05)` or `(Smith, 2020)`.
function stripMetaCommentary(text) {
  if (!text) return text;
  let stripped = 0;
  const META_PATTERNS = [
    // Parenthetical containing a meta-marker word
    /\([^)]{0,400}\b(?:hypothetical(?:\s+year)?|placeholder|illustrative\s+(?:example|purposes?)|likely\s+intended|note\s+that|disclaimer\b|for\s+the\s+purpose\s+of\s+(?:this\s+)?(?:example|illustration)|in\s+this\s+synthesis|as\s+(?:an?\s+)?(?:example|illustration))\b[^)]{0,400}\)/gi,
    // Bare "Note: ..." / "Disclaimer: ..." sentence
    /(?:^|\s)(?:Note|Disclaimer)\s*:\s+[^.\n]{20,300}\.(?=\s|$)/g,
  ];
  for (const re of META_PATTERNS) {
    text = text.replace(re, () => { stripped++; return ""; });
  }
  if (stripped) {
    text = text.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:)])/g, "$1");
    console.log(`[thesisSynthesizer] metaCommentary: stripped ${stripped} meta-commentary block(s)`);
  }
  return text;
}

// ── Phase 14B — detect mid-sentence truncation ────────────────────────────
// deepseek-r1's <think>...</think> reasoning consumes tokens, so visible
// output sometimes ends mid-sentence even when word_count looks under-budget.
// Logs from the CBT thesis run showed Abstract ending "…making strong causal"
// and Introduction §V ending "* A pilot dataset (N=3" — clearly cut.
// Healthy endings: . ! ? ) ] " ' or markdown structure (`]]`, `*Figure 1.*`).
// Truncation tells: trailing comma, lowercase word, conjunction, or open paren+digit.
function looksTruncated(text) {
  if (!text || text.length < 80) return false;
  // Strip trailing whitespace and any markdown artifacts
  const tail = String(text).replace(/[\s>]+$/, "").slice(-160);
  if (!tail) return false;
  // Healthy endings
  if (/[.!?)\]"'»’”]$/.test(tail)) return false;
  if (/\]\]$/.test(tail)) return false;            // wikilink
  if (/\*$|_$/.test(tail)) return false;            // bold/italic close
  // Truncation tells
  if (/[a-z,]$/.test(tail)) return true;
  if (/\b(and|or|the|a|an|in|of|with|that|to|from|by|for|as|on|at|is|are|was|were|but|while|when|which|where|but|though)$/i.test(tail)) return true;
  if (/\(\s*[NnPpKk]?\s*=?\s*\d*$/.test(tail)) return true;     // "(N=" or "(N=3"
  if (/&$|\+$|-$/.test(tail)) return true;          // hanging conjunction/operator
  // Phase 18F — partial-citation-year truncation. The CBT thesis Abstract
  // ended with "...Cognitive-Behavioral Treatment for Depression in
  // Adolescents, 20" — a citation year cut mid-digits inside an unclosed
  // paren. Detect:
  //   (a) trailing 1-3 digits NOT followed by a closing paren or punctuation
  //   (b) open paren that hasn't been closed before end-of-tail
  if (/,\s*\d{1,3}$/.test(tail)) return true;       // "..., 20" (partial year after comma)
  if (/\b\d{1,3}$/.test(tail) && !/\d{4}$/.test(tail)) return true;   // bare 1-3 digits, but not a full year
  // Unclosed paren in the tail (open without matching close)
  const opens = (tail.match(/\(/g) || []).length;
  const closes = (tail.match(/\)/g) || []).length;
  if (opens > closes) return true;
  return false;
}

// ── Phase 14D — strip alphabetic bracket-tag pseudo-citations ─────────────
// LLMs (esp. deepseek-r1) invent study labels like `[Cochrane review]`,
// `[Mexico Trial Data]`, `[Mindset App Analysis]`, `[Evidence from "..." description]`
// and inject them as if they were citations. Our actual citation system is APA
// in-text only. Strip any [X] whose content is NOT:
//   - numeric-only (handled elsewhere by Phase 13C; leave alone)
//   - APA-shaped (contains a 4-digit year in valid range)
//   - a wikilink ([[X]]) — guarded by negative lookbehind/ahead
//   - a markdown link ([text](url)) — guarded by negative lookahead `(?![\]\(])`
function stripBracketTags(text) {
  if (!text) return text;
  let stripped = 0;
  let out = String(text).replace(/(?<!\[)\[([^\]\n]{3,200})\](?![\]\(])/g, (m, inner) => {
    const trimmed = inner.trim();
    // Numeric ref → keep (Phase 13C handles separately)
    if (/^[\d,\s\-]+$/.test(trimmed)) return m;
    // APA-style — must contain a plausible year
    if (/\b(1[7-9]\d{2}|20\d{2}|21\d{2})\b/.test(trimmed)) return m;
    // Footnote/note marker style ^N or *N — keep
    if (/^[*^]\d+$/.test(trimmed)) return m;
    stripped++;
    return "";
  });
  if (stripped) {
    // Collapse double-spaces and stray spaces before punctuation left behind
    out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:)])/g, "$1");
    console.log(`[thesisSynthesizer] bracketTags: stripped ${stripped} alphabetic bracket-tag(s)`);
  }
  return out;
}

// ── Phase 13E — deterministic acronym wrapper ─────────────────────────────
// Known mental-health/research acronyms that should always be wikilinked.
// Augments the LLM-driven enrichWithWikilinks (which is conservative on
// short tokens). Applied as a post-pass.
const ACRONYM_WIKILINK_LIST = [
  // CBT family
  "CBT", "CBT-I", "CBT-T", "CBT-E", "TF-CBT", "MBCT",
  // Common diagnoses
  "PTSD", "OCD", "GAD", "ADHD", "PGD", "C-PTSD",
  // Therapy variants
  "ACT", "DBT", "EMDR", "IPT", "MBSR",
  // Other
  "RCT", "PRISMA"
];
function wrapAcronymsAsWikilinks(text, alreadyLinked = new Set()) {
  if (!text) return text;
  // Phase 22 — skip heading lines so wikilinks never get injected into
  // `### Foo` or `#### Bar`. The May CBT thesis-deep run had three smushed
  // headings because the wrapper inserted `[[CBT]]` into heading text, and
  // markdown reflow then broke the heading line in half.
  const HEADING_RE = /^\s{0,3}#{1,6}\s/;
  const lines = String(text).split("\n");
  let wrapped = 0;
  // Track firstMatchUsed across the WHOLE document (not per-line), to keep
  // the "link only first occurrence" semantics the function had before.
  const firstMatchUsed = new Map(); // acronym (lowercase) → bool
  for (let li = 0; li < lines.length; li++) {
    if (HEADING_RE.test(lines[li])) continue;   // never touch heading lines
    let line = lines[li];
    for (const acronym of ACRONYM_WIKILINK_LIST) {
      if (alreadyLinked.has(acronym.toLowerCase())) continue;
      const key = acronym.toLowerCase();
      if (firstMatchUsed.get(key) && process.env.WIKILINK_ALL_OCCURRENCES !== "true") continue;
      const escaped = acronym.replace(/-/g, "\\-");
      const re = new RegExp(`(?<!\\[\\[)(?<![\\w-])(${escaped})(?![\\w-])(?!\\]\\])`, "g");
      line = line.replace(re, (m, captured) => {
        if (firstMatchUsed.get(key) && process.env.WIKILINK_ALL_OCCURRENCES !== "true") return m;
        firstMatchUsed.set(key, true);
        wrapped++;
        return `[[${captured}]]`;
      });
    }
    lines[li] = line;
  }
  if (wrapped) console.log(`[thesisSynthesizer] acronymWikilinks: wrapped ${wrapped} acronym occurrence(s) (headings skipped)`);
  return lines.join("\n");
}

// ── Phase 12E — demote section-body H2 headings to H3 ─────────────────────
// The assembler owns the section's `## Heading`. When the LLM emits its own
// `## Subheading` mid-body, you get a structural mess (Abstract had 7 H2s
// in the GraphRAG run). Demote any `^## ` inside the section body to `### `
// so the assembler's hierarchy stays intact while preserving substructure.
function demoteSectionH2sToH3(text, sectionHeading) {
  if (!text) return text;
  let out = String(text);
  let demoted = 0;
  // Only demote H2s that are NOT the section's own heading (those get
  // separately stripped by stripDuplicateLeadingHeading + stripMidBodyDuplicateHeading).
  const expected = String(sectionHeading || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
  out = out.replace(/^(##)\s+(.+?)\s*$/gm, (match, hashes, headingText) => {
    const norm = headingText.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (norm === expected || (expected.length > 6 && norm.includes(expected))) {
      // Owned by the section — leave to dedicated heading-strip helpers
      return match;
    }
    demoted++;
    return `### ${headingText}`;
  });
  if (demoted) console.log(`[thesisSynthesizer] H2demote: demoted ${demoted} stray H2 → H3 in "${sectionHeading}"`);
  return out;
}

// ── Phase 19B — strip empty H4 stubs ──────────────────────────────────────
// LLMs sometimes emit `#### Heading\n\n#### Next Heading` where the first H4
// has zero body content. The CBT thesis Methodology had:
//   #### Systematic Review and Meta-Analysis of CBT for Anorexia Nervosa
//   #### Comparative Analysis with Other Therapies
// — the first H4 was an empty stub. Strip these.
function stripEmptyH4Stubs(text) {
  if (!text) return text;
  const before = text;
  // H4 immediately followed by another heading (any level) with no body
  const out = String(text).replace(
    /^#### [^\n]+\n\s*(?=^####\s|^###[^#]|^##[^#]|^#[^#])/gm,
    ""
  );
  if (out !== before) console.log(`[thesisSynthesizer] emptyH4Stubs: stripped`);
  return out;
}

// ── Phase 19C — strip embedded `### References` section blocks ────────────
// The LLM treats each section as a complete document and emits its own
// "### References\n\n1.\n2.\n..." stub at section end. The real bibliography
// is appended at document level later, so this is always pure leakage and
// produces the duplicate-References artifact the user spotted in the CBT
// thesis run.
function stripEmbeddedReferencesBlock(text) {
  if (!text) return text;
  const before = text;
  // Strip any "### References" / Bibliography / Works Cited / Citations heading
  // and EVERYTHING that follows within the section.
  const out = String(text).replace(
    /^###\s+(?:References?|Bibliography|Citations?|Works\s+Cited)\s*\n[\s\S]*$/im,
    ""
  ).trimEnd();
  if (out !== before) console.log(`[thesisSynthesizer] embeddedRefs: stripped section-level References block`);
  return out;
}

// ── Phase 19D — strip embedded `### Conclusion` blocks from non-Conclusion sections ──
// LLMs sometimes append a self-summarizing `### Conclusion\n\n...summary...`
// at the end of any section, treating it like a standalone essay. The
// document already has a top-level `## Conclusion` section so these mini
// summaries cause repetition and tonal awkwardness.
function stripEmbeddedConclusionBlock(text, sectionHeading) {
  if (!text) return text;
  // Don't strip from the actual Conclusion section
  if (/^conclusion$/i.test(String(sectionHeading || "").trim())) return text;
  const before = text;
  const out = String(text).replace(
    /^###\s+(?:Conclusion|Summary|Final\s+Thoughts)\s*\n[\s\S]*$/im,
    ""
  ).trimEnd();
  if (out !== before) console.log(`[thesisSynthesizer] embeddedConclusion: stripped from "${sectionHeading}"`);
  return out;
}

// ── Phase 19E — strip meta-commentary tail blocks ─────────────────────────
// The LLM ends sections with self-narrating paragraphs like:
//   "This expanded section delves deeper into the mechanisms..."
//   "This structured approach ensures that the introduction covers..."
//   "...going beyond the initial 610-word draft."
// These leak when the model is too aware of being asked to expand. Strip
// them when they appear at the very end of a section, with or without a
// preceding `---` separator.
function stripMetaCommentaryTail(text) {
  if (!text) return text;
  const before = text;
  let out = String(text);
  // Pattern A — separator + meta paragraph at end
  out = out.replace(
    /\n+---\s*\n+(?:This (?:expanded |structured |comprehensive )?(?:section|approach|review|analysis)|By integrating|This (?:section|review) (?:provides|delves|covers))[\s\S]+?$/i,
    ""
  );
  // Pattern B — meta paragraph alone at end (no separator)
  out = out.replace(
    /\n+(?:This (?:expanded |structured |comprehensive )?(?:section|approach|review|analysis) (?:delves|ensures|provides|underscores|highlights|covers|goes beyond)|By integrating technology[^\n]*?,?\s*(?:CBT|this section|this review))[\s\S]+?(?:draft\.|field\.|innovation\.|conditions\.|disorders\.|outcomes\.)\s*$/i,
    ""
  );
  // Pattern C — "going beyond the initial Nw draft" tail (very specific leak)
  out = out.replace(/\n+[^\n]*\bgoing beyond the initial \d+\s*-?\s*word draft[^\n]*\.\s*$/i, "");
  if (out !== before) console.log(`[thesisSynthesizer] metaCommentary: stripped tail self-narration`);
  return out.trimEnd();
}

// ── Phase 19F — strip "(unverified study)" placeholder citations ──────────
// When the prompt demands a citation but the LLM has nothing to cite, it
// emits literal "(unverified study)", "(hypothetical study)", "(placeholder
// study)" markers. The CBT Lit Review used "(unverified study)" 11+ times.
// Strip the parenthetical entirely; the surrounding sentence still reads
// fine without it.
function stripUnverifiedStudyMarkers(text) {
  if (!text) return text;
  const before = text;
  let stripped = 0;
  let out = String(text);
  // " by (unverified study)" full attribution form first
  out = out.replace(/\s+by\s+\((?:unverified|hypothetical|placeholder|fictional|illustrative)\s+stud(?:y|ies)\)/gi, () => { stripped++; return ""; });

  // Phase 20H — `(unverified study)` wrapped inside a multi-citation paren.
  // The May CBT thesis had: `((unverified study), 2012; Williams et al., 2015)`
  // — the marker is INSIDE the outer citation paren so the bare-paren regex
  // below doesn't match. Strip the wrapped form + its year, plus the leading
  // separator if there is one, leaving a clean outer paren.
  // Form A: `((unverified study), YYYY; <rest>)` → `(<rest>)`
  out = out.replace(/\(\((?:unverified|hypothetical|placeholder)\s+stud(?:y|ies)\),\s*\d{4}[a-z]?\s*;\s*/gi, () => { stripped++; return "("; });
  // Form B: `(<other>; (unverified study), YYYY)` → `(<other>)`
  out = out.replace(/\s*;\s*\((?:unverified|hypothetical|placeholder)\s+stud(?:y|ies)\),\s*\d{4}[a-z]?(?=\s*\))/gi, () => { stripped++; return ""; });
  // Form C: `((unverified study), YYYY)` only — entire outer paren is bogus
  out = out.replace(/\s*\(\((?:unverified|hypothetical|placeholder)\s+stud(?:y|ies)\),\s*\d{4}[a-z]?\)\s*/gi, () => { stripped++; return " "; });

  // Bare parenthetical (with optional comma after)
  out = out.replace(/\s*\((?:unverified|hypothetical|placeholder|fictional|illustrative)\s+(?:stud(?:y|ies)|references?|sources?)\)\s*,?\s*/gi, () => { stripped++; return " "; });
  // Tidy the resulting double-spaces and orphan commas
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1");
  if (stripped) console.log(`[thesisSynthesizer] unverifiedStudyMarkers: stripped ${stripped}`);
  return out;
}

// ── Phase 19I — split smushed `### heading body` lines ────────────────────
// LLMs occasionally emit an H3 heading followed on the SAME line by what
// should be the body's first sentence. The CBT Methodology had:
//   ### Introduction to Cognitive Behavioral Therapy (CBT) in Mental Health Cognitive Behavioral Therapy (CBT) is a widely recognized...
// Split at the period+capitalized-word boundary so the heading is short and
// the body starts on a new paragraph.
function splitSmushedHeadingBody(text) {
  if (!text) return text;
  let splits = 0;
  let out = String(text);

  // Phase 23A — extended to all H3-H6 levels (was H3-only). The CBT thesis-deep
  // output had `#### Title Body sentence...` patterns in Intro, Methodology,
  // Results, Conclusion — none caught because Phase 19I/20G hardcoded `### `.

  // Heuristic A: heading line with `. <Capital body>` boundary.
  out = out.replace(/^((#{3,6}) [^\n]{30,200}?)\.\s+([A-Z][a-z][^\n]{40,})$/gm, (m, head, _h, body) => {
    splits++;
    return `${head}.\n\n${body}`;
  });

  // Heuristic B: heading line without a period boundary. E.g.
  //   ### Efficacy Across Mental Health Conditions The literature supports the efficacy of...
  // No period between the heading title and the body opener.
  const BODY_STARTERS_RE = /\b(?:The|This|These|Those|It|A|An|Despite|Although|While|Several|Many|Most|Studies|Research|Evidence|Findings|Recent|Cognitive|However|Furthermore|Moreover|Numerous|One|Two|Three|First|Second|In\s+\w|A\s+meta-analysis|A\s+systematic|For\s+example|Specifically|Although|Yet|Whereas)\b/;
  out = out.replace(/^((#{3,6}) [^\n]{40,300})$/gm, (line, _full, hashes) => {
    if (/^#{3,6} [^\n]+\.\s/.test(line)) return line;   // Already handled by A
    if (line.length < 90) return line;
    const headPart = line.slice(hashes.length + 1);     // strip "### "/"#### " etc.
    const words = headPart.split(/\s+/);
    if (words.length < 6) return line;
    for (let i = words.length - 1; i >= 3; i--) {
      const next = words.slice(i + 1).join(" ");
      if (next.length < 40) continue;
      if (!BODY_STARTERS_RE.test(words.slice(i + 1, i + 4).join(" "))) continue;
      const headPartWords = words.slice(0, i + 1);
      const titleCaseCount = headPartWords.filter(w => /^[A-Z][a-zA-Z'\-]*$/.test(w) || /^(of|and|for|the|in|on|at|to|a|an|with|across|by)$/i.test(w)).length;
      if (titleCaseCount / headPartWords.length < 0.7) continue;
      splits++;
      return `${hashes} ${words.slice(0, i + 1).join(" ")}\n\n${next}`;
    }
    return line;
  });

  if (splits > 0) console.log(`[thesisSynthesizer] smushedHeading: split ${splits} heading(s) from inline body`);
  return out;
}
// Phase 23A — backwards-compat alias; old name still referenced by helpers.
const splitSmushedH3HeadingBody = splitSmushedHeadingBody;

// Phase 23A — paragraph-boundary normaliser. Runs once on the assembled
// draft before lint() so the lint paragraph splitter (split on `\n{2,}`)
// actually sees real paragraphs. Without this, the LLM occasionally emits
// `# Heading body body body body…` (everything on one line) and the lint
// pass treats the entire section as ONE 1500w paragraph that then sails
// into rewriteParagraph() and times out.
//
// Two patterns inserted:
//   1. heading line followed directly by a body line (no blank line between)
//      `#### Title\nProse without leading hash` → `#### Title\n\nProse...`
//   2. sentence-ending body followed by a heading on the same line
//      `…sentence. ### Heading` → `…sentence.\n\n### Heading`
//
// Both regexes only fire on heading markers `#{1,6} ` to avoid disturbing
// numbered lists, indented bullets, etc.
function normaliseParagraphBoundaries(text) {
  let out = String(text || "");
  let inserted = 0;
  out = out.replace(/^(#{1,6} [^\n]+)\n(?!\s*$|#|\s*\n)/gm, (m, head) => {
    inserted++;
    return `${head}\n\n`;
  });
  out = out.replace(/([.!?])[ \t]+(#{2,6}[ \t]+[A-Z])/g, (m, p, h) => {
    inserted++;
    return `${p}\n\n${h}`;
  });
  if (inserted > 0) console.log(`[thesisSynthesizer] paragraphBoundaries: inserted ${inserted} \\n\\n boundary marker(s)`);
  return out;
}

// Phase 23A — strip leading section-name duplicates. The CBT thesis-deep
// Introduction body opened with a bare `Introduction:` line right after
// the assembler-injected `## Introduction` heading. This pattern repeats
// (Methodology, Results, Discussion, Conclusion). Removing it eliminates
// the duplicate-title noise and reduces the surface area that the
// smushed-heading regex has to chew through.
function stripLeadingSectionLabel(body, heading) {
  if (!body || !heading) return body;
  const target = String(heading).trim();
  if (!target) return body;
  // Match: optional whitespace, the target text (case-insensitive), optional
  // `:` or `.`, then a newline. Allows multiple variants like:
  //   "Introduction:\n", "Introduction\n", " introduction :\n"
  const re = new RegExp(`^\\s*${escapeRegex(target)}\\s*[:.]?\\s*\\n+`, "i");
  return body.replace(re, "");
}

// Phase 23A — continuation-pass overlap dedupe. When the continuation
// LLM call appends new text, it sometimes restarts mid-sentence and
// repeats the tail of the prior body. Example from May CBT thesis-deep:
//   prior: "…This paper examines whether cognitive behavioral"
//   appended: "This paper examines whether cognitive behavioral therapy …"
// → reads "…cognitive behavioral This paper examines whether cognitive
//    behavioral therapy …". Dedupe by finding the longest suffix of the
// prior tail that also prefixes the continuation, then trimming.
function dedupeContinuationOverlap(sectionTail, continuation) {
  if (!sectionTail || !continuation) return continuation;
  const tail = String(sectionTail).slice(-200);
  for (let len = Math.min(tail.length, continuation.length); len >= 20; len--) {
    const candidate = tail.slice(-len);
    if (continuation.startsWith(candidate)) {
      return continuation.slice(len).trimStart();
    }
  }
  return continuation;
}

// ── Phase 18E — normalize Roman-numeral H3 series ─────────────────────────
// LLMs sometimes emit a section that starts with an unprefixed H3 then jumps
// to Roman-numbered H3s (the CBT thesis Lit Review had:
//   ### Overall Efficacy and Standing of CBT
//   ### II. Key Areas of Application
//   ### III. Effectiveness, Limitations, and Related Factors
//   ### IV. Implementation and Future Directions
// — `I.` is missing). When we detect `II.` AND a preceding non-Roman H3
// inside the same section, prepend `I.` to the first non-Roman H3 so the
// numbering is consistent.
function normalizeRomanH3Series(text, sectionHeading) {
  if (!text) return text;
  const lines = String(text).split("\n");
  // Find all H3 line indices in this section
  const h3Indices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^###\s+\S/.test(lines[i])) h3Indices.push(i);
  }
  if (h3Indices.length < 2) return text;
  // Detect a Roman series: at least one ### II. heading
  const ROMAN_RE = /^###\s+(I{2,3}|IV|VI{0,3}|IX|X)\.\s+/;
  const hasIIPlus = h3Indices.some(i => ROMAN_RE.test(lines[i]));
  if (!hasIIPlus) return text;
  // Already has `### I.`? — series is fine
  const hasI = h3Indices.some(i => /^###\s+I\.\s+/.test(lines[i]));
  if (hasI) return text;
  // Find the first H3 BEFORE the first ### II./III. that doesn't start with a Roman
  const firstRomanIdx = h3Indices.find(i => ROMAN_RE.test(lines[i]));
  let prependTarget = -1;
  for (const i of h3Indices) {
    if (i >= firstRomanIdx) break;
    // Skip headings that already have any leading numeral/roman
    if (/^###\s+(\d+\.|[IVX]+\.)/.test(lines[i])) continue;
    prependTarget = i;
    break;
  }
  if (prependTarget === -1) return text;
  lines[prependTarget] = lines[prependTarget].replace(/^###\s+/, "### I. ");
  console.log(`[thesisSynthesizer] romanH3Series: prepended "I." to first non-Roman H3 in "${sectionHeading}"`);
  return lines.join("\n");
}

// ── Phase 10J — strip duplicate `## Heading` mid-body + leading `---` ─────
// The assembler adds the section H2; if the LLM also emits one (with or
// without preamble), we end up with two. Phase 5F's stripDuplicateLeadingHeading
// only catches LEADING headings — this catches mid-body duplicates and stray
// horizontal rules at the section start.
function stripMidBodyDuplicateHeading(text, sectionHeading) {
  if (!text || !sectionHeading) return text;
  let out = String(text);
  let stripped = 0;
  // Strip leading `---` separator (often pairs with a stripped preamble)
  out = out.replace(/^[\s\n]*---\s*\n+/, () => { stripped++; return ""; });
  const expected = sectionHeading.toLowerCase().replace(/[^\w\s]/g, "").trim();
  // Find any H2 whose normalized text equals the section heading (mid-body)
  const headingRe = /^(#{1,3})\s+(.+?)\s*$/gm;
  out = out.replace(headingRe, (match, _hashes, headingText) => {
    const norm = headingText.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (norm === expected || (norm.includes(expected) && expected.length > 6)) {
      stripped++;
      return "";   // drop the duplicate heading line
    }
    return match;
  });
  // Collapse the resulting blank-line storm
  out = out.replace(/\n{3,}/g, "\n\n");
  if (stripped) console.log(`[thesisSynthesizer] dupHeading: stripped ${stripped} duplicate heading/separator(s) from "${sectionHeading}"`);
  return out;
}

// ── Phase 10K — lint malformed wikilinks ──────────────────────────────────
// Catches LLM-emitted wikilinks containing parenthetical sentences or unclosed
// brackets, e.g. `[[Document GraphRAG: ... (Evaluation demonstrates consistent...)]`
// (note: only one `]` at the end). These render badly in Obsidian and create
// junk stub files when resolveWikilinks runs.
function lintMalformedWikilinks(text) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  // Phase 12C — `[![[X]]]` malformed wikilink-with-image-bang. The LLM mixes
  // image-embed `![[...]]` with wikilink `[[...]]` syntax, producing things
  // like `[![[Parental Involvement in CBT...]]]`. The leading `[!` is also
  // an Obsidian callout marker, which adds to the confusion. Convert to
  // plain `[[X]]`.
  out = out.replace(/\[!\[\[([^\]\n]{5,300}?)\]\]\]/g, (m, inner) => {
    stripped++;
    return `[[${inner}]]`;
  });
  // 1. Wikilinks with sentence-style parentheticals inside (nested-clause hint)
  out = out.replace(/\[\[([^\]\n]{20,200}?\([A-Z][^\]\n]{30,}?\.\.?\)[^\]\n]{0,40})\]\]/g, (m, inner) => {
    stripped++;
    // Replace with a quoted plain-text reference (preserve the leading title)
    const titleOnly = inner.split(/[:.(]/)[0].trim();
    return titleOnly ? `"${titleOnly}"` : "";
  });
  // 2. Unclosed `[[X]` (single trailing bracket) — convert to italic plain text
  out = out.replace(/\[\[([^\]\n]{5,200}?)\](?!\])/g, (m, inner) => {
    stripped++;
    const cleaned = inner.split(/[:.(]/)[0].trim();
    return cleaned ? `*${cleaned}*` : "";
  });
  // 3. Wikilinks containing newlines (always malformed)
  out = out.replace(/\[\[[^\]]*\n[^\]]*\]\]/g, () => { stripped++; return ""; });
  if (stripped) console.log(`[thesisSynthesizer] malformedWikilinks: cleaned ${stripped}`);
  return out;
}

// ── Phase 10L — strip deepseek-r1 thinking blocks ─────────────────────────
// deepseek-r1 emits <think>...</think> reasoning that should never reach the
// final document. The model is tuned to keep these private but occasionally
// leaks them through.
function stripThinkingBlocks(text) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, () => { stripped++; return ""; });
  // Also catch unclosed <think> blocks (model truncated mid-think)
  out = out.replace(/<think>[\s\S]*$/i, () => { stripped++; return ""; });
  if (stripped) console.log(`[thesisSynthesizer] thinkingBlocks: stripped ${stripped}`);
  return out;
}

// ── Phase 10D — fabricated-author lint (prose attribution patterns) ───────
// Catches "Smith et al. (2020)", "Smith and Jones (2020)", "Smith (2020) found"
// where the surname is NOT in the citation index. lintStrayCitations only
// catches `(Smith, 2020)` parenthetical forms — prose attributions slip past.
//
// Strategy: build a whitelist of valid surnames from the citation index, then
// scan for the prose patterns. If the lead surname isn't whitelisted, strip
// the year-paren and any leading attribution clause.
function lintFabricatedAuthorsInProse(draft, citationIndex) {
  if (!draft || !Array.isArray(citationIndex) || citationIndex.length === 0) return draft;
  // Build whitelist of surnames (first-author + first-two characters of surname-prefix
  // checks for short surnames that might collide).
  const validSurnames = new Set();
  // Phase 19K — also build a surname+year tuple set. The CBT thesis run had
  // real "Fairburn" and "Andersson" in the citation index (some year) but the
  // LLM emitted "Fairburn et al. (2005)" and "Andersson et al. (2018)" with
  // years that did NOT match any real harvested entry. The old surname-only
  // check accepted those as valid; the tuple check rejects them.
  const validSurnameYears = new Set();
  for (const ce of citationIndex) {
    for (const a of (ce?.cite?.authors || [])) {
      const surname = String(a || "").split(",")[0].split(/\s+/).pop().trim();
      if (surname && surname.length >= 2) {
        const sLower = surname.toLowerCase();
        validSurnames.add(sLower);
        if (ce?.year) validSurnameYears.add(`${sLower}|${ce.year}`);
      }
    }
  }
  if (validSurnames.size === 0) return draft;

  let stripped = 0;
  let out = String(draft);
  // Pattern A: "Smith et al. (2020)" — Phase 19K reject when surname+year
  // tuple isn't in citation index (catches Fairburn et al. 2005, Andersson
  // et al. 2019 style leaks where the surname is real but the YEAR is fake).
  out = out.replace(/\b([A-Z][a-zA-Z'\-]{2,30})\s+et\s+al\.?\s*\((\d{4}[a-z]?)\)/g, (match, surname, year) => {
    const key = `${surname.toLowerCase()}|${year}`;
    if (validSurnameYears.has(key)) return match;
    stripped++;
    return surname + " et al.";
  });
  // Pattern B: "Smith and Jones (2020)" — same tuple check on EITHER surname
  out = out.replace(/\b([A-Z][a-zA-Z'\-]{2,30})\s+and\s+([A-Z][a-zA-Z'\-]{2,30})\s*\((\d{4}[a-z]?)\)/g, (match, s1, s2, year) => {
    const k1 = `${s1.toLowerCase()}|${year}`;
    const k2 = `${s2.toLowerCase()}|${year}`;
    if (validSurnameYears.has(k1) || validSurnameYears.has(k2)) return match;
    stripped++;
    return `${s1} and ${s2}`;
  });
  // Pattern C: "Smith (2020)" — Phase 19K tuple check (surname-year)
  out = out.replace(/(\b(?:by|to|in|from|of|per|via)\s+|^|\n|\.\s+)([A-Z][a-zA-Z'\-]{2,30})\s*\((\d{4}[a-z]?)\)/g, (match, prefix, surname, year) => {
    const key = `${surname.toLowerCase()}|${year}`;
    if (validSurnameYears.has(key)) return match;
    stripped++;
    return prefix + surname;
  });
  // Phase 22 — Pattern D rewritten. Previously substituted "(unverified
  // study)" which left the Literature Review reading "A randomized
  // controlled trial by (unverified study) demonstrated…" 5+ times.
  // New behaviour: DELETE the attribution clause entirely when the surname
  // isn't in the citation index. Two sub-patterns:
  //   D1: "<preposition> Surname et al." → delete the clause (preserve
  //        leading space/comma so we don't smush adjacent words)
  //   D2: bare "Surname et al." with no preposition → drop the surname
  //        phrase only
  out = out.replace(
    /(^|[\s,])(by|in|from|per|via)\s+([A-Z][a-zA-Z'\-]{2,30})\s+et\s+al\.?(?!\s*\()/g,
    (match, lead, prep, surname) => {
      if (validSurnames.has(surname.toLowerCase())) return match;
      stripped++;
      // Keep lead char (space/comma/start), drop the rest. Trim a trailing
      // space if the lead is start-of-string to avoid double-spacing.
      return lead;
    }
  );
  out = out.replace(/\b([A-Z][a-zA-Z'\-]{2,30})\s+et\s+al\.?(?!\s*\()/g, (match, surname) => {
    if (validSurnames.has(surname.toLowerCase())) return match;
    stripped++;
    return "";
  });
  // Phase 22 — Pattern E rewritten. Same logic for paired-surname
  // attributions: delete the full clause (prefix + both surnames) when
  // both surnames are missing from the citation index. Preserves the lead
  // char so adjacent prose isn't damaged.
  out = out.replace(
    /(^|[\s,])(by|in|from|per|via|see)\s+([A-Z][a-zA-Z'\-]{2,30})\s+and\s+([A-Z][a-zA-Z'\-]{2,30})(?!\s*\()/g,
    (match, lead, prep, s1, s2) => {
      if (validSurnames.has(s1.toLowerCase()) || validSurnames.has(s2.toLowerCase())) return match;
      stripped++;
      return lead;
    }
  );
  // Also remove standalone "study by"/"research by"/"work of"/"paper by"
  // attributions where neither named author is in the index.
  out = out.replace(
    /\b(?:a\s+)?(?:study|research|work|paper)\s+(?:by|of|from)\s+([A-Z][a-zA-Z'\-]{2,30})\s+and\s+([A-Z][a-zA-Z'\-]{2,30})(?!\s*\()/g,
    (match, s1, s2) => {
      if (validSurnames.has(s1.toLowerCase()) || validSurnames.has(s2.toLowerCase())) return match;
      stripped++;
      return "a study";   // collapse to a neutral phrase the surrounding sentence can absorb
    }
  );
  // Tidy: collapse any "  " (double space) and " ," / " ." artifacts left
  // by the deletions above.
  out = out.replace(/  +/g, " ").replace(/\s+([,.;:])/g, "$1");
  if (stripped > 0) console.log(`[thesisSynthesizer] proseAuthorLint: stripped ${stripped} fabricated author attribution(s)`);
  return out;
}

// ── Phase 8F — strip orphan close-quote artifacts ──────────────────────────
// Pattern: `...sentence." lowercase prose continues` — the closing quote is
// a leak from a prompt instruction template; strip it.
function stripOrphanQuotes(text) {
  if (!text) return text;
  let out = String(text);
  let stripped = 0;
  // Closing quote followed by lowercase letter (not a sentence start)
  out = out.replace(/([.!?])"\s+(?=[a-z])/g, (m, p) => { stripped++; return `${p} `; });
  // Closing quote at start of new line followed by lowercase paragraph
  out = out.replace(/\n"\s*(?=[a-z])/g, () => { stripped++; return "\n"; });
  if (stripped) console.log(`[thesisSynthesizer] orphanQuotes: stripped ${stripped} orphan close-quote(s)`);
  return out;
}

// ── Phase 8B — chart enforcement (post-pass on Results section) ────────────
// If quantitativeFindings contains rendered charts but the Results section has
// zero ![[charts/...svg]] embeds, deterministically inject them. The LLM is
// unreliable about following the embed instruction; this guarantees charts
// reach the page when they exist.
function enforceChartsInResults(text, quantFindings) {
  if (!text || !Array.isArray(quantFindings)) return text;
  const renderedCharts = quantFindings.flatMap(qf => qf.charts || []);
  if (renderedCharts.length === 0) return text;

  const alreadyEmbedded = (text.match(/!\[\[charts\//g) || []).length;
  if (alreadyEmbedded >= Math.min(2, renderedCharts.length)) return text;

  console.log(`[thesisSynthesizer] enforceCharts: ${renderedCharts.length} chart(s) available, ${alreadyEmbedded} embedded — injecting ${Math.min(3, renderedCharts.length) - alreadyEmbedded} more`);

  // Pick the top N charts (limit 3) and build an embed block.
  const toEmbed = renderedCharts.slice(0, 3);
  const blocks = toEmbed.map((c, i) => {
    return `\n\n![[${c.chartPath}]]\n\n*Figure ${i + 1}. ${c.caption}*\n\n${c.interpretation}`;
  }).join("");

  // Insert before the LAST paragraph of the section. Find the last \n\n before the trailing whitespace.
  const trimmed = text.trimEnd();
  const lastBreak = trimmed.lastIndexOf("\n\n");
  if (lastBreak === -1) {
    return trimmed + blocks + "\n";
  }
  return trimmed.slice(0, lastBreak) + blocks + "\n\n" + trimmed.slice(lastBreak + 2) + "\n";
}

// ── Phase 8G — Introduction research-question enforcer ────────────────────
// If the Intro doesn't contain an explicit research-question sentence
// ("This paper examines…" / "This review investigates…"), inject one via a
// targeted one-shot rewrite of the closing paragraph.
const RQ_MARKERS = /\b(?:this\s+(?:paper|review|study|article|work)\s+(?:examines|investigates|analyzes|explores|addresses|tests|presents)|the\s+present\s+(?:study|review)\s+(?:examines|investigates|asks))\b/i;

async function ensureResearchQuestion(text, topic) {
  if (!text) return text;
  if (RQ_MARKERS.test(text)) return text;
  console.log(`[thesisSynthesizer] ensureResearchQuestion: Intro missing explicit RQ — appending one`);

  const prompt = `The introduction below lacks a clear research-question sentence. Append ONE additional sentence to the end of the LAST paragraph that begins with EXACTLY one of: "This paper examines", "This review investigates", "This study analyzes". The sentence must name the central research question for a paper on "${topic}" — be specific, not generic.

Return the COMPLETE introduction with the new sentence appended at the end. Do not change any other content.

Introduction:
"""
${text}
"""`;
  try {
    const res = await llm(prompt, {
      timeoutMs: 90000,
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 4096, num_predict: 600 }
    });
    const out = String(res?.data?.text || "").trim();
    if (out && RQ_MARKERS.test(out) && out.length >= text.length * 0.95) return out;
    log(`ensureResearchQuestion: rewrite did not contain RQ marker — keeping original`, "warn");
  } catch (err) {
    log(`ensureResearchQuestion: ${err.message} — keeping original`, "warn");
  }
  return text;
}

// ── Phase 8H — Methodology subheading enforcer ─────────────────────────────
// If the Methodology section composed as a single wall-of-text paragraph
// (zero ### subheadings), force a structural rewrite that splits it into
// the four mandated subsections. One-shot LLM call.
async function enforceMethodologySubheadings(text, hasEmpiricalData, realCounts = null) {
  if (!text) return text;
  const h3Count = (text.match(/^###\s+/gm) || []).length;
  if (h3Count >= 2) return text;        // already has structure — keep as-is

  console.log(`[thesisSynthesizer] enforceSubheadings: methodology has ${h3Count} subheadings — forcing structural rewrite`);
  const subsections = hasEmpiricalData
    ? `### Literature Search\n### Quantitative Analysis\n### Integration\n### Limitations`
    : `### Literature Search\n### Source Screening\n### Synthesis\n### Limitations`;

  // Phase 15D — anchor the LLM to REAL harvest counts so it doesn't invent
  // numbers like "12 studies met the inclusion criteria" when the actual
  // harvest was 56 articles. Only used in the rewrite path; if the original
  // methodology text already had subheadings (h3Count >= 2 above) we don't
  // get here.
  const factsBlock = realCounts ? `=== EMPIRICAL FACTS (use these EXACT numbers; do NOT invent counts) ===
- Total articles harvested across sub-questions: ${realCounts.articles}
- Total datasets retrieved: ${realCounts.datasets}
- Total entries in the final bibliography: ${realCounts.sources}
- Search providers actually used: OpenAlex, CORE, DOAJ, Semantic Scholar, OSF Preprints, Academagic
- Retrieval was an automated multi-database keyword search (NOT a PRISMA systematic review)
` : "";

  const prompt = `${factsBlock}Restructure the following Methodology section to use these four H3 subheadings:

${subsections}

REQUIREMENTS:
- Keep ALL the factual content from the original.
- Distribute existing material across the subheadings — do NOT invent new facts.
- ${hasEmpiricalData ? "" : "DO NOT mention datasets, statistical analysis, observations, sample sizes, or quantitative methods. This was a literature review only — no rows analyzed."}
- Use academic terminology (databases, inclusion criteria, narrative review, descriptive synthesis).
${realCounts ? `- When mentioning numbers of articles/studies/datasets, use the EXACT counts from the EMPIRICAL FACTS block above. Do NOT invent counts like "12 studies" or "8 open-access" — use the real numbers.` : ""}
- Output ONLY the restructured Methodology body — no leading "## Methodology" heading.

Original Methodology section:
"""
${text}
"""

Restructured (with the four ### subheadings):`;

  try {
    const res = await llm(prompt, {
      timeoutMs: 240000,
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.3, num_ctx: 8192, num_predict: 1500 }
    });
    const out = String(res?.data?.text || "").trim();
    if (out && (out.match(/^###\s+/gm) || []).length >= 2) {
      // Phase 18B — preservation guard. Earlier the rewrite was reducing a
      // 725-word Methodology to 245 words because qwen2.5:7b interprets
      // "distribute existing material across the subheadings" as "summarize
      // and redistribute key points." Reject any rewrite that dropped below
      // 75% of the original word count — a real subheading injection
      // shouldn't lose more than a quarter of the prose.
      const beforeWords = wordCount(text);
      const afterWords = wordCount(out);
      if (beforeWords > 200 && afterWords < beforeWords * 0.75) {
        log(`enforceSubheadings: rewrite shrank from ${beforeWords}w to ${afterWords}w (lost >25%) — keeping original`, "warn");
        return text;
      }
      console.log(`[thesisSynthesizer] enforceSubheadings: rewrite succeeded (${beforeWords}w → ${afterWords}w)`);
      return out;
    }
    log(`enforceSubheadings: LLM didn't produce subheadings — keeping original`, "warn");
  } catch (err) {
    log(`enforceSubheadings: ${err.message} — keeping original`, "warn");
  }
  return text;
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

// ── Phase 7E: format quantitative findings for prompt injection ────────────
// Returns a block describing every dataset finding + chart filename + honesty
// labels, designed to be appended to the prompt for Methodology / Results /
// Discussion sections.
function buildQuantitativeBlock(quantFindings) {
  if (!Array.isArray(quantFindings) || quantFindings.length === 0) return "";
  const lines = [];
  for (const qf of quantFindings) {
    if (qf.metadataOnly) {
      lines.push(`- METADATA-ONLY: "${qf.datasetTitle}" (${qf.repository}). Cite for methodological rigor; rows not analyzed.`);
      continue;
    }
    lines.push(`- DATASET: "${qf.datasetTitle}" (${qf.repository}, N=${qf.N}, sampling=${qf.sampling})`);
    if (qf.hypothesis) lines.push(`    Hypothesis: ${qf.hypothesis}`);
    if (qf.honestyLabels?.length) lines.push(`    Honesty labels: [${qf.honestyLabels.join("; ")}]`);
    for (const c of qf.charts || []) {
      lines.push(`    CHART → ![[${c.chartPath}]]`);
      lines.push(`      ${c.interpretation}`);
    }
  }
  return `\n\n=== QUANTITATIVE FINDINGS YOU MUST USE (computed deterministically by the agent over the dataset rows) ===\nThese are not literature claims — these are the agent's own analyses. When the section directive says to embed quantitative findings, draw from this list. Use the EXACT figure-embed syntax shown (![[charts/...svg]]) so Obsidian renders the chart inline. NEVER fabricate numbers; only use values that appear in the interpretations below.\n${lines.join("\n")}`;
}

// Sections that should receive the quantitative block in their prompt.
// (Other sections still see article-level facts but no chart pressure.)
function shouldInjectQuantBlock(section) {
  const id = String(section?.id || "").toLowerCase();
  const heading = String(section?.heading || "").toLowerCase();
  return /method|result|discuss|abstract|introduction|conclusion/.test(id) ||
         /method|result|discuss|abstract|introduction|conclusion/.test(heading);
}

// ── Phase 9A — article-fact aggregation + injection ────────────────────────
// The dominant fidelity bug: articleAnalyzer extracts precise facts ("82.4%
// satisfaction", "t(53)=2.64, p=0.011") but the conclusionWriter aggregates
// them into vague commonalities ("CBT is valuable") and the synthesizer reads
// from the conclusion-vector store, never seeing the raw numbers. This pass
// pipes the structured facts directly into the section prompt so the writer
// is anchored to real numbers and can't paraphrase them away.

/**
 * Build a fact pool grouped by source article. Returns text suitable for
 * direct prompt injection — one block per article with title + in-text cite +
 * extracted facts as bullets.
 */
function buildFactsPool(promptResults, citationIndex) {
  if (!Array.isArray(promptResults) || promptResults.length === 0) return "";
  // Build a quick lookup: normalized title → in-text cite (e.g. "(Smith, 2023)")
  // so each fact-block is tagged with the citation we'd use in-prose.
  const titleToCite = new Map();
  for (const ce of (citationIndex || [])) {
    const t = String(ce?.cite?.title || "").toLowerCase().slice(0, 80);
    if (t) titleToCite.set(t, ce.inText);
  }

  const blocks = [];
  let totalFacts = 0;
  for (const p of promptResults) {
    for (const a of (p.analyses || [])) {
      const facts = a?.analysis?.facts || [];
      if (facts.length === 0) continue;
      const title = String(a?.frontmatter?.title || "").trim();
      if (!title) continue;
      const titleKey = title.toLowerCase().slice(0, 80);
      const inText = titleToCite.get(titleKey) || "";
      const citeStr = inText ? ` ${inText}` : "";
      const titleShort = title.length > 90 ? title.slice(0, 87) + "…" : title;
      blocks.push(`[Source: "${titleShort}"${citeStr}]\n` +
        facts.slice(0, 8).map(f => `  • ${f}`).join("\n"));
      totalFacts += Math.min(facts.length, 8);
    }
  }
  if (blocks.length === 0) return "";

  console.log(`[thesisSynthesizer] facts pool: ${blocks.length} sources, ${totalFacts} total facts`);
  return blocks.join("\n\n");
}

/**
 * Wrap the fact pool with strict instructions for use in a section prompt.
 * The instruction language is designed to force preservation of specific
 * numbers — the C- failure mode was paraphrasing "82.4% satisfaction" into
 * "reported as valuable".
 */
function buildFactsBlock(factsPool, sectionHeading) {
  if (!factsPool) return "";
  const sectionLower = String(sectionHeading || "").toLowerCase();
  const isPrecisionSection = /method|result|discuss|literature|review/.test(sectionLower);
  const minCitedFacts = isPrecisionSection ? 5 : 2;

  return `\n\n=== SOURCE FACTS — PRESERVE EXACT NUMBERS, DO NOT PARAPHRASE ===
The facts below were extracted from the cited papers. Each is a specific
finding with a real number, sample size, statistical test, or effect size.

CRITICAL RULES:
1. When you reference a study, cite it WITH ITS SPECIFIC NUMBER.
   GOOD: "Thomas et al. (2026) found 82.4% satisfaction with online CBT (n=54)"
   BAD:  "Thomas et al. (2026) found patients valued online CBT"
2. NEVER paraphrase a percentage, p-value, effect size, or sample size into
   a vague qualitative claim. The whole point of citing a study is the number.
3. In this section you MUST cite at least ${minCitedFacts} specific numbers
   drawn from the pool below.
4. Do not invent numbers that aren't in the pool. If a fact you want to make
   doesn't have a supporting number here, state it as a general observation
   WITHOUT a parenthetical citation rather than fabricating one.

FACT POOL:

${factsPool}`;
}

async function writeSection({ topic, tier, section, prevSummaries, constraints, knownCitationUrls, citationsPrompt, citationIndex, conclusionsCollection, quantFindings = [], factsPool = "" }) {
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
    ? `\n\nAVAILABLE CITATIONS (use ONLY these — never invent author names):\n${citationsPrompt}\n\nWhen you reference a study, use the EXACT in-text form shown in the list, e.g. "(Smith & Jones, 2023)". If you cannot attribute a claim to one of these citations, REPHRASE it as general knowledge with NO parenthetical citation. NEVER write "[5]", "Source 1", "(Author, Year)" placeholders, or made-up author names. NEVER use database/repository names as parenthetical citations — "(openalex)", "(figshare)", "(dryad)", "(osf)", "(zenodo)" are WRONG; databases are not authors.`
    : `\n\nNo structured citations available. Write claims as general knowledge — DO NOT invent (Author, Year) parentheticals. NEVER cite databases or repositories like "(openalex)" or "(figshare)" — they are not authors.`;

  // Phase 5B: tell the model to avoid its filler openings + previously-used openings.
  // Phase 20I — also give the model an explicit structural directive when prior
  // openings have used a particular pattern. The May CBT run had 3 sections
  // (Methodology, Discussion, Conclusion) trigger the duplicate-opening rewrite
  // because every section started with "Cognitive Behavioral Therapy (CBT) has
  // emerged…". Tell the model what STRUCTURE the new opening should take.
  const recentOpenings = (prevSummaries || []).map(p => p?.opening).filter(Boolean).slice(-5);
  const STRUCTURAL_ALTERNATIVES = [
    `Open with a SPECIFIC FINDING (e.g., "A meta-analysis of N=42 trials reported a Hedges' g of 0.71...")`,
    `Open with a CONTRADICTION (e.g., "While early reviews suggested X, more recent work demonstrates Y...")`,
    `Open with a MECHANISTIC question (e.g., "How does cognitive restructuring translate into long-term remission rates?")`,
    `Open with a CLINICAL POPULATION (e.g., "Among adolescents with comorbid OCD, treatment-as-usual yields...")`,
    `Open with a METHODOLOGICAL observation (e.g., "Three core measurement approaches dominate this literature...")`,
  ];
  // Rotate which alternatives are emphasized so each section gets a different push.
  const altsForThisSection = [
    STRUCTURAL_ALTERNATIVES[(prevSummaries?.length || 0) % STRUCTURAL_ALTERNATIVES.length],
    STRUCTURAL_ALTERNATIVES[((prevSummaries?.length || 0) + 2) % STRUCTURAL_ALTERNATIVES.length],
  ];
  const openingGuardrail = `\n\nDO NOT start this section with any of these stock openings:\n${FORBIDDEN_OPENINGS.map(o => `  - "${o}..."`).join("\n")}` +
    (recentOpenings.length > 0
      ? `\nALSO avoid repeating these openings already used in earlier sections:\n${recentOpenings.map(o => `  - "${o.slice(0, 80)}..."`).join("\n")}`
      : "") +
    `\n\nINSTEAD, take a DIFFERENT structural angle for this section's opening. Two good options:\n  - ${altsForThisSection[0]}\n  - ${altsForThisSection[1]}\nPick one (or another distinct angle) — do NOT default to "CBT has emerged…" / "CBT continues to be…" / "Cognitive Behavioral Therapy is a widely-used…" patterns.`;

  // Phase 6D — bake length floor into FIRST prompt so we don't waste retries.
  // Phase 19L — qwen2.5:7b consistently undershoots by 30-50% on first attempt
  // (litreview 562/900, results 688/1050, discussion 610/1200 in the May run).
  // Add a "self-checkpoint" instruction that asks the model to count and
  // continue if under the floor. Empirically this halves the retry rate on
  // small-model runs.
  const wordFloor = Math.floor((section.word_budget || 600) * 0.85);
  const wordCheckpoint = Math.floor((section.word_budget || 600) * 0.5);
  const expansionDirectives = `\n\n=== LENGTH REQUIREMENT (HARD FLOOR — read carefully) ===
This section's target is ${section.word_budget} words. You MUST write AT LEAST ${wordFloor} words.
A draft shorter than ${wordFloor} words is a FAILURE — it will be sent back for revision and waste minutes.

Your default tendency is to UNDERWRITE — to wrap up at ~50-65% of the target. Consciously override this.
SELF-CHECKPOINT: When you've written approximately ${wordCheckpoint} words, you are HALFWAY done — not nearly done. Continue with the same density and depth.

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

  // Phase 7E — inject the agent's own quantitative findings into Methodology /
  // Results / Discussion / Abstract / Intro / Conclusion. Other sections see
  // only article-derived facts.
  const quantBlock = (quantFindings.length && shouldInjectQuantBlock(section))
    ? buildQuantitativeBlock(quantFindings)
    : "";

  // Phase 9A — inject the article-fact pool into every section that needs to
  // cite specific numbers (basically every academic section). This is the
  // dominant fidelity fix: anchors the writer to real extracted findings
  // instead of paraphrased vector-store summaries.
  const factsBlock = factsPool ? buildFactsBlock(factsPool, section.heading) : "";

  const finalPrompt = prompt + expansionDirectives + factsBlock + quantBlock;

  // Phase 5D + 6D — explicit num_predict so the model doesn't quit early.
  // qwen2.5:7b often produces 1.5-1.7 tokens/word; 1.8x was borderline tight.
  // Bumped to 2.2x so even verbose sections have ample headroom.
  // Phase 10M + 12F — Lit Review and Discussion specifically overflow (long
  // comparative analysis, multi-claim synthesis). Bump to 2.8x to avoid the
  // mid-section truncation seen in both the GraphRAG and CBT runs.
  const isLitReview  = /lit.?review|literature/i.test(section.id || section.heading || "");
  const isDiscussion = /discussion/i.test(section.id || section.heading || "");
  const isLong       = isLitReview || isDiscussion;
  // Phase 14B — bump num_predict for the heavyweight (deepseek-r1) model.
  // deepseek-r1 spends 30-40% of generated tokens inside <think>...</think>
  // reasoning blocks, which means visible output is cut at ~60-70% of the
  // raw num_predict budget. Run logs showed Abstract/Conclusion ending mid-
  // sentence ("…making strong causal", "(N=3") despite raw word-count being
  // under budget. Use a heavier multiplier when the section composer is the
  // reasoning model.
  const usingReasoningModel = SYNTH_HEAVY_MODEL.includes("deepseek-r1") || SYNTH_HEAVY_MODEL.includes("qwq");
  // Phase 19L — bumped baseMult 2.2 → 2.6 so qwen2.5:7b has headroom to hit the
  // 85% floor on first try (was running out of num_predict and stopping short).
  const baseMult  = usingReasoningModel ? 2.8 : 2.6;
  const longMult  = usingReasoningModel ? 3.4 : 3.0;
  const numPredict = Math.ceil((section.word_budget || 600) * (isLong ? longMult : baseMult));

  // Phase 9E — section composition uses the heavyweight model when configured.
  // The heavy num_ctx is configurable (default 6144) since 14B-q3 quantized
  // models on 8GB VRAM are tight on the 8192 default.
  const sectionModel = SYNTH_HEAVY_MODEL;
  const sectionNumCtx = sectionModel === SYNTH_MODEL ? 8192 : HEAVY_NUM_CTX;
  let text = "";
  try {
    const res = await llm(finalPrompt, {
      timeoutMs: 600000,
      model: sectionModel,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.35, num_ctx: sectionNumCtx, num_predict: numPredict }
    });
    // Phase 15B — guard against LLM error sentinels. When llm() catches an abort/
    // timeout, it returns { success: false, data: { text: "The language model
    // encountered an error: ..." } }. Without this check, the error string
    // becomes section content (the CBT thesis run had this leak in Results).
    if (res && res.success === false) {
      log(`section "${section.id}" LLM call failed (success=false): ${res.error || "(no error msg)"}`, "warn");
      text = "";
    } else {
      text = String(res?.data?.text || "").trim();
      // Defense-in-depth: if the model itself emitted error-shaped prose, strip it
      if (looksLikeLlmError(text)) {
        log(`section "${section.id}" output matches LLM-error sentinel — discarding`, "warn");
        text = "";
      }
    }
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
        model: sectionModel,
        skipKnowledge: true,
        skipLanguageDetection: true,
        options: { temperature: 0.4, num_ctx: sectionNumCtx, num_predict: numPredict }
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

  // Phase 18B — widened the acceptable upper bound from 1.5 → 1.8. The old
  // window meant that a section coming back at 165% of budget triggered an
  // LLM rewrite that, on small models like qwen2.5:7b, regularly compressed
  // the section down to ~25% of budget (the "raw=1730 → final=251" Results
  // bug). Better to keep an over-budget section than destroy real content.
  if (ratio >= 0.6 && ratio <= 1.8) return text;

  const action = ratio < 0.6 ? "expand" : "trim";
  const delta  = Math.abs(target - current);
  const minAcceptableWords = Math.floor(target * 0.6);   // floor for trim sanity check
  const maxAcceptableWords = Math.ceil(target * 1.5);    // ceiling for expand sanity check

  const expandInstr = `The text is too short (${current} words, target ${target}).
Expand it by approximately ${delta} words. Add depth, examples, technical detail, and analysis.
Do NOT pad with filler — every added sentence must advance the argument.
HARD CAP: output must be at most ${maxAcceptableWords} words.`;

  const trimInstr = `The text is too long (${current} words, target ${target}).
Trim approximately ${delta} words to bring it close to ${target}.
Remove repetition, over-explanation, and weak filler sentences.
Preserve ALL key facts, statistics, citations, named studies, and quantitative findings VERBATIM.
HARD FLOOR: output must be at least ${minAcceptableWords} words. If you cannot reach that floor without losing content, return the input unchanged.`;

  // Phase 18B — removed the .slice(0, 6000) char cap. A 1500-word section is
  // ~10kc; truncating before the rewrite was losing ~40% of long sections
  // before the LLM even saw them, which compounded the over-aggressive trim.
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
${text}
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
    // Phase 18B — post-rewrite preservation guard. Reject the LLM's output
    // if it dropped below 60% of the budget on a trim, OR fell below 70% of
    // the original word count on an expand. Either case means the rewrite
    // destroyed content; keep the original so the user gets real prose.
    const adjustedWords = wordCount(adjusted);
    if (adjusted.length <= 50) return text;
    if (action === "trim" && adjustedWords < minAcceptableWords) {
      log(`adjustSectionLength(trim): rewrite dropped to ${adjustedWords}w (floor ${minAcceptableWords}w) for "${section.heading}" — keeping original`, "warn");
      return text;
    }
    if (action === "expand" && adjustedWords < Math.floor(current * 0.7)) {
      log(`adjustSectionLength(expand): rewrite shrank from ${current}w to ${adjustedWords}w for "${section.heading}" — keeping original`, "warn");
      return text;
    }
    return adjusted;
  } catch (err) {
    log(`adjustSectionLength(${action}) failed for "${section.heading}": ${err.message}`, "warn");
  }
  return text;
}

/**
 * Targeted rewrite of a single offending paragraph (third-person violation).
 */
async function rewriteParagraph(paragraph, reason) {
  // Phase 20A — strengthened prompt + preservation guard. The first-person
  // rewrite was the dominant content-loss culprit in the May CBT thesis run
  // (DRAFT[assembled]: 58541c → DRAFT[first-person-rewrite]: 29507c — a 50%
  // collapse). qwen2.5:7b was summarizing instead of just changing voice.
  const originalWords = wordCount(paragraph);
  const prompt = `Rewrite the paragraph below to remove the issue: ${reason}.

CRITICAL RULES — read carefully:
- This is a VOICE rewrite, NOT a summary. Output MUST be the same length as input (±15%).
- Preserve EVERY sentence, every statistic, every citation, every named study verbatim.
- Only change: first-person pronouns (I/we/our/my/us) → third-person (this study, the analysis, the data).
- Keep all [[wikilinks]] intact.
- Keep all (Author, YYYY) attributions intact.
- No contractions.
- Output the rewritten paragraph ONLY, no preamble, no "Here is the rewrite" wrapper.

Original word count: ${originalWords}. Your output should be ${Math.floor(originalWords * 0.85)}-${Math.ceil(originalWords * 1.15)} words.

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
      // Phase 20A — bumped num_predict so the model has headroom to actually
      // preserve length. 600 was occasionally too tight for long paragraphs.
      options: { temperature: 0.2, num_ctx: 4096, num_predict: Math.ceil(Math.max(originalWords, 200) * 2.2) }
    });
    const rewritten = String(res?.data?.text || "").trim();
    if (!rewritten) return paragraph;
    // Phase 20A-fix — PROMPT-LEAK GUARD. The CBT thesis-deep run had the LLM
    // regurgitate the entire rewrite prompt verbatim (including "CRITICAL
    // RULES", "Original word count:", the `"""` heredoc markers, and the
    // original paragraph wrapped in those markers). The word-count guard
    // approved it because the regurgitated prompt + content was LONGER than
    // the input. Detect this by scanning the output for any of the prompt's
    // own marker strings — if matched, reject and keep the original.
    const PROMPT_LEAK_MARKERS = [
      "CRITICAL RULES",
      "Original word count:",
      "Your output should be",
      "VOICE rewrite, NOT a summary",
      "no preamble, no \"Here is the rewrite\"",
      // Standalone `"""` lines indicate the LLM echoed the heredoc wrapper
      /^\s*"""\s*$/m,
    ];
    for (const marker of PROMPT_LEAK_MARKERS) {
      const hit = typeof marker === "string"
        ? rewritten.includes(marker)
        : marker.test(rewritten);
      if (hit) {
        log(`rewriteParagraph: LLM regurgitated prompt text (matched "${typeof marker === "string" ? marker.slice(0, 40) : marker.source}") — keeping original`, "warn");
        return paragraph;
      }
    }
    // Phase 20A — preservation guard. Reject any rewrite that dropped below
    // 80% of the input word count. The rewrite is supposed to be voice-only;
    // anything significantly shorter means the LLM summarized instead. Keep
    // the original first-person prose (the downstream pass will catch
    // remaining I/we/our markers via the lighter linter) rather than ship a
    // half-truncated version.
    const rewrittenWords = wordCount(rewritten);
    if (originalWords >= 50 && rewrittenWords < originalWords * 0.80) {
      log(`rewriteParagraph: rewrite shrank from ${originalWords}w to ${rewrittenWords}w (lost >20%) — keeping original`, "warn");
      return paragraph;
    }
    return rewritten;
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

// Phase 20N — render the "Future Directions" section from a deep-followup
// payload. Lists the open questions that drove the supplementary harvest +
// summarizes findings from the harvested articles. Plain markdown; no LLM
// call (the per-article analyzer already extracted facts).
function buildFutureDirectionsSection(deepFollowup) {
  if (!deepFollowup || !Array.isArray(deepFollowup.analyses) || deepFollowup.analyses.length === 0) return "";
  const questions = deepFollowup.rankedQuestions || [];
  const analyses = deepFollowup.analyses || [];
  const lines = [];
  lines.push(`## Future Directions`);
  lines.push("");
  lines.push(`> [!info] Open-questions follow-up (\`[depth:thesis-deep]\`)`);
  lines.push(`> This section is grounded in a supplementary harvest of ${analyses.length} article(s) targeting the highest-recurrence open questions surfaced across the primary literature review. Follow-up search query: *"${(deepFollowup.followupQuery || "(n/a)").replace(/\n/g, " ")}"*.`);
  lines.push("");
  if (questions.length > 0) {
    lines.push(`### Top open questions that drove this follow-up`);
    questions.forEach((q, i) => {
      lines.push(`${i + 1}. **${q.question}** — surfaced ${q.occurrences}× across prompt(s) ${q.sourcePrompts.join(", ")} (avg article quality ${q.avgWeight.toFixed(2)})`);
    });
    lines.push("");
  }
  // Group analyses' top facts as bullet points; one paragraph per article.
  lines.push(`### Supplementary findings`);
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    const title = a?.frontmatter?.title || a?.article?.title || "(untitled)";
    const facts = (a?.analysis?.facts || []).slice(0, 3).map(f => `  - ${f}`).join("\n");
    if (facts) {
      lines.push(`- **${title.replace(/[*_]/g, "")}**`);
      lines.push(facts);
    } else if (a?.analysis?.summary) {
      lines.push(`- **${title.replace(/[*_]/g, "")}** — ${a.analysis.summary}`);
    }
  }
  lines.push("");
  return lines.join("\n");
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
export async function synthesize({ topic, topicSlug, cleanTitle, tier, promptResults, constraints, onStep, bridgeSkipNotice = null, topicVaultRel = null, signal = null, deepFollowup = null }) {
  // Phase 16E — abort guard. Used between sections so a long composition
  // doesn't keep running after the user cancels.
  const checkAborted = () => {
    if (signal && signal.aborted) {
      const e = new Error("Pipeline aborted by user");
      e.code = "PIPELINE_ABORTED";
      throw e;
    }
  };
  // Phase 6C — progress emitter (no-op when caller didn't supply onStep).
  const emitProgress = typeof onStep === "function" ? onStep : () => {};
  // Final title precedence: caller-supplied cleanTitle (LLM-derived in orchestrator)
  // > outline's own title > raw topic. cleanTitle is what users see in the H1 + frontmatter.
  // Phase 22 — de-slug LLM-supplied titles. The CBT thesis-deep run came
  // out titled `# Cognitive-Behavioral-Therapy-Efficacy-Analysis` because
  // the LLM picked a hyphenated kebab-style title. Detect "slug-shaped"
  // candidates (hyphens between Capitalized words, no spaces) and replace
  // hyphens with spaces so the heading reads like prose.
  function deSlugTitle(t) {
    if (!t || typeof t !== "string") return t;
    const trimmed = t.trim();
    if (!trimmed) return trimmed;
    // If the title has spaces, leave it alone.
    if (/\s/.test(trimmed)) return trimmed;
    // Pattern: at least two Capitalised words joined by hyphens
    if (/^[A-Z][A-Za-z]+(?:-[A-Z][A-Za-z]+){1,}$/.test(trimmed)) {
      return trimmed.replace(/-/g, " ");
    }
    return trimmed;
  }
  const finalTitle = deSlugTitle((cleanTitle && cleanTitle.trim()) || topic);

  console.log(`[thesisSynthesizer] ▶ starting synthesis: tier=${tier} prompts=${promptResults.length} topic="${String(topic).slice(0, 60)}"`);
  if (SYNTH_HEAVY_MODEL !== SYNTH_MODEL) {
    console.log(`[thesisSynthesizer] section composer model: ${SYNTH_HEAVY_MODEL} (num_ctx=${HEAVY_NUM_CTX}); other stages: ${SYNTH_MODEL}`);
  } else {
    console.log(`[thesisSynthesizer] all stages model: ${SYNTH_MODEL} (set SYNTH_HEAVY_MODEL env to use a heavyweight model for section composition only)`);
  }

  // 1. Build conclusions vector collection.
  const conclusionsCollection = await indexConclusions(topicSlug, promptResults);
  console.log(`[thesisSynthesizer] ✓ conclusions indexed (collection=${conclusionsCollection})`);

  // 2. Build outline.
  console.log(`[thesisSynthesizer] ⏳ building outline (LLM pass 1/N)...`);
  emitProgress(`📐 Building outline…`);
  const outline = await buildOutline({ topic, tier, promptResults });
  console.log(`[thesisSynthesizer] ✓ outline built: ${outline.sections?.length || 0} sections`);

  // 3. Collect known citation URLs from harvested article frontmatter (deterministic guardrail).
  const articleNotes = promptResults.flatMap(p => (p.analyses || []).map(a => a.frontmatter || {}));

  // Phase 7E — aggregate empirical-methodology outputs across all prompts.
  const allQuantFindings = promptResults.flatMap(p => p.quantitativeFindings || []);
  const allDatasetCites  = promptResults.flatMap(p => p.datasetCitations || []);
  const datasetTotalN    = allQuantFindings.reduce((s, q) => s + (q.N || 0), 0);
  console.log(`[thesisSynthesizer] empirical inputs: ${allQuantFindings.length} quantitative findings, ${allDatasetCites.length} dataset citations, total N=${datasetTotalN}`);

  // Datasets are first-class citations: shape each into a note-like record so
  // buildCitationIndex picks them up alongside article frontmatter. Only those
  // with author + year + title pass the indexer's filter.
  const datasetNotes = allDatasetCites.map(ds => ({
    title: ds.title,
    url: ds.url,
    paper_url: ds.url,
    cite: ds.cite
  }));
  const allNotesForCitations = [...articleNotes, ...datasetNotes];
  // Phase 3A — prefer upgraded paper URL; fall back to original article URL.
  // Both are registered as "known" so the lint pass doesn't strip them.
  const knownCitationUrls = [...new Set(
    articleNotes.flatMap(n => [n.paper_url, n.url].filter(Boolean))
  )];

  // Phase 19A — ORCID rescue pre-pass. For citations with a DOI but a
  // malformed authors list (the Cochrane "82/88 single-token authors" bug),
  // ask ORCID for the canonical authors. Mutates allNotesForCitations in
  // place; no-ops when ORCID env creds aren't configured. Best-effort.
  await rescueMalformedAuthors(allNotesForCitations);

  // Phase 5A — build the structured citation index.
  // Each entry: { id, inText: "(Smith & Jones, 2023)", apa: "<full APA entry>", cite, ... }
  // The synthesizer uses this to ground in-text citations and emit a real
  // References section instead of a URL dump.
  const citationIndex = buildCitationIndex(allNotesForCitations);
  const citationsPrompt = renderCitationsForPrompt(citationIndex, 30);
  console.log(`[thesisSynthesizer] citation index built: ${citationIndex.length} structured entries from ${allNotesForCitations.length} sources (${articleNotes.length} articles + ${datasetNotes.length} datasets)`);

  // Phase 9A — build the article-fact pool ONCE; reused for every section.
  const factsPool = buildFactsPool(promptResults, citationIndex);

  // 4. Section-by-section synthesis.
  const writtenSections = [];
  const prevSummaries = [];
  const totalSections = outline.sections.length;
  for (let idx = 0; idx < outline.sections.length; idx++) {
    // Phase 16E — bail if the user has aborted between sections.
    checkAborted();
    const section = outline.sections[idx];
    console.log(`[thesisSynthesizer] ⏳ composing section ${idx + 1}/${totalSections}: "${section.heading}" (budget=${section.word_budget}w)`);
    emitProgress(`✍️ Composing ${section.heading} (${idx + 1}/${totalSections}, ~${section.word_budget}w)`,
      { current: idx + 1, total: totalSections, heading: section.heading });
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
      conclusionsCollection,
      quantFindings: allQuantFindings,  // Phase 7E — empirical analysis injected into prompt
      factsPool                          // Phase 9A — article-extracted facts with exact numbers
    });
    // Phase 5F — strip duplicate leading heading. The LLM often adds
    // "### Literature Review" inside the Literature Review section, on top of
    // the "## Literature Review" the assembler adds.
    text = stripDuplicateLeadingHeading(text, section.heading);
    // Phase 23A — also strip a plain-text section label like "Introduction:"
    // or "Methodology:" that the LLM emits as the first body line (no hash
    // markers). The CBT thesis-deep output had: `## Introduction\n\nIntroduction:\n\n### …`.
    text = stripLeadingSectionLabel(text, section.heading);

    const rawWords = wordCount(text);
    // Phase 1C: one expand/trim pass if section is significantly off budget
    text = await adjustSectionLength(text, section, topic, tier);
    text = stripDuplicateLeadingHeading(text, section.heading); // adjustment pass might re-add it
    text = stripLeadingSectionLabel(text, section.heading);

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
      // Phase 8A — strip LLM-pipeline jargon ("semantic-chunk indexing", etc.)
      const dej = dejargonMethodology(text);
      text = dej.text;
      // Phase 8H — force structural rewrite if no ### subheadings present.
      // Phase 15D — pass real harvest counts so the rewrite doesn't invent
      // numbers like "12 studies met inclusion criteria".
      const hasEmpiricalData = (allQuantFindings || []).some(q => !q.metadataOnly && (q.charts?.length || 0) > 0);
      const realCounts = {
        articles: (promptResults || []).reduce((s, p) => s + (p?.analyses?.length || 0), 0),
        datasets: (allDatasetCites || []).length,
        sources: (citationIndex || []).length,
      };
      text = await enforceMethodologySubheadings(text, hasEmpiricalData, realCounts);
      // Re-run dejargon after the rewrite (the LLM may have re-introduced jargon)
      text = dejargonMethodology(text).text;
    }

    // Phase 8B — chart enforcement on Results section
    if (/result/i.test(section.id || section.heading || "")) {
      text = enforceChartsInResults(text, allQuantFindings || []);
    }

    // Phase 13I — Abstract subsection guard. Detects when the LLM emitted
    // subsections inside the Abstract and forces a flat-paragraph rewrite.
    if (/abstract/i.test(section.id || section.heading || "")) {
      text = await flattenAbstractIfNeeded(text, topic);
    }

    // Phase 8G — Introduction must have an explicit research-question sentence
    if (/intro/i.test(section.id || section.heading || "")) {
      text = await ensureResearchQuestion(text, topic);
    }

    // ── Phase 14A — per-helper char-delta instrumentation ─────────────────
    // Wrap each cleanup helper to log a warning when it removes >30% of the
    // section's characters in a single pass. This pinpoints which helper is
    // destroying content (e.g., the Lit Review `raw=1425w → final=283w`
    // collapse). The 30% threshold is sensitive enough to flag most real
    // bugs and quiet enough to not spam logs on healthy strips.
    const _runHelper = (label, fn) => {
      const before = text.length;
      text = fn(text);
      const after = text.length;
      if (before > 200 && after < before * 0.7) {
        const removed = before - after;
        const pct = Math.round(100 * (1 - after / before));
        console.warn(`[thesisSynthesizer] helper ${label} removed ${removed}c (${pct}%) from "${section.heading}" — investigate if section came back too short`);
      }
    };

    // Phase 10L — strip deepseek-r1 <think>...</think> blocks
    _runHelper("stripThinkingBlocks", stripThinkingBlocks);

    // Phase 12A — strip ```markdown / ```md fence wrappers (deepseek-r1
    // wraps section output in fences, leaving orphan ``` lines mid-paragraph)
    _runHelper("stripMarkdownFences", stripMarkdownFences);

    // Phase 12B — strip """ triple-quote heredoc markers (prompt scaffolding leak)
    _runHelper("stripTripleQuotes", stripTripleQuotes);

    // Phase 10I (+ 12D extended patterns) — strip conversational preambles
    _runHelper("stripConversationalPreamble", stripConversationalPreamble);

    // Phase 10J — strip mid-body duplicate `## Heading` + leading `---`
    _runHelper("stripMidBodyDuplicateHeading", (t) => stripMidBodyDuplicateHeading(t, section.heading));

    // Phase 12E — demote stray `## Heading` inside section body to `### Heading`
    // (the assembler owns the section's H2; LLMs sometimes emit additional H2
    // sub-sections which break the document outline).
    _runHelper("demoteSectionH2sToH3", (t) => demoteSectionH2sToH3(t, section.heading));

    // Phase 18E — normalize Roman-numeral H3 series. When the LLM jumps to
    // `### II.`, `### III.`, ... but leaves the first heading unprefixed,
    // prepend `### I. ` to that first heading so the series reads correctly.
    _runHelper("normalizeRomanH3Series", (t) => normalizeRomanH3Series(t, section.heading));

    // Phase 19B — drop empty H4 stubs (heading with no body before next heading)
    _runHelper("stripEmptyH4Stubs", stripEmptyH4Stubs);

    // Phase 19C — strip section-internal `### References` blocks. The real
    // bibliography is appended at document level; these are pure leakage
    // and produced the duplicate-References artifact in the CBT thesis.
    _runHelper("stripEmbeddedReferencesBlock", stripEmbeddedReferencesBlock);

    // Phase 19D — strip section-internal `### Conclusion`/`### Summary`
    // self-summary blocks from non-Conclusion sections.
    _runHelper("stripEmbeddedConclusionBlock", (t) => stripEmbeddedConclusionBlock(t, section.heading));

    // Phase 19E — strip self-narrating meta-commentary tails ("This expanded
    // section delves deeper..." / "going beyond the initial Nw draft").
    _runHelper("stripMetaCommentaryTail", stripMetaCommentaryTail);

    // Phase 19F — strip "(unverified study)" placeholder citations.
    _runHelper("stripUnverifiedStudyMarkers", stripUnverifiedStudyMarkers);

    // Phase 19I — split smushed `### heading body` lines into proper heading
    // + paragraph break.
    _runHelper("splitSmushedH3HeadingBody", splitSmushedH3HeadingBody);

    // Phase 13A — strip stray `# Heading` inside section body (LLM treating
    // section like a whole document)
    _runHelper("stripSectionH1s", (t) => stripSectionH1s(t, section.heading));

    // Phase 13B — strip fabricated "References:\n- Author..." blocks emitted
    // by the LLM at section end (the real bibliography is appended later).
    // Phase 14A: tightened to require real author signatures + 60% cap.
    _runHelper("stripFabricatedBibliography", (t) => stripFabricatedBibliography(t, section.heading));

    // Phase 13C — strip orphan `[N]`, `[N, M]` numeric citation markers
    // (we use APA in-text style; numeric markers are leftover scaffolding)
    _runHelper("stripOrphanNumericRefs", stripOrphanNumericRefs);

    // Phase 14D — strip alphabetic bracket-tag pseudo-citations like
    // `[Cochrane review]`, `[Mexico Trial Data]`, `[Mindset App Analysis]`
    // (LLM-invented study labels; we use APA in-text only)
    _runHelper("stripBracketTags", stripBracketTags);

    // Phase 15E — strip model meta-commentary parentheticals like
    // `(given the hypothetical year 2026 reference, likely intended as a
    // placeholder for illustrative examples)` — model self-talk leak.
    _runHelper("stripMetaCommentary", stripMetaCommentary);

    // Phase 8D — strip "Key Findings:" / "Limitations:" stock bullet sections.
    // Phase 14A: tightened with 60% cap.
    _runHelper("stripStockBulletSections", (t) => stripStockBulletSections(t, section.heading));

    // Phase 8F — remove orphan close-quote artifacts
    _runHelper("stripOrphanQuotes", stripOrphanQuotes);

    // Phase 10K — clean malformed wikilinks (run after stripDuplicate to keep order safe)
    _runHelper("lintMalformedWikilinks", lintMalformedWikilinks);

    // Phase 14B — mid-sentence truncation detection + one-shot continuation.
    // If the cleaned section ends mid-sentence (lowercase letter, hanging
    // conjunction, "(N=", trailing comma, etc.), call the model once for a
    // short continuation so the user doesn't see "…making strong causal" or
    // "* A pilot dataset (N=3" as the saved output. Best-effort only — if
    // the continuation call fails or returns nothing, the original truncated
    // text is preserved (fail-open, never destructive).
    if (looksTruncated(text)) {
      console.warn(`[thesisSynthesizer] section "${section.id}" appears truncated (mid-sentence end) — running continuation pass`);
      try {
        const tail = text.slice(-1500);
        const contPrompt = `The following section ended mid-sentence and needs to be COMPLETED (not rewritten).
Continue from where it cuts off and finish the thought naturally. 1–3 closing sentences max.

Hard rules:
- DO NOT repeat any of the existing content
- DO NOT add new headings or bullet markers
- DO NOT introduce new claims requiring citations
- DO NOT start with "Continuing", "In addition", "Furthermore" — pick up mid-sentence

Section ending (the last 1500 chars — note where it cuts off):
"""
${tail}
"""

Output ONLY the continuation text (no preamble, no quotes):`;
        const contRes = await llm(contPrompt, {
          timeoutMs: 90000,
          model: SYNTH_MODEL,                  // use the lighter model — small completion only
          skipKnowledge: true,
          skipLanguageDetection: true,
          options: { temperature: 0.3, num_ctx: 4096, num_predict: 400 }
        });
        // Phase 15B — guard: continuation pass must not splice an LLM error
        // string into the section. The CBT thesis run had this happen — the
        // continuation timed out and the error sentinel got appended.
        if (contRes && contRes.success === false) {
          console.log(`[thesisSynthesizer] continuation pass: LLM call failed (success=false) — keeping truncated text`);
          // fall through to outer end-of-block; cont stays empty so no splice
        }
        let cont = (contRes && contRes.success === false)
          ? ""
          : String(contRes?.data?.text || "").trim();
        // Defense-in-depth: even if success=true, the model may have echoed the
        // error sentinel from a stale buffer. Discard if matched.
        if (looksLikeLlmError(cont)) {
          console.log(`[thesisSynthesizer] continuation pass: output matches LLM-error sentinel — discarding`);
          cont = "";
        }
        // Strip preamble-style scaffolding the model may emit despite instructions
        cont = cont.replace(/^["'`]+|["'`]+$/g, "").trim();
        cont = cont.replace(/^(Continuation|Continuing|Here is the continuation)[:.\s]+/i, "").trim();
        if (cont.length > 15 && cont.length < 1500) {
          // Phase 23A — dedupe leading overlap. The LLM sometimes restarts
          // mid-sentence and repeats the tail of `text`. Without this, the
          // CBT thesis-deep Intro produced: "...This paper examines whether
          // cognitive behavioral This paper examines whether cognitive
          // behavioral therapy (CBT)..."
          const dedupedCont = dedupeContinuationOverlap(text, cont);
          if (dedupedCont !== cont) {
            console.log(`[thesisSynthesizer] continuation pass: dedupe-overlap trimmed ${cont.length - dedupedCont.length}c of repeat-prefix`);
          }
          // Splice: remove trailing whitespace/comma from existing text, add space, append continuation.
          text = text.replace(/[\s,;]+$/, "") + " " + dedupedCont;
          console.log(`[thesisSynthesizer] continuation pass: appended ${dedupedCont.length}c to "${section.id}"`);
        } else {
          console.log(`[thesisSynthesizer] continuation pass: skipped (got ${cont.length}c, expected 15-1500)`);
        }
      } catch (err) {
        console.log(`[thesisSynthesizer] continuation pass failed: ${err.message} — keeping truncated text`);
      }
    }

    // Phase 15B — final safeguard before the saved file: if anywhere in this
    // chain an LLM error sentinel survived, replace the whole section with a
    // graceful placeholder. Better an honest "this section couldn't be
    // generated" than the literal string "The language model encountered an
    // error: LLM request aborted or timed out" embedded in academic prose.
    if (looksLikeLlmError(text)) {
      console.warn(`[thesisSynthesizer] section "${section.id}" still contains LLM-error sentinel after cleanup — replacing with placeholder`);
      text = `_(this section could not be generated due to an LLM error; please re-run if this persists)_`;
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
    dataset_count: allDatasetCites.length,
    chart_count: allQuantFindings.reduce((s, q) => s + (q.charts?.length || 0), 0),
    quantitative: allQuantFindings.some(q => !q.metadataOnly && (q.charts?.length || 0) > 0),
    total_observations: datasetTotalN,
    created: new Date().toISOString(),
    tags: ["research-thesis", topicSlug, tier]
  });

  let draft = `# ${finalTitle}\n\n`;
  for (const { section, text } of writtenSections) {
    draft += `## ${section.heading}\n\n${text}\n\n`;
  }

  // 6. Bibliography (deterministic).
  draft += buildBibliography(allNotesForCitations);

  // 7. AI usage footer for non-thesis tiers (thesis already gets its own section).
  if (TIER_BUDGETS[tier]?.aiAcknowledgment === "footer") {
    draft += aiUsageFooter();
  }

  snapshotDraft("assembled", draft);

  // Phase 23A — normalise paragraph boundaries BEFORE lint(). The May
  // CBT thesis-deep run had entire 1503w / 1629w Literature Review and
  // Results sections smushed onto fewer than 6 lines (heading + body on a
  // single line). lint() splits on `\n{2,}` so it treated each section as
  // ONE paragraph, which then hit `rewriteParagraph(1503w)` and timed out
  // at 30s. Inserting `\n\n` boundaries here breaks that cascade.
  draft = normaliseParagraphBoundaries(draft);
  snapshotDraft("paragraph-normalised", draft);

  // 8. Lint pass.
  console.log(`[thesisSynthesizer] ⏳ linting draft...`);
  emitProgress(`✨ Polishing draft…`);
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
  if (tier === "research" || tier === "thesis" || tier === "thesis-deep") {
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
    // Phase 10D — prose-style fabricated-author lint. lintStrayCitations
    // catches `(Smith, 2020)` parentheticals; this catches the prose forms
    // "Smith et al. (2020)" / "Smith and Jones (2020)" / "Smith (2020) found".
    draft = lintFabricatedAuthorsInProse(draft, citationIndex);
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

  // ── Phase 19H — renumber broken ordered lists (LLM-skipped indices) ──
  // The CBT Conclusion had `1. Depression`, `3. Substance Abuse`, `4. PTSD`
  // — `2.` was missing entirely. Sequentially renumber contiguous numbered
  // list blocks so display order matches the explicit numbering.
  draft = renumberOrderedLists(draft);
  snapshotDraft("renumbered", draft);

  // 11. Persist.
  // 11a. Wikilink enrichment — the synthesizer LLM doesn't generate [[wikilinks]],
  //      so without this pass the article saves with 0 stubs created. Run a small
  //      LLM pass to wrap key concepts in [[...]], then save the enriched draft.
  // Phase 10A — chart embed validator. The LLM occasionally hallucinates
  // chart filenames like ![[charts/insomnia_dose_response.svg]] when no
  // such chart was generated. Scan the draft against actual files in
  // vault/<slug>/charts/ and strip any embed (plus its caption line) that
  // doesn't resolve. Prevents Obsidian "could not be found" errors AND
  // prevents resolveWikilinks from creating broken stubs for them.
  try {
    const chartsDirAbs = path.join(getVaultPath() || "", VAULT_JOURNAL_ROOT, "Research", topicSlug, "charts");
    let realCharts = new Set();
    try {
      const files = await fs.readdir(chartsDirAbs);
      realCharts = new Set(files.map(f => f.toLowerCase()));
    } catch { /* charts dir doesn't exist — all embeds are hallucinated */ }
    let strippedEmbeds = 0;
    draft = draft.replace(/!\[\[charts\/([^\]\n]+)\]\][^\n]*\n(?:[^\n]*Figure[^\n]*\n)?/g, (match, fname) => {
      if (realCharts.has(String(fname).toLowerCase())) return match;
      strippedEmbeds++;
      return "";
    });
    if (strippedEmbeds) console.log(`[thesisSynthesizer] chartValidator: stripped ${strippedEmbeds} hallucinated chart embed(s) (real charts on disk: ${realCharts.size})`);
  } catch (err) {
    log(`chartValidator non-fatal: ${err.message}`, "warn");
  }

  console.log(`[thesisSynthesizer] ⏳ enriching draft with wikilinks...`);
  let enrichedDraft = draft;
  // Phase 22 — mask heading lines with sentinels before calling the LLM
  // enricher, then restore. Without this, `enrichWithWikilinks` happily
  // inserts `[[Foo Bar]]` into heading text, which then breaks the heading
  // line because markdown headings are single-line constructs. The May
  // CBT thesis-deep run had three smushed `###` headings as a result.
  const HEADING_RE_MASK = /^(\s{0,3}#{1,6}\s.*)$/gm;
  const savedHeadings = [];
  const masked = draft.replace(HEADING_RE_MASK, (m) => {
    savedHeadings.push(m);
    return `XHDRMARKERX${savedHeadings.length - 1}X`;
  });
  try {
    let llmEnriched = await enrichWithWikilinks(masked, { noteTitle: topicSlug, label: "thesisSynthesizer" });
    // Restore the masked headings. If any sentinel was mangled by the LLM,
    // fall back to the pre-LLM draft for safety — better unchanged than
    // broken.
    const expected = savedHeadings.length;
    let restoredCount = 0;
    llmEnriched = llmEnriched.replace(/XHDRMARKERX(\d+)X/g, (_, idx) => {
      const i = parseInt(idx, 10);
      if (savedHeadings[i] !== undefined) { restoredCount++; return savedHeadings[i]; }
      return _;
    });
    if (restoredCount === expected) {
      enrichedDraft = llmEnriched;
    } else {
      console.log(`[thesisSynthesizer] ⚠ wikilink enrichment heading-restore mismatch (${restoredCount}/${expected}) — keeping un-enriched draft`);
      enrichedDraft = draft;
    }
  } catch (err) {
    console.log(`[thesisSynthesizer] ⚠ wikilink enrichment failed (non-fatal): ${err.message}`);
  }

  // Phase 13E — deterministic acronym wrapper. The LLM enrichment is
  // conservative on short tokens; this guarantees common research acronyms
  // (CBT, CBT-I, MBCT, ACT, PGD, OCD, PTSD, GAD, etc.) get wikilinked.
  // Default: first occurrence per acronym. Set WIKILINK_ALL_OCCURRENCES=true
  // in env to wrap every occurrence (heavier link density).
  enrichedDraft = wrapAcronymsAsWikilinks(enrichedDraft);

  // Phase 14F — if the bridge gate offered but couldn't pause (missing
  // conversationId), prepend a visible warning callout to the saved file
  // so the user sees it the moment they open the note. This is the only
  // surface the user has for this failure mode (the warn went to PM2 logs).
  let bridgeCallout = "";
  if (bridgeSkipNotice && bridgeSkipNotice.count > 0) {
    bridgeCallout = buildBridgeSkipCallout(bridgeSkipNotice, topicVaultRel || `Research/${topicSlug}`);
    console.log(`[thesisSynthesizer] bridgeSkipNotice: prepended Manual-Bridge-Skipped callout for ${bridgeSkipNotice.count} blocked source(s)`);
  }

  // Phase 15H — when datasets were retrieved but all metadata-only, prepend
  // a note explaining why no charts appear in this run.
  // Phase 20J — replace the bare "no charts" message with a structured
  // metadata summary (repositories, sample sizes, intervention keywords,
  // conditions, study types) when we have dataset records. Pure-string +
  // node built-in heuristics; no LLM call.
  const parseableChartCount = (allQuantFindings || []).reduce((s, q) => s + (q.charts?.length || 0), 0);
  let chartsNote = "";
  if ((allQuantFindings || []).length > 0 && parseableChartCount === 0) {
    try {
      const { buildDatasetMetadataSummary, renderDatasetMetadataSummary } = await import("./datasetMetadataSummary.js");
      const summary = buildDatasetMetadataSummary(allDatasetCites || []);
      if (summary) {
        chartsNote = renderDatasetMetadataSummary(summary, { topicSlug });
        console.log(`[thesisSynthesizer] chartsNote: prepended dataset-metadata summary (datasets=${summary.totalCount}, repos=${Object.keys(summary.byRepository).length}, totalN=${summary.totalN ?? "n/a"})`);
      }
    } catch (err) {
      log(`datasetMetadataSummary failed: ${err.message}`, "warn");
    }
  }
  if (!chartsNote) {
    chartsNote = buildNoChartsNote((allQuantFindings || []).length, parseableChartCount);
    if (chartsNote) {
      console.log(`[thesisSynthesizer] chartsNote: prepended no-charts note (datasets=${(allQuantFindings || []).length}, parseable=${parseableChartCount})`);
    }
  }

  // Phase 20N — append "Future Directions" section when the thesis-deep
  // recursive follow-up returned harvested articles. Append BEFORE the final
  // ## References section, after the main Conclusion.
  let futureDirectionsBlock = "";
  if (deepFollowup && Array.isArray(deepFollowup.analyses) && deepFollowup.analyses.length > 0) {
    futureDirectionsBlock = buildFutureDirectionsSection(deepFollowup);
    if (futureDirectionsBlock) {
      console.log(`[thesisSynthesizer] futureDirections: appended (${deepFollowup.analyses.length} follow-up article(s), query="${deepFollowup.followupQuery?.slice(0, 60) || "n/a"}")`);
    }
  }

  console.log(`[thesisSynthesizer] ⏳ writing final article to disk...`);
  const relativePath = `${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${topicSlug}.md`;
  // Phase 19J — strip stray empty `#` line that sometimes appears at the very
  // top of the assembled draft (LLM emits a bare H1 marker before the first
  // real heading). The CBT thesis output started with `#\n\n# Abstract`.
  let finalBody = enrichedDraft.replace(/^\s*#+\s*\n+/, "");
  // Phase 20N — insert future-directions before References (which is the
  // last `## References` block); fall back to append-at-end if References
  // isn't present (defensive).
  if (futureDirectionsBlock) {
    const refIdx = finalBody.lastIndexOf("## References");
    if (refIdx > 0) {
      finalBody = finalBody.slice(0, refIdx) + futureDirectionsBlock + "\n\n" + finalBody.slice(refIdx);
    } else {
      finalBody = finalBody + "\n\n" + futureDirectionsBlock;
    }
  }
  // Phase 22 — place the bridge callout + datasets callout BELOW the `# H1`
  // and above the Abstract. Previously chartsNote sat above the H1 which
  // made the note open with a callout box instead of the title. We extract
  // the first heading line of finalBody, then re-assemble.
  let titledBody = finalBody;
  if (bridgeCallout || chartsNote) {
    const m = finalBody.match(/^(\s*#\s+[^\n]+\n+)([\s\S]*)$/);
    if (m) {
      titledBody = m[1] + bridgeCallout + chartsNote + m[2];
    } else {
      // No H1 detected — fall back to old ordering rather than risk losing the callouts
      titledBody = bridgeCallout + chartsNote + finalBody;
    }
  }

  // Phase 23C — claim-verifier pass. The pre-write surface is the right
  // place: by now all section composition, polish, citation lint, and
  // wikilink enrichment are done. We scan for numeric claims and
  // annotate / sentence-strip any that don't have backing in the fact
  // pool. Default mode is "annotate" (non-destructive); flip with
  // CLAIM_VERIFY_MODE=strict in .env to drop unverified sentences.
  try {
    const { verifyAndAnnotate } = await import("./claimVerifier.js");
    const factPool = promptResults.flatMap(p => (p.analyses || []).flatMap(a => {
      const facts = Array.isArray(a?.analysis?.facts) ? a.analysis.facts : [];
      const sourceTitle = a?.article?.title || "?";
      const sourceContent = String(a?.article?.content || "");
      const factEntries = facts.map(f => ({ source: sourceTitle, content: String(f || ""), text: sourceContent }));
      // Always include the article content slice as a "fact" so numbers
      // appearing only in the raw text (not extracted as facts) still match.
      if (sourceContent.length > 0) factEntries.push({ source: sourceTitle, content: sourceContent });
      return factEntries;
    }));
    const verifyMode = process.env.CLAIM_VERIFY_MODE === "strict" ? "strict" : "annotate";
    const verifyResult = verifyAndAnnotate(titledBody, factPool, { mode: verifyMode });
    if (verifyResult.totalClaims > 0) {
      console.log(`[thesisSynthesizer] claimVerifier: ${verifyResult.unverifiedCount}/${verifyResult.totalClaims} numeric claim(s) unverified (mode=${verifyMode})`);
    }
    titledBody = verifyResult.text;
  } catch (err) {
    log(`claimVerifier failed (non-fatal): ${err.message}`, "warn");
  }

  await writeNote(relativePath, headerFm + titledBody);
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

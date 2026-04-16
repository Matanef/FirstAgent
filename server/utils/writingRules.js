// server/utils/writingRules.js
// Academic writing rules for deepResearch synthesizer.
// Pure module: no I/O at import time. All paths resolved lazily so tests can stub.
//
// Exports:
//   TIER_BUDGETS           — per-tier section structure + word targets (bibliography is deterministic, not LLM)
//   loadAgentConstraints() — reads data/agent-constraints.json fresh each call (hot reload)
//   buildOutlineSections() — returns ordered section spec list for a tier (consumed by thesisSynthesizer.buildOutline)
//   sectionPrompt()        — assembles the full LLM prompt for one section
//   lint()                 — third-person + contraction + citation + length checks. Returns {issues, warnings}
//   buildBibliography()    — deterministic bibliography from article-note frontmatter
//
// References:
//   - Plan: per-Tier per-Section word budget table
//   - Critical formatting rules placed at the END of each prompt (anti-fading on small models)
//   - Hard cap retrieved snippets to 4×800 chars to stay under 8192 num_ctx

import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-Tier Section Structure & Word Budgets
// (matches the table in the approved plan)
// ─────────────────────────────────────────────────────────────────────────────
export const TIER_BUDGETS = {
  article: {
    total: 1500,
    sections: [
      { id: "intro",       heading: "Introduction",        words: 250 },
      { id: "body1",       heading: "Analysis",            words: 400 },
      { id: "body2",       heading: "Key Findings",        words: 350 },
      { id: "discussion",  heading: "Discussion",          words: 300 },
      { id: "conclusion",  heading: "Conclusion",          words: 200 }
    ],
    aiAcknowledgment: "footer"
  },
  indepth: {
    total: 2200,
    sections: [
      { id: "abstract",    heading: "Summary",             words: 150 },
      { id: "intro",       heading: "Introduction",        words: 300 },
      { id: "litreview",   heading: "Literature Review",   words: 350 },
      { id: "body",        heading: "Analysis",            words: 900 },
      { id: "discussion",  heading: "Discussion",          words: 350 },
      { id: "conclusion",  heading: "Conclusion",          words: 300 }
    ],
    aiAcknowledgment: "footer"
  },
  research: {
    total: 3500,
    sections: [
      { id: "abstract",    heading: "Abstract",            words: 250 },
      { id: "intro",       heading: "Introduction",        words: 400 },
      { id: "litreview",   heading: "Literature Review",   words: 550 },
      { id: "methodology", heading: "Methodology",         words: 400 },
      { id: "results",     heading: "Results",             words: 600 },
      { id: "discussion",  heading: "Discussion",          words: 650 },
      { id: "conclusion",  heading: "Conclusion",          words: 450 }
    ],
    aiAcknowledgment: "footer"
  },
  thesis: {
    total: 5500,
    sections: [
      { id: "abstract",    heading: "Abstract",            words: 400 },
      { id: "intro",       heading: "Introduction",        words: 550 },
      { id: "litreview",   heading: "Literature Review",   words: 900 },
      { id: "methodology", heading: "Methodology",         words: 700 },
      { id: "results",     heading: "Results",             words: 950 },
      { id: "discussion",  heading: "Discussion",          words: 1100 },
      { id: "conclusion",  heading: "Conclusion",          words: 650 },
      { id: "ai_ack",      heading: "AI Usage Acknowledgment", words: 250 }
    ],
    aiAcknowledgment: "section"
  }
};

// Structural rules — embedded in section prompts as guidance fragments.
const SECTION_RULES = {
  abstract: "Summarize problem, methods, key findings, and broader implications. No citations. No new claims.",
  intro: "Define the research problem, state objectives, argue significance. End with a 1–2 sentence specific, arguable thesis statement.",
  litreview: "Critically evaluate existing research — do NOT just summarize. Highlight the specific gap this paper addresses.",
  methodology: "Explain the research process (query expansion, source harvesting, synthesis approach). Justify why these choices fit the question.",
  body: "Present the core analysis. Synthesize across sources. Identify patterns, contradictions, and implications.",
  body1: "Present the first major analytical thread. Synthesize across sources, not just summarize each.",
  body2: "Present the second analytical thread. Build on body1; do not repeat its claims.",
  results: "State findings without interpretation. Tables and bullet lists are acceptable here only.",
  discussion: "Interpret findings, tie back to the thesis statement, acknowledge limitations.",
  conclusion: "Summarize findings and broader implications. Introduce NO new data or citations.",
  ai_ack: "Disclose AI assistance: which model performed synthesis, what role it played (synthesis vs original analysis), and how sources were sampled."
};

// ─────────────────────────────────────────────────────────────────────────────
// Constraints loader — fresh read every call (no module cache)
// ─────────────────────────────────────────────────────────────────────────────
let _defaultConstraintsPath = null;
function constraintsPath() {
  if (_defaultConstraintsPath) return _defaultConstraintsPath;
  const envPath = process.env.AGENT_CONSTRAINTS_PATH;
  _defaultConstraintsPath = envPath
    ? path.resolve(envPath)
    : path.resolve(PROJECT_ROOT, "data", "agent-constraints.json");
  return _defaultConstraintsPath;
}

const FALLBACK_CONSTRAINTS = {
  writing: {
    wordsPerParagraph: { min: 80, max: 180 },
    tone: "formal-academic",
    voice: "third-person",
    allowContractions: false,
    bulletTolerancePerSection: 3
  },
  formatting: {
    useCallouts: true,
    calloutMinPerSection: 1,
    wikilinkDensity: "medium",
    mermaidDiagrams: { mindmap: true, flowchart: "on-demand" }
  },
  research: {
    maxArticlesPerPrompt: 7,
    minFactsPerArticle: 3,
    skipDomains: [],
    preferDomains: ["sciencedaily.com"],
    thinArticleMinChars: 800,
    thinArticleMinFacts: 2
  }
};

export async function loadAgentConstraints() {
  try {
    const raw = await fs.readFile(constraintsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      writing:    { ...FALLBACK_CONSTRAINTS.writing,    ...(parsed.writing    || {}) },
      formatting: { ...FALLBACK_CONSTRAINTS.formatting, ...(parsed.formatting || {}) },
      research:   { ...FALLBACK_CONSTRAINTS.research,   ...(parsed.research   || {}) }
    };
  } catch {
    return FALLBACK_CONSTRAINTS;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Outline / section helpers
// ─────────────────────────────────────────────────────────────────────────────
export function buildOutlineSections(tier) {
  const spec = TIER_BUDGETS[tier] || TIER_BUDGETS.article;
  return spec.sections.map((s, i) => ({
    id: s.id,
    order: i + 1,
    heading: s.heading,
    word_budget: s.words,
    rule_hint: SECTION_RULES[s.id] || ""
  }));
}

// Hard cap to stay under 8192 num_ctx (~6k tokens for prompt + 2k for output).
const MAX_SNIPPETS = 4;
const MAX_SNIPPET_CHARS = 800;

function clampSnippets(snippets) {
  if (!Array.isArray(snippets)) return [];
  return snippets.slice(0, MAX_SNIPPETS).map(s => {
    const text = typeof s === "string" ? s : (s?.text || s?.content || "");
    return text.length > MAX_SNIPPET_CHARS ? text.slice(0, MAX_SNIPPET_CHARS) + "…" : text;
  });
}

/**
 * Build a section synthesis prompt.
 * Structure: section meta → retrieved snippets → previous-heading anti-duplication → critical rules at END.
 *
 * @param {object}  args
 * @param {string}  args.topic
 * @param {string}  args.tier
 * @param {object}  args.section            { id, heading, word_budget, rule_hint, thesis_claim? }
 * @param {Array}   args.relevantSnippets   array of strings or {text} objects — clamped to 4×800
 * @param {Array}   args.previousHeadings   [{heading, summary_1liner}, ...]
 * @param {object}  args.constraints        loadAgentConstraints() result
 * @param {Array<string>} args.knownCitationUrls   URLs harvested earlier — model is told to cite from this set only
 * @returns {string} prompt text
 */
export function sectionPrompt({ topic, tier, section, relevantSnippets, previousHeadings, constraints, knownCitationUrls }) {
  const c = constraints || FALLBACK_CONSTRAINTS;
  const snippets = clampSnippets(relevantSnippets);
  const prevList = (previousHeadings || []).map(p => `- ${p.heading}: ${p.summary_1liner || ""}`.trim()).join("\n") || "(none yet — this is the first section)";

  const snippetsBlock = snippets.length
    ? snippets.map((s, i) => `[Source ${i + 1}]\n${s}`).join("\n\n")
    : "(no retrieved snippets — write from general knowledge of the topic, but do not fabricate citations)";

  const citationDirective = (knownCitationUrls && knownCitationUrls.length)
    ? `Cite ONLY URLs from this approved list (markdown link form: [phrase](url)):\n${knownCitationUrls.slice(0, 20).map(u => `  - ${u}`).join("\n")}`
    : `Do NOT invent citation URLs. If you cannot back a claim with one of the retrieved sources, state it without a citation.`;

  const calloutHint = c.formatting.useCallouts && c.formatting.calloutMinPerSection > 0
    ? `Include at least ${c.formatting.calloutMinPerSection} Obsidian callout (e.g. \`> [!info]\`, \`> [!warning]\`, \`> [!quote]\`) in this section.`
    : "Callouts are optional.";

  return `# Synthesis task: ${section.heading} for "${topic}"

You are writing the **${section.heading}** section of a ${tier}-tier academic write-up.
Section role: ${section.rule_hint || "Contribute substantively to the document."}
${section.thesis_claim ? `\nThesis claim for this section: ${section.thesis_claim}\n` : ""}

## Retrieved source material (use as evidence; paraphrase, do not copy)
${snippetsBlock}

## Sections already written (do NOT repeat these claims — build on them)
${prevList}

────────────────────────────────────────────────────────────────────────
CRITICAL FORMATTING RULES (these override anything above):
────────────────────────────────────────────────────────────────────────
1. Output ONLY the section body — start directly with prose. Do not include the heading "${section.heading}" yourself; it will be added by the assembler.
2. Target length: ~${section.word_budget} words (±25%).
3. Voice: ${c.writing.voice}. Do NOT use "I", "we", "our", "my", or "us".
4. Tone: ${c.writing.tone}. ${c.writing.allowContractions ? "" : "No contractions (e.g. write 'do not' not 'don't')."}
5. Paragraphs: ${c.writing.wordsPerParagraph.min}–${c.writing.wordsPerParagraph.max} words each. No single-sentence paragraphs.
6. Bullet lists: at most ${c.writing.bulletTolerancePerSection} per section, and only when the content is genuinely enumerable.
7. ${calloutHint}
8. Wikilinks: when referencing a related concept, use \`[[Concept Name]]\` form (Obsidian wikilink) sparingly — ${c.formatting.wikilinkDensity} density.
9. ${citationDirective}
10. Do NOT fabricate facts, names, dates, statistics, or quotes. If a source does not support a claim, omit the claim.

Begin the section now:
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lint
// ─────────────────────────────────────────────────────────────────────────────

// Skip first-person checks inside fenced code blocks, blockquotes, and AI-ack section.
function stripIgnored(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")             // fenced code
    .replace(/^>.*$/gm, "")                     // blockquotes (callouts, citations)
    .replace(/##\s*AI Usage Acknowledgment[\s\S]*$/i, ""); // AI-ack section can speak in 1st person
}

const FIRST_PERSON_RE = /\b(I|we|our|my|us|ours|ourselves)\b/g;
const CONTRACTION_RE = /\b(don't|won't|can't|it's|that's|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|wouldn't|shouldn't|couldn't|I'm|you're|they're|we're|I've|you've|they've|we've|I'll|you'll|they'll|we'll|I'd|you'd|they'd|we'd)\b/gi;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Lint a finished thesis text.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.tier                  used for total-word-count tolerance
 * @param {Array<string>} opts.knownUrls      harvested article URLs; unknown citations get flagged
 * @returns {{ issues: Array, warnings: Array, offendingParagraphs: Array<{paragraph:string, reason:string}> }}
 */
export function lint(text, { tier = "article", knownUrls = [] } = {}) {
  const issues = [];
  const warnings = [];
  const offendingParagraphs = [];

  const cleaned = stripIgnored(text);

  // 1. Third-person check — by paragraph so we can target rewrites
  const paragraphs = cleaned.split(/\n{2,}/);
  for (const p of paragraphs) {
    const matches = p.match(FIRST_PERSON_RE);
    if (matches && matches.length > 0) {
      offendingParagraphs.push({ paragraph: p.trim(), reason: `first-person voice: ${[...new Set(matches)].join(", ")}` });
      issues.push(`First-person voice in paragraph (${matches.length} hit${matches.length > 1 ? "s" : ""})`);
    }
  }

  // 2. Contractions (warning only — not auto-rewritten)
  const contractionHits = cleaned.match(CONTRACTION_RE);
  if (contractionHits && contractionHits.length > 0) {
    warnings.push(`${contractionHits.length} contraction${contractionHits.length > 1 ? "s" : ""} found: ${[...new Set(contractionHits.map(c => c.toLowerCase()))].slice(0, 5).join(", ")}`);
  }

  // 3. Citation validation
  const knownSet = new Set(knownUrls.map(normalizeUrl));
  const citations = [];
  let m;
  const re = new RegExp(MARKDOWN_LINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    citations.push({ phrase: m[1], url: m[2], normalized: normalizeUrl(m[2]) });
  }
  const strayCitations = citations.filter(c => /^https?:\/\//i.test(c.url) && knownSet.size > 0 && !knownSet.has(c.normalized));
  if (strayCitations.length > 0) {
    issues.push(`${strayCitations.length} citation${strayCitations.length > 1 ? "s" : ""} reference URLs not in the harvested-source set`);
  }

  // 4. Length tolerance (±25% of tier total)
  const target = TIER_BUDGETS[tier]?.total || 1500;
  const actual = wordCount(text);
  const drift = (actual - target) / target;
  if (Math.abs(drift) > 0.25) {
    warnings.push(`Document length ${actual} words vs. ${target} target (${(drift * 100).toFixed(0)}% drift)`);
  }

  return { issues, warnings, offendingParagraphs, strayCitations, wordCount: actual, targetWords: target };
}

function normalizeUrl(u) {
  if (!u) return "";
  return u.trim().replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
}

export function wordCount(text) {
  if (!text) return 0;
  return (text.trim().match(/\S+/g) || []).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bibliography (deterministic — never LLM-generated)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a numbered bibliography from article-note frontmatter records.
 *
 * @param {Array<{title?:string, url?:string, source?:string, date?:string, authors?:string}>} articleNotes
 * @returns {string} markdown bibliography section
 */
export function buildBibliography(articleNotes) {
  if (!Array.isArray(articleNotes) || articleNotes.length === 0) {
    return "## Bibliography\n\n_No sources recorded._\n";
  }
  // De-dupe by normalized URL or title
  const seen = new Set();
  const unique = [];
  for (const a of articleNotes) {
    const key = normalizeUrl(a.url || "") || (a.title || "").toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }
  // Alphabetize by title (fallback to source)
  unique.sort((a, b) => (a.title || a.source || "").localeCompare(b.title || b.source || ""));

  const lines = unique.map((a, i) => {
    const title  = (a.title || "(untitled)").replace(/^"|"$/g, "");
    // Phase 3A — prefer the upgraded paper URL when present
    const citUrl = a.paper_url || a.url || "";
    const urlStr = citUrl ? ` <${citUrl}>` : "";
    const source = a.source ? ` — *${a.source}*` : "";
    const date   = a.date ? ` (${a.date.slice(0, 10)})` : "";
    const authors = a.authors ? `${a.authors}. ` : "";
    // Annotate source kind so readers know whether citation is a research paper or a web article
    const kindBadge = a.paper_url || a.paper_doi
      ? " **(paper)**"
      : a.paper_source === "html" ? " *(OA landing)*" : " *(web)*";
    return `${i + 1}. ${authors}${title}${source}${date}${kindBadge}.${urlStr}`;
  });
  return `## Bibliography\n\n${lines.join("\n")}\n`;
}

// AI usage footer for non-thesis tiers
export function aiUsageFooter({ model = "Lanou local LLM", date = new Date().toISOString().slice(0, 10) } = {}) {
  return `\n---\n> _Synthesized with the Lanou research pipeline (${model}) on ${date}._\n`;
}

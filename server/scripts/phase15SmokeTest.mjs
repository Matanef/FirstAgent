#!/usr/bin/env node
// Phase 15 smoke test — pure-helper assertions for Round-3 fixes.
// Mirrors Phase 13/14 patterns: inline mini-implementations + targeted imports.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

// ── 15A: stripDepthFlag with [MODEL:xxx] ─────────────────────────────────
console.log("\n=== 15A: stripDepthFlag strips [MODEL:xxx] directives ===");
try {
  const { stripDepthFlag } = await import("../skills/deepResearch/tierDetector.js");
  check("strips '[MODEL:cloud]' alone",
    stripDepthFlag("[MODEL:cloud] write a piece about CBT") === "write a piece about CBT");
  check("strips '[MODEL:cloud]' AND '[depth:thesis]' together",
    stripDepthFlag("[MODEL:cloud] [depth:thesis] write a piece about CBT") === "write a piece about CBT");
  check("strips '[MODEL:local]'",
    stripDepthFlag("[MODEL:local] hello world") === "hello world");
  check("strips '[MODEL:openai]' (any name)",
    stripDepthFlag("[MODEL:openai] test") === "test");
  check("preserves text without directives",
    stripDepthFlag("write a piece about CBT") === "write a piece about CBT");
  check("strips '--depth=thesis' CLI flag (existing behavior)",
    stripDepthFlag("topic --depth=thesis here") === "topic here");
  check("does NOT strip '[MODEL]' without colon (real bracket content)",
    stripDepthFlag("[MODEL] should stay") === "[MODEL] should stay");
} catch (err) {
  check("tierDetector module loads", false, `(${err.message})`);
}

// ── 15B: looksLikeLlmError detector ──────────────────────────────────────
console.log("\n=== 15B: LLM error sentinel detection ===");
try {
  const ts = await import("../skills/deepResearch/thesisSynthesizer.js");
  const f = ts.looksLikeLlmError;
  check("export exists", typeof f === "function");
  check("'The language model encountered an error: LLM request aborted...' → true",
    f("The language model encountered an error: LLM request aborted or timed out") === true);
  check("'(synthesis failed for this section: Some error)' → true",
    f("(synthesis failed for this section: Network unreachable, retried 3 times)") === true);
  check("normal section text → false",
    f("CBT is a structured psychotherapy that targets maladaptive cognitions and behaviors.") === false);
  check("empty/short text → false",
    f("") === false && f("short") === false);
  check("partial match in middle of normal text → true (full sentinel)",
    f("This section discusses CBT. The language model encountered an error: timeout. More content here.") === true);
} catch (err) {
  check("thesisSynthesizer loads", false, `(${err.message})`);
}

// ── 15C: bare prose author lint (extended pattern D + E) ─────────────────
function lintBareProse(draft, validSurnames) {
  let stripped = 0;
  let out = String(draft);
  // Pattern D: BARE "Surname et al." without parens
  out = out.replace(/\b([A-Z][a-zA-Z'\-]{2,30})\s+et\s+al\.?(?!\s*\()/g, (match, surname) => {
    if (validSurnames.has(surname.toLowerCase())) return match;
    stripped++;
    return "(unverified study)";
  });
  // Pattern E: bare "Surname and Surname" with attribution prefix
  out = out.replace(
    /(\b(?:by|to|in|from|per|via|see|by\s+a\s+study\s+by)\s+|study\s+by\s+|research\s+by\s+|work\s+of\s+|paper\s+by\s+)([A-Z][a-zA-Z'\-]{2,30})\s+and\s+([A-Z][a-zA-Z'\-]{2,30})(?!\s*\()/g,
    (match, prefix, s1, s2) => {
      if (validSurnames.has(s1.toLowerCase()) || validSurnames.has(s2.toLowerCase())) return match;
      stripped++;
      return `${prefix.trim()} (unverified studies)`;
    }
  );
  return { out, stripped };
}
console.log("\n=== 15C: bare prose author lint ===");
const idx = new Set(["smith", "jones", "foa", "beck"]);
const r1 = lintBareProse("a study by Hofmann et al. found significant improvements", idx);
check("bare 'Hofmann et al.' (not in index) → stripped",
  !r1.out.includes("Hofmann et al.") && r1.out.includes("(unverified study)"));
const r2 = lintBareProse("Cuijpers et al. reported mixed results", idx);
check("bare 'Cuijpers et al.' (not in index) → stripped",
  !r2.out.includes("Cuijpers et al."));
const r3 = lintBareProse("Smith et al. (2020) showed effects", idx);
check("'Smith et al. (2020)' (with parens, in index) → preserved",
  r3.out.includes("Smith et al. (2020)"));
const r4 = lintBareProse("Smith et al. demonstrated effects", idx);
check("'Smith et al.' bare (in index) → preserved",
  r4.out.includes("Smith et al."));
const r5 = lintBareProse("a study by Smith and Jones reported X", idx);
check("'Smith and Jones' (both in index) → preserved",
  r5.out.includes("Smith and Jones"));
const r6 = lintBareProse("a study by Hofmann and Cuijpers found X", idx);
check("'Hofmann and Cuijpers' (neither in index) → stripped",
  !r6.out.includes("Hofmann and Cuijpers"));
const r7 = lintBareProse("Black and white pixels are common in old images", idx);
check("'Black and white' WITHOUT attribution prefix → preserved (false-positive guard)",
  r7.out.includes("Black and white"));

// ── 15D: methodology factsBlock assembly ──────────────────────────────────
console.log("\n=== 15D: methodology realCounts factsBlock ===");
function buildFactsBlock(realCounts) {
  if (!realCounts) return "";
  return `=== EMPIRICAL FACTS (use these EXACT numbers; do NOT invent counts) ===
- Total articles harvested across sub-questions: ${realCounts.articles}
- Total datasets retrieved: ${realCounts.datasets}
- Total entries in the final bibliography: ${realCounts.sources}
- Search providers actually used: OpenAlex, CORE, DOAJ, Semantic Scholar, OSF Preprints, Academagic
- Retrieval was an automated multi-database keyword search (NOT a PRISMA systematic review)
`;
}
const fb = buildFactsBlock({ articles: 56, datasets: 14, sources: 70 });
check("factsBlock includes article count",  fb.includes("56"));
check("factsBlock includes dataset count",  fb.includes("14"));
check("factsBlock includes source count",   fb.includes("70"));
check("factsBlock names real providers",    fb.includes("OpenAlex") && fb.includes("DOAJ"));
check("factsBlock disavows PRISMA",         fb.includes("NOT a PRISMA"));
check("buildFactsBlock(null) → ''",         buildFactsBlock(null) === "");

// ── 15E: stripMetaCommentary ─────────────────────────────────────────────
function stripMeta(text) {
  let stripped = 0;
  const META_PATTERNS = [
    /\([^)]{0,400}\b(?:hypothetical(?:\s+year)?|placeholder|illustrative\s+(?:example|purposes?)|likely\s+intended|note\s+that|disclaimer\b|for\s+the\s+purpose\s+of\s+(?:this\s+)?(?:example|illustration)|in\s+this\s+synthesis|as\s+(?:an?\s+)?(?:example|illustration))\b[^)]{0,400}\)/gi,
    /(?:^|\s)(?:Note|Disclaimer)\s*:\s+[^.\n]{20,300}\.(?=\s|$)/g,
  ];
  for (const re of META_PATTERNS) text = text.replace(re, () => { stripped++; return ""; });
  if (stripped) text = text.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:)])/g, "$1");
  return { text, stripped };
}
console.log("\n=== 15E: stripMetaCommentary ===");
const m1 = stripMeta("CBT is effective (given the hypothetical year 2026 reference, likely intended as a placeholder for illustrative examples) for many disorders.");
check("strips '(given the hypothetical year ... placeholder ...)'",
  !m1.text.includes("hypothetical") && !m1.text.includes("placeholder"));
check("preserves surrounding sentence after strip",
  m1.text.includes("CBT is effective") && m1.text.includes("for many disorders"));
const m2 = stripMeta("The result was significant (p<.05) across all conditions.");
check("preserves '(p<.05)' (no meta marker)",
  m2.text.includes("(p<.05)"));
const m3 = stripMeta("Per (Smith, 2020), the effect was moderate.");
check("preserves '(Smith, 2020)' citation",
  m3.text.includes("(Smith, 2020)"));
const m4 = stripMeta("This finding is robust. Note: This is a placeholder for further data. The next section discusses...");
check("strips 'Note: ... placeholder ...' bare sentence",
  !m4.text.includes("Note: This is a placeholder"));

// ── 15G: wikilink word-count cap ─────────────────────────────────────────
console.log("\n=== 15G: wikilink word-count cap ===");
function filterWikilinks(phrases) {
  return phrases
    .filter(p => p.length >= 2 && p.length <= 60)
    .filter(p => p.split(/\s+/).length <= 3);
}
const candidates = [
  "CBT",                                    // 1 word — keep
  "Co-design principles",                   // 2 words (hyphen counts as one) — keep
  "Artificial intelligence in CBT",         // 4 words — drop
  "Digital health tools for cancer care",   // 6 words — drop
  "BRAVE-ONLINE program",                   // 2 words (hyphen counts as one) — keep
  "Three-word concept here",                // 3 words — keep (boundary)
];
const filtered = filterWikilinks(candidates);
check("'CBT' (1 word) kept",                       filtered.includes("CBT"));
check("'Co-design principles' (2 words) kept",     filtered.includes("Co-design principles"));
check("'Three-word concept here' (3 words) kept",  filtered.includes("Three-word concept here"));
check("'Artificial intelligence in CBT' (4 words) dropped",
  !filtered.includes("Artificial intelligence in CBT"));
check("'Digital health tools for cancer care' (6 words) dropped",
  !filtered.includes("Digital health tools for cancer care"));
check("'BRAVE-ONLINE program' (hyphen=1word, total 2 words) kept",
  filtered.includes("BRAVE-ONLINE program"));

// ── 15H: buildNoChartsNote formatter ─────────────────────────────────────
console.log("\n=== 15H: no-charts provenance note ===");
try {
  const ts = await import("../skills/deepResearch/thesisSynthesizer.js");
  const f = ts.buildNoChartsNote;
  check("export exists",  typeof f === "function");
  check("returns '' when datasetCount=0",  f(0, 0) === "");
  check("returns '' when parseableCount > 0 (charts present)",  f(14, 3) === "");
  const note = f(14, 0);
  check("returns callout when 14 datasets, 0 parseable",
    note.startsWith("> [!note]") && note.includes("14 dataset"));
  check("includes 'expected variance' explanation",
    note.includes("expected variance"));
  check("includes 'figshare' or 'dryad' as future-providers hint",
    note.includes("figshare") || note.includes("dryad"));
} catch (err) {
  check("thesisSynthesizer loads (15H)", false, `(${err.message})`);
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Phase 8 smoke test — verifies the deterministic post-passes:
// dejargon, stockBullets, orphanQuotes, chart enforcement, citation sanitizer.

import { _internals as CITES } from "../skills/deepResearch/citations.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== 8E: Citation sanitizer (canonicalizeAuthor) ===");
check("rejects 'V., (.'",         CITES.canonicalizeAuthor("V., (.") === null);
check("rejects 'V., .. A. P.'",   CITES.canonicalizeAuthor("V., .. A. P.") === null);
check("rejects 'L., (. T.'",      CITES.canonicalizeAuthor("L., (. T.") === null);
check("rejects single-letter 'V.'", CITES.canonicalizeAuthor("V.") === null);
check("rejects '..A. P.'",        CITES.canonicalizeAuthor("..A. P.") === null);
check("accepts 'Smith, J.'",      CITES.canonicalizeAuthor("Smith, J.") === "Smith, J.");
check("accepts 'John Smith'",     CITES.canonicalizeAuthor("John Smith") === "Smith, J.");
check("accepts 'O'Brien, M.'",    CITES.canonicalizeAuthor("O'Brien, M.") === "O'Brien, M.");

// Replicate the inline functions from thesisSynthesizer.js for the
// post-pass tests (we can't easily import them since they're not exported).
// Keep the regex/logic identical to the source.

const PIPELINE_JARGON_SUBSTITUTIONS = [
  [/\bsemantic[\s-]?chunk(?:[\s-]?indexing|[\s-]?index|[\s-]?retrieval)?\b/gi, "indexed source excerpts"],
  [/\bdeterministic\s+aggregation\b/gi, "descriptive aggregation"],
  [/\b(?:extensive\s+)?query\s+expansion\b/gi, "multi-database keyword search"],
  [/\bvector\s+embedding(?:s)?\s+(?:for\s+)?(?:retrieval|search|index(?:ing)?)?\b/gi, "indexed source excerpts"],
  [/\bvector\s+(?:store|index|database|db)\b/gi, "source-excerpt index"],
  [/\bRAG\b/g, "retrieval over indexed sources"],
  [/\b(?:deterministic|programmatic)\s+(?:JS|JavaScript|Python|aggregation|computation)(?:\s+over\s+(?:full|all)\s+rows)?\b/gi, "descriptive statistical aggregation"],
  [/\brendered\s+programmatically\b/gi, "rendered with charting software"],
  [/\bharvest(?:ed|ing)?\s+(?:articles|sources|datasets)\b/gi, "retrieved sources"],
  [/\bsub-questions?\s+probed\b/gi, "research questions investigated"],
  [/\bpipeline\b/gi, "process"],
];

function dejargon(text) {
  let out = text;
  for (const [re, repl] of PIPELINE_JARGON_SUBSTITUTIONS) out = out.replace(re, repl);
  return out;
}

console.log("\n=== 8A: dejargonMethodology ===");
const jargonInput = "We used semantic-chunk indexing for retrieval. The pipeline conducted extensive query expansion. Deterministic aggregation was performed over full rows. Charts were rendered programmatically.";
const dejargoned = dejargon(jargonInput);
check("strips 'semantic-chunk indexing'", !/semantic[\s-]chunk/i.test(dejargoned));
check("strips 'query expansion'",         !/query expansion/i.test(dejargoned));
check("strips 'deterministic aggregation'", !/deterministic aggregation/i.test(dejargoned));
check("strips 'pipeline'",                !/\bpipeline\b/i.test(dejargoned));
check("strips 'rendered programmatically'", !/rendered programmatically/i.test(dejargoned));
check("inserts 'multi-database keyword search'", /multi-database keyword search/.test(dejargoned));
check("inserts 'descriptive'",            /descriptive/i.test(dejargoned));

console.log("\n=== 8D: stripStockBulletSections ===");
const stockBulletPatterns = [
  /\n+\*{1,2}(?:Key\s+(?:Findings?|Takeaways?|Points?)|Limitations?|Implications?|Highlights?|Summary)\s*:?\s*\*{0,2}\s*:?\s*\n+(?:[-*]\s+[^\n]+\n)+/gi,
  /\n+(?:Key\s+(?:Findings?|Takeaways?|Points?)|Limitations?)\s*:\s*\n+(?:[-*]\s+[^\n]+\n)+/gi
];
function stripStock(text, sectionHeading) {
  if (/conclusion|summary|future/i.test(sectionHeading || "")) return text;
  let out = text;
  for (const re of stockBulletPatterns) out = out.replace(re, "\n\n");
  return out;
}
const inputAbstract = `Some abstract text.

**Key Findings:**
- Finding one
- Finding two

**Limitations:**
- Limitation one
- Limitation two

More abstract content.`;
const cleanedAbstract = stripStock(inputAbstract, "Abstract");
check("strips Key Findings from Abstract", !/Key Findings:/.test(cleanedAbstract));
check("strips Limitations from Abstract",  !/Limitations:/.test(cleanedAbstract));
check("preserves prose",                   /Some abstract text/.test(cleanedAbstract) && /More abstract content/.test(cleanedAbstract));
const conclusionWithBullets = stripStock(inputAbstract, "Conclusion");
check("PRESERVES Key Findings in Conclusion", /Key Findings/.test(conclusionWithBullets));

console.log("\n=== 8F: stripOrphanQuotes ===");
function stripOrphan(text) {
  return text
    .replace(/([.!?])"\s+(?=[a-z])/g, (m, p) => `${p} `)
    .replace(/\n"\s*(?=[a-z])/g, "\n");
}
const orphanInput = `End of one thought." emphasizes the importance of self-efficacy. Another sentence here.`;
const orphanFixed = stripOrphan(orphanInput);
check("strips orphan close-quote",        !/\."\s+emphasizes/.test(orphanFixed));
check("preserves valid quotes elsewhere", stripOrphan(`She said "hello." Then she left.`).includes(`"hello."`));

console.log("\n=== 8B: enforceChartsInResults ===");
function enforce(text, qfs) {
  const charts = qfs.flatMap(q => q.charts || []);
  if (charts.length === 0) return text;
  const already = (text.match(/!\[\[charts\//g) || []).length;
  if (already >= Math.min(2, charts.length)) return text;
  const toEmbed = charts.slice(0, 3);
  const blocks = toEmbed.map((c, i) => `\n\n![[${c.chartPath}]]\n\n*Figure ${i + 1}. ${c.caption}*\n\n${c.interpretation}`).join("");
  const trimmed = text.trimEnd();
  const lastBreak = trimmed.lastIndexOf("\n\n");
  return lastBreak === -1
    ? trimmed + blocks + "\n"
    : trimmed.slice(0, lastBreak) + blocks + "\n\n" + trimmed.slice(lastBreak + 2) + "\n";
}
const noChartsResults = "Results paragraph one.\n\nResults paragraph two.\n\nFinal paragraph.";
const qfsWithCharts = [{
  charts: [
    { chartPath: "charts/foo.svg", caption: "Bar chart of treatment effects.", interpretation: "Treatment group showed M=12.3 vs control M=18.7." },
    { chartPath: "charts/bar.svg", caption: "Line chart of trends.", interpretation: "Trend rose 47% over the period." }
  ]
}];
const enforced = enforce(noChartsResults, qfsWithCharts);
check("injects 1st chart embed",  /!\[\[charts\/foo\.svg\]\]/.test(enforced));
check("injects 2nd chart embed",  /!\[\[charts\/bar\.svg\]\]/.test(enforced));
check("includes Figure caption",  /Figure 1\./.test(enforced));
check("includes interpretation",  /M=12\.3/.test(enforced));
const alreadyHasCharts = "Some text. ![[charts/x.svg]]\n\n![[charts/y.svg]]\n\nMore text.";
const noOpEnforce = enforce(alreadyHasCharts, qfsWithCharts);
check("no-op when 2+ already present", noOpEnforce === alreadyHasCharts);
const noQfs = enforce("plain text", []);
check("no-op when no charts available", noQfs === "plain text");

console.log("\n=== 8G: research-question marker regex ===");
const RQ = /\b(?:this\s+(?:paper|review|study|article|work)\s+(?:examines|investigates|analyzes|explores|addresses|tests|presents)|the\s+present\s+(?:study|review)\s+(?:examines|investigates|asks))\b/i;
check("matches 'This paper examines'",  RQ.test("This paper examines the role of X."));
check("matches 'This review investigates'", RQ.test("This review investigates how Y."));
check("matches 'The present study examines'", RQ.test("The present study examines Z."));
check("rejects vague intro",            !RQ.test("CBT is widely used in clinical practice today."));

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

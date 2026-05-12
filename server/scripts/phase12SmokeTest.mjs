#!/usr/bin/env node
// Phase 12 smoke test — covers the new strippers and lints.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

// Replicate inline (helpers aren't exported)
function stripPreamble(text) {
  const re = /^[\s>]*(?:Okay,?|Sure,?|Certainly,?|Of\s+course,?|Alright,?|Here\s+is|Here's|Below\s+is|It\s+targets|It\s+aims|Aiming\s+for|This\s+synthesis|This\s+piece|This\s+section\s+(?:will|aims|presents|offers)|The\s+following|Based\s+on\s+the\s+provided|Drawing\s+(?:upon|from))\s[^.\n!?:]{0,400}[.!?:][\s\n]*(?:---[\s\n]*)?/i;
  const m = text.match(re);
  return m ? text.slice(m[0].length).trimStart() : text;
}

console.log("\n=== 12D: extended preamble patterns (deepseek-r1 specific) ===");
check("strips colon-terminated 'Okay, here is a synthesis...:'",
  !stripPreamble("Okay, here is a synthesis of the provided sources, highlighting key themes:\n\nReal content.").startsWith("Okay"));
check("strips 'It targets exceeding...'",
  !stripPreamble("It targets exceeding the 1020-word mark.\n\nReal content.").startsWith("It targets"));
check("strips 'Based on the provided dataset...'",
  !stripPreamble("Based on the provided dataset and quantitative findings, here is a synthesis:\n\nReal content.").startsWith("Based"));
check("strips 'Below is a synthesis...'",
  !stripPreamble("Below is a synthesis of the literature.\n\nReal content.").startsWith("Below"));
check("strips 'Aiming for at least N words.'",
  !stripPreamble("Aiming for at least 552 words by deepening analysis.\n\nReal content.").startsWith("Aiming"));
check("strips 'This synthesis aims...'",
  !stripPreamble("This synthesis aims to clarify the evidence:\n\nReal content.").startsWith("This synthesis"));
check("strips 'Drawing upon...'",
  !stripPreamble("Drawing upon the dataset:\n\nReal content.").startsWith("Drawing"));
check("preserves real research prose",
  stripPreamble("Cognitive Behavioral Therapy is widely recognized.").startsWith("Cognitive"));

// 12A — markdown fence stripper
function stripFences(text) {
  let out = text;
  out = out.replace(/^[\s>]*```(?:markdown|md)[\s>]*$/gim, "");
  out = out.replace(/^[\s>]*```\s*$/gm, "");
  out = out.replace(/^[\s>]*```\s+(?=\S)/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}
console.log("\n=== 12A: markdown fence stripper ===");
const fenceInput1 = "```markdown\n\n# Title\n\n```\nReal content here.";
check("strips opening ```markdown fence",  !stripFences(fenceInput1).includes("```markdown"));
check("strips orphan ``` line",            !stripFences("Section.\n\n```\n\nMore content.").includes("```"));
check("strips inline ``` mid-paragraph",   !stripFences("``` CBT is widely used as a therapy.").includes("```"));
check("preserves prose",                   stripFences(fenceInput1).includes("Real content"));

// 12B — triple-quote stripper
function stripTQ(text) {
  return text.replace(/^[\s>]*"""[\s>]*$/gm, "").replace(/\n{3,}/g, "\n\n");
}
console.log("\n=== 12B: triple-quote heredoc stripper ===");
check("strips lone \"\"\" line",
  !stripTQ('Section text.\n\n"""\n* item\n* item\n"""\n\nMore text.').includes('"""'));
check("preserves quoted text within prose",
  stripTQ('She said "hello" then left.').includes('"hello"'));

// 12C — malformed wikilink (extended for [![[X]]])
function lintWiki(text) {
  let out = text;
  out = out.replace(/\[!\[\[([^\]\n]{5,300}?)\]\]\]/g, (m, inner) => `[[${inner}]]`);
  out = out.replace(/\[\[([^\]\n]{20,200}?\([A-Z][^\]\n]{30,}?\.\.?\)[^\]\n]{0,40})\]\]/g, (m, inner) => {
    const t = inner.split(/[:.(]/)[0].trim();
    return t ? `"${t}"` : "";
  });
  out = out.replace(/\[\[([^\]\n]{5,200}?)\](?!\])/g, (m, inner) => {
    const c = inner.split(/[:.(]/)[0].trim();
    return c ? `*${c}*` : "";
  });
  return out;
}
console.log("\n=== 12C: malformed wikilink lint (extended) ===");
const seen = "[![[Parental Involvement in CBT for Anxiety-Disordered Youth Revisited: Family CBT Outperforms Child CBT]]]";
const fixed = lintWiki(seen);
check("converts [![[X]]] to [[X]]",
  fixed.startsWith("[[") && fixed.endsWith("]]") && !fixed.includes("[!"));
check("preserves clean [[X]]", lintWiki("Use [[CBT]] for treatment.").includes("[[CBT]]"));

// 12E — H2 demote inside section body
function demoteH2(text, sectionHeading) {
  const expected = sectionHeading.toLowerCase().replace(/[^\w\s]/g, "").trim();
  return text.replace(/^(##)\s+(.+?)\s*$/gm, (m, h, ht) => {
    const norm = ht.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (norm === expected || (expected.length > 6 && norm.includes(expected))) return m;
    return `### ${ht}`;
  });
}
console.log("\n=== 12E: section-body H2 demote ===");
const abstractMess = "Some prose.\n\n## Effectiveness Across Conditions\n\nText\n\n## Future Directions\n\nMore text";
const fixedA = demoteH2(abstractMess, "Abstract");
// Use line-anchored match so "### Effectiveness" doesn't false-positive
check("demotes ## Effectiveness → ###", !/^## Effectiveness/m.test(fixedA));
check("demotes ## Future Directions → ###", !/^## Future/m.test(fixedA));
check("converted to ###", fixedA.includes("### Effectiveness") && fixedA.includes("### Future Directions"));
const ownHeader = "## Abstract\n\nText.\n\n## Other section";
const fixedB = demoteH2(ownHeader, "Abstract");
check("preserves section's OWN H2",        fixedB.includes("## Abstract"));
check("demotes UNRELATED ## Other section", fixedB.includes("### Other section"));

// 12G — bridge eligibility with libgen-fallback flag
function isBlocked(article, analysis) {
  const url = String(article?.url || "");
  if (!url) return false;
  if (/sci-?hub|google\.com\/scholar/i.test(url)) return false;
  const relevance = analysis?.analysis?.relevance ?? 0;
  if (article?._fetch_failed === true && relevance >= 0.5) return true;
  if (article?._used_libgen_fallback === true && relevance >= 0.5) {
    const content = String(article?.content || "");
    if (content.length < 4000) return true;
  }
  const content = String(article?.content || "");
  if (content.length < 1500 && relevance >= 0.6) return true;
  return false;
}
console.log("\n=== 12G: bridge eligibility honors libgen-fallback flag ===");
check("blocks libgen 3.6KB content (real ad-page case)",
  isBlocked({ url: "https://libgen.li/x.pdf", content: "x".repeat(3600), _used_libgen_fallback: true }, { analysis: { relevance: 0.7 } }));
check("does NOT block libgen 5KB content (real PDF text)",
  !isBlocked({ url: "https://libgen.li/x.pdf", content: "x".repeat(5000), _used_libgen_fallback: true }, { analysis: { relevance: 0.7 } }));
check("blocks _fetch_failed regardless of libgen",
  isBlocked({ url: "https://example.com/x.pdf", content: "x".repeat(2000), _fetch_failed: true }, { analysis: { relevance: 0.7 } }));
check("does NOT block sci-hub URL",
  !isBlocked({ url: "https://sci-hub.foo/x.pdf", content: "thin", _fetch_failed: true }, { analysis: { relevance: 0.7 } }));

// 12H — malformed authors list
function shouldDropMalformed(authors) {
  const singleWord = authors.filter(a => typeof a === "string" && !a.includes(",") && !/\s/.test(a.trim()) && a.trim().length < 25).length;
  return authors.length >= 5 && singleWord / authors.length > 0.6;
}
console.log("\n=== 12H: malformed author-list detection ===");
check("flags 'Beck, Bender, Brown, Emerson, ...' as malformed",
  shouldDropMalformed(["Beck", "Bender", "Brown", "Emerson", "Goldberg", "Hatton", "Lindsay"]));
check("preserves valid 'Smith, J.' / 'Jones, K.' format",
  !shouldDropMalformed(["Smith, J.", "Jones, K.", "Brown, A.", "Davis, M.", "Wilson, P."]));
check("preserves single-author entry (under threshold)",
  !shouldDropMalformed(["Smith"]));
check("preserves 'First Last' form (has space)",
  !shouldDropMalformed(["John Smith", "Jane Doe", "Bob Jones", "Alice Brown", "Carol Davis"]));

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

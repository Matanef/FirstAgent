#!/usr/bin/env node
// Phase 10 smoke test — covers post-pass cleaners + provider fixes.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

// ── 10I: Conversational preamble strip ───────────────────────────────────
const preambleRe = /^[\s>]*(?:Okay,?|Sure,?|Certainly,?|Of course,?|Alright,?|Here is|Here's|Below is)\s[^.\n]{0,300}\.[\s\n]*(?:---[\s\n]*)?/i;
function stripPreamble(text) {
  const m = text.match(preambleRe);
  return m ? text.slice(m[0].length).trimStart() : text;
}

console.log("\n=== 10I: conversational preamble strip ===");
check("strips 'Okay, here is an expanded section...'",
  !stripPreamble("Okay, here is an expanded discussion section based on your draft.\n\n---\n\nThe synthesis...").startsWith("Okay"));
check("strips 'Sure, here's...'",
  !stripPreamble("Sure, here's the rewrite.\n\nReal content.").startsWith("Sure"));
check("strips 'Below is the...'",
  !stripPreamble("Below is the requested section, expanded as instructed.\n\nReal content.").startsWith("Below"));
check("preserves real content (no preamble)",
  stripPreamble("The synthesis offers analysis.").startsWith("The synthesis"));
check("strips trailing horizontal rule with preamble",
  !stripPreamble("Okay, here is the section.\n\n---\n\nReal content.").includes("---"));

// ── 10J: Mid-body duplicate heading + leading `---` ─────────────────────
function stripDupHeading(text, sectionHeading) {
  let out = String(text);
  out = out.replace(/^[\s\n]*---\s*\n+/, "");
  const expected = sectionHeading.toLowerCase().replace(/[^\w\s]/g, "").trim();
  out = out.replace(/^(#{1,3})\s+(.+?)\s*$/gm, (match, _h, headingText) => {
    const norm = headingText.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (norm === expected || (norm.includes(expected) && expected.length > 6)) return "";
    return match;
  });
  return out.replace(/\n{3,}/g, "\n\n");
}

console.log("\n=== 10J: mid-body duplicate heading + `---` strip ===");
check("strips leading `---`",
  !stripDupHeading("---\n\nReal content.", "Discussion").startsWith("---"));
check("strips mid-body `## Discussion`",
  stripDupHeading("Some prose.\n\n## Discussion\n\nMore prose.", "Discussion").split("##").length === 1);
check("preserves UNRELATED `## Methods` heading",
  stripDupHeading("Prose.\n\n## Methods\n\nMore.", "Discussion").includes("## Methods"));
check("strips `### Discussion` H3 too",
  !stripDupHeading("Prose.\n\n### Discussion\n\nMore.", "Discussion").includes("### Discussion"));

// ── 10K: Malformed wikilink lint ─────────────────────────────────────────
function lintWiki(text) {
  let out = String(text);
  out = out.replace(/\[\[([^\]\n]{20,200}?\([A-Z][^\]\n]{30,}?\.\.?\)[^\]\n]{0,40})\]\]/g, (m, inner) => {
    const t = inner.split(/[:.(]/)[0].trim();
    return t ? `"${t}"` : "";
  });
  out = out.replace(/\[\[([^\]\n]{5,200}?)\](?!\])/g, (m, inner) => {
    const c = inner.split(/[:.(]/)[0].trim();
    return c ? `*${c}*` : "";
  });
  out = out.replace(/\[\[[^\]]*\n[^\]]*\]\]/g, "");
  return out;
}

console.log("\n=== 10K: malformed wikilink lint ===");
const seenIn1 = "[[Document GraphRAG: Knowledge Graph Enhanced Retrieval Augmented Generation for Document... (Evaluation demonstrates consistent performance gains...)]";
const seenOut1 = lintWiki(seenIn1);
check("strips wikilink with parenthetical sentence + missing `]`",
  !/\[\[/.test(seenOut1) || /\*Document GraphRAG/.test(seenOut1));
check("preserves clean `[[GraphRAG]]`", lintWiki("Use [[GraphRAG]] for retrieval.").includes("[[GraphRAG]]"));
check("removes wikilinks with newlines", !lintWiki("text [[foo\nbar]] more").includes("[["));

// ── 10L: deepseek <think> block strip ────────────────────────────────────
function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");
}

console.log("\n=== 10L: deepseek <think> block strip ===");
check("strips closed <think>...</think>",
  !stripThink("<think>reasoning here</think>Real content.").includes("<think>"));
check("strips unclosed <think> (truncated)",
  !stripThink("Some prose.\n<think>reasoning that never closed").includes("<think>"));
check("preserves content outside think blocks",
  stripThink("Before<think>X</think>After").includes("After"));

// ── 10D: prose-fabricated-author lint ────────────────────────────────────
function lintProseAuthors(draft, validSurnames) {
  const valid = new Set(validSurnames.map(s => s.toLowerCase()));
  let out = draft;
  out = out.replace(/\b([A-Z][a-zA-Z'\-]{2,30})\s+et\s+al\.?\s*\((\d{4}[a-z]?)\)/g, (m, s, y) =>
    valid.has(s.toLowerCase()) ? m : s + " et al.");
  out = out.replace(/\b([A-Z][a-zA-Z'\-]{2,30})\s+and\s+([A-Z][a-zA-Z'\-]{2,30})\s*\((\d{4}[a-z]?)\)/g, (m, s1, s2, y) =>
    (valid.has(s1.toLowerCase()) || valid.has(s2.toLowerCase())) ? m : `${s1} and ${s2}`);
  out = out.replace(/(\b(?:by|to|in|from|of|per|via)\s+|^|\n|\.\s+)([A-Z][a-zA-Z'\-]{2,30})\s*\((\d{4}[a-z]?)\)/g, (m, prefix, s, y) =>
    valid.has(s.toLowerCase()) ? m : prefix + s);
  return out;
}

console.log("\n=== 10D: prose-fabricated-author lint ===");
const valid = ["Bennett", "Dunford", "Espie"];
check("strips fabricated 'Smith et al. (2020)'",
  !lintProseAuthors("Smith et al. (2020) found something.", valid).includes("(2020)"));
check("preserves real 'Bennett et al. (2016)'",
  lintProseAuthors("Bennett et al. (2016) reported.", valid).includes("(2016)"));
check("strips fabricated 'Smith and Jones (2020)'",
  !lintProseAuthors("Smith and Jones (2020) said.", valid).includes("(2020)"));
check("preserves 'Espie and Bennett (2018)' (one valid)",
  lintProseAuthors("Espie and Bennett (2018).", valid).includes("(2018)"));
check("strips 'by Smith (2019)' attribution",
  !lintProseAuthors("Reviewed by Smith (2019).", valid).includes("(2019)"));

// ── 10C: repository-as-venue detection ───────────────────────────────────
const REPO_VENUES = new Set([
  "openalex", "figshare", "dryad", "dryad digital repository",
  "harvard dataverse", "dataverse",
  "open science framework", "osf", "osf preprints",
  "zenodo", "data.gov", "datagov",
  "icpsr", "humanitarian data exchange", "hdx",
  "world bank open data", "world bank", "oecd statistics", "oecd",
  "fred", "fred — st. louis fed",
  "who global health observatory", "who", "whogho",
  "academagic"
]);
function isRepo(v) { return REPO_VENUES.has(String(v || "").trim().toLowerCase()); }

console.log("\n=== 10C: repository-as-venue detection ===");
check("OpenAlex flagged as repo", isRepo("OpenAlex"));
check("openalex (lower) flagged", isRepo("openalex"));
check("Dryad Digital Repository flagged", isRepo("Dryad Digital Repository"));
check("Harvard Dataverse flagged", isRepo("Harvard Dataverse"));
check("Real journal NOT flagged: 'Journal of Eating Disorders'", !isRepo("Journal of Eating Disorders"));
check("Real journal NOT flagged: 'SLEEP'", !isRepo("SLEEP"));

// ── 10G: DOI sanitizer ───────────────────────────────────────────────────
function sanitizeDoi(rawDoi) {
  if (!rawDoi || typeof rawDoi !== "string") return "";
  return rawDoi
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .split(/[\s{}",'<>]/)[0]
    .replace(/[.,:;]+$/, "")
    .trim();
}

console.log("\n=== 10G: DOI sanitizer ===");
check("strips serialization debris '},title'",
  sanitizeDoi("10.1186/2050-2974-1-23},title:foo") === "10.1186/2050-2974-1-23");
check("strips trailing punctuation",
  sanitizeDoi("10.1186/x.") === "10.1186/x");
check("strips https://doi.org/ prefix",
  sanitizeDoi("https://doi.org/10.1186/x") === "10.1186/x");
check("preserves clean DOI",
  sanitizeDoi("10.5061/dryad.rjdfn2zcr") === "10.5061/dryad.rjdfn2zcr");
check("returns empty for null", sanitizeDoi(null) === "");
check("returns empty for whitespace", sanitizeDoi("  ") === "");

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

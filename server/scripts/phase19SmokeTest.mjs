#!/usr/bin/env node
// Phase 19 smoke test — ORCID rescue + 8 synthesizer leak strippers
// + Dryad skip + ordered-list renumber + strict prose-author lint
// + tighter initial section prompt. Pure-helper assertions; no live
// network calls (ORCID covered by source-grep + signature checks).

import { readFileSync } from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== Phase 19 Smoke (ORCID, leak strippers, Dryad, renumber, strict lint) ===\n");

// ── 19A: ORCID client surface + citation pre-rescue wiring ────────────────
console.log("Test 19A: ORCID client + citation rescue wiring");
{
  const orcidSrc = readFileSync(new URL("../skills/deepResearch/orcidClient.js", import.meta.url), "utf8");
  check("orcidClient exports getAccessToken",
    /export async function getAccessToken/.test(orcidSrc));
  check("orcidClient exports searchAuthor",
    /export async function searchAuthor/.test(orcidSrc));
  check("orcidClient exports verifyByDoi",
    /export async function verifyByDoi/.test(orcidSrc));
  check("orcidClient exports rescueAuthors",
    /export async function rescueAuthors/.test(orcidSrc));
  check("orcidClient exports isConfigured",
    /export function isConfigured/.test(orcidSrc));
  check("orcidClient uses client_credentials grant",
    /grant_type[^\n]*client_credentials/.test(orcidSrc));
  check("orcidClient uses /read-public scope",
    /scope[^\n]*\/read-public/.test(orcidSrc));
  check("orcidClient reads ORCID_CLIENT_ID + ORCID_CLIENT_SECRET env",
    /ORCID_CLIENT_ID/.test(orcidSrc) && /ORCID_CLIENT_SECRET/.test(orcidSrc));
  check("orcidClient single-flights the token exchange",
    /_tokenFetchPromise/.test(orcidSrc));
  check("orcidClient supports ORCID_ACCESS_TOKEN override",
    /ORCID_ACCESS_TOKEN/.test(orcidSrc));
  check("orcidClient caches with 24h TTL",
    /CACHE_TTL_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(orcidSrc));

  const citSrc = readFileSync(new URL("../skills/deepResearch/citations.js", import.meta.url), "utf8");
  check("citations.js exports rescueMalformedAuthors",
    /export async function rescueMalformedAuthors/.test(citSrc));
  check("rescueMalformedAuthors only fires when ORCID configured",
    /_orcidConfigured\(\)/.test(citSrc));
  check("rescueMalformedAuthors skips entries without DOI",
    /if \(!cite\.doi\) continue/.test(citSrc));

  const synthSrc = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("thesisSynthesizer imports rescueMalformedAuthors",
    /rescueMalformedAuthors/.test(synthSrc));
  check("thesisSynthesizer awaits rescueMalformedAuthors before buildCitationIndex",
    /await rescueMalformedAuthors\(allNotesForCitations\)[\s\S]{0,400}const citationIndex = buildCitationIndex/.test(synthSrc));
}

// ── 19B: stripEmptyH4Stubs ───────────────────────────────────────────────
console.log("\nTest 19B: stripEmptyH4Stubs");
{
  function stripEmptyH4Stubs(text) {
    return String(text).replace(/^#### [^\n]+\n\s*(?=^####\s|^###[^#]|^##[^#]|^#[^#])/gm, "");
  }
  const input = "#### Empty Stub Heading\n\n#### Real Heading\n\nReal body content here.";
  const out = stripEmptyH4Stubs(input);
  check("empty H4 followed by another H4 is removed",
    !/Empty Stub Heading/.test(out));
  check("real H4 + body preserved",
    /Real Heading[\s\S]+Real body content/.test(out));

  // Don't mangle H4 with body
  const withBody = "#### Has Body\n\nBody paragraph.\n\n#### Another";
  check("H4 with body left alone",
    /Has Body[\s\S]+Body paragraph/.test(stripEmptyH4Stubs(withBody)));
}

// ── 19C: stripEmbeddedReferencesBlock ────────────────────────────────────
console.log("\nTest 19C: stripEmbeddedReferencesBlock");
{
  function stripRefs(text) {
    return String(text).replace(
      /^###\s+(?:References?|Bibliography|Citations?|Works\s+Cited)\s*\n[\s\S]*$/im,
      ""
    ).trimEnd();
  }
  const conclusion = "Section body talking about CBT.\n\nMore body content.\n\n### References\n\n1.\n2.\n3.\n4.";
  const out = stripRefs(conclusion);
  check("section-internal `### References\\n1.\\n2.\\n3.` block removed",
    !/### References/.test(out));
  check("section body preserved",
    /Section body talking about CBT/.test(out));

  // Other reference-style headings stripped too
  check("`### Bibliography` also stripped",
    !/### Bibliography/.test(stripRefs("Body.\n\n### Bibliography\n\n1. Smith 2024.")));
  check("`### Works Cited` also stripped",
    !/### Works Cited/.test(stripRefs("Body.\n\n### Works Cited\n\n1. Jones 2024.")));
}

// ── 19D: stripEmbeddedConclusionBlock ───────────────────────────────────
console.log("\nTest 19D: stripEmbeddedConclusionBlock");
{
  function stripConc(text, heading) {
    if (/^conclusion$/i.test(String(heading || "").trim())) return text;
    return String(text).replace(
      /^###\s+(?:Conclusion|Summary|Final\s+Thoughts)\s*\n[\s\S]*$/im,
      ""
    ).trimEnd();
  }
  const intro = "Introduction body content here.\n\nMore introduction.\n\n### Conclusion\n\nThis intro is a mini-essay.";
  const out = stripConc(intro, "Introduction");
  check("section-internal `### Conclusion` stripped from Introduction",
    !/### Conclusion/.test(out));
  check("introduction body preserved",
    /Introduction body content/.test(out));

  // Don't strip from the actual Conclusion section
  const realConclusion = "Conclusion body content.\n\n### Conclusion\n\nNested conclusion - should survive (caller handles).";
  // The function preserves untouched when the section heading is "Conclusion"
  const out2 = stripConc(realConclusion, "Conclusion");
  check("real Conclusion section is NOT touched",
    /### Conclusion/.test(out2));
}

// ── 19E: stripMetaCommentaryTail ────────────────────────────────────────
console.log("\nTest 19E: stripMetaCommentaryTail");
{
  function stripMeta(text) {
    let out = String(text);
    out = out.replace(/\n+---\s*\n+(?:This (?:expanded |structured |comprehensive )?(?:section|approach|review|analysis)|By integrating|This (?:section|review) (?:provides|delves|covers))[\s\S]+?$/i, "");
    out = out.replace(/\n+(?:This (?:expanded |structured |comprehensive )?(?:section|approach|review|analysis) (?:delves|ensures|provides|underscores|highlights|covers|goes beyond)|By integrating technology[^\n]*?,?\s*(?:CBT|this section|this review))[\s\S]+?(?:draft\.|field\.|innovation\.|conditions\.|disorders\.|outcomes\.)\s*$/i, "");
    out = out.replace(/\n+[^\n]*\bgoing beyond the initial \d+\s*-?\s*word draft[^\n]*\.\s*$/i, "");
    return out.trimEnd();
  }
  const withTail = "Real section body content discussing the topic at length.\n\n---\n\nThis expanded section delves deeper into the mechanisms, comparisons, and future directions of CBT in treating anorexia nervosa, providing a comprehensive analysis that goes beyond the initial 610-word draft.";
  const out = stripMeta(withTail);
  check("meta-commentary tail with `---` separator removed",
    !/This expanded section delves/.test(out));
  check("body content before tail preserved",
    /Real section body content/.test(out));

  // Without separator
  const noSep = "Body discussing CBT outcomes.\n\nThis structured approach ensures that the introduction covers key conditions.";
  const out2 = stripMeta(noSep);
  check("meta-commentary without separator removed",
    !/This structured approach ensures/.test(out2));
}

// ── 19F: stripUnverifiedStudyMarkers ────────────────────────────────────
console.log("\nTest 19F: stripUnverifiedStudyMarkers");
{
  function stripUnv(text) {
    let out = String(text);
    out = out.replace(/\s+by\s+\((?:unverified|hypothetical|placeholder|fictional|illustrative)\s+stud(?:y|ies)\)/gi, "");
    out = out.replace(/\s*\((?:unverified|hypothetical|placeholder|fictional|illustrative)\s+(?:stud(?:y|ies)|references?|sources?)\)\s*,?\s*/gi, " ");
    out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1");
    return out;
  }
  const withMarker = "A study by (unverified study) found significant effects.";
  const out = stripUnv(withMarker);
  check("`by (unverified study)` attribution removed",
    !/unverified study/.test(out));
  check("sentence remains readable",
    /A study found significant effects\./.test(out) || /A study\s+found significant effects\./.test(out));

  const bare = "Multiple meta-analyses (unverified studies) confirm the trend.";
  const out2 = stripUnv(bare);
  check("bare `(unverified studies)` parenthetical removed",
    !/unverified studies/.test(out2));
}

// ── 19G: Dryad direct-file URL skip ─────────────────────────────────────
console.log("\nTest 19G: Dryad direct-file URL skip");
{
  const re = /datadryad\.org\/api\/v\d+\/files\/\d+\/download/i;
  check("matches v2 download URL",
    re.test("https://datadryad.org/api/v2/files/1377477/download"));
  check("matches v3 download URL (forward-compat)",
    re.test("https://datadryad.org/api/v3/files/9999/download"));
  check("does NOT match Dryad landing page",
    !re.test("https://datadryad.org/stash/dataset/doi:10.5061/dryad.abc123"));
  check("does NOT match other domains",
    !re.test("https://figshare.com/articles/dataset/foo/12345"));

  const dsSrc = readFileSync(new URL("../skills/deepResearch/datasetHarvester.js", import.meta.url), "utf8");
  check("downloadAndParse skips Dryad direct-file URLs",
    /DRYAD_DIRECT_FILE_RE\.test\(file\.downloadUrl\)/.test(dsSrc));
  check("DRYAD_API_TOKEN env hook present (future-proof)",
    /DRYAD_API_TOKEN/.test(dsSrc));
}

// ── 19H: renumberOrderedLists ────────────────────────────────────────────
console.log("\nTest 19H: renumberOrderedLists");
{
  // Inline replica of renumberOrderedLists
  function renumberOrderedLists(draft) {
    const lines = String(draft).split("\n");
    const out = [];
    let runActive = false;
    let runIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(\s*)(\d+)\.(\s+\S[\s\S]*)$/);
      if (m && m[1].length === 0) {
        if (!runActive) { runActive = true; runIndex = 1; }
        else runIndex++;
        out.push(`${runIndex}.${m[3]}`);
        continue;
      }
      if (/^\s*$/.test(line) || /^\s{2,}\S/.test(line)) {
        out.push(line);
        continue;
      }
      runActive = false;
      runIndex = 0;
      out.push(line);
    }
    return out.join("\n");
  }
  const skipped = "1. Depression and Anxiety\n3. Substance Abuse\n4. PTSD";
  const fixed = renumberOrderedLists(skipped);
  check("`1., 3., 4.` becomes `1., 2., 3.`",
    /^1\. Depression/m.test(fixed) && /^2\. Substance Abuse/m.test(fixed) && /^3\. PTSD/m.test(fixed));

  const withBlanks = "1. First\n\n2. Second\n\n4. Fourth";
  const fixedBlanks = renumberOrderedLists(withBlanks);
  check("list with blank-line separators renumbered",
    /^1\. First/m.test(fixedBlanks) && /^2\. Second/m.test(fixedBlanks) && /^3\. Fourth/m.test(fixedBlanks));

  // Two separate lists with prose between are independently numbered
  const twoBlocks = "1. A\n2. B\n\nSome prose.\n\n1. C\n2. D";
  const fixedTwo = renumberOrderedLists(twoBlocks);
  check("two separate lists renumbered independently",
    /^1\. C/m.test(fixedTwo) && /^2\. D/m.test(fixedTwo));
}

// ── 19I: splitSmushedH3HeadingBody ───────────────────────────────────────
console.log("\nTest 19I: splitSmushedH3HeadingBody");
{
  function split(text) {
    return String(text).replace(/^(### [^\n]{30,200}?)\.\s+([A-Z][a-z][^\n]{40,})$/gm, (m, head, body) => `${head}.\n\n${body}`);
  }
  const smushed = "### Introduction to Cognitive Behavioral Therapy (CBT) in Mental Health. Cognitive Behavioral Therapy (CBT) is a widely recognized, evidence-based psychological treatment approach.";
  const out = split(smushed);
  check("smushed H3+body split into heading + paragraph",
    /^### Introduction to Cognitive Behavioral Therapy \(CBT\) in Mental Health\.$/m.test(out));
  check("body becomes its own paragraph",
    /^Cognitive Behavioral Therapy \(CBT\) is a widely recognized/m.test(out));

  // Don't split short legitimate H3
  const legit = "### Methodology";
  check("short H3 unchanged",
    split(legit) === legit);
}

// ── 19J: strip empty H1 prefix ──────────────────────────────────────────
console.log("\nTest 19J: strip empty H1 prefix in final assembly");
{
  function stripPrefix(body) {
    return body.replace(/^\s*#+\s*\n+/, "");
  }
  const dirty = "#\n\n# Abstract\n\nBody text.";
  const clean = stripPrefix(dirty);
  check("leading `#\\n\\n#` collapsed (Abstract heading retained)",
    /^# Abstract\n/.test(clean));

  // Don't mangle a single proper H1
  const ok = "# Title\n\nBody";
  // The replace WILL strip the title because regex matches `# Title` pattern... wait no
  // /^\s*#+\s*\n+/ requires `#` followed by whitespace + newline. `# Title\n` has content after #
  // so it should NOT match. Let me verify:
  check("regular `# Title\\nBody` unchanged",
    stripPrefix(ok) === ok);

  const synthSrc = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("thesisSynthesizer strips empty H1 prefix from enrichedDraft before write",
    /enrichedDraft\.replace\(\/\^\\s\*#\+\\s\*\\n\+\//.test(synthSrc));
}

// ── 19K: strict prose-author lint (surname+year tuple) ─────────────────
console.log("\nTest 19K: strict prose-author lint with surname+year tuple");
{
  const synthSrc = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("validSurnameYears tuple set built from citationIndex",
    /validSurnameYears\s*=\s*new\s+Set\(\)/.test(synthSrc));
  check("Pattern A checks surname|year tuple",
    /validSurnameYears\.has\(key\)/.test(synthSrc));
  check("comment explains the Fairburn-style false-positive bug",
    /Fairburn[\s\S]{0,200}YEAR was fake/i.test(synthSrc) || /Fairburn[\s\S]{0,300}did NOT match/i.test(synthSrc));

  // Functional: simulate the tuple-keyed lint behavior
  const validTuples = new Set(["fairburn|2020"]);
  function tupleCheck(s, y) { return validTuples.has(`${s.toLowerCase()}|${y}`); }
  check("real (Fairburn, 2020) passes",
    tupleCheck("Fairburn", "2020") === true);
  check("fake (Fairburn, 2005) rejected",
    tupleCheck("Fairburn", "2005") === false);
  check("fake (Andersson, 2019) rejected",
    tupleCheck("Andersson", "2019") === false);
}

// ── 19L: tighter initial section prompt + bumped num_predict ───────────
console.log("\nTest 19L: better initial section prompt");
{
  const synthSrc = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("expansionDirectives mentions SELF-CHECKPOINT",
    /SELF-CHECKPOINT/.test(synthSrc));
  check("expansionDirectives addresses underwriting tendency",
    /default tendency is to UNDERWRITE/i.test(synthSrc));
  check("expansionDirectives uses 50%-halfway checkpoint",
    /wordCheckpoint\s*=\s*Math\.floor\(\(section\.word_budget\s*\|\|\s*600\)\s*\*\s*0\.5\)/.test(synthSrc));
  check("baseMult bumped to 2.6 for non-reasoning models (was 2.2)",
    /baseMult\s*=\s*usingReasoningModel\s*\?\s*2\.8\s*:\s*2\.6/.test(synthSrc));
  check("longMult bumped to 3.0 for non-reasoning long sections (was 2.8)",
    /longMult\s*=\s*usingReasoningModel\s*\?\s*3\.4\s*:\s*3\.0/.test(synthSrc));
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

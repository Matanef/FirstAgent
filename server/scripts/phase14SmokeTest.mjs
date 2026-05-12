#!/usr/bin/env node
// Phase 14 smoke test — pure-helper assertions for the Round-2 fixes.
// Mirrors the Phase 13 pattern: inline mini-implementations + a few targeted
// imports from the live citation/harvester modules. No server, no LLM, no I/O.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

// ── 14A — stripFabricatedBibliography (tightened) + 60% cap ─────────────
function stripFabricatedBibliography(text) {
  if (!text) return text;
  const original = String(text);
  let out = original;
  let stripped = 0;
  const AUTHOR_BULLET = "[-*]\\s+[A-Z][\\p{L}'\\-]+,\\s*[A-Z]\\.[^\\n]{0,500}";
  const AUTHOR_BULLET_AMP = "[-*]\\s+[A-Z][\\p{L}'\\-]+\\s+(?:&|and)\\s+[A-Z][\\p{L}'\\-]+[^\\n]{0,500}";
  const REF_HEADER = "(?:#{0,3}\\s*)?(?:\\*\\*)?References?:?(?:\\s*Cited)?:?(?:\\*\\*)?\\s*:?\\s*";
  const BIB_HEADER = "(?:#{0,3}\\s*)?(?:\\*\\*)?Bibliography:?(?:\\*\\*)?\\s*:?\\s*";
  const refBlockPatterns = [
    new RegExp(`\\n+${REF_HEADER}\\n+(?:(?:${AUTHOR_BULLET}|${AUTHOR_BULLET_AMP})\\n+){3,}`, "giu"),
    new RegExp(`\\n+${BIB_HEADER}\\n+(?:(?:${AUTHOR_BULLET}|${AUTHOR_BULLET_AMP})\\n+){3,}`, "giu"),
  ];
  for (const re of refBlockPatterns) {
    out = out.replace(re, (match) => {
      if (match.length > original.length * 0.6) return match; // 60% cap
      stripped++;
      return "\n\n";
    });
  }
  return out;
}
console.log("\n=== 14A: stripFabricatedBibliography (tightened) + 60% cap ===");
// Test fabricated-bib strip — needs enough prose so the bibliography is <60%
// of the section (so the cap guard does NOT fire). Real sections are 1500+
// chars so the cap rarely triggers; the test must mirror that proportion.
const sectionProse = "CBT is a structured psychotherapy that targets maladaptive cognitions and behavioral responses. Decades of meta-analyses have established its efficacy across anxiety disorders, depression, PTSD, and insomnia. Recent work has extended these findings to digital platforms and culturally adapted protocols, with mixed but generally favorable evidence on adherence and outcome equivalence to face-to-face delivery. Several adaptations now exist for pediatric populations, eating disorders, and trauma-related grief. ".repeat(3);
const fabricatedBib = sectionProse + "\n\n**References:**\n- Smith, J. (2020). Title. Journal.\n- Jones, A. (2021). Title2. Journal.\n- Foa, E.B. (2017). PTSD. Journal Y.\n- Beck, A.T. (1979). Cognitive therapy. Guilford.\n\n";
const stripped = stripFabricatedBibliography(fabricatedBib);
check("strips fabricated bibliography (4 author-shaped bullets, prose dominant)",
  !stripped.includes("Smith, J."));
check("preserves preceding prose after strip",
  stripped.includes("CBT is a structured psychotherapy"));

// LR-shaped retry output: study-summary bullets with prose body — must NOT be eaten.
const lrLikeOutput = `CBT theoretical foundations emphasize the interplay between thoughts, emotions, and behaviors, with cognitive distortions playing a central role.

Recent meta-analyses indicate CBT effectiveness across various conditions:

- Anxiety disorders show large effect sizes
- Depression shows moderate-to-large effects
- Insomnia (CBT-I) is now first-line
- PTSD shows robust effects with TF-CBT
- Eating disorders benefit from adapted protocols
- Substance use shows mixed efficacy

Cultural adaptations enhance effectiveness with diverse populations.`;
const lrCleaned = stripFabricatedBibliography(lrLikeOutput);
check("LR-shaped study bullets (no References header) NOT stripped",
  lrCleaned.length === lrLikeOutput.length);

// 60% cap test: a section that's mostly bibliography
const mostlyBib = "Short intro.\n\n**References:**\n" +
  Array.from({length: 12}, (_, i) => `- Author${i}, A. (202${i % 10}). Title ${i}. Journal.`).join("\n") + "\n\n";
const mostlyBibAfter = stripFabricatedBibliography(mostlyBib);
check("60% cap fires when bibliography would consume too much (preserves content)",
  mostlyBibAfter.length === mostlyBib.length);

// Ensure non-author bullets (just descriptions) don't trigger the strip
const nonAuthorBullets = `Section.

**References:**
- The first finding was that CBT works well for anxiety
- The second finding was that CBT works for depression
- The third finding was that CBT-I is gold standard
`;
const nonAuthorAfter = stripFabricatedBibliography(nonAuthorBullets);
check("non-author bullets (no surname-comma-initial) NOT stripped",
  nonAuthorAfter.includes("The first finding"));

// ── 14B — looksTruncated detector ──────────────────────────────────────
function looksTruncated(text) {
  if (!text || text.length < 80) return false;
  const tail = String(text).replace(/[\s>]+$/, "").slice(-160);
  if (!tail) return false;
  if (/[.!?)\]"'»’”]$/.test(tail)) return false;
  if (/\]\]$/.test(tail)) return false;
  if (/\*$|_$/.test(tail)) return false;
  if (/[a-z,]$/.test(tail)) return true;
  if (/\b(and|or|the|a|an|in|of|with|that|to|from|by|for|as|on|at|is|are|was|were|but|while|when|which|where|but|though)$/i.test(tail)) return true;
  if (/\(\s*[NnPpKk]?\s*=?\s*\d*$/.test(tail)) return true;
  if (/&$|\+$|-$/.test(tail)) return true;
  return false;
}
console.log("\n=== 14B: looksTruncated detector ===");
const padding = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
check("healthy period ending → false",      !looksTruncated(padding + "This sentence ends properly."));
check("healthy ! ending → false",           !looksTruncated(padding + "Strong claim!"));
check("healthy ? ending → false",           !looksTruncated(padding + "What is the impact?"));
check("healthy ) ending → false",           !looksTruncated(padding + "Result was significant (p<.05)"));
check("healthy ]] (wikilink) ending → false", !looksTruncated(padding + "the [[CBT]]"));
check("healthy *italic* close → false",     !looksTruncated(padding + "*italicized*"));
check("CBT log truncation 'making strong causal' → true",
  looksTruncated(padding + "this makes strong causal"));
check("CBT log truncation '* A pilot dataset (N=3' → true",
  looksTruncated(padding + "* A pilot dataset (N=3"));
check("hanging conjunction 'and' → true",
  looksTruncated(padding + "the analysis and"));
check("trailing comma → true",
  looksTruncated(padding + "Smith, Jones, and Foa et al.,"));
check("'Popenoe &' (CBT log Lit Review tail) → true",
  looksTruncated(padding + "incorporating cultural values (Popenoe &"));
check("short text → false (no false positive on 50-char snippet)",
  !looksTruncated("Short text"));

// ── 14C — numbered-list rejoin in reflowParagraphs ─────────────────────
function reflowRejoinOnly(draft) {
  let out = String(draft);
  out = out.replace(/^(\s*\d+\.)[ \t]*\n{1,}[ \t]*(\*\*)/gm, "$1 $2");
  out = out.replace(/^(\s*[-*])[ \t]*\n{1,}[ \t]*(\*\*)/gm, "$1 $2");
  return out;
}
console.log("\n=== 14C: numbered-list rejoin ===");
check("'1.\\n\\n**Title:** body' → '1. **Title:** body'",
  reflowRejoinOnly("1.\n\n**Methodological Heterogeneity:** Many studies...") === "1. **Methodological Heterogeneity:** Many studies...");
check("'2.\\n**Title:**' (single newline) → joined",
  reflowRejoinOnly("2.\n**Bold:** body") === "2. **Bold:** body");
check("preserves '1. **Title:** body' unchanged",
  reflowRejoinOnly("1. **Already joined:** body") === "1. **Already joined:** body");
check("preserves '1.\\n\\nplain paragraph' (no bold marker)",
  reflowRejoinOnly("1.\n\nPlain paragraph here") === "1.\n\nPlain paragraph here");
check("bullet '- \\n\\n**Title:**' also rejoined",
  reflowRejoinOnly("- \n\n**Bold:** body") === "- **Bold:** body");

// ── 14D — bracket-tag citation stripper ────────────────────────────────
function stripBracketTags(text) {
  if (!text) return text;
  let stripped = 0;
  let out = String(text).replace(/(?<!\[)\[([^\]\n]{3,200})\](?![\]\(])/g, (m, inner) => {
    const trimmed = inner.trim();
    if (/^[\d,\s\-]+$/.test(trimmed)) return m;
    if (/\b(1[7-9]\d{2}|20\d{2}|21\d{2})\b/.test(trimmed)) return m;
    if (/^[*^]\d+$/.test(trimmed)) return m;
    stripped++;
    return "";
  });
  if (stripped) out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:)])/g, "$1");
  return out;
}
console.log("\n=== 14D: bracket-tag citation stripper ===");
check("strips '[Cochrane review]'",
  !stripBracketTags("CBT works for depression [Cochrane review].").includes("[Cochrane review]"));
check("strips '[Mexico Trial Data]'",
  !stripBracketTags("Aurora trial showed promise [Mexico Trial Data].").includes("[Mexico Trial Data]"));
check("strips '[Mindset App Analysis]'",
  !stripBracketTags("Adherence varied [Mindset App Analysis].").includes("[Mindset App Analysis]"));
check("strips '[CBT-I for Psychiatric Populations, CBT-I Meta-analysis]'",
  !stripBracketTags("CBT-I works [CBT-I for Psychiatric Populations, CBT-I Meta-analysis].").includes("CBT-I Meta-analysis]"));
check("strips '[Evidence from \"...\" description]'",
  !stripBracketTags("Mindset adherence [Evidence from the Mindset study description] was low.").includes("Evidence from"));
check("preserves '[Smith et al., 2020]' (APA, has year)",
  stripBracketTags("Cited [Smith et al., 2020].").includes("[Smith et al., 2020]"));
check("preserves '[Smith, 2020]' (APA, has year)",
  stripBracketTags("Per [Smith, 2020], the result holds.").includes("[Smith, 2020]"));
check("preserves '[5, 6]' numeric ref (Phase 13C territory)",
  stripBracketTags("Cited [5, 6] in the result.").includes("[5, 6]"));
check("preserves wikilink '[[CBT]]'",
  stripBracketTags("Use [[CBT]] for therapy.").includes("[[CBT]]"));
check("preserves markdown link '[text](url)'",
  stripBracketTags("See [the paper](https://example.com) for details.").includes("[the paper](https://example.com)"));
check("collapses double-spaces left by strip",
  !/  /.test(stripBracketTags("Cited [Cochrane review] is real.").trim()));

// ── 14E — methodology fabricated-DB scrubber ──────────────────────────
function honestifyFabDB(text) {
  let out = text;
  let fabStripped = 0;
  out = out.replace(
    /[^.]*\b(PubMed|PsycINFO|PsycInfo|MEDLINE|Web\s+of\s+Science|Embase|Scopus|Cochrane\s+Library|EBSCO(?:host)?|ProQuest)\b[^.]*\./gi,
    () => { fabStripped++; return ""; }
  );
  if (fabStripped > 0) {
    out = "The literature was harvested via OpenAlex, CORE, DOAJ, Semantic Scholar, OSF Preprints, and Academagic across multiple sub-questions, with deep-PDF reads on accessible open-access articles. " + out.trimStart();
  }
  return { text: out.replace(/\s{2,}/g, " ").trim(), fabStripped };
}
console.log("\n=== 14E: methodology fabricated-DB scrubber ===");
const fabMethod = "The literature search was conducted using PubMed, PsycINFO, and Cochrane Library. Inclusion criteria were applied.";
const fabResult = honestifyFabDB(fabMethod);
check("strips fabricated DB sentence",
  !fabResult.text.includes("PubMed") && !fabResult.text.includes("PsycINFO") && !fabResult.text.includes("Cochrane Library"));
check("prepends honest provenance line",
  fabResult.text.startsWith("The literature was harvested via OpenAlex"));
check("counts strip events",
  fabResult.fabStripped >= 1);
const cleanMethod = "The literature was harvested via open-access providers across 8 sub-questions.";
const cleanResult = honestifyFabDB(cleanMethod);
check("clean methodology unchanged (no DB names)",
  cleanResult.fabStripped === 0);

// ── 14G — isDeepResearchInProgress flag ─────────────────────────────────
console.log("\n=== 14G: deepResearch in-progress flag ===");
try {
  const mod = await import("../skills/deepResearch/index.js");
  check("isDeepResearchInProgress export exists",
    typeof mod.isDeepResearchInProgress === "function");
  check("flag default is false",
    mod.isDeepResearchInProgress() === false);
  if (typeof mod._markDeepResearchInProgress === "function") {
    mod._markDeepResearchInProgress(true);
    check("flag flips to true after _markDeepResearchInProgress(true)",
      mod.isDeepResearchInProgress() === true);
    mod._markDeepResearchInProgress(false);
    check("flag flips back to false",
      mod.isDeepResearchInProgress() === false);
  }
} catch (err) {
  check("deepResearch module imports", false, `(${err.message})`);
}

// ── 14H — articleHarvester: GScholar removed ────────────────────────────
console.log("\n=== 14H: articleHarvester GScholar removed ===");
try {
  const harvester = await import("../skills/deepResearch/articleHarvester.js");
  // The module exports a small surface; check the source map can't reference GScholar.
  const src = await import("fs").then(fs => fs.readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8"));
  check("SOURCE_NAME_TO_FETCHER no longer has 'googlescholar'",
    !/googlescholar:\s*fetchGoogleScholar/.test(src));
  check("fetchGoogleScholar function body removed",
    !/^async function fetchGoogleScholar\b/m.test(src));
  check("determineDomains no longer pushes 'googlescholar'",
    !/out\.push\("googlescholar"\)/.test(src));
} catch (err) {
  check("articleHarvester module loads", false, `(${err.message})`);
}

// ── 14I — citation sanitizer (figshare ID + future-year cap) ───────────
console.log("\n=== 14I: citation sanitizer ===");
try {
  const cit = await import("../skills/deepResearch/citations.js");
  // canonicalizeAuthor is exposed via _internals
  const canon = cit._internals?.canonicalizeAuthor || cit.canonicalizeAuthor;
  check("canonicalizeAuthor strips figshare ID '(21245345)'",
    canon("Lubna Ghazal (21245345)") === "Ghazal, L.");
  check("canonicalizeAuthor strips figshare ID '(3569003)'",
    canon("Naixue Cui (3569003)") === "Cui, N.");
  check("canonicalizeAuthor still handles clean name",
    canon("Jane Smith") === "Smith, J.");
  check("canonicalizeAuthor rejects pure-paren-id input",
    canon("(21245345)") === null);

  const py = cit.parseYear;
  const currentYear = new Date().getFullYear();
  check("parseYear accepts current year",
    py(currentYear) === currentYear);
  check("parseYear accepts current year + 1",
    py(currentYear + 1) === currentYear + 1);
  check("parseYear REJECTS current year + 2 (future)",
    py(currentYear + 2) === null);
  check("parseYear accepts string '2024'",
    py("2024") === 2024);
  check("parseYear rejects '2099' (likely out-of-range future)",
    py("2099") === null);
  check("parseYear handles '(21245345)' figshare ID correctly (rejected)",
    py("(21245345)") === null);
  check("parseYear handles 1700 (boundary)",
    py(1700) === 1700);
  check("parseYear rejects 1699 (below boundary)",
    py(1699) === null);
} catch (err) {
  check("citations module loads", false, `(${err.message})`);
}

// ── 14F — buildBridgeSkipCallout helper ────────────────────────────────
console.log("\n=== 14F: bridge-skip callout ===");
try {
  const ts = await import("../skills/deepResearch/thesisSynthesizer.js");
  const callout = ts.buildBridgeSkipCallout(
    { count: 33, blocked: [{ kind: "article", url: "https://example.com/1.pdf" }, { kind: "dataset", url: "https://example.com/data.csv" }] },
    "Journal/Research/cognitive-behavioral-therapy"
  );
  check("buildBridgeSkipCallout starts with > [!warning]",
    callout.startsWith("> [!warning]"));
  check("includes the blocked count",
    callout.includes("33"));
  check("includes _pending/ recovery instruction",
    callout.includes("_pending/"));
  check("includes vaultRel slug for resume command",
    callout.includes("cognitive-behavioral-therapy"));
  check("empty notice → empty string",
    ts.buildBridgeSkipCallout(null, "x") === "" && ts.buildBridgeSkipCallout({ count: 0 }, "x") === "");
} catch (err) {
  check("thesisSynthesizer loads", false, `(${err.message})`);
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

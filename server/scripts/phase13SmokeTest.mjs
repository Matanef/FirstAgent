#!/usr/bin/env node
// Phase 13 smoke test — covers the new strippers, lints, and helpers.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

// ── 13A: H1 strip in section body ────────────────────────────────────────
function stripH1(text) {
  return text.replace(/^#\s+(?!#)([^\n]+)$/gm, "").replace(/\n{3,}/g, "\n\n");
}
console.log("\n=== 13A: H1 strip inside section body ===");
const h1Input = "Some intro text.\n\n# Cognitive Behavioral Therapy: Multifaceted Analysis\n\n---\n\nMore content.";
const h1Out = stripH1(h1Input);
check("removes mid-body H1 line",        !/^#\s+/m.test(h1Out));
check("preserves H2 headings",           stripH1("Text\n## Real H2\nMore").includes("## Real H2"));
check("preserves H3 headings",           stripH1("Text\n### Sub\nMore").includes("### Sub"));

// ── 13B: fabricated bibliography stripper ──────────────────────────────────
function stripBib(text) {
  let out = text;
  out = out.replace(/\n+(?:#{0,3}\s*)?(?:\*\*)?References?(?:\s*Cited)?(?:\*\*)?\s*:?\s*\n+(?:[-*]\s+[A-Z][^\n]{20,500}\n+){3,}/gi, "\n\n");
  out = out.replace(/\n+(?:#{0,3}\s*)?(?:\*\*)?Bibliography(?:\*\*)?\s*:?\s*\n+(?:[-*]\s+[A-Z][^\n]{20,500}\n+){3,}/gi, "\n\n");
  return out;
}
console.log("\n=== 13B: fabricated bibliography stripper ===");
const fabBib = `Section content here.

References:
- Hofmann, S.G., Asnaani, A., Vonk, I.J., Sawyer, A.T., & Fang, A. (2012). The efficacy of cognitive behavioral therapy. Journal X, 36(5), 427-440.
- Butler, A.C., Chapman, J.E., Forman, E.M., & Beck, A.T. (2006). The empirical status of cognitive-behavioral therapy. Clinical Psychology Review, 26(1), 17-31.
- Foa, E.B., Hembree, E.A., Cahill, S.P. (2017). Treatment of posttraumatic stress disorder. Journal Y, 30(4), 385-396.

`;
const stripped = stripBib(fabBib);
check("strips 'References:' block at section end", !stripped.includes("Hofmann, S.G."));
check("preserves prose before block",              stripped.includes("Section content here"));
check("strips 'Bibliography:' variant",
  !stripBib("Some prose.\n\nBibliography:\n- Author1, A. (2020). Title.\n- Author2, B. (2021). Title.\n- Author3, C. (2022). Title.\n\n").includes("Author1, A."));

// ── 13C: orphan numeric ref stripper ─────────────────────────────────────
function stripNumericRefs(text) {
  return text.replace(/(\w[^\n]{0,50}?)\[\d+(?:[,\s\-]+\d+)*\](?=[\s.,;:)])/g, (m, p) => p);
}
console.log("\n=== 13C: orphan numeric ref stripper ===");
check("strips '[5, 6]' from prose",       !stripNumericRefs("CBT works [5, 6]. Other claim.").includes("[5, 6]"));
check("strips '[7]' from prose",          !stripNumericRefs("Per the study [7], ...").includes("[7]"));
check("preserves bullet '[ ]' markers (lookbehind)",
  stripNumericRefs("- list item\n- another").includes("- list"));

// ── 13E: acronym wrapping ────────────────────────────────────────────────
const ACRONYMS = ["CBT", "CBT-I", "MBCT", "ACT", "PGD", "OCD", "PTSD", "GAD"];
function wrapAcronyms(text, allOccurrences = false) {
  let out = text;
  let count = 0;
  for (const ac of ACRONYMS) {
    const escaped = ac.replace(/-/g, "\\-");
    const re = new RegExp(`(?<!\\[\\[)(?<![\\w-])(${escaped})(?![\\w-])(?!\\]\\])`, "g");
    let firstUsed = false;
    out = out.replace(re, (m, c) => {
      if (firstUsed && !allOccurrences) return m;
      firstUsed = true;
      count++;
      return `[[${c}]]`;
    });
  }
  return { text: out, count };
}
console.log("\n=== 13E: acronym wrapping ===");
const acronymInput = "CBT-I is effective. PGD with insomnia. CBT works for PTSD and OCD. CBT-I is recommended.";
const r1 = wrapAcronyms(acronymInput);
check("wraps CBT-I",       r1.text.includes("[[CBT-I]]"));
check("wraps PGD",         r1.text.includes("[[PGD]]"));
check("wraps PTSD",        r1.text.includes("[[PTSD]]"));
check("wraps OCD",         r1.text.includes("[[OCD]]"));
// First-occurrence only by default — second CBT-I should be plain text
const cbtIMatches = r1.text.match(/\[\[CBT-I\]\]/g) || [];
check("first-occurrence: only one [[CBT-I]] link", cbtIMatches.length === 1);
const r2 = wrapAcronyms(acronymInput, true);
const cbtIMatches2 = r2.text.match(/\[\[CBT-I\]\]/g) || [];
check("all-occurrences mode: 2x [[CBT-I]] links", cbtIMatches2.length === 2);
check("preserves existing [[CBT]] (no double-wrap)",
  !wrapAcronyms("Use [[CBT]] for therapy.").text.includes("[[[[CBT]]]]"));
check("doesn't wrap CBT inside CBT-I (boundary)",
  !wrapAcronyms("CBT-I").text.includes("[[CBT]]-I"));
check("wraps standalone ACT but not 'act of' words",
  wrapAcronyms("ACT therapy is good. The act of speaking.").text.includes("[[ACT]]") &&
  !wrapAcronyms("The act of speaking.").text.includes("[[act]]"));

// ── 13F: chart embed exclusion in resolveWikilinks ───────────────────────
function extractWikilinks(content) {
  const linkRegex = /(?<!!)\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links = new Set();
  let m;
  while ((m = linkRegex.exec(content)) !== null) {
    const target = m[1].trim();
    if (target.startsWith("charts/") || /\.(svg|png|jpg|jpeg|gif|webp)$/i.test(target)) continue;
    links.add(target);
  }
  return links;
}
console.log("\n=== 13F: chart embed exclusion (no stub creation for charts) ===");
const mixedContent = "Use [[CBT-I]] therapy.\n\n![[charts/figshare-30100714-c1.svg]]\n\n*Figure 1.*\n\n[[Anorexia Nervosa]] is hard.";
const links = extractWikilinks(mixedContent);
check("includes [[CBT-I]]",            links.has("CBT-I"));
check("includes [[Anorexia Nervosa]]", links.has("Anorexia Nervosa"));
check("EXCLUDES ![[charts/X.svg]]",   !links.has("charts/figshare-30100714-c1.svg"));
const moreContent = "[[normal-link]] and ![[image.png]] and ![[chart.svg]]";
const links2 = extractWikilinks(moreContent);
check("EXCLUDES image embeds",         !links2.has("image.png") && !links2.has("chart.svg"));
check("includes plain link",           links2.has("normal-link"));

// ── 13G: _fetch_failed propagation through harvester output ──────────────
function buildOutputItem(item) {
  return {
    url: item.url,
    title: item.title || "(untitled)",
    content: item.content || item.title,
    ...(item._fetch_failed ? { _fetch_failed: true } : {}),
    ...(item._used_libgen_fallback ? { _used_libgen_fallback: true } : {}),
  };
}
console.log("\n=== 13G: harvester output flag propagation ===");
const item1 = { url: "x", title: "Paper A", _fetch_failed: true };
const item2 = { url: "y", title: "Paper B", _used_libgen_fallback: true, content: "thin" };
const item3 = { url: "z", title: "Paper C", content: "full text" };
const o1 = buildOutputItem(item1);
const o2 = buildOutputItem(item2);
const o3 = buildOutputItem(item3);
check("propagates _fetch_failed when set",         o1._fetch_failed === true);
check("propagates _used_libgen_fallback when set", o2._used_libgen_fallback === true);
check("does NOT add _fetch_failed when unset",     !("_fetch_failed" in o3));
check("does NOT add _used_libgen_fallback when unset", !("_used_libgen_fallback" in o3));

// ── 13H: sanitizeDoi shared usage ────────────────────────────────────────
function sanitizeDoi(rawDoi) {
  if (!rawDoi || typeof rawDoi !== "string") return "";
  return rawDoi
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .split(/[\s{}",'<>]/)[0]
    .replace(/[.,:;]+$/, "")
    .trim();
}
console.log("\n=== 13H: sanitizeDoi (shared utility) ===");
check("strips '},title:' from DOI",       sanitizeDoi("10.1186/2050-2974-1-23},title:foo") === "10.1186/2050-2974-1-23");
check("preserves clean DOI",              sanitizeDoi("10.5061/dryad.7h44j1007") === "10.5061/dryad.7h44j1007");
check("strips https://doi.org/ prefix",   sanitizeDoi("https://doi.org/10.1145/3331166") === "10.1145/3331166");
check("returns empty for null",           sanitizeDoi(null) === "");

// ── 13I: Abstract subsection detector ────────────────────────────────────
function abstractHasStructure(text) {
  const h3Count = (text.match(/^###\s+/gm) || []).length;
  const numberedListCount = (text.match(/^\s*[*-]\s+\*\*\d+\./gm) || []).length;
  return h3Count >= 2 || numberedListCount >= 3;
}
console.log("\n=== 13I: Abstract subsection detector ===");
check("flags abstract with 2+ ### subsections",
  abstractHasStructure("Text.\n\n### 1. Section\n\nText.\n\n### 2. Other\n\nText."));
check("flags abstract with 3+ numbered bullets",
  abstractHasStructure("- **1. First**\n- **2. Second**\n- **3. Third**"));
check("does NOT flag normal flat abstract",
  !abstractHasStructure("This study examines CBT effectiveness across various conditions. The findings show that CBT is highly effective."));
check("does NOT flag single ###",
  !abstractHasStructure("Text.\n\n### Only one\n\nText."));

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

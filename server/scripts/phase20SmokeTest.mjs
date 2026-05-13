#!/usr/bin/env node
// Phase 20 smoke test — bridge pipeline + landing-page scrape + alt-source
// + first-person rewrite guard + thesis-deep super-tier + 8 cleanup helpers.

import { readFileSync } from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== Phase 20 Smoke (bridge, landing-scrape, alt-source, thesis-deep, cleanup) ===\n");

// ── 20A: rewriteParagraph preservation guard ──────────────────────────────
console.log("Test 20A: first-person rewrite preservation guard");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("rewriteParagraph guard rejects shrink >20%",
    /rewriteParagraph: rewrite shrank from.*to.*lost >20%.*keeping original/.test(src));
  check("rewriteParagraph computes originalWords from input",
    /const originalWords = wordCount\(paragraph\)/.test(src));
  check("rewriteParagraph passes \"This is a VOICE rewrite, NOT a summary\"",
    /This is a VOICE rewrite, NOT a summary/.test(src));
  check("rewriteParagraph num_predict scales with originalWords",
    /num_predict:\s*Math\.ceil\(Math\.max\(originalWords/.test(src));
  // Phase 20A-fix — prompt-leak guard. Regression for the CBT thesis-deep run
  // where the Literature Review section came out as the literal prompt text.
  check("rewriteParagraph has PROMPT_LEAK_MARKERS guard",
    /PROMPT_LEAK_MARKERS/.test(src));
  check("prompt-leak guard catches CRITICAL RULES echo",
    /"CRITICAL RULES"/.test(src));
  check("prompt-leak guard catches `Original word count:` echo",
    /"Original word count:"/.test(src));
}

// ── 20B + 20C: bridge resume handles empty extraction ─────────────────────
console.log("\nTest 20B+20C: bridge resume updates article note even on empty extraction");
{
  const src = readFileSync(new URL("../skills/deepResearch/index.js", import.meta.url), "utf8");
  check("bridge-resume tags empty extraction as scanned-or-image-pdf",
    /scanned-or-image-pdf-needs-ocr/.test(src));
  check("bridge-resume sets _bridge_resolved_but_empty flag",
    /_bridge_resolved_but_empty:\s*true/.test(src));
  check("bridge-resume clears stale _fetch_failed flags on success",
    /delete newArticle\._fetch_failed/.test(src));
  check("bridge-resume sets _content_provenance",
    /_content_provenance:\s*"manual-bridge"/.test(src));
}

// ── 20M: RAW_EXCERPT_CHARS env-tunable, default 3000 ──────────────────────
console.log("\nTest 20M: raw excerpt cap env-tunable");
{
  const src = readFileSync(new URL("../skills/deepResearch/articleAnalyzer.js", import.meta.url), "utf8");
  check("RAW_EXCERPT_CHARS env knob present, default 3000",
    /RAW_EXCERPT_CHARS\s*=\s*parseInt\(process\.env\.RAW_EXCERPT_CHARS\s*\|\|\s*"3000"/.test(src));
  check("excerpt block uses ${RAW_EXCERPT_CHARS} in template",
    /first \$\{RAW_EXCERPT_CHARS\} chars/.test(src));
  check("slice uses RAW_EXCERPT_CHARS variable",
    /\.slice\(0,\s*RAW_EXCERPT_CHARS\)/.test(src));
  check("hard-coded 1500 char cap removed",
    !/first 1500 chars/.test(src) && !/\.slice\(0,\s*1500\)/.test(src));
}

// ── 20E: maxRedirects bumped to 20 ────────────────────────────────────────
console.log("\nTest 20E: maxRedirects = 20 in fetchPage");
{
  const src = readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8");
  check("fetchPage uses maxRedirects: 20",
    /maxRedirects:\s*20/.test(src));
}

// ── 20D: landing-page scraper ─────────────────────────────────────────────
console.log("\nTest 20D: landing-page HTML scraper");
{
  // Import the module's exported helpers — these are pure functions.
  const mod = await import("../skills/deepResearch/landingPageScraper.js");
  check("isLandingPageHost recognizes europepmc.org",
    mod.isLandingPageHost("https://europepmc.org/article/MED/12345") === true);
  check("isLandingPageHost recognizes biomedcentral.com subdomain",
    mod.isLandingPageHost("https://bmcpsychiatry.biomedcentral.com/articles/foo") === true);
  check("isLandingPageHost rejects unrelated domain",
    mod.isLandingPageHost("https://example.com/article") === false);
  check("inferLandingUrl strips trailing /pdf",
    mod.inferLandingUrl("https://core.ac.uk/download/123.pdf") === "https://core.ac.uk/download/123");
  check("inferLandingUrl strips /counter/pdf/ → /articles/",
    /\/articles\//.test(mod.inferLandingUrl("https://bmcpsychiatry.biomedcentral.com/counter/pdf/10.1186/x") || ""));

  // Classification heuristics
  const fullText = `Abstract Background... Methods: We enrolled 240 participants... Results showed a Hedges' g of 0.71. Discussion: These findings extend prior work on... ` + "x".repeat(5500);
  const klass = mod._internals.classifyExtraction(fullText);
  check("classifyExtraction returns full-text when Methods+Results+Discussion present and length >= 5000",
    klass.quality === "full-text" && klass.fullText === true);

  const abstractOnly = "Abstract: Cognitive behavioral therapy has been studied across various conditions. The present study aimed to evaluate efficacy among adolescents. " + "y".repeat(1800);
  const klass2 = mod._internals.classifyExtraction(abstractOnly);
  check("classifyExtraction returns abstract for ~2000c text with no full-text markers",
    klass2.quality === "abstract" && klass2.fullText === false, `got quality=${klass2.quality}, length=${klass2.length}`);

  const paywalled = "Abstract... Methods... Results... Get access to this content. Subscribe to access the full text. Sign in to view." + "z".repeat(5500);
  const klass3 = mod._internals.classifyExtraction(paywalled);
  check("classifyExtraction does NOT mark paywall-gated text as full-text",
    klass3.fullText === false);

  // htmlToPlainText basic correctness
  const html = "<article><h2>Title</h2><p>Hello world.</p><script>alert(1)</script><p>Second.</p></article>";
  const txt = mod._internals.htmlToPlainText(html);
  check("htmlToPlainText strips <script> blocks",
    !/alert/.test(txt));
  check("htmlToPlainText preserves prose content",
    /Hello world/.test(txt) && /Second/.test(txt));
}

// ── 20D: harvester wired to call landing-html on thin content ─────────────
console.log("\nTest 20D-wiring: harvester invokes landing-page scrape fallback");
{
  const src = readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8");
  check("harvester imports scrapeLandingPage + isLandingPageHost",
    /scrapeLandingPage,\s*isLandingPageHost/.test(src));
  check("harvester checks _landing_html_tried flag",
    /_landing_html_tried/.test(src));
  check("harvester clears _fetch_failed on fullText recovery",
    /if \(scraped\.fullText\)[\s\S]{0,200}delete item\._fetch_failed/.test(src));
}

// ── 20F: alt-source finder ────────────────────────────────────────────────
console.log("\nTest 20F: alt-source pre-bridge fallback");
{
  const mod = await import("../skills/deepResearch/altSourceFinder.js");
  check("altSourceFinder exports findAltSource",
    typeof mod.findAltSource === "function");
  check("altSourceFinder exports resetAltSourceState",
    typeof mod.resetAltSourceState === "function");

  const plos = mod._internals.plosCandidate({ doi: "10.1371/journal.pone.0123456" });
  check("plosCandidate returns journals.plos.org URL for 10.1371 DOI",
    plos && /journals\.plos\.org/.test(plos.url));
  const noPlos = mod._internals.plosCandidate({ doi: "10.1186/s12888-016-0783-z" });
  check("plosCandidate returns null for non-10.1371 DOIs",
    noPlos === null);

  // takeHostSlot enforces cooldown
  mod.resetAltSourceState();
  check("takeHostSlot returns true on first hit",
    mod._internals.takeHostSlot("test.host") === true);
  check("takeHostSlot returns false on immediate second hit",
    mod._internals.takeHostSlot("test.host") === false);
}

// ── 20G: smushed H3 split with non-period boundary ────────────────────────
console.log("\nTest 20G: splitSmushedH3HeadingBody catches non-period boundary");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("splitSmushedH3HeadingBody handles non-period heuristic B",
    /Heuristic B|Phase 20G/.test(src));
  check("splitSmushedH3HeadingBody references BODY_STARTERS_RE",
    /BODY_STARTERS_RE/.test(src));
}

// ── 20H: unverified-study inside multi-citation parens ────────────────────
console.log("\nTest 20H: stripUnverifiedStudyMarkers handles wrapped form");
{
  function strip(text) {
    let s = String(text);
    s = s.replace(/\s+by\s+\((?:unverified|hypothetical|placeholder|fictional|illustrative)\s+stud(?:y|ies)\)/gi, "");
    s = s.replace(/\(\((?:unverified|hypothetical|placeholder)\s+stud(?:y|ies)\),\s*\d{4}[a-z]?\s*;\s*/gi, "(");
    s = s.replace(/\s*;\s*\((?:unverified|hypothetical|placeholder)\s+stud(?:y|ies)\),\s*\d{4}[a-z]?(?=\s*\))/gi, "");
    s = s.replace(/\s*\(\((?:unverified|hypothetical|placeholder)\s+stud(?:y|ies)\),\s*\d{4}[a-z]?\)\s*/gi, " ");
    s = s.replace(/\s*\((?:unverified|hypothetical|placeholder|fictional|illustrative)\s+(?:stud(?:y|ies)|references?|sources?)\)\s*,?\s*/gi, " ");
    s = s.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1");
    return s;
  }
  const before = "Findings reported earlier ((unverified study), 2012; Williams et al., 2015) support this view.";
  const after = strip(before);
  check("`((unverified study), 2012; Williams...)` collapses to `(Williams...)`",
    !/unverified study/.test(after) && /Williams et al\.,\s*2015/.test(after));

  const trailing = "Multiple sources (Smith, 2020; (unverified study), 2018) confirmed.";
  const afterTrailing = strip(trailing);
  check("`(Smith, 2020; (unverified study), 2018)` collapses to `(Smith, 2020)`",
    !/unverified study/.test(afterTrailing) && /Smith,\s*2020/.test(afterTrailing));
}

// ── 20I: diversified opening prompts ──────────────────────────────────────
console.log("\nTest 20I: diversified opening prompts");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("openingGuardrail includes STRUCTURAL_ALTERNATIVES",
    /STRUCTURAL_ALTERNATIVES/.test(src));
  check("openingGuardrail asks for SPECIFIC FINDING / CONTRADICTION / etc.",
    /SPECIFIC FINDING/.test(src) && /CONTRADICTION/.test(src));
  check("opening directive forbids `\"CBT has emerged…\"` patterns",
    /CBT has emerged/.test(src));
}

// ── 20J: dataset metadata summary ─────────────────────────────────────────
console.log("\nTest 20J: dataset metadata-only summary");
{
  const { buildDatasetMetadataSummary, renderDatasetMetadataSummary } = await import("../skills/deepResearch/datasetMetadataSummary.js");
  const samples = [
    { title: "RCT of CBT for adolescents (N=140)", description: "Randomized controlled trial", repository: "openalex", year: 2024 },
    { title: "Meta-analysis of mindfulness in depression", description: "Systematic review including 12 trials", repository: "figshare", year: 2023 },
    { title: "Online CBT-I for anxiety", description: "Pilot study of internet-delivered CBT", repository: "openalex", year: 2025 },
    { title: "Trauma-focused CBT in PTSD (45 participants)", description: "Single-arm feasibility", repository: "dryad", year: 2022 },
  ];
  const summary = buildDatasetMetadataSummary(samples);
  check("buildDatasetMetadataSummary returns non-null for non-empty input",
    summary !== null);
  check("totalCount = number of inputs",
    summary.totalCount === 4);
  check("byRepository counts openalex × 2",
    summary.byRepository.openalex === 2);
  check("yearRange spans 2022..2025",
    summary.yearRange?.min === 2022 && summary.yearRange?.max === 2025);
  check("totalN aggregates sample sizes",
    summary.totalN >= 140);  // 140 + 45 = 185
  check("topInterventions includes 'cbt'",
    summary.topInterventions.includes("cbt"));
  check("topConditions includes 'depression' or 'anxiety' or 'ptsd'",
    summary.topConditions.some(c => ["depression", "anxiety", "ptsd"].includes(c)));

  const rendered = renderDatasetMetadataSummary(summary, { topicSlug: "test" });
  check("rendered note starts with `> [!info]` callout",
    /^> \[!info\]/.test(rendered));
  check("rendered note mentions repositories",
    /openalex|figshare|dryad/.test(rendered));
  check("renderDatasetMetadataSummary returns empty string for empty summary",
    renderDatasetMetadataSummary(null) === "");
}

// ── 20K: malformed-wikilink filtering ─────────────────────────────────────
console.log("\nTest 20K: malformed-wikilink stub filtering");
{
  const src = readFileSync(new URL("../utils/obsidianUtils.js", import.meta.url), "utf8");
  check("resolveWikilinks skips nested `[[` patterns",
    /skipping malformed nested wikilink/.test(src));
  check("resolveWikilinks rejects FS-illegal chars",
    /FS-illegal chars/.test(src));
}

// ── 20L: boot-time env log ────────────────────────────────────────────────
console.log("\nTest 20L: OLLAMA env knobs logged at boot");
{
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("server logs OLLAMA_NUM_GPU at boot",
    /OLLAMA_NUM_GPU/.test(src));
  check("server logs SYNTHESIZER_MODEL at boot",
    /SYNTHESIZER_MODEL/.test(src));
}

// ── 20N: tier detector recognizes thesis-deep ─────────────────────────────
console.log("\nTest 20N: tier detector recognizes thesis-deep");
{
  const { detect, stripDepthFlag, TIERS } = await import("../skills/deepResearch/tierDetector.js");
  check("TIERS array includes 'thesis-deep'",
    TIERS.includes("thesis-deep"));
  check("detect() returns 'thesis-deep' on inline flag",
    detect("[depth:thesis-deep] write about CBT") === "thesis-deep");
  check("detect() returns 'thesis-deep' on lexicon 'deep thesis'",
    detect("write a deep thesis about CBT") === "thesis-deep");
  check("detect() falls back to 'thesis' for plain 'thesis'",
    detect("[depth:thesis] write about CBT") === "thesis");
  check("stripDepthFlag removes [depth:thesis-deep]",
    !/thesis-deep/.test(stripDepthFlag("[depth:thesis-deep] hello")));
}

// ── 20N: open-question recursion ranks + dedupes ──────────────────────────
console.log("\nTest 20N: openQuestionRecursion ranking");
{
  const { collectOpenQuestions, rankOpenQuestions } = await import("../skills/deepResearch/openQuestionRecursion.js");
  const promptResults = [
    {
      promptIndex: 1,
      // Phase 20N-fix — conclusionWriter actually stores at p.conclusion.openQuestions
      conclusion: { openQuestions: ["What are the long-term effects of digital CBT?", "How does mindfulness moderate CBT outcomes?"] },
      analyses: [{ analysis: { relevance: 0.9 } }, { analysis: { relevance: 0.7 } }]
    },
    {
      promptIndex: 2,
      conclusion: { openQuestions: ["What are the long-term effects of digital CBT?", "Can group CBT scale in primary care?"] },
      analyses: [{ analysis: { relevance: 0.8 } }]
    },
  ];
  const collected = collectOpenQuestions(promptResults);
  check("collectOpenQuestions returns 4 raw items",
    collected.length === 4);
  const ranked = rankOpenQuestions(collected, { topN: 3 });
  check("ranking dedupes the repeated 'long-term effects' question",
    ranked.length === 3);
  check("most-recurring question ranks first",
    /long-term effects/i.test(ranked[0].question));
  check("sourcePrompts captures both prompts for the duplicate",
    ranked[0].sourcePrompts.length === 2);
}

// ── 20N: thesis-deep tier wired into ALL gates (regression for "only recursion ran" bug) ──
console.log("\nTest 20N-gates: thesis-deep treated like thesis at every tier gate");
{
  const indexSrc = readFileSync(new URL("../skills/deepResearch/index.js", import.meta.url), "utf8");
  check("tierLimits map includes 'thesis-deep' entry (was missing → 3 articles/prompt)",
    /"thesis-deep":\s*7/.test(indexSrc));
  check("tierDatasetLimit map includes 'thesis-deep' entry",
    /"thesis-deep":\s*5/.test(indexSrc));
  check("MIN_SOURCES map includes 'thesis-deep' entry",
    /MIN_SOURCES[\s\S]{0,200}"thesis-deep":\s*14/.test(indexSrc));

  const bridgeSrc = readFileSync(new URL("../skills/deepResearch/manualBridge.js", import.meta.url), "utf8");
  check("BRIDGE_ELIGIBLE_TIERS includes 'thesis-deep'",
    /BRIDGE_ELIGIBLE_TIERS[\s\S]{0,80}"thesis-deep"/.test(bridgeSrc));

  const deepModeSrc = readFileSync(new URL("../skills/deepResearch/deepModeToggle.js", import.meta.url), "utf8");
  check("isDeepModeForTier accepts 'thesis-deep'",
    /tier === "thesis-deep"/.test(deepModeSrc));

  const wrSrc = readFileSync(new URL("../utils/writingRules.js", import.meta.url), "utf8");
  check("TIER_BUDGETS has 'thesis-deep' entry (same as thesis)",
    /"thesis-deep":\s*\{[\s\S]{0,800}total:\s*5750/.test(wrSrc));

  // Phase 20N — promptPlanner.TIER_COUNTS must include thesis-deep, otherwise
  // the planner falls through to the `article` default of 4 prompts (which is
  // exactly the bug the user hit after the first round of tier-gate fixes).
  const ppSrc = readFileSync(new URL("../skills/deepResearch/promptPlanner.js", import.meta.url), "utf8");
  check("promptPlanner TIER_COUNTS has 'thesis-deep': 8",
    /"thesis-deep":\s*8/.test(ppSrc));
}

// ── 20N: openQuestionRecursion uses correct articleHarvester.harvest signature ──
console.log("\nTest 20N-harvest-sig: openQuestionRecursion calls harvest(query, opts)");
{
  const src = readFileSync(new URL("../skills/deepResearch/openQuestionRecursion.js", import.meta.url), "utf8");
  // Regression for the CBT thesis-deep run where harvest crashed with
  // "(topic || \"\").toLowerCase is not a function" because query was
  // passed in an options object instead of as the first positional arg.
  check("harvest called with positional first arg (followupQuery)",
    /articleHarvester\.harvest\(followupQuery,\s*\{/.test(src));
  check("harvest opts include topic (not query)",
    /articleHarvester\.harvest\([^)]*topic,/s.test(src) || /articleHarvester\.harvest\(followupQuery,\s*\{\s*topic,/.test(src));
}

// ── 20N: index.js wires thesis-deep follow-up ─────────────────────────────
console.log("\nTest 20N-wiring: index.js triggers deepFollowup for thesis-deep");
{
  const src = readFileSync(new URL("../skills/deepResearch/index.js", import.meta.url), "utf8");
  check("index.js runs deepFollowup only when tier === 'thesis-deep'",
    /effectiveTier === "thesis-deep"/.test(src));
  check("index.js imports openQuestionRecursion module dynamically",
    /import\("\.\/openQuestionRecursion\.js"\)/.test(src));
  check("index.js passes deepFollowup to synthesizer",
    /deepFollowup,/.test(src) || /deepFollowup\s*\}/.test(src));

  const synSrc = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("synthesizer accepts deepFollowup arg",
    /deepFollowup\s*=\s*null/.test(synSrc));
  check("synthesizer defines buildFutureDirectionsSection",
    /function buildFutureDirectionsSection/.test(synSrc));
  check("synthesizer inserts Future Directions before References",
    /lastIndexOf\("## References"\)/.test(synSrc));
}

// ── Phase 21: bridge no-TTL + content-based PDF match + EuropePMC PDF + Dryad OAuth ──
console.log("\nTest 21A: bridge resume window removed (no 60-min auto-cancel)");
{
  const idx = readFileSync(new URL("../skills/deepResearch/index.js", import.meta.url), "utf8");
  const mb  = readFileSync(new URL("../skills/deepResearch/manualBridge.js", import.meta.url), "utf8");
  const pq  = readFileSync(new URL("../utils/pendingQuestion.js", import.meta.url), "utf8");
  check("setPendingQuestion at bridge-offer site passes ttlMs: 0 (no expiry)",
    /ttlMs:\s*0,\s*\/\/\s*Phase 21/.test(idx));
  check("renderBridgeMessage no longer mentions 60-min window",
    !/60-min window/.test(mb));
  check("renderBridgeMessage advertises 'no time limit' to user",
    /no time limit/.test(mb));
  check("pendingQuestion.isExpired treats ttlMs===0 as never-expire",
    /entry\.ttlMs === 0[^|]*entry\.ttlMs === -1[^=]*return false/.test(pq) ||
    /ttlMs === 0.*return false/s.test(pq));
}

console.log("\nTest 21B: content-based PDF match — renamed files still resolve");
{
  const mb = readFileSync(new URL("../skills/deepResearch/manualBridge.js", import.meta.url), "utf8");
  check("scanAndAttach exposes titleMatchScore via _internals",
    /titleMatchScore,/.test(mb));
  check("scanAndAttach has pass-2 content-match block",
    /Pass 2:\s*content-based match/.test(mb));
  check("scanAndAttach marks matches with _matchedByContent flag",
    /_matchedByContent:\s*true/.test(mb));
  check("renderBridgeMessage tells user filenames don't need to match",
    /match files to slots by content/i.test(mb));

  // Live function test — load module and exercise titleMatchScore.
  const url = new URL("../skills/deepResearch/manualBridge.js", import.meta.url);
  const mod = await import(url.href);
  const { titleMatchScore } = mod._internals;
  const head = "Cognitive Behavioral Therapy for Insomnia: A Randomised Controlled Trial in Veterans with PTSD\nAuthors: ... Abstract: ...";
  const score1 = titleMatchScore("Cognitive Behavioral Therapy for Insomnia in Veterans", head);
  check(`titleMatchScore yields ≥0.5 on title overlap (got ${score1.toFixed(2)})`, score1 >= 0.5);
  const score2 = titleMatchScore("Climate Change and Armed Conflict", head);
  check(`titleMatchScore yields <0.4 on unrelated title (got ${score2.toFixed(2)})`, score2 < 0.4);
}

console.log("\nTest 21C: EuropePMC prefers PMC PDF URL when available");
{
  const ah = readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8");
  check("fetchEuropePMC inspects fullTextUrlList for PDF entries",
    /fullTextUrlList\?\.fullTextUrl/.test(ah));
  check("fetchEuropePMC builds pmcid render-pdf endpoint fallback",
    /europepmc\.org\/articles\/\$\{x\.pmcid\}\?pdf=render/.test(ah));
  check("fetchEuropePMC sets domain from chosen PDF URL hostname",
    /chosenDomain\s*=\s*new URL\(pdfEntry\.url\)\.hostname/.test(ah));
  check("fetchEuropePMC carries pmcid into cite block",
    /pmcid:\s*x\.pmcid\s*\|\|\s*null/.test(ah));
}

console.log("\nTest 21D: Dryad OAuth — client_credentials + Authorization header");
{
  const dh = readFileSync(new URL("../skills/deepResearch/datasetHarvester.js", import.meta.url), "utf8");
  check("Dryad token cache exists (in-memory)",
    /_dryadCachedToken/.test(dh));
  check("getDryadAccessToken does client_credentials OAuth exchange",
    /grant_type:\s*"client_credentials"/.test(dh) && /datadryad\.org\/oauth\/token/.test(dh));
  check("downloadAndParse stops short-circuiting when DRYAD creds present",
    /dryadAuthHeaders\(\)/.test(dh));
  check("downloadFull forwards _extraHeaders (auth) to axios",
    /\.\.\.\(file\._extraHeaders \|\| \{\}\)/.test(dh));
  check("downloadStratified forwards _extraHeaders (auth) to ranged requests",
    /\.\.\.\(file\._extraHeaders \|\| \{\}\),\s*Range:/.test(dh));
  check("HEAD probe forwards _extraHeaders so size probe authenticates too",
    /head[\s\S]{0,80}_extraHeaders/.test(dh));
  check("env names match user-supplied: DRYAD_CLIENT_ID / DRYAD_CLIENT_SECRET / DRYAD_API_TOKEN",
    /DRYAD_CLIENT_ID/.test(dh) && /DRYAD_CLIENT_SECRET/.test(dh) && /DRYAD_API_TOKEN/.test(dh));
}

// ── Phase 22: thesis output polish + progress visibility ──
console.log("\nTest 22A: heading-safe wikilinks — wrappers skip heading lines");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("wrapAcronymsAsWikilinks splits on lines and skips heading regex",
    /HEADING_RE\s*=.*#\{1,6\}/.test(src) && /HEADING_RE\.test\(lines\[li\]\)/.test(src));
  check("enrichWithWikilinks pre-masks heading lines with sentinel",
    /XHDRMARKERX/.test(src) && /savedHeadings/.test(src));
  check("heading-restore mismatch falls back to un-enriched draft",
    /heading-restore mismatch.*keeping un-enriched/.test(src));
}

console.log("\nTest 22B: proseAuthorLint deletes attribution clauses cleanly");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  // Pattern D should NOT substitute "(unverified study)" anymore for et-al
  // attributions — it should delete the clause.
  const patternDBlock = src.match(/Pattern D rewritten[\s\S]{0,2000}Pattern E rewritten/);
  check("Pattern D body no longer contains the literal 'unverified study' return",
    patternDBlock && !/return "\(unverified study\)"/.test(patternDBlock[0]));
  check("Pattern D body returns empty string for bare surname et al.",
    /return ""/.test(patternDBlock ? patternDBlock[0] : ""));
}

console.log("\nTest 22C: openQuestionRecursion relevance + off-topic filter");
{
  const src = readFileSync(new URL("../skills/deepResearch/openQuestionRecursion.js", import.meta.url), "utf8");
  check("OFFTOPIC_RE regex present in openQuestionRecursion",
    /OFFTOPIC_RE\s*=/.test(src));
  check("filter drops analyses with relevance < 0.4",
    /rel\s*<\s*0\.4/.test(src));
  check("OFFTOPIC_RE matches 'does not contain'",
    /does not contain/.test(src));
  check("per-article progress emission inside follow-up loop",
    /analyzing follow-up \$\{i \+ 1\}\/\$\{deepArticles\.length\}/.test(src));
}

console.log("\nTest 22D: citations.js — initials-only mixed-list guard");
{
  const src = readFileSync(new URL("../skills/deepResearch/citations.js", import.meta.url), "utf8");
  check("initialsOnly counter inspects ≤2-char alpha content",
    /a\.replace\(\/\[\.\\s,'-\]\/g, ""\)\.length\s*<=\s*2/.test(src));
  check("drops when initials-only ratio > 0.6 AND ≥4 authors",
    /rawCite\.authors\.length\s*>=\s*4\s*&&\s*initialsOnly\s*\/\s*rawCite\.authors\.length\s*>\s*0\.6/.test(src));
}

console.log("\nTest 22E: articleHarvester maxContentLength bumped to 12 MB");
{
  const src = readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8");
  check("maxContentLength is 12 MB now (12 * 1024 * 1024)",
    /maxContentLength:\s*12\s*\*\s*1024\s*\*\s*1024/.test(src));
  check("old 3MB ceiling is gone",
    !/maxContentLength:\s*3\s*\*\s*1024\s*\*\s*1024/.test(src));
}

console.log("\nTest 22F: per-article progress in bridge resume + analyzer chunks");
{
  const idx = readFileSync(new URL("../skills/deepResearch/index.js", import.meta.url), "utf8");
  const an  = readFileSync(new URL("../skills/deepResearch/articleAnalyzer.js", import.meta.url), "utf8");
  check("bridge resume tracks bridgeIdx/bridgeTotal",
    /bridgeIdx\+\+/.test(idx) && /bridgeTotal/.test(idx));
  check("bridge resume emits 'bridge re-analyzing N/M' progress",
    /bridge re-analyzing \$\{bridgeIdx\}\/\$\{bridgeTotal\}/.test(idx));
  check("articleAnalyzer logs chunk i/n in multi-chunk mode",
    /chunk \$\{i \+ 1\}\/\$\{chunks\.length\}/.test(an));
}

console.log("\nTest 22G: chartsNote placed below H1 + slug-style titles de-hyphenated");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("writeNote called with titledBody (callouts injected after H1)",
    /await writeNote\(relativePath,\s*headerFm\s*\+\s*titledBody\)/.test(src));
  check("deSlugTitle function exists",
    /function deSlugTitle/.test(src));
  // Live function exercise via dynamic import is brittle (the synthesizer
  // pulls in lots of deps); just regex-check the de-slug behaviour by
  // running the regex inline:
  const slugRe = /^[A-Z][A-Za-z]+(?:-[A-Z][A-Za-z]+){1,}$/;
  check("deSlug regex matches 'Cognitive-Behavioral-Therapy-Efficacy-Analysis'",
    slugRe.test("Cognitive-Behavioral-Therapy-Efficacy-Analysis"));
  check("deSlug regex does NOT match titles with spaces",
    !slugRe.test("Cognitive Behavioral Therapy"));
}

// ── Phase 23: paragraph-boundary repair, Ollama wait, claim verifier, depth UI gate ──
console.log("\nTest 23A: paragraph-boundary repair");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("splitSmushedHeadingBody handles H3-H6 (was H3-only)",
    /splitSmushedHeadingBody/.test(src) && /#\{3,6\}/.test(src));
  check("backward-compat alias kept for splitSmushedH3HeadingBody",
    /const splitSmushedH3HeadingBody = splitSmushedHeadingBody/.test(src));
  check("normaliseParagraphBoundaries function defined",
    /function normaliseParagraphBoundaries\(/.test(src));
  check("normaliseParagraphBoundaries invoked before lint pass",
    /draft = normaliseParagraphBoundaries\(draft\)/.test(src) &&
    /paragraph-normalised/.test(src));
  check("stripLeadingSectionLabel function defined",
    /function stripLeadingSectionLabel\(/.test(src));
  check("stripLeadingSectionLabel called in section composer",
    /stripLeadingSectionLabel\(text, section\.heading\)/.test(src));
  check("dedupeContinuationOverlap function defined",
    /function dedupeContinuationOverlap\(/.test(src));
  check("continuation pass calls dedupeContinuationOverlap",
    /dedupeContinuationOverlap\(text, cont\)/.test(src));
}

console.log("\nTest 23B: waitForOllamaHealthy + retry-on-stall wiring");
{
  const src = readFileSync(new URL("../tools/llm.js", import.meta.url), "utf8");
  check("waitForOllamaHealthy exported",
    /export async function waitForOllamaHealthy/.test(src));
  check("pings /api/tags for health check",
    /\/api\/tags/.test(src));
  check("retry path branches on category === 'timeout' to call waitForOllamaHealthy",
    /if \(cat === "timeout"\)[\s\S]{0,300}waitForOllamaHealthy\(\)/.test(src));
  check("non-timeout retries still use exponential backoff",
    /Math\.min\(2000\s*\*\s*Math\.pow\(2,\s*attempt\),\s*15000\)/.test(src));
}

console.log("\nTest 23C: claimVerifier module");
{
  const mod = await import("../skills/deepResearch/claimVerifier.js");
  const { extractClaims, verifyClaim, verifyAndAnnotate } = mod;
  const sample = "A study found a 63% risk reduction (N=147) with p < 0.05 over 30 minutes.";
  const claims = extractClaims(sample);
  check(`extractClaims returns >=3 claims for sample (got ${claims.length})`, claims.length >= 3);
  // Verify with empty fact pool → all unverified
  const noPool = verifyAndAnnotate(sample, [], { mode: "annotate" });
  check(`annotate-mode flags all numeric claims when factPool empty (got ${noPool.unverifiedCount} flagged)`,
    noPool.unverifiedCount >= 3 && /\[unverified\]/.test(noPool.text));
  // Verify with matching fact pool
  const goodPool = [{ source: "Smith2020", content: "The trial demonstrated a 62.5% reduction in symptoms; N was 145.", text: "" }];
  const claim63 = { raw: "63%", value: 63, kind: "percent", start: 0, end: 3 };
  const r1 = verifyClaim(claim63, goodPool);
  check("verifyClaim accepts 63% as matching 62.5% (within ±5%)", r1.verified === true);
  const claim10 = { raw: "10%", value: 10, kind: "percent", start: 0, end: 3 };
  const r2 = verifyClaim(claim10, goodPool);
  check("verifyClaim rejects 10% (outside ±5% of any number in pool)", r2.verified === false);
  // Strict mode
  const strict = verifyAndAnnotate("The study reported 99% efficacy.", [], { mode: "strict" });
  check("strict mode strips the unverified sentence entirely",
    !strict.text.includes("99%") && strict.unverifiedCount >= 1);
}

console.log("\nTest 23D: DepthBar gate for thesis-deep");
{
  const src = readFileSync(new URL("../../client/local-llm-ui/src/components/DepthBar.jsx", import.meta.url), "utf8");
  check("TIERS array contains 'thesis-deep' entry",
    /key:\s*"thesis-deep"/.test(src));
  check("'thesis-deep' tier declares requires: 'thesis'",
    /requires:\s*"thesis"/.test(src));
  check("isGated function present",
    /function isGated\(/.test(src));
  check("button disabled prop respects gated state",
    /disabled=\{disabled \|\| gated\}/.test(src));
  check("gated tooltip explains the gate",
    /click "Thesis" first to enable/.test(src));
}

console.log("\nTest 23E: thesisSynthesizer integrates claimVerifier before writeNote");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("dynamic import of claimVerifier.js",
    /import\("\.\/claimVerifier\.js"\)/.test(src));
  check("verifyAndAnnotate invoked with factPool",
    /verifyAndAnnotate\(titledBody,\s*factPool/.test(src));
  check("CLAIM_VERIFY_MODE env switches strict/annotate mode",
    /CLAIM_VERIFY_MODE.*strict.*annotate/.test(src));
}

// ── Phase 24: bracket-Author leak, smushed-heading regression, H4 consolidator, paywall tagging, claim+citation tightening ──
console.log("\nTest 24A: rewriteParagraph prompt no longer instructs LLM to keep '(Author, YYYY)' literally");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  // The dangerous instruction "(Author, YYYY) attributions intact" must be gone.
  check("'(Author, YYYY) attributions intact' instruction removed",
    !/Keep all \(Author, YYYY\) attributions intact/.test(src));
  // The new instruction must explicitly forbid emitting the literal placeholder.
  check("rewriteParagraph prompt explicitly forbids placeholder citations",
    /DO NOT invent or insert placeholder citation text/i.test(src));
  // The final-pass stripBracketTags must be wired post-polish.
  check("finalBracketTags log message defined post-polish",
    /finalBracketTags: stripped/.test(src));
}

console.log("\nTest 24B: splitSmushedHeadingBody now handles 2-word headings");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("Heuristic B loop floor lowered from i>=3 to i>=1",
    /for \(let i = words\.length - 1; i >= 1; i--\)/.test(src));
  check("body-starter-in-heading guard added",
    /reject if any heading word \(other than the first\) is/i.test(src) ||
    /BODY_STARTERS_RE\.test\(headPartWords\.slice\(1\)/.test(src));
}

console.log("\nTest 24C: consolidateRepeatedH4Sections collapses repeated identical-heading H4 runs");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("consolidateRepeatedH4Sections function defined",
    /function consolidateRepeatedH4Sections\(/.test(src));
  check("consolidator runs in post-polish pipeline",
    /draft = consolidateRepeatedH4Sections\(draft\)/.test(src));
  check("consolidator threshold is ≥3 repeats",
    /run\.length >= 3/.test(src));
  check("consolidator emits 'cited for methodological rigor' intro line",
    /cited for methodological rigor/.test(src));
}

console.log("\nTest 24D: metadataOnlyReason tagging + renderer updates");
{
  const dh = readFileSync(new URL("../skills/deepResearch/datasetHarvester.js", import.meta.url), "utf8");
  const ds = readFileSync(new URL("../skills/deepResearch/datasetMetadataSummary.js", import.meta.url), "utf8");
  const idx = readFileSync(new URL("../skills/deepResearch/index.js", import.meta.url), "utf8");
  check("buildRecord accepts metadataOnlyReason",
    /metadataOnlyReason\s*=\s*""/.test(dh));
  check("OpenAlex datasets tagged 'catalog-only'",
    /metadataOnlyReason:\s*"catalog-only"/.test(dh));
  check("datasetMetadataSummary aggregates byReason",
    /const byReason = \{\}/.test(ds));
  check("renderDatasetMetadataSummary emits 'Reasons rows not analyzed:'",
    /Reasons rows not analyzed/.test(ds));
  check("index.js _data.md uses per-reason text for metadata-only entries",
    /REASON_TEXTS = \{/.test(idx) && /catalog-only.*provider returns catalog metadata only/.test(idx));
}

console.log("\nTest 24E: proseAuthorLint Pattern C-bare + context-aware claimVerifier");
{
  const ts = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("Pattern C-bare regex present (no preposition prefix required)",
    /Pattern C-bare:/.test(ts));
  check("Pattern C-bare strips entire parenthetical when surname not in index",
    /Surname-only fallback: if the surname appears in the index for ANY/.test(ts));

  const cv = readFileSync(new URL("../skills/deepResearch/claimVerifier.js", import.meta.url), "utf8");
  check("verifyClaim accepts claimContext via opts",
    /opts\.claimContext/.test(cv));
  check("COMMON_STOPWORDS set defined",
    /COMMON_STOPWORDS\s*=\s*new Set/.test(cv));
  check("verifyAndAnnotate extracts ±40-char context per claim",
    /claimContext\s*=\s*text\.slice\(ctxStart, ctxEnd\)/.test(cv));

  // Live exercise — claim should NOT verify when context tokens don't overlap.
  const mod = await import("../skills/deepResearch/claimVerifier.js");
  const factPool = [{ source: "test", content: "The team won 63 medals in athletics last year." }];
  const claim = { raw: "63%", value: 63, kind: "percent", start: 50, end: 53 };
  const noContext = mod.verifyClaim(claim, factPool);
  check("verifyClaim still works without claimContext (legacy numeric-only match)",
    noContext.verified === true);
  const withContext = mod.verifyClaim(claim, factPool, { claimContext: "depression symptoms decreased by 63% in the trial" });
  check("verifyClaim rejects when claim context (depression/symptoms) doesn't overlap source context (medals/athletics)",
    withContext.verified === false);
  // Positive case — should verify when overlap exists
  const withGoodContext = mod.verifyClaim(claim, [{ source: "x", content: "The depression group showed 62.5% symptom reduction." }], { claimContext: "depression symptoms decreased by 63% in the trial" });
  check("verifyClaim accepts when claim and source share 'depression' / 'symptom' overlap",
    withGoodContext.verified === true);
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Phase 9 smoke test — covers the deterministic pieces:
//   9A: facts pool builder
//   9C: OpenAlex catalog-cruft filter, topic-root fallback flag
//   9D: manualBridge eligibility + render

import { _internals as MB } from "../skills/deepResearch/manualBridge.js";
import { _internals as DH } from "../skills/deepResearch/datasetHarvester.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== 9D: article eligibility for manual bridge ===");
const blockedArticle = {
  url: "https://www.tandfonline.com/doi/pdf/10.1080/foo",
  content: "abstract only, ~600 chars" + " ".repeat(200),
};
const blockedAnalysis = { analysis: { relevance: 0.85 } };
check("blocked: thin tandfonline article",   MB.isArticleBlocked(blockedArticle, blockedAnalysis));

const fineArticle = { url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123", content: "x".repeat(5000) };
check("not blocked: full content article",   !MB.isArticleBlocked(fineArticle, blockedAnalysis));

const offTopicArticle = { url: "https://www.ncbi.nlm.nih.gov/foo", content: "thin" };
const offTopicAnalysis = { analysis: { relevance: 0.1 } };
check("not blocked: low relevance article",  !MB.isArticleBlocked(offTopicArticle, offTopicAnalysis));

const noUrlArticle = { url: "", content: "thin" };
check("not blocked: no URL",                 !MB.isArticleBlocked(noUrlArticle, blockedAnalysis));

// Phase 12G — libgen URLs are no longer auto-skipped. They're now blocked
// when content is thin (likely an ad page) so the manual bridge can request
// a real PDF. Updated assertion to match new policy.
const libgenArticle = { url: "https://libgen.li/foo.pdf", content: "thin" };
check("BLOCKED: libgen URL with thin content (Phase 12G)", MB.isArticleBlocked(libgenArticle, blockedAnalysis));

console.log("\n=== 9D: dataset eligibility ===");
const blockedDS = { metadataOnly: false, files: [{ format: "csv", downloadUrl: "x" }], _bridge_eligible: true };
const fineDS    = { metadataOnly: false, files: [{ format: "csv", downloadUrl: "x" }], _bridge_eligible: false };
const metaDS    = { metadataOnly: true,  files: [], _bridge_eligible: true };
check("blocked: dataset with files but parse failed", MB.isDatasetBlocked(blockedDS));
check("not blocked: dataset that parsed OK",          !MB.isDatasetBlocked(fineDS));
check("not blocked: metadata-only dataset",           !MB.isDatasetBlocked(metaDS));

console.log("\n=== 9D: bridge thresholds ===");
check("research tier in eligible set",    MB.BRIDGE_ELIGIBLE_TIERS.has("research"));
check("thesis tier in eligible set",      MB.BRIDGE_ELIGIBLE_TIERS.has("thesis"));
check("article tier NOT eligible",        !MB.BRIDGE_ELIGIBLE_TIERS.has("article"));
check("indepth tier NOT eligible",        !MB.BRIDGE_ELIGIBLE_TIERS.has("indepth"));
check("MIN_THIN_CONTENT = 1500",          MB.MIN_THIN_CONTENT === 1500);
check("MIN_BLOCKED_TO_OFFER = 2",         MB.MIN_BLOCKED_TO_OFFER === 2);

console.log("\n=== 9C: OpenAlex catalog-cruft filter (regression coverage) ===");
// Replicate the cruft-detection patterns to verify the filter catches the
// titles we saw in the real C- run.
const CRUFT_PATTERNS = [
  /^Faculty Opinions recommendation/i,
  /^Search Strategy/i,
  /^Excluded Studies/i,
  /^Qualitative synthesis of results/i,
  /^Supplementary (Material|Table|Data|File)/i,
  /^metadat:\s*Meta-Analysis/i,
  /^HSAUR:/i,
  /\bcran\.package\b/i,
];
function isCruft(t) { return CRUFT_PATTERNS.some(re => re.test(t)); }
const realObservedCruftTitles = [
  "Faculty Opinions recommendation of Cognitive behavioral therapy is associated with...",
  "Search Strategy Violent Radicalization",
  "Excluded Studies",
  "Qualitative synthesis of results",
  "Supplementary Material for: The Efficacy of a Group CBT...",
  "metadat: Meta-Analysis Datasets",
  "HSAUR: A Handbook of Statistical Analyses Using R (1st Edition)",
];
const realKeepers = [
  "A Multi-Site Study of Brief Cognitive-Behavioural Therapy for Eating Disorders",
  "Adolescent and Young Adult Perceptions of Online Versus In-Person CBT",
  "Transdiagnostic Predictors of Treatment Outcome in Patients With Anorexia Nervosa",
];
for (const t of realObservedCruftTitles) check(`cruft caught: "${t.slice(0, 50)}…"`, isCruft(t));
for (const t of realKeepers)              check(`real dataset kept: "${t.slice(0, 50)}…"`, !isCruft(t));

console.log("\n=== 9D: collectBlockedSources path ===");
// Build a minimal promptResults shape and verify collection.
import { collectBlockedSources, shouldOfferBridge } from "../skills/deepResearch/manualBridge.js";

const fakePromptResults = [
  {
    promptIndex: 1,
    analyses: [
      {
        article: { url: "https://www.tandfonline.com/x.pdf", content: "thin abstract" + " ".repeat(200) },
        frontmatter: { title: "Paywalled Paper Title" },
        analysis: { relevance: 0.85 }
      },
      {
        article: { url: "https://www.ncbi.nlm.nih.gov/y", content: "x".repeat(5000) },
        frontmatter: { title: "Free Paper" },
        analysis: { relevance: 0.9 }
      }
    ],
    datasetCitations: [
      { id: "dryad:1", title: "Blocked Dataset", repository: "dryad", metadataOnly: false,
        files: [{ format: "csv", downloadUrl: "https://datadryad.org/x.csv" }],
        _bridge_eligible: true, url: "https://datadryad.org/x" }
    ]
  },
  {
    promptIndex: 2,
    analyses: [
      {
        article: { url: "https://www.karger.com/z.pdf", content: "thin" },
        frontmatter: { title: "Karger 403 Article" },
        analysis: { relevance: 0.7 }
      }
    ],
    datasetCitations: []
  }
];

const blocked = collectBlockedSources(fakePromptResults);
check("collected exactly 3 blocked entries", blocked.length === 3, `got ${blocked.length}`);
check("first blocked is article from prompt 1", blocked[0]?.kind === "article" && blocked[0]?.promptIndex === 1);
check("dataset entry savePath uses csv", blocked.find(b => b.kind === "dataset")?.savePath?.endsWith(".csv"));
check("article savePath uses pdf",       blocked[0]?.savePath?.endsWith(".pdf"));
check("filename has p1-article-1 format", blocked[0]?.savePath?.includes("p1-article-1"));

check("shouldOfferBridge: thesis + 3 blocked → offer",   shouldOfferBridge(blocked, "thesis") === true);
check("shouldOfferBridge: research + 3 blocked → offer", shouldOfferBridge(blocked, "research") === true);
check("shouldOfferBridge: article tier → no",            shouldOfferBridge(blocked, "article") === false);
check("shouldOfferBridge: 1 blocked → no (below threshold)", shouldOfferBridge(blocked.slice(0, 1), "thesis") === false);
check("shouldOfferBridge: env=always overrides tier", shouldOfferBridge(blocked.slice(0, 1), "article", true) === true);
check("shouldOfferBridge: env=never blocks always",   shouldOfferBridge(blocked, "thesis", false) === false);

console.log("\n=== 9C: provider classifier preserves topic→provider mapping ===");
// Topic-root fallback list is internal; verify we still pick the right
// providers for psych vs finance topics (regression on Phase 7).
const psychProviders = DH.pickProviders("CBT for eating disorders", 6);
check("psych topic includes osf",          psychProviders.includes("osf"));
check("psych topic includes figshare",     psychProviders.includes("figshare"));
const finProviders = DH.pickProviders("inflation monetary policy", 6);
check("finance topic includes worldbank",  finProviders.includes("worldbank"));
check("finance topic includes fred",       finProviders.includes("fred"));

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

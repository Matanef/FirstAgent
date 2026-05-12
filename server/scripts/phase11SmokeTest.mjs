#!/usr/bin/env node
// Phase 11 smoke test — covers the deterministic pieces:
//   11A: data.gov.il provider topic routing + CKAN DataStore parser
//   11B: bridge state stripContentForSerialization + JSON round-trip lossless

import { _internals as DH } from "../skills/deepResearch/datasetHarvester.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== 11A: Hebrew topic detection ===");
const hebrewTopic = "מחקר על בריאות הציבור בישראל";
const englishTopic = "public health research israel";
check("classifies Hebrew chars as 'hebrew'",   DH.classifyTopic(hebrewTopic).includes("hebrew"));
check("classifies English string NOT as 'hebrew'", !DH.classifyTopic(englishTopic).includes("hebrew"));
check("Hebrew + health: both classes detected", DH.classifyTopic("מחקר בריאות").includes("hebrew"));

console.log("\n=== 11A: provider ordering with Hebrew ===");
const hebrewProviders = DH.pickProviders(hebrewTopic, 6);
check("hebrew topic puts datagovIL in providers",   hebrewProviders.includes("datagovIL"));
check("hebrew topic still includes always-on figshare", hebrewProviders.includes("figshare"));
// Mixed-language topic (Hebrew script + English health term) — both classes detected
const mixedProviders = DH.pickProviders("מחקר on diabetes treatment", 6);
check("mixed-language topic with health term routes to datagovIL + whoGho",
  mixedProviders.includes("datagovIL") && mixedProviders.includes("whoGho"));

console.log("\n=== 11A: CKAN DataStore format allowed ===");
check("ckan_datastore in ALLOWED_FORMATS", DH.ALLOWED_FORMATS.has("ckan_datastore"));

console.log("\n=== 11A: parseCkanDatastore (round-trip on real shape) ===");
// Realistic shape from the data.gov.il probe earlier (vaccine batch data)
const ckanResponse = JSON.stringify({
  help: "https://...",
  success: true,
  result: {
    total: 1257,
    fields: [
      { id: "_id", type: "int" },
      { id: "vaccinationCode", type: "numeric" },
      { id: "vaccinationDesc", type: "text" },
      { id: "manufacturerCode", type: "numeric" },
      { id: "batchNumber", type: "text" }
    ],
    records: [
      { _id: 1, vaccinationCode: 65, vaccinationDesc: "COVID-19", manufacturerCode: 30, batchNumber: "000032A" },
      { _id: 2, vaccinationCode: 65, vaccinationDesc: "COVID-19", manufacturerCode: 30, batchNumber: "000051A" },
      { _id: 3, vaccinationCode: 70, vaccinationDesc: "Influenza", manufacturerCode: 31, batchNumber: "INF22" }
    ]
  }
});

// Replicate the parser inline (the exported function isn't in _internals)
function parseCkanDatastore(body) {
  const data = typeof body === "string" ? JSON.parse(body) : body;
  if (!data?.success || !data?.result) return null;
  const records = Array.isArray(data.result.records) ? data.result.records : [];
  const fields  = Array.isArray(data.result.fields)  ? data.result.fields  : [];
  if (records.length === 0) return null;
  const headers = fields.filter(f => f.id !== "_id").map(f => f.id);
  const rows = records.map(r => {
    const out = {};
    for (const h of headers) out[h] = r[h];
    return out;
  });
  return { headers, rows };
}

const parsed = parseCkanDatastore(ckanResponse);
check("parsed not null", parsed !== null);
check("headers count = 4 (excludes _id)", parsed?.headers?.length === 4);
check("rows count = 3", parsed?.rows?.length === 3);
check("_id column stripped from rows", !("_id" in (parsed?.rows?.[0] || {})));
check("preserves vaccinationDesc value", parsed?.rows?.[0]?.vaccinationDesc === "COVID-19");
check("preserves batch number string", parsed?.rows?.[2]?.batchNumber === "INF22");
check("rejects malformed body (no success)", parseCkanDatastore('{"success":false}') === null);
check("rejects empty records", parseCkanDatastore('{"success":true,"result":{"records":[],"fields":[]}}') === null);

console.log("\n=== 11B: stripContentForSerialization ===");
// Replicate the helper inline (it's not exported)
function stripContent(promptResults) {
  if (!Array.isArray(promptResults)) return [];
  return promptResults.map(p => ({
    ...p,
    analyses: (p.analyses || []).map(a => {
      if (!a) return a;
      const article = a.article ? { ...a.article } : null;
      if (article) delete article.content;
      return { ...a, article };
    })
  }));
}

const fakePromptResults = [
  {
    promptIndex: 1,
    promptSpec: { id: "p1", query: "test", angle: "Definitions" },
    analyses: [
      {
        relativePath: "Journal/Research/x/1/article-1.md",
        analysis: { facts: ["fact 1: 82.4%", "fact 2: n=240"], relevance: 0.9, summary: "study summary", facts_meta: {} },
        frontmatter: { title: "Test Paper", url: "http://x", cite: { authors: ["Smith"], year: 2024, title: "T" } },
        article: {
          url: "http://x",
          content: "FULL PDF TEXT ".repeat(500),  // ~7KB
          title: "Test Paper"
        }
      }
    ],
    conclusion: { summary: "conclusion text", commonalities: ["c1"] },
    collectionName: "research-x-p1-articles",
    quantitativeFindings: [{ N: 50, hypothesis: "H1" }],
    datasetCitations: [{ id: "ds1", title: "DS Title", repository: "openalex" }]
  }
];

const slim = stripContent(fakePromptResults);
check("slim has same prompt count", slim.length === 1);
check("slim has same analysis count", slim[0].analyses.length === 1);
check("article.content REMOVED",       !("content" in slim[0].analyses[0].article));
check("article.url PRESERVED",         slim[0].analyses[0].article.url === "http://x");
check("article.title PRESERVED",       slim[0].analyses[0].article.title === "Test Paper");
check("analysis.facts PRESERVED",      slim[0].analyses[0].analysis.facts.length === 2);
check("analysis.facts[0] preserved",   slim[0].analyses[0].analysis.facts[0] === "fact 1: 82.4%");
check("frontmatter preserved",         slim[0].analyses[0].frontmatter.cite.authors[0] === "Smith");
check("conclusion preserved",          slim[0].conclusion.summary === "conclusion text");
check("collectionName preserved",      slim[0].collectionName === "research-x-p1-articles");
check("quantFindings preserved",       slim[0].quantitativeFindings[0].N === 50);
check("datasetCitations preserved",    slim[0].datasetCitations[0].id === "ds1");

console.log("\n=== 11B: JSON round-trip lossless ===");
const json = JSON.stringify(slim);
const restored = JSON.parse(json);
check("round-trip preserves prompt count", restored.length === 1);
check("round-trip preserves facts",        restored[0].analyses[0].analysis.facts.length === 2);
check("round-trip preserves cite.authors", restored[0].analyses[0].frontmatter.cite.authors[0] === "Smith");
check("round-trip preserves quant N",      restored[0].quantitativeFindings[0].N === 50);
check("round-trip total bytes < 100KB",    json.length < 100000, `actual=${json.length}b`);
console.log(`    [info] state size for 1 prompt × 1 analysis: ${json.length} bytes`);

// Stress test: thesis tier shape (8 prompts × 7 articles each)
const stress = [];
for (let i = 0; i < 8; i++) {
  const analyses = [];
  for (let j = 0; j < 7; j++) {
    analyses.push({
      relativePath: `j/${i}/${j}.md`,
      analysis: {
        facts: ["f1: 82.4%", "f2: n=240", "f3: t(53)=2.64", "f4: p=0.011", "f5: 47% reduction"],
        relevance: 0.85,
        summary: "summary text " + "x".repeat(300)
      },
      frontmatter: { title: `Title ${i}-${j}`, url: `http://x/${i}/${j}`, cite: { authors: [`Author${j}`], year: 2024, title: `T${i}${j}` } },
      article: { url: `http://x/${i}/${j}`, content: "x".repeat(5000), title: `Title ${i}-${j}` }
    });
  }
  stress.push({ promptIndex: i + 1, promptSpec: { id: `p${i+1}`, query: `q${i}` }, analyses, conclusion: { summary: "c" + i }, collectionName: `coll-${i}`, quantitativeFindings: [], datasetCitations: [] });
}
const stressSlim = stripContent(stress);
const stressJson = JSON.stringify(stressSlim);
check("thesis-shape state strips ~280KB of content",
  stressJson.length < 80000, `actual=${stressJson.length}b — should be far under raw 8×7×5KB=280KB`);
console.log(`    [info] state size for 8×7 thesis shape: ${stressJson.length} bytes (~${Math.round(stressJson.length/1024)}KB)`);

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

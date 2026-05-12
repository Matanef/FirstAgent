#!/usr/bin/env node
// Phase 17 smoke test — pure-helper assertions for Round-5 fixes.
// Mirrors Phase 13/14/15/16 patterns: inline mini-implementations + targeted imports.

import { readFileSync } from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== Phase 17 Smoke (KV cap, depth strip, blocklists, dead domains, table cap) ===\n");

// ── 17A: llm.js Ollama body has num_ctx 4096 default + num_gpu 999 + env override ──
console.log("Test 17A: llm.js KV cap + num_gpu pin");
{
  const src = readFileSync(new URL("../tools/llm.js", import.meta.url), "utf8");
  check("llm.js sets num_ctx: 4096 in body builder",
    /num_ctx:\s*4096/.test(src));
  check("llm.js sets num_gpu in body builder",
    /num_gpu:\s*numGpu/.test(src));
  check("llm.js reads OLLAMA_NUM_GPU env var",
    /process\.env\.OLLAMA_NUM_GPU/.test(src));
  check("llm.js default num_gpu is 999 (all-GPU)",
    /:\s*999\b/.test(src));
  check("llm.js no longer sets num_ctx: 8192 as default",
    !/num_ctx:\s*8192,\s*\/\/\s*Hard cap/.test(src));
}

// ── 17B: articleAnalyzer reads ANALYZER_TIMEOUT_MS env, passes maxRetries:0 ──
console.log("\nTest 17B: articleAnalyzer env-tunable timeouts + maxRetries:0");
{
  const src = readFileSync(new URL("../skills/deepResearch/articleAnalyzer.js", import.meta.url), "utf8");
  check("declares ANALYZER_TIMEOUT_MS env constant",
    /ANALYZER_TIMEOUT_MS\s*=\s*parseInt\(process\.env\.ANALYZER_TIMEOUT_MS/.test(src));
  check("declares ANALYZER_RETRY_TIMEOUT env constant",
    /ANALYZER_RETRY_TIMEOUT\s*=\s*parseInt\(process\.env\.ANALYZER_RETRY_TIMEOUT/.test(src));
  check("default ANALYZER_TIMEOUT_MS = 60000",
    /ANALYZER_TIMEOUT_MS[^"]*"60000"/.test(src));
  check("default ANALYZER_RETRY_TIMEOUT = 45000",
    /ANALYZER_RETRY_TIMEOUT[^"]*"45000"/.test(src));
  check("first analyzeChunk call uses ANALYZER_TIMEOUT_MS",
    /timeoutMs:\s*ANALYZER_TIMEOUT_MS/.test(src));
  check("retry analyzeChunk call uses ANALYZER_RETRY_TIMEOUT",
    /timeoutMs:\s*ANALYZER_RETRY_TIMEOUT/.test(src));
  // Both calls must pass maxRetries:0 — count occurrences
  const maxRetriesZeroCount = (src.match(/maxRetries:\s*0/g) || []).length;
  check("at least 2 maxRetries:0 in analyzeChunk (first + retry)",
    maxRetriesZeroCount >= 2,
    `(found ${maxRetriesZeroCount})`);
  check("no remaining hard-coded timeoutMs: 30000 in analyzeChunk",
    !/timeoutMs:\s*30000/.test(src));
  check("no remaining hard-coded timeoutMs: 25000 in analyzeChunk",
    !/timeoutMs:\s*25000/.test(src));
}

// ── 17E: executor strips both [MODEL:xxx] AND [depth:xxx] for non-imageGen ──
console.log("\nTest 17E: executor strips [MODEL:xxx] AND [depth:xxx]");
function execStrip(skillRequest, dynamicKey) {
  // Replicates executor.js dynamic-skill block logic.
  if (dynamicKey === "imageGen") return skillRequest;
  if (dynamicKey === "deepResearch") {
    if (typeof skillRequest === "string") {
      return skillRequest.replace(/\[MODEL:[A-Za-z0-9_\-]+\]\s*/gi, "").trim();
    } else if (skillRequest && typeof skillRequest === "object" && typeof skillRequest.text === "string") {
      skillRequest.text = skillRequest.text.replace(/\[MODEL:[A-Za-z0-9_\-]+\]\s*/gi, "").trim();
      return skillRequest;
    }
    return skillRequest;
  }
  if (typeof skillRequest === "string") {
    return skillRequest.replace(/\[(?:MODEL|depth):[A-Za-z0-9_\-]+\]\s*/gi, "").trim();
  } else if (skillRequest && typeof skillRequest === "object" && typeof skillRequest.text === "string") {
    skillRequest.text = skillRequest.text.replace(/\[(?:MODEL|depth):[A-Za-z0-9_\-]+\]\s*/gi, "").trim();
    return skillRequest;
  }
  return skillRequest;
}
check("strips '[depth:thesis]' for news skill",
  execStrip("[depth:thesis] write about cats", "news") === "write about cats");
check("strips '[MODEL:cloud]' for news skill",
  execStrip("[MODEL:cloud] write about cats", "news") === "write about cats");
check("strips both directives combined for news skill",
  execStrip("[MODEL:local] [depth:research] write about CBT", "news") === "write about CBT");
check("preserves [MODEL:cloud] for imageGen",
  execStrip("[MODEL:cloud] generate cat", "imageGen") === "[MODEL:cloud] generate cat");
check("deepResearch keeps [depth:thesis] (needs it for tier detection)",
  execStrip("[depth:thesis] CBT", "deepResearch") === "[depth:thesis] CBT");
check("deepResearch strips [MODEL:cloud]",
  execStrip("[MODEL:cloud] [depth:thesis] CBT", "deepResearch") === "[depth:thesis] CBT");
check("strip on object .text for news",
  execStrip({ text: "[depth:thesis] hello", context: {} }, "news").text === "hello");
check("strip on object .text for deepResearch keeps [depth:]",
  execStrip({ text: "[MODEL:local][depth:thesis] hello" }, "deepResearch").text === "[depth:thesis] hello");
// Verify executor.js source actually has the combined regex
{
  const src = readFileSync(new URL("../executor.js", import.meta.url), "utf8");
  check("executor.js has combined (?:MODEL|depth) regex (dynamic skills branch)",
    /\[\(\?:MODEL\|depth\):/i.test(src) || /\(\?:MODEL\|depth\)/.test(src));
}

// ── 17F: paperUpgrader has PAYWALLED_DOI_PREFIXES list ──
console.log("\nTest 17F: paperUpgrader publisher DOI blocklist");
{
  const src = readFileSync(new URL("../skills/deepResearch/paperUpgrader.js", import.meta.url), "utf8");
  check("declares PAYWALLED_DOI_PREFIXES const",
    /PAYWALLED_DOI_PREFIXES\s*=\s*\[/.test(src));
  // Spot-check a few prefixes that must be in the list
  for (const prefix of ["10.1001/", "10.1080/", "10.1186/", "10.3390/", "10.1017/"]) {
    check(`PAYWALLED_DOI_PREFIXES includes "${prefix}"`,
      src.includes(`"${prefix}"`));
  }
  check("doi.org block guarded by PAYWALLED_DOI_PREFIXES.some()",
    /PAYWALLED_DOI_PREFIXES\.some\(p\s*=>\s*\w+\.startsWith\(p\)\)/.test(src));
}

// ── 17F: dead-domain set in articleHarvester ──
console.log("\nTest 17F: articleHarvester per-run dead-domain set");
function makeDeadDomainHelpers() {
  const set = new Set();
  return {
    isDead: (url) => { try { return set.has(new URL(url).hostname.toLowerCase()); } catch { return false; } },
    mark:   (url) => { try { set.add(new URL(url).hostname.toLowerCase()); } catch {} },
    reset:  () => set.clear(),
    inspect: () => [...set]
  };
}
{
  const h = makeDeadDomainHelpers();
  check("isDead is false for fresh domain",
    !h.isDead("https://example.com/foo"));
  h.mark("https://example.com/timeout");
  check("isDead is true after mark",
    h.isDead("https://example.com/bar"));
  check("isDead also matches different path on same host",
    h.isDead("https://example.com/baz/qux"));
  check("isDead is false for unrelated host",
    !h.isDead("https://other.com/x"));
  h.reset();
  check("reset() clears all dead domains",
    !h.isDead("https://example.com/foo"));
  // Check the actual articleHarvester.js exports the resetDeadDomains function
  const src = readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8");
  check("articleHarvester exports resetDeadDomains",
    /export\s+function\s+resetDeadDomains/.test(src));
  check("articleHarvester defines _deadDomainsThisRun Set",
    /_deadDomainsThisRun\s*=\s*new Set/.test(src));
  check("fetchPage short-circuits via isDeadDomain",
    /isDeadDomain\(url\)/.test(src));
  check("ECONNABORTED catch marks domain dead",
    /markDeadDomain\(url\)/.test(src));
}

// ── 17G: S2 cooldown extended to 30 minutes + reset hook ──
console.log("\nTest 17G: S2 cooldown extension + reset");
{
  const src = readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8");
  check("S2_COOLDOWN_MS is 30 minutes (30 * 60 * 1000)",
    /S2_COOLDOWN_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/.test(src));
  check("S2_COOLDOWN_MS is no longer 5 minutes",
    !/S2_COOLDOWN_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(src));
  check("articleHarvester exports resetS2Cooldown",
    /export\s+function\s+resetS2Cooldown/.test(src));
}

// ── 17H: tableAnalyst caps columns + bails on >50 cols ──
console.log("\nTest 17H: tableAnalyst column cap + wide-table skip");
{
  const src = readFileSync(new URL("../skills/deepResearch/tableAnalyst.js", import.meta.url), "utf8");
  check("declares TABLE_PROMPT_COLUMN_CAP = 30",
    /TABLE_PROMPT_COLUMN_CAP\s*=\s*30/.test(src));
  check("buildPrompt sorts by .n descending",
    /\.sort\(\(a,\s*b\)\s*=>\s*\(b\.n\s*\|\|\s*0\)\s*-\s*\(a\.n\s*\|\|\s*0\)\)/.test(src));
  check("buildPrompt slices to TABLE_PROMPT_COLUMN_CAP",
    /\.slice\(0,\s*TABLE_PROMPT_COLUMN_CAP\)/.test(src));
  check("assess() bails on schema.columns.length > 50",
    /schema\.columns\.length\s*>\s*50/.test(src));
  check("wide-table bail returns skipped_reason: 'wide_table'",
    /skipped_reason:\s*"wide_table"/.test(src));
}

// ── 17I: webhookTunnel listen-with-retry ──
console.log("\nTest 17I: webhookTunnel EADDRINUSE retry");
{
  const src = readFileSync(new URL("../tools/webhookTunnel.js", import.meta.url), "utf8");
  check("webhookTunnel detects EADDRINUSE",
    /code\s*===\s*"EADDRINUSE"/.test(src));
  check("webhookTunnel retries listen() once via setTimeout(..., 1000)",
    /setTimeout\(attemptListen,\s*1000\)/.test(src));
  check("retried flag prevents infinite retry loop",
    /retried\s*=\s*true/.test(src) && /!retried/.test(src));
}

// ── 17D: taskAgent/coordinator/chatAgent forward resolvedPending ──
console.log("\nTest 17D: resolvedPending plumbing source check");
{
  const taskSrc  = readFileSync(new URL("../agents/taskAgent.js", import.meta.url), "utf8");
  const coordSrc = readFileSync(new URL("../utils/coordinator.js", import.meta.url), "utf8");
  const chatSrc  = readFileSync(new URL("../agents/chatAgent.js", import.meta.url), "utf8");
  check("taskAgent.handleTask destructures resolvedPending",
    /resolvedPending\s*=\s*null/.test(taskSrc));
  check("taskAgent forwards resolvedPending to executeAgent",
    /executeAgent\(\{[\s\S]*?resolvedPending[\s\S]*?\}\)/.test(taskSrc));
  check("coordinator.executeAgent accepts resolvedPending",
    /executeAgent\(\{[^)]*resolvedPending\s*=\s*null/.test(coordSrc));
  check("coordinator injects resolvedPending into enrichedContext",
    /enrichedContext\.resolvedPending\s*=\s*resolvedPending/.test(coordSrc));
  // Both handleTask call sites in chatAgent must pass resolvedPending
  const handleTaskCallsiteCount = (chatSrc.match(/handleTask\(\{/g) || []).length;
  const handleTaskWithResolvedPendingCount = (chatSrc.match(/handleTask\(\{[\s\S]*?resolvedPending:[\s\S]*?\}\)/g) || []).length;
  check("chatAgent passes resolvedPending at all handleTask call sites",
    handleTaskWithResolvedPendingCount === handleTaskCallsiteCount && handleTaskCallsiteCount >= 2,
    `(callsites=${handleTaskCallsiteCount}, with-resolvedPending=${handleTaskWithResolvedPendingCount})`);
}

// ── 17C: deepResearch index.js has pre-flight probe + reset hooks ──
console.log("\nTest 17C: deepResearch pre-flight probe");
{
  const src = readFileSync(new URL("../skills/deepResearch/index.js", import.meta.url), "utf8");
  check("pre-flight probe calls llm() with num_predict: 5",
    /num_predict:\s*5/.test(src));
  check("pre-flight probe with timeoutMs 60000",
    /timeoutMs:\s*60000/.test(src));
  check("probe failure returns aborted result with actionable error",
    /OLLAMA_NUM_GPU/i.test(src) && /pre-flight/i.test(src));
  check("probe failure surfaces underlying Ollama error message",
    /Underlying error:|ollamaMsg/.test(src));
  check("probe failure result has aborted:true (terminal signal)",
    /aborted:\s*true/.test(src));
  check("probe failure result has preformatted:true (verbatim signal)",
    /preformatted:\s*true/.test(src));
  check("probe failure suggests SYNTHESIZER_MODEL=qwen2.5:3b fallback",
    /qwen2\.5:3b/.test(src));
  check("probe failure suggests `ollama ps` diagnostic",
    /ollama ps/.test(src));
  check("calls resetDeadDomains() on run start",
    /articleHarvester\.resetDeadDomains/.test(src));
  check("calls resetS2Cooldown() on run start",
    /articleHarvester\.resetS2Cooldown/.test(src));
}

// ── 17J: chatAgent bypass extends to preformatted FAILURES ──
console.log("\nTest 17J: chatAgent bypass honours preformatted on failures");
{
  const src = readFileSync(new URL("../agents/chatAgent.js", import.meta.url), "utf8");
  check("chatAgent declares isPreformattedFailure check",
    /isPreformattedFailure/.test(src));
  check("isPreformattedFailure requires data.preformatted === true",
    /data\?\.preformatted\s*===\s*true/.test(src));
  check("isPreformattedFailure requires !toolResult.success",
    /!toolResult\.success/.test(src));
  check("bypass condition includes isPreformattedFailure branch",
    /\|\|\s*isPreformattedFailure/.test(src));
}

// Functional re-implementation of Phase 17J bypass logic to confirm semantics
console.log("\nTest 17J (functional): bypass behaviors");
function shouldBypass(toolResult) {
  if (!toolResult || toolResult.tool === "weather") return false;
  const isPreformattedFailure = !toolResult.success && toolResult.data?.preformatted === true;
  return (toolResult.success && (toolResult.final || toolResult.data?.preformatted)) || isPreformattedFailure;
}
check("bypasses when success=true, final=true",
  shouldBypass({ tool: "deepResearch", success: true, final: true, data: {} }) === true);
check("bypasses when success=true, preformatted=true",
  shouldBypass({ tool: "deepResearch", success: true, data: { preformatted: true } }) === true);
check("bypasses when success=false BUT preformatted=true (the fix)",
  shouldBypass({ tool: "deepResearch", success: false, final: true, data: { preformatted: true } }) === true);
check("does NOT bypass when success=false and no preformatted flag",
  shouldBypass({ tool: "deepResearch", success: false, data: { text: "err" } }) === false);
check("does NOT bypass for weather tool (special-cased)",
  shouldBypass({ tool: "weather", success: true, final: true, data: { preformatted: true } }) === false);

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

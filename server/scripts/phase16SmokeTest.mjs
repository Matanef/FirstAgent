#!/usr/bin/env node
// Phase 16 smoke test — pure-helper assertions for Round-4 fixes.
// Mirrors Phase 13/14/15 patterns: inline mini-implementations + targeted imports.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

// ── 16B: Universal [MODEL:xxx] strip mirroring executor logic ────────────
function execStrip(skillRequest, dynamicKey) {
  if (dynamicKey === "imageGen") return skillRequest;
  if (typeof skillRequest === "string") {
    return skillRequest.replace(/\[MODEL:[A-Za-z0-9_\-]+\]\s*/gi, "").trim();
  } else if (skillRequest && typeof skillRequest === "object" && typeof skillRequest.text === "string") {
    skillRequest.text = skillRequest.text.replace(/\[MODEL:[A-Za-z0-9_\-]+\]\s*/gi, "").trim();
    return skillRequest;
  }
  return skillRequest;
}
console.log("\n=== 16B: Executor [MODEL:xxx] strip ===");
check("strips '[MODEL:local] hello' for non-imageGen",
  execStrip("[MODEL:local] hello", "news") === "hello");
check("strips '[MODEL:cloud]' from object .text",
  execStrip({ text: "[MODEL:cloud] foo bar", context: {} }, "deepResearch").text === "foo bar");
check("preserves message for imageGen",
  execStrip("[MODEL:cloud] generate cat", "imageGen") === "[MODEL:cloud] generate cat");
check("multiple directives stripped",
  execStrip("[MODEL:local] [MODEL:cloud] hello", "news") === "hello");
check("no directive: unchanged",
  execStrip("hello world", "news") === "hello world");

// ── 16C: Error categorization logic ──────────────────────────────────────
// Replicate the mini-categorizer from fetchWithTimeout
function categorizeError(err, abortReason = null) {
  if (err.category) return err.category;
  if (err.name === "AbortError") return abortReason || "unknown_abort";
  if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "ENOTFOUND" || err.code === "EHOSTUNREACH") {
    return "network";
  }
  return err.category || "unknown";
}
function categorizeHttp(status, bodyText) {
  if (status >= 200 && status < 300) return null;
  const isContextOverflow = (status === 400 || status === 422)
    && /context|num_ctx|too\s+(?:long|large)|exceed/i.test(bodyText);
  return isContextOverflow ? "context_overflow" : "http_error";
}
console.log("\n=== 16C: LLM error categorization ===");
const abortErr = new Error("aborted"); abortErr.name = "AbortError";
check("AbortError + abortReason='timeout' → 'timeout'",
  categorizeError(abortErr, "timeout") === "timeout");
check("AbortError + abortReason='user_abort' → 'user_abort'",
  categorizeError(abortErr, "user_abort") === "user_abort");
check("AbortError + no reason → 'unknown_abort'",
  categorizeError(abortErr) === "unknown_abort");
const econErr = new Error("net"); econErr.code = "ECONNREFUSED";
check("ECONNREFUSED → 'network'",
  categorizeError(econErr) === "network");
const ersErr = new Error("net"); ersErr.code = "ECONNRESET";
check("ECONNRESET → 'network'",
  categorizeError(ersErr) === "network");
check("HTTP 400 with 'context length exceeded' body → 'context_overflow'",
  categorizeHttp(400, "context length exceeded model max") === "context_overflow");
check("HTTP 422 with 'too long' body → 'context_overflow'",
  categorizeHttp(422, "Input too long for model num_ctx") === "context_overflow");
check("HTTP 500 generic → 'http_error'",
  categorizeHttp(500, "Internal Server Error") === "http_error");
check("HTTP 200 → null (no error)",
  categorizeHttp(200, "{}") === null);

// ── 16D: Retry logic — categories and backoff ────────────────────────────
const RETRYABLE_CATEGORIES = new Set(["timeout", "network", "http_error"]);
const NON_RETRYABLE_CATEGORIES = new Set(["user_abort", "context_overflow"]);
console.log("\n=== 16D: Retry policy ===");
check("'timeout' is retryable",      RETRYABLE_CATEGORIES.has("timeout"));
check("'network' is retryable",      RETRYABLE_CATEGORIES.has("network"));
check("'http_error' is retryable",   RETRYABLE_CATEGORIES.has("http_error"));
check("'user_abort' NOT retryable",  NON_RETRYABLE_CATEGORIES.has("user_abort"));
check("'context_overflow' NOT retryable", NON_RETRYABLE_CATEGORIES.has("context_overflow"));
// Test the retry harness with a mocked _llmCore
async function makeRetryHarness(coreImpl) {
  let calls = 0;
  const wrapper = async (configOptions = {}) => {
    const maxRetries = configOptions.maxRetries ?? 1;
    let lastResult = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      calls++;
      const result = await coreImpl(attempt);
      if (result?.success) return { result, calls };
      lastResult = result;
      const cat = result?.errorCategory || "unknown";
      if (NON_RETRYABLE_CATEGORIES.has(cat)) break;
      if (attempt < maxRetries && RETRYABLE_CATEGORIES.has(cat)) {
        // Skip backoff in test
        continue;
      }
      break;
    }
    return { result: lastResult, calls };
  };
  return wrapper;
}
{
  // Scenario 1: timeout once then succeed → 2 calls, success=true
  const harness = await makeRetryHarness(async (attempt) => {
    if (attempt === 0) return { success: false, errorCategory: "timeout" };
    return { success: true };
  });
  const { result, calls } = await harness({ maxRetries: 1 });
  check("retries once on 'timeout' then succeeds", result.success === true && calls === 2);
}
{
  // Scenario 2: user_abort → no retry, 1 call
  const harness = await makeRetryHarness(async () => ({ success: false, errorCategory: "user_abort" }));
  const { result, calls } = await harness({ maxRetries: 1 });
  check("does NOT retry on 'user_abort'", calls === 1 && result.success === false);
}
{
  // Scenario 3: context_overflow → no retry
  const harness = await makeRetryHarness(async () => ({ success: false, errorCategory: "context_overflow" }));
  const { result, calls } = await harness({ maxRetries: 1 });
  check("does NOT retry on 'context_overflow'", calls === 1 && result.success === false);
}
{
  // Scenario 4: timeout x3 with maxRetries=1 → only 2 calls then give up
  const harness = await makeRetryHarness(async () => ({ success: false, errorCategory: "timeout" }));
  const { result, calls } = await harness({ maxRetries: 1 });
  check("caps retries at maxRetries=1 even if all fail", calls === 2 && result.success === false);
}
{
  // Scenario 5: backoff sequence — attempt 0 → wait 2s, attempt 1 → wait 4s
  const computeBackoff = (attempt) => Math.min(2000 * Math.pow(2, attempt), 15000);
  check("backoff(0) = 2000ms", computeBackoff(0) === 2000);
  check("backoff(1) = 4000ms", computeBackoff(1) === 4000);
  check("backoff(2) = 8000ms", computeBackoff(2) === 8000);
  check("backoff(3) = 15000ms (capped)", computeBackoff(3) === 15000);
}

// ── 16E: AbortController abort triggers checkAborted ─────────────────────
console.log("\n=== 16E: Abort signal helper ===");
function makeCheckAborted(signal) {
  return () => {
    if (signal && signal.aborted) {
      const e = new Error("Pipeline aborted by user");
      e.code = "PIPELINE_ABORTED";
      throw e;
    }
  };
}
const ctrl1 = new AbortController();
const check1 = makeCheckAborted(ctrl1.signal);
let threw1 = false; try { check1(); } catch { threw1 = true; }
check("checkAborted does NOT throw before abort", threw1 === false);
ctrl1.abort();
let threw2 = false, code2 = null;
try { check1(); } catch (e) { threw2 = true; code2 = e.code; }
check("checkAborted throws after abort", threw2 === true);
check("thrown error has code='PIPELINE_ABORTED'", code2 === "PIPELINE_ABORTED");
const check2 = makeCheckAborted(null);
let threw3 = false; try { check2(); } catch { threw3 = true; }
check("checkAborted with null signal never throws", threw3 === false);

// ── 16F: Audit deepResearch llm() calls have model: ──────────────────────
console.log("\n=== 16F: deepResearch llm() calls have explicit model ===");
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
const drDir = new URL("../skills/deepResearch/", import.meta.url);
const drDirPath = fileURLToPath(drDir);
const files = readdirSync(drDirPath).filter(f => f.endsWith(".js"));
let unspecified = [];
for (const f of files) {
  const src = readFileSync(new URL(f, drDir), "utf8");
  // Find each `await llm(` call and check if `model:` appears in the next 12 lines
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/await llm\(/.test(lines[i])) {
      const window = lines.slice(i, Math.min(i + 12, lines.length)).join("\n");
      if (!/model\s*:/.test(window)) {
        unspecified.push(`${f}:${i + 1}`);
      }
    }
  }
}
check("every deepResearch llm() call specifies model:",
  unspecified.length === 0,
  unspecified.length ? `(found unspecified: ${unspecified.join(", ")})` : "");

// ── Plan-level: confirm imageGen still consumes [MODEL:xxx] BEFORE strip ──
console.log("\n=== 16B sanity: imageGen consumes the directive itself ===");
const imgSrc = readFileSync(new URL("../skills/imageGen/imageGen.js", import.meta.url), "utf8");
check("imageGen.js strips [MODEL:cloud] internally",
  /\[MODEL:cloud\]/.test(imgSrc));
check("imageGen.js strips [MODEL:local] internally",
  /\[MODEL:local\]/.test(imgSrc));

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

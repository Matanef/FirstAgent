#!/usr/bin/env node
// Phase 17 Ollama pre-flight probe test.
//
// Verifies that deepResearch's pre-flight probe behavior matches expectations:
//   - probe success → pipeline proceeds
//   - probe failure (timeout/network/etc.) → pipeline aborts in <60s with
//     a clear error message, NOT after 2 hours of cascading timeouts.
//
// We don't import the real deepResearch._impl (it pulls in heavy deps).
// Instead we replicate the probe wrapper structure and verify the logic.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== Phase 17 Ollama Pre-Flight Probe ===\n");

const TOOL_NAME = "deepResearch";
const SYNTH_MODEL = "qwen2.5:7b";

// Replicates the probe wrapper from deepResearch/index.js.
async function _probeAndRun({ llm, doRun }) {
  const probe = await llm("Reply with the single word OK.", {
    timeoutMs: 60000,
    model: SYNTH_MODEL,
    maxRetries: 0,
    skipKnowledge: true,
    skipLanguageDetection: true,
    options: { temperature: 0, num_ctx: 512, num_predict: 5 }
  });
  if (!probe?.success) {
    const cat = probe?.errorCategory || "unknown";
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Ollama pre-flight probe failed (${cat}). The model may be CPU-spilling, unloaded, or unreachable. Try: (1) confirm Ollama is running ('ollama ps'); (2) reduce GPU layer count via OLLAMA_NUM_GPU env var; (3) check VRAM headroom in Task Manager.`,
      data: {
        text: `Research aborted before harvest — Ollama pre-flight probe failed (category=${cat}). See server logs for details.`,
        preformatted: true
      }
    };
  }
  return await doRun();
}

// ── Test 1 — Probe success → run proceeds ────────────────────────────────
console.log("Test 1: probe success → pipeline proceeds");
{
  let runCalled = false;
  const llm = async () => ({ success: true, data: { text: "OK" } });
  const doRun = async () => { runCalled = true; return { tool: TOOL_NAME, success: true, final: true, data: { text: "completed" } }; };
  const result = await _probeAndRun({ llm, doRun });
  check("doRun was invoked after probe success", runCalled === true);
  check("result.success is true", result.success === true);
  check("result.tool is deepResearch", result.tool === TOOL_NAME);
}

// ── Test 2 — Probe timeout → abort with actionable error ────────────────
console.log("\nTest 2: probe timeout → abort with actionable error");
{
  let runCalled = false;
  const llm = async () => ({ success: false, errorCategory: "timeout", error: "LLM request timeout after 60003ms" });
  const doRun = async () => { runCalled = true; return { success: true }; };
  const startTime = Date.now();
  const result = await _probeAndRun({ llm, doRun });
  const duration = Date.now() - startTime;
  check("doRun was NOT invoked after probe failure", runCalled === false);
  check("result.success is false", result.success === false);
  check("result.final is true (terminal)", result.final === true);
  check("result.error mentions 'pre-flight'", /pre-flight/i.test(result.error));
  check("result.error mentions 'timeout' (the category)", /timeout/i.test(result.error));
  check("result.error contains actionable hint about Ollama", /ollama/i.test(result.error));
  check("result.error mentions OLLAMA_NUM_GPU env var",
    /OLLAMA_NUM_GPU/.test(result.error));
  check("probe abort completes near-instantly (<200ms with mocked llm)",
    duration < 200, `(actual=${duration}ms)`);
}

// ── Test 3 — Probe network error → abort with actionable error ──────────
console.log("\nTest 3: probe network error → abort, error mentions Ollama");
{
  const llm = async () => ({ success: false, errorCategory: "network", error: "ECONNREFUSED" });
  const doRun = async () => ({ success: true });
  const result = await _probeAndRun({ llm, doRun });
  check("result.success is false on network failure", result.success === false);
  check("result.error mentions 'network' category", /network/i.test(result.error));
  check("result.error contains 'Ollama' for user diagnostics",
    /ollama/i.test(result.error));
  check("data.text mentions 'aborted before harvest'",
    /aborted before harvest/i.test(result.data?.text || ""));
}

// ── Test 4 — Probe error with unknown category ──────────────────────────
console.log("\nTest 4: probe failure with no errorCategory → category=unknown");
{
  const llm = async () => ({ success: false });    // no errorCategory field
  const doRun = async () => ({ success: true });
  const result = await _probeAndRun({ llm, doRun });
  check("missing errorCategory falls back to 'unknown'",
    /unknown/i.test(result.error));
}

// ── Test 5 — Probe params shape (cheap probe, not expensive call) ───────
console.log("\nTest 5: probe params are cheap (small num_ctx, num_predict, no retries)");
{
  let probeParams = null;
  const llm = async (prompt, opts) => { probeParams = { prompt, opts }; return { success: true }; };
  const doRun = async () => ({ success: true });
  await _probeAndRun({ llm, doRun });
  check("probe prompt is short (<=64 chars)",
    (probeParams?.prompt?.length || 0) <= 64);
  check("probe num_ctx is 512 (cheap)",
    probeParams?.opts?.options?.num_ctx === 512);
  check("probe num_predict is 5 (cheap)",
    probeParams?.opts?.options?.num_predict === 5);
  check("probe maxRetries is 0 (don't compound a stuck Ollama)",
    probeParams?.opts?.maxRetries === 0);
  check("probe timeoutMs is 60000",
    probeParams?.opts?.timeoutMs === 60000);
  check("probe explicit model (not default fallthrough)",
    probeParams?.opts?.model === SYNTH_MODEL);
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

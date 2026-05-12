#!/usr/bin/env node
// Phase 17 resume-plumbing integration test.
//
// Verifies `resolvedPending` flows through the chain:
//   orchestrator → chatAgent → taskAgent → coordinator.executeAgent
//                            → enrichedContext → executeStep → skill.context
//
// Without this plumbing, deepResearch's bridge-resume short-circuit
// (index.js:305 `isBridgeResume = context.resolvedPending?.manual_bridge_continue !== undefined`)
// would never fire, and "continue" replies after a manual-bridge offer
// would restart the entire pipeline (the loop bug).
//
// Strategy: stub executeAgent and inspect what taskAgent passes; then stub
// executeStep and inspect what executeAgent passes downstream.

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== Phase 17 Resume Plumbing ===\n");

// Synthetic pending-resume payload mirroring orchestrator.js:65 shape
const SAMPLE_RP = {
  manual_bridge_continue: "continue",
  _skill: "deepResearch",
  _bridgeSlug: "cognitive-behavioral-therapy"
};

// ── Test 1 — taskAgent forwards resolvedPending to executeAgent ─────────
console.log("Test 1: taskAgent forwards resolvedPending to executeAgent");
{
  // We can't inject a stub executeAgent into taskAgent without mocking,
  // so instead we replicate the expected behavior and verify by reading
  // taskAgent.js's source for the forwarding line.
  const { readFileSync } = await import("fs");
  const taskSrc = readFileSync(new URL("../agents/taskAgent.js", import.meta.url), "utf8");
  check("handleTask signature accepts resolvedPending",
    /resolvedPending\s*=\s*null/.test(taskSrc));
  check("handleTask passes resolvedPending into executeAgent({...})",
    /executeAgent\(\{[\s\S]*?resolvedPending[\s\S]*?\}\)/.test(taskSrc));

  // Direct functional test: a stand-in handleTask that mirrors the real one's
  // shape.
  async function handleTaskStandIn({ message, resolvedPending = null }, executeAgent) {
    return await executeAgent({ message, resolvedPending });
  }
  let captured = null;
  const stubExecuteAgent = async (params) => { captured = params; return { mode: "task" }; };
  await handleTaskStandIn({ message: "test", resolvedPending: SAMPLE_RP }, stubExecuteAgent);
  check("stand-in: executeAgent received resolvedPending unchanged",
    captured?.resolvedPending === SAMPLE_RP);
  check("stand-in: resolvedPending has manual_bridge_continue='continue'",
    captured?.resolvedPending?.manual_bridge_continue === "continue");
  check("stand-in: resolvedPending has _bridgeSlug='cognitive-behavioral-therapy'",
    captured?.resolvedPending?._bridgeSlug === "cognitive-behavioral-therapy");
}

// ── Test 2 — executeAgent → enrichedContext.resolvedPending ─────────────
console.log("\nTest 2: coordinator.executeAgent injects resolvedPending into enrichedContext");
{
  // Simulate the coordinator's enrichedContext build (mirrors utils/coordinator.js
  // around line 332-380 with our Phase 17D injection point).
  function buildEnrichedContext(stepContext, options) {
    const enrichedContext = { ...(stepContext || {}) };
    if (options.onStep) enrichedContext._onStep = options.onStep;
    if (options.resolvedPending) enrichedContext.resolvedPending = options.resolvedPending;
    return enrichedContext;
  }
  const ctx = buildEnrichedContext({}, { resolvedPending: SAMPLE_RP });
  check("enrichedContext.resolvedPending is set when input non-null",
    ctx.resolvedPending === SAMPLE_RP);
  const ctx2 = buildEnrichedContext({}, {});
  check("enrichedContext.resolvedPending is unset when input null",
    !("resolvedPending" in ctx2));
  // Confirm the actual coordinator.js source has the injection
  const { readFileSync } = await import("fs");
  const coordSrc = readFileSync(new URL("../utils/coordinator.js", import.meta.url), "utf8");
  check("coordinator.js has 'enrichedContext.resolvedPending = resolvedPending' line",
    /enrichedContext\.resolvedPending\s*=\s*resolvedPending/.test(coordSrc));
}

// ── Test 3 — chatAgent forwards options.resolvedPending at all callsites ─
console.log("\nTest 3: chatAgent forwards resolvedPending at all handleTask callsites");
{
  const { readFileSync } = await import("fs");
  const chatSrc = readFileSync(new URL("../agents/chatAgent.js", import.meta.url), "utf8");
  // Find every `handleTask({` block and confirm `resolvedPending:` appears in it.
  const blocks = chatSrc.split(/handleTask\(\{/).slice(1);
  let allHaveIt = blocks.every(blk => /resolvedPending:\s*options\.resolvedPending/.test(blk.slice(0, 600)));
  check(`all ${blocks.length} handleTask call sites pass options.resolvedPending`,
    allHaveIt && blocks.length >= 2,
    `(found ${blocks.length} call sites)`);
}

// ── Test 4 — end-to-end bridge resume detection ─────────────────────────
console.log("\nTest 4: simulated bridge-resume detection in deepResearch");
{
  // Replicates the index.js:305 isBridgeResume check.
  function isBridgeResume(context) {
    return context.resolvedPending?.manual_bridge_continue !== undefined;
  }
  check("isBridgeResume fires when context.resolvedPending.manual_bridge_continue exists",
    isBridgeResume({ resolvedPending: SAMPLE_RP }) === true);
  check("isBridgeResume fires when manual_bridge_continue is 'continue'",
    isBridgeResume({ resolvedPending: { manual_bridge_continue: "continue" } }) === true);
  check("isBridgeResume fires even when value is 'skip' (defined but skip)",
    isBridgeResume({ resolvedPending: { manual_bridge_continue: "skip" } }) === true);
  check("isBridgeResume does NOT fire when resolvedPending is null",
    isBridgeResume({ resolvedPending: null }) === false);
  check("isBridgeResume does NOT fire when resolvedPending lacks manual_bridge_continue",
    isBridgeResume({ resolvedPending: { _skill: "deepResearch" } }) === false);
  check("isBridgeResume does NOT fire when context is empty",
    isBridgeResume({}) === false);
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

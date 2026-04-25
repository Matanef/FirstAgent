#!/usr/bin/env node
// server/scripts/stress-routing-regression.mjs
//
// Stress test #4 — Routing regression suite.
//
// Sends a curated list of known-intent messages and verifies the server
// selects the expected tool. Parses PM2/server logs via a diagnostic endpoint
// OR inspects the SSE response tool label. Uses a fresh conversationId per
// case so no prior context taints the routing decision.
//
// Usage:
//   node server/scripts/stress-routing-regression.mjs
//   BASE_URL=http://localhost:3000 node server/scripts/stress-routing-regression.mjs
//   VERBOSE=1 node server/scripts/stress-routing-regression.mjs  # print full SSE body on miss
//
// Each case has: { msg, expect, category }
//   - expect: the tool name we expect the planner/router to select
//   - category: for summary grouping
//
// Re-run after every rules.js change. Any regression should show up as a FAIL.

import crypto from "node:crypto";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY || "";
const VERBOSE = process.env.VERBOSE === "1";

const CASES = [
  // ── CHAT (should NOT misroute to any tool) ──
  { msg: "so i had a long day at work",                   expect: "chatAgent", category: "chat" },
  { msg: "well lets see if this bug happens again",       expect: "chatAgent", category: "chat" },
  { msg: "i'm trying to reproduce an issue where you get stuck while chatting", expect: "chatAgent", category: "chat" },
  { msg: "duplicate messages are annoying aren't they",   expect: "chatAgent", category: "chat" },
  { msg: "the routing issues are finally under control",  expect: "chatAgent", category: "chat" },

  // ── EMAIL (task) ──
  { msg: "send an email to alice@example.com saying hi",  expect: "email",     category: "email" },
  { msg: "draft an email to bob about the meeting",       expect: "email",     category: "email" },

  // ── WEATHER ──
  { msg: "what's the weather in Tel Aviv",                expect: "weather",   category: "weather" },
  { msg: "weather forecast for tomorrow",                 expect: "weather",   category: "weather" },

  // ── CALCULATOR ──
  { msg: "what is 23 times 47",                           expect: "calculator", category: "math" },
  { msg: "calculate 2^10 + 15",                           expect: "calculator", category: "math" },

  // ── SEARCH ──
  // NOTE: was "search for the latest news on quantum computing" expecting search,
  // but "latest news" correctly routes to the news tool (priority 65 > search's 30).
  // That's the router being right, not wrong. Rephrased so the test actually exercises search.
  { msg: "search for information about quantum computing", expect: "search",  category: "search" },

  // ── CODE RAG (new rule) ──
  { msg: "based on your codebase suggest a test prompt",  expect: "codeRag",   category: "codeRag" },
  { msg: "reindex the codebase",                          expect: "codeRag",   category: "codeRag" },
  { msg: "where in your repo is email sending handled",   expect: "codeRag",   category: "codeRag" },

  // ── SELF-IMPROVEMENT (should fire only on explicit reports) ──
  { msg: "show me your routing report",                   expect: "selfImprovement", category: "self" },
  { msg: "how accurate is your routing",                  expect: "selfImprovement", category: "self" },

  // ── DUPLICATE SCANNER (should fire only on qualified phrasing) ──
  { msg: "scan my downloads folder for duplicate files",  expect: "duplicateScanner", category: "duplicate" },
  { msg: "find duplicate photos in /tmp/pics",            expect: "duplicateScanner", category: "duplicate" },
];

async function postAndExtractTool(message) {
  const convId = `reg-${crypto.randomBytes(6).toString("hex")}`;
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, conversationId: convId }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    body += decoder.decode(value, { stream: true });
  }

  // Parse the final "done" SSE frame — that's the frame with the authoritative tool label.
  // Previously we grepped every `"tool":"..."` in the raw body, but when the server returned
  // an error (rate limit / auth) there's no tool field at all and we silently reported null.
  // Now we walk the SSE frames, prefer the `done` frame, and surface HTTP status + error on miss.
  const frames = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const jsonText = line.slice(6).trim();
    if (!jsonText || jsonText.startsWith(":")) continue;
    try { frames.push(JSON.parse(jsonText)); } catch { /* skip non-JSON heartbeats */ }
  }

  const doneFrame = [...frames].reverse().find(f => f.type === "done");
  const errorFrame = frames.find(f => f.type === "error" || f.error);
  let finalTool = null;
  if (doneFrame?.tool && doneFrame.tool !== "unknown" && doneFrame.tool !== "orchestrator") {
    finalTool = doneFrame.tool;
  } else if (doneFrame?.stateGraph?.length) {
    // Fallback: the last non-generic tool mentioned in the stateGraph
    const nonGeneric = doneFrame.stateGraph.map(s => s.tool).filter(t => t && t !== "orchestrator");
    finalTool = nonGeneric[nonGeneric.length - 1] || null;
  }

  return { convId, finalTool, body, status: res.status, doneFrame, errorFrame, frameCount: frames.length };
}

(async () => {
  console.log(`[regression] BASE_URL=${BASE_URL}  cases=${CASES.length}\n`);

  const results = [];
  for (const [i, c] of CASES.entries()) {
    try {
      const r = await postAndExtractTool(c.msg);
      const pass = r.finalTool === c.expect;
      results.push({ ...c, got: r.finalTool, pass });
      const mark = pass ? "✔" : "✘";
      const statusTag = r.status !== 200 ? ` [HTTP ${r.status}]` : "";
      console.log(`  ${mark} [${String(i + 1).padStart(2, "0")}] ${c.category.padEnd(10)} "${c.msg.slice(0, 60)}" → expected=${c.expect}  got=${r.finalTool}${statusTag}`);
      if (!pass) {
        // Always surface diagnostic info on miss — silent nulls were unhelpful.
        if (r.errorFrame) console.log(`      error frame: ${JSON.stringify(r.errorFrame).slice(0, 300)}`);
        if (!r.doneFrame) console.log(`      no 'done' frame received (${r.frameCount} frames total)`);
        if (VERBOSE) console.log(`      body snippet: ${r.body.slice(0, 500).replace(/\n/g, " ⏎ ")}`);
      }
      // Small delay between cases — /chat is rate-limited to RATE_LIMIT_MAX=30/min by default.
      // 19 cases at 2500ms spacing = ~48s, safely under the window.
      await new Promise(resolve => setTimeout(resolve, 2500));
    } catch (err) {
      results.push({ ...c, got: null, pass: false, error: err.message });
      console.log(`  ✘ [${String(i + 1).padStart(2, "0")}] "${c.msg}" → ERROR ${err.message}`);
    }
  }

  const byCategory = results.reduce((acc, r) => {
    acc[r.category] = acc[r.category] || { pass: 0, fail: 0 };
    if (r.pass) acc[r.category].pass++; else acc[r.category].fail++;
    return acc;
  }, {});

  console.log("\n[regression] By category:");
  for (const [cat, v] of Object.entries(byCategory)) {
    const total = v.pass + v.fail;
    const ratio = total ? ((v.pass / total) * 100).toFixed(0) : "0";
    console.log(`  ${cat.padEnd(10)} ${v.pass}/${total}  (${ratio}%)`);
  }

  const passes = results.filter(r => r.pass).length;
  const fails = results.length - passes;
  console.log(`\n[regression] TOTAL: ${passes}/${results.length} passed  ${fails ? `(${fails} failed)` : ""}`);
  console.log(`[regression] VERDICT: ${fails === 0 ? "PASS" : "FAIL"}`);
  if (fails > 0) process.exitCode = 1;
})().catch(err => {
  console.error("[regression] FATAL:", err);
  process.exit(1);
});

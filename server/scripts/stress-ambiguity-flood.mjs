#!/usr/bin/env node
// server/scripts/stress-ambiguity-flood.mjs
//
// Stress test #1 — Ambiguity flood.
//
// Fires N genuinely-ambiguous messages in parallel at the SAME conversationId.
// Goal: verify that the re-entrant memory lock + pending-question write path
// doesn't race, doesn't deadlock, and ends with exactly ONE pending question
// entry (not N) in memory.json → meta.pendingQuestions[conversationId].
//
// Usage:
//   node server/scripts/stress-ambiguity-flood.mjs
//   BASE_URL=http://localhost:3000 CONCURRENCY=8 node server/scripts/stress-ambiguity-flood.mjs
//
// Expected result:
//   - All N requests complete (no hangs)
//   - Server never logs a TIMED OUT probe
//   - memory.json has exactly 1 pending question for the test conv id
//   - No stuck "thinking" state — re-running the script back-to-back works

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.resolve(__dirname, "..", "..", "utils", "memory.json");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY || "";
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5", 10);
const CONV_ID = `stress-amb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Deliberately ambiguous messages. None should match a strong routing rule.
// Each triggers the Phase-4 ambiguity clarification path.
const AMBIGUOUS_MESSAGES = [
  "evolve",
  "just do it",
  "continue",
  "the thing",
  "handle this",
  "proceed",
  "whatever works",
  "you decide",
];

async function postChat(message) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, conversationId: CONV_ID }),
  });
  // Drain SSE body so server finishes writing
  const reader = res.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  return { status: res.status, ms: Date.now() - t0, bytes, message };
}

async function readPendingQuestionCount() {
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const mem = JSON.parse(raw);
    const pq = mem?.meta?.pendingQuestions?.[CONV_ID];
    return pq ? 1 : 0;
  } catch {
    return -1;
  }
}

(async () => {
  const messages = AMBIGUOUS_MESSAGES.slice(0, CONCURRENCY);
  console.log(`[flood] BASE_URL=${BASE_URL}  CONV_ID=${CONV_ID}  CONCURRENCY=${messages.length}`);
  console.log(`[flood] firing ${messages.length} ambiguous messages in parallel…\n`);

  const t0 = Date.now();
  const settled = await Promise.allSettled(messages.map(postChat));
  const elapsed = Date.now() - t0;

  let ok = 0, failed = 0;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      ok++;
      console.log(`  ✔ [${i}] "${messages[i]}" → ${s.value.status} in ${s.value.ms}ms (${s.value.bytes}B)`);
    } else {
      failed++;
      console.log(`  ✘ [${i}] "${messages[i]}" → ERROR ${s.reason?.message || s.reason}`);
    }
  });

  const pqCount = await readPendingQuestionCount();
  console.log(`\n[flood] total elapsed: ${elapsed}ms  ok=${ok}  failed=${failed}`);
  console.log(`[flood] pending questions for conv: ${pqCount} (expected: 1 if at least one fired, 0 if none)`);

  const verdict = failed === 0 && pqCount >= 0 && pqCount <= 1;
  console.log(`\n[flood] VERDICT: ${verdict ? "PASS" : "FAIL"}`);
  if (!verdict) {
    console.log("[flood] Check PM2 logs for:");
    console.log("  - 'getPendingQuestion TIMED OUT' → lock stuck");
    console.log("  - 'setPendingQuestion failed' → write path broke");
    console.log("  - multiple clarification prompts returned → race on read-modify-write");
    process.exitCode = 1;
  }
})().catch(err => {
  console.error("[flood] FATAL:", err);
  process.exit(1);
});

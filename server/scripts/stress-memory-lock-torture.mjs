#!/usr/bin/env node
// server/scripts/stress-memory-lock-torture.mjs
//
// Stress test #3 — Memory-lock torture.
//
// Fires CONCURRENCY parallel chat requests across WAVES waves. Since every turn
// reads + writes memory.json under the AsyncLocalStorage-based re-entrant mutex,
// this should surface any deadlock, starvation, or corruption.
//
// Checks:
//   (a) All requests eventually complete (no hang)
//   (b) memory.json remains valid JSON at the end
//   (c) Every conversation id we sent to actually has turns persisted (no lost writes)
//   (d) No duplicate lock wait timeouts in server logs (user checks manually)
//
// Usage:
//   node server/scripts/stress-memory-lock-torture.mjs
//   CONCURRENCY=10 WAVES=6 node server/scripts/stress-memory-lock-torture.mjs

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.resolve(__dirname, "..", "..", "utils", "memory.json");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY || "";
// Defaults stay under the /chat rate limit (30/min per IP) so rate-limit 429s don't
// get confused with real lock contention. Override via env if you've bumped RATE_LIMIT_MAX.
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "7", 10);
const WAVES = parseInt(process.env.WAVES || "4", 10);

const MESSAGES = [
  "hey there",
  "what's up",
  "tell me something",
  "how are you",
  "i have a quick question",
  "just checking in",
  "random thought for you",
  "what do you think",
  "curious about something",
  "give me a take",
];

function mkConvId() { return `lock-${crypto.randomBytes(4).toString("hex")}`; }

async function post(msg, convId) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: msg, conversationId: convId }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      // Keep a rolling window so we can surface the first error frame / last snippet
      if (body.length < 4000) body += decoder.decode(value, { stream: true });
    }
    // If the SSE stream contains an error frame, capture it so we stop reporting blind fails.
    let errorFrame = null;
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      try {
        const f = JSON.parse(line.slice(6).trim());
        if (f?.type === "error" || f?.error) { errorFrame = f; break; }
      } catch { /* ignore non-JSON */ }
    }
    return {
      ok: res.status === 200 && bytes > 0 && !errorFrame,
      ms: Date.now() - t0,
      bytes,
      status: res.status,
      convId,
      errorFrame,
      bodySnippet: body.slice(0, 400),
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, bytes: 0, error: err.message, convId };
  }
}

(async () => {
  console.log(`[lock] BASE_URL=${BASE_URL}  CONCURRENCY=${CONCURRENCY}  WAVES=${WAVES}  total=${CONCURRENCY * WAVES}\n`);

  const convIds = [];
  const latencies = [];
  let failures = 0;
  let raceCollisions = 0;  // responses that came back as errors likely from lock contention

  const startT = Date.now();

  for (let w = 1; w <= WAVES; w++) {
    console.log(`[lock] wave ${w}/${WAVES} — firing ${CONCURRENCY} parallel requests...`);
    const tasks = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const convId = mkConvId();
      convIds.push(convId);
      const msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
      tasks.push(post(msg, convId));
    }
    const results = await Promise.all(tasks);
    let waveFails = 0;
    const failSamples = [];
    for (const r of results) {
      if (!r.ok) {
        failures++; waveFails++;
        if (r.error?.includes("lock") || r.status >= 500) raceCollisions++;
        if (failSamples.length < 3) {
          failSamples.push({
            status: r.status,
            err: r.error,
            errorFrame: r.errorFrame,
            bytes: r.bytes,
            bodySnippet: r.bodySnippet?.slice(0, 200),
          });
        }
      } else latencies.push(r.ms);
    }
    console.log(`  wave ${w}: ok=${results.length - waveFails}  fail=${waveFails}  avgMs=${Math.round(latencies.slice(-results.length).reduce((a,b)=>a+b,0) / Math.max(1, results.length - waveFails))}`);
    if (failSamples.length) {
      for (const s of failSamples) {
        console.log(`     ↳ fail sample: status=${s.status ?? "n/a"}  bytes=${s.bytes}  err=${s.err ?? "none"}  frame=${s.errorFrame ? JSON.stringify(s.errorFrame).slice(0, 200) : "none"}`);
        if (!s.errorFrame && !s.err && s.bodySnippet) console.log(`       body: ${s.bodySnippet.replace(/\n/g, " ⏎ ")}`);
      }
    }
  }

  const totalMs = Date.now() - startT;

  // Verify memory.json is valid JSON and contains every convId we spoke to
  let memValid = false;
  let missing = 0;
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const mem = JSON.parse(raw);
    memValid = true;
    for (const id of convIds) {
      const convo = mem.conversations?.[id];
      if (!Array.isArray(convo) || convo.length === 0) missing++;
    }
  } catch (err) {
    console.log(`[lock] memory.json VALIDATION FAILED: ${err.message}`);
  }

  const avgMs = latencies.length ? Math.round(latencies.reduce((a,b)=>a+b,0) / latencies.length) : 0;
  const maxMs = latencies.length ? Math.max(...latencies) : 0;

  console.log(`\n[lock] total duration: ${totalMs}ms  successful: ${latencies.length}/${CONCURRENCY * WAVES}`);
  console.log(`[lock] latency: avg=${avgMs}ms  max=${maxMs}ms`);
  console.log(`[lock] failures: ${failures}  lock-shaped-errors: ${raceCollisions}`);
  console.log(`[lock] memory.json valid: ${memValid}  missing conversations: ${missing}/${convIds.length}`);

  const pass = memValid && failures === 0 && missing === 0;
  console.log(`\n[lock] VERDICT: ${pass ? "PASS" : "INVESTIGATE"}`);
  if (!memValid) console.log("  - memory.json corrupted — serialization races or partial writes");
  if (failures > 0) console.log(`  - ${failures} requests failed — check for deadlocks or lock timeouts in PM2 logs`);
  if (missing > 0) console.log(`  - ${missing} conversations lost their turns — write coalescing dropped them`);
  if (!pass) process.exitCode = 1;
})().catch(err => { console.error("[lock] FATAL:", err); process.exit(1); });

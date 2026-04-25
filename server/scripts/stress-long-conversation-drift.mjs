#!/usr/bin/env node
// server/scripts/stress-long-conversation-drift.mjs
//
// Stress test #6 — Long conversation drift.
//
// Runs a 40-turn synthetic chat conversation and measures:
//   (a) turn latency growth across the conversation
//   (b) response body size (proxy for streamed reply length)
//   (c) memory.conversations[<id>].length growth (unbounded storage check)
//   (d) durable facts written (was the auto-extractor active?)
//
// Goal: catch unbounded context growth, runaway prompt bloat, or a memory
// lock getting slower as convo grows. A healthy system should stay roughly
// flat in latency — if turn 35 takes 3× longer than turn 5, something is
// quadratic somewhere.
//
// Usage:
//   node server/scripts/stress-long-conversation-drift.mjs
//   TURNS=60 BASE_URL=http://localhost:3000 node server/scripts/stress-long-conversation-drift.mjs

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.resolve(__dirname, "..", "..", "utils", "memory.json");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY || "";
const TURNS = parseInt(process.env.TURNS || "40", 10);
const CONV_ID = `drift-${crypto.randomBytes(6).toString("hex")}`;

// A mix of chatty and factual messages. Keeps the classifier in chat mode
// most of the time so we're measuring chat-path drift specifically.
const MESSAGE_POOL = [
  "hey, how's it going?",
  "i was thinking about that bug we discussed earlier.",
  "what do you think about distributed systems?",
  "tell me something interesting you learned recently.",
  "i had coffee this morning, it was decent.",
  "my friend sarah thinks we should use kubernetes. thoughts?",
  "i love hiking on weekends when the weather cooperates.",
  "what's your take on rust versus go for backend services?",
  "i have two cats and they fight constantly, it's exhausting.",
  "do you remember what we talked about regarding locks?",
  "random thought: why do we call it 'debugging' and not 'bug-removing'?",
  "i'm working on a side project that involves vector embeddings.",
  "how do you feel about the latest AI developments?",
  "i live in a small apartment with big windows.",
  "my manager wants a status update tomorrow. ugh.",
  "i prefer coffee over tea, controversial opinion i know.",
  "what's the difference between a thread and a process again?",
  "let's just chat for a bit, no tool calls.",
  "i had a strange dream last night about my old job.",
  "i'm a backend developer, mostly node and python.",
];

function sample(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function postChat(message) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, conversationId: CONV_ID }),
  });
  const reader = res.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  return { ms: Date.now() - t0, bytes, status: res.status };
}

async function readMemoryStats() {
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const mem = JSON.parse(raw);
    const convo = mem.conversations?.[CONV_ID] || [];
    const durable = mem.durable;
    const durableCount = Array.isArray(durable)
      ? (durable.length === 1 && durable[0]?._encrypted ? "encrypted(opaque)" : durable.length)
      : 0;
    return { convoLength: convo.length, durableCount };
  } catch {
    return { convoLength: -1, durableCount: -1 };
  }
}

function summarizeWindow(arr) {
  if (arr.length === 0) return { avg: 0, min: 0, max: 0, median: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    avg: Math.round(avg),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

(async () => {
  console.log(`[drift] BASE_URL=${BASE_URL}  CONV_ID=${CONV_ID}  TURNS=${TURNS}\n`);

  const startStats = await readMemoryStats();
  console.log(`[drift] baseline: convoLength=${startStats.convoLength}  durable=${startStats.durableCount}\n`);

  const latencies = [];
  const sizes = [];
  for (let i = 1; i <= TURNS; i++) {
    const msg = sample(MESSAGE_POOL);
    try {
      const { ms, bytes, status } = await postChat(msg);
      latencies.push(ms);
      sizes.push(bytes);
      const marker = i % 5 === 0 ? "★" : " ";
      console.log(`  ${marker} turn ${String(i).padStart(2, "0")}  ${ms.toString().padStart(6)}ms  ${String(bytes).padStart(6)}B  [${status}]  "${msg.slice(0, 50)}"`);
    } catch (err) {
      console.log(`  ✘ turn ${i}  ERROR: ${err.message}`);
      latencies.push(-1);
      sizes.push(0);
    }
  }

  const endStats = await readMemoryStats();

  // Split latencies into early (first third) vs late (last third) windows
  const third = Math.floor(TURNS / 3);
  const early = latencies.slice(0, third).filter(x => x > 0);
  const late = latencies.slice(-third).filter(x => x > 0);
  const earlyStats = summarizeWindow(early);
  const lateStats = summarizeWindow(late);
  const driftRatio = earlyStats.avg > 0 ? (lateStats.avg / earlyStats.avg) : 0;

  console.log("\n[drift] latency summary (ms):");
  console.log(`  early third  avg=${earlyStats.avg.toString().padStart(5)}  median=${earlyStats.median}  min=${earlyStats.min}  max=${earlyStats.max}`);
  console.log(`  late  third  avg=${lateStats.avg.toString().padStart(5)}  median=${lateStats.median}  min=${lateStats.min}  max=${lateStats.max}`);
  console.log(`  drift ratio  late/early = ${driftRatio.toFixed(2)}×  (>1.5× suggests growth; >2× = investigate)`);

  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  console.log(`\n[drift] response size: total=${totalBytes}B  avg/turn=${Math.round(totalBytes / sizes.length)}B`);

  console.log(`\n[drift] memory state:`);
  console.log(`  memory.conversations[conv].length: ${startStats.convoLength} → ${endStats.convoLength}  (delta=${endStats.convoLength - startStats.convoLength}, expected ≥ ${TURNS * 2})`);
  console.log(`  memory.durable count:              ${startStats.durableCount} → ${endStats.durableCount}`);

  const driftOK = driftRatio > 0 && driftRatio < 2.0;
  const storageOK = endStats.convoLength - startStats.convoLength >= TURNS; // at minimum user messages persisted
  console.log(`\n[drift] VERDICT: ${driftOK && storageOK ? "PASS" : "INVESTIGATE"}`);
  if (!driftOK) console.log("  - latency drift >2× — check recentTurns slicing, prompt size, lock contention");
  if (!storageOK) console.log("  - conversation not persisting turns as expected");
  if (!driftOK || !storageOK) process.exitCode = 1;
})().catch(err => {
  console.error("[drift] FATAL:", err);
  process.exit(1);
});

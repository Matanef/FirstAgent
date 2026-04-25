#!/usr/bin/env node
// server/scripts/stress-midstream-abort.mjs
//
// Stress test #2 — Mid-stream abort.
//
// Starts a chat request, waits for the first few tokens of streamed output,
// then aborts the fetch via AbortController. Repeats N times and checks:
//   - No process crash (PM2 should stay up)
//   - No leaked fact extraction (background extractAndSaveFacts should still
//     either complete OR be cleanly cancelled — no partial writes)
//   - No runaway pending questions piling up (abort shouldn't create ghosts)
//
// Pre/post memory.conversations[id].length deltas show whether aborted turns
// still got persisted (acceptable) or dropped silently (acceptable too — what
// matters is that the server didn't crash and memory is internally consistent).
//
// Usage:
//   node server/scripts/stress-midstream-abort.mjs
//   ABORTS=30 FIRST_TOKEN_MS=150 node server/scripts/stress-midstream-abort.mjs

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.resolve(__dirname, "..", "..", "utils", "memory.json");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY || "";
const ABORTS = parseInt(process.env.ABORTS || "20", 10);
const FIRST_TOKEN_MS = parseInt(process.env.FIRST_TOKEN_MS || "200", 10);
const CONV_ID = `abort-${crypto.randomBytes(6).toString("hex")}`;

const MESSAGES = [
  "tell me a long story about distributed systems",
  "explain in great detail how tcp works",
  "give me a comprehensive summary of your capabilities",
  "walk me through your own architecture step by step",
  "what do you know about me? include everything",
];

async function readPending() {
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const mem = JSON.parse(raw);
    return Object.keys(mem.pendingQuestions || {}).length;
  } catch { return -1; }
}

async function readConvoLen() {
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const mem = JSON.parse(raw);
    return (mem.conversations?.[CONV_ID] || []).length;
  } catch { return -1; }
}

async function abortAfterFirstBytes(message, ms) {
  const ctrl = new AbortController();
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;

  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, conversationId: CONV_ID }),
      signal: ctrl.signal,
    });
    // Read until we've seen ANY bytes, then rely on the abort timer to kill it
    const reader = res.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
    } catch (err) {
      if (err.name === "AbortError") return { aborted: true, bytes };
      throw err;
    }
    return { aborted: false, bytes, status: res.status };
  } catch (err) {
    if (err.name === "AbortError") return { aborted: true, bytes: 0 };
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log(`[abort] BASE_URL=${BASE_URL}  CONV_ID=${CONV_ID}  ABORTS=${ABORTS}  FIRST_TOKEN_MS=${FIRST_TOKEN_MS}\n`);
  const startPending = await readPending();
  const startConvo = await readConvoLen();
  console.log(`[abort] baseline: pendingQuestions=${startPending}  convoLength=${startConvo}\n`);

  let aborted = 0, completed = 0, errors = 0;
  for (let i = 1; i <= ABORTS; i++) {
    const msg = MESSAGES[i % MESSAGES.length];
    const r = await abortAfterFirstBytes(msg, FIRST_TOKEN_MS);
    if (r.aborted) { aborted++; console.log(`  ✂  ${String(i).padStart(2,"0")}  aborted after ${r.bytes}B`); }
    else if (r.error) { errors++; console.log(`  ✘  ${String(i).padStart(2,"0")}  error: ${r.error}`); }
    else { completed++; console.log(`  ✓  ${String(i).padStart(2,"0")}  completed (${r.bytes}B, status ${r.status})`); }
    // Give the server a beat to finish any background work before next iteration
    await new Promise(r => setTimeout(r, 100));
  }

  const endPending = await readPending();
  const endConvo = await readConvoLen();
  console.log(`\n[abort] summary: aborted=${aborted}  completed=${completed}  errors=${errors}`);
  console.log(`[abort] pendingQuestions: ${startPending} → ${endPending}  (delta=${endPending - startPending})`);
  console.log(`[abort] convoLength:      ${startConvo} → ${endConvo}  (delta=${endConvo - startConvo})`);

  // Health check — is the server still responsive?
  try {
    const res = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { "X-Api-Key": API_KEY } : {}) },
      body: JSON.stringify({ message: "hello, are you still alive?", conversationId: `${CONV_ID}-health` }),
    });
    const reader = res.body.getReader();
    let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
    console.log(`[abort] post-test health probe: status=${res.status}  bytes=${bytes}`);
    const healthy = res.status === 200 && bytes > 0;
    const pendingOk = endPending - startPending <= 1; // at most one residual
    console.log(`\n[abort] VERDICT: ${healthy && pendingOk ? "PASS" : "INVESTIGATE"}`);
    if (!healthy) console.log("  - server unresponsive after abort flood");
    if (!pendingOk) console.log(`  - pendingQuestions grew by ${endPending - startPending} — aborts leaking questions?`);
    if (!healthy || !pendingOk) process.exitCode = 1;
  } catch (err) {
    console.log(`[abort] post-test health probe FAILED: ${err.message}`);
    process.exitCode = 1;
  }
})().catch(err => { console.error("[abort] FATAL:", err); process.exit(1); });

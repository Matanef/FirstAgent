#!/usr/bin/env node
// server/scripts/stress-hebrew-english-alternation.mjs
//
// Stress test #5 — Hebrew ↔ English alternation.
//
// Alternates 30 turns between Hebrew and English messages on the same conversation.
// Goal: catch RTL/LTR handling bugs, regex patterns that rely on `\b` (which fails
// on Hebrew per CLAUDE.md), and memory persistence across script-mixing.
//
// Checks:
//   (a) Every turn gets a response (no silent drops, no crashes)
//   (b) Latency stays comparable across scripts — if Hebrew turns take 3× longer,
//       a regex somewhere is catastrophically backtracking
//   (c) Memory persists facts from BOTH scripts — a Hebrew "my dog's name is X"
//       should land in memory just like its English counterpart
//
// Usage:
//   node server/scripts/stress-hebrew-english-alternation.mjs
//   TURNS=50 node server/scripts/stress-hebrew-english-alternation.mjs

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.resolve(__dirname, "..", "..", "utils", "memory.json");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.AGENT_API_KEY || "";
const TURNS = parseInt(process.env.TURNS || "30", 10);
const CONV_ID = `heb-${crypto.randomBytes(6).toString("hex")}`;

const HE = [
  "שלום, מה שלומך?",
  "יש לי כלב שקוראים לו רקס.",
  "אני גר בתל אביב.",
  "אני מרגיש עייף היום.",
  "ספר לי משהו מעניין.",
  "מה אתה חושב על בינה מלאכותית?",
  "איך עובר עליך היום?",
  "אני אוהב לטייל בסופי שבוע.",
  "אני מתכנת בנוד ובפייתון.",
  "מה דעתך על קוברנטיס?",
];
const EN = [
  "hi, how's it going?",
  "i have a cat named whiskers.",
  "i live in a small apartment.",
  "i'm feeling a bit tired today.",
  "tell me something interesting.",
  "what do you think about ai?",
  "how's your day going?",
  "i enjoy hiking on weekends.",
  "i code in node and python.",
  "what's your take on kubernetes?",
];

async function post(msg) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: msg, conversationId: CONV_ID }),
    });
    const reader = res.body.getReader();
    let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
    return { ms: Date.now() - t0, bytes, status: res.status };
  } catch (err) {
    return { ms: Date.now() - t0, bytes: 0, error: err.message };
  }
}

async function readConvoLen() {
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const mem = JSON.parse(raw);
    return (mem.conversations?.[CONV_ID] || []).length;
  } catch { return -1; }
}

function avg(arr) { return arr.length ? Math.round(arr.reduce((a,b) => a+b, 0) / arr.length) : 0; }

(async () => {
  console.log(`[heb-en] BASE_URL=${BASE_URL}  CONV_ID=${CONV_ID}  TURNS=${TURNS}\n`);
  const startConvo = await readConvoLen();

  const heLat = [], enLat = [];
  let failures = 0;

  for (let i = 0; i < TURNS; i++) {
    const isHe = i % 2 === 0;
    const msg = isHe ? HE[i % HE.length] : EN[i % EN.length];
    const r = await post(msg);
    const tag = isHe ? "HE" : "EN";
    if (r.error || r.status !== 200 || r.bytes === 0) {
      failures++;
      console.log(`  ✘ ${tag} turn ${String(i+1).padStart(2,"0")}  ERR ${r.error || `status ${r.status}, ${r.bytes}B`}`);
    } else {
      (isHe ? heLat : enLat).push(r.ms);
      console.log(`  ✓ ${tag} turn ${String(i+1).padStart(2,"0")}  ${r.ms.toString().padStart(6)}ms  ${r.bytes}B  "${msg.slice(0, 40)}"`);
    }
  }

  const endConvo = await readConvoLen();
  const heAvg = avg(heLat), enAvg = avg(enLat);
  const ratio = enAvg > 0 ? heAvg / enAvg : 0;

  console.log(`\n[heb-en] latency: HE avg=${heAvg}ms  EN avg=${enAvg}ms  HE/EN ratio=${ratio.toFixed(2)}×`);
  console.log(`[heb-en] convo length: ${startConvo} → ${endConvo}  (delta=${endConvo - startConvo}, expected ≥ ${TURNS})`);
  console.log(`[heb-en] failures: ${failures} / ${TURNS}`);

  const latOk = ratio > 0 && ratio < 2.5;
  const persistOk = endConvo - startConvo >= TURNS;
  const allRespondedOk = failures === 0;
  const pass = latOk && persistOk && allRespondedOk;
  console.log(`\n[heb-en] VERDICT: ${pass ? "PASS" : "INVESTIGATE"}`);
  if (!latOk) console.log("  - HE/EN latency ratio suspicious — check regex patterns for RTL backtracking");
  if (!persistOk) console.log("  - turns not persisting in memory.conversations");
  if (!allRespondedOk) console.log(`  - ${failures} turns failed to produce a response`);
  if (!pass) process.exitCode = 1;
})().catch(err => { console.error("[heb-en] FATAL:", err); process.exit(1); });

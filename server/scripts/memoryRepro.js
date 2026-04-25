#!/usr/bin/env node
// server/scripts/memoryRepro.js
//
// READ-ONLY probe for the memory profile read path. No writes, no mutations.
//
// Purpose: safely reproduce the "weird/mean-toned reply to 'what is my mother's name?'"
// complaint without sending real WhatsApp traffic. Also exposes durable[] entries that
// would be filtered by the new allowlist in getEnrichedProfile() so the user can review.
//
// Run:  node server/scripts/memoryRepro.js

// Load .env from server/ (not repo root) — that's where MEMORY_ENCRYPTION_KEY lives.
// CRITICAL: dotenv must run BEFORE memory.js is imported, because memory.js reads
// process.env.MEMORY_ENCRYPTION_KEY at module-load time. Use dynamic import below.
import { config as dotenvConfig } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "..", ".env") });

if (!process.env.MEMORY_ENCRYPTION_KEY) {
  console.error("❌ MEMORY_ENCRYPTION_KEY not loaded from server/.env — decryption will fail.");
  console.error("   Looked at:", path.resolve(__dirname, "..", ".env"));
  process.exit(1);
}

const { getMemory } = await import("../memory.js");
const { memorytool } = await import("../tools/memoryTool.js");

function redact(s, n = 40) {
  if (!s) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function section(title) {
  console.log("\n" + "═".repeat(70));
  console.log("  " + title);
  console.log("═".repeat(70));
}

async function main() {
  section("1. MEMORY STRUCTURE OVERVIEW");
  const mem = await getMemory();
  const profile = mem.profile || {};

  console.log("profile keys:           ", Object.keys(profile).join(", ") || "(none)");
  console.log("profile.self keys:      ", Object.keys(profile.self || {}).join(", ") || "(none)");
  console.log("profile.contacts keys:  ", Object.keys(profile.contacts || {}).join(", ") || "(none)");
  console.log("profile.knownFacts:     ", (profile.knownFacts || []).length, "entries");
  console.log("durable[]:              ", (mem.durable || []).length, "entries");
  console.log("conversations:          ", Object.keys(mem.conversations || {}).length);

  section("2. DURABLE ENTRIES (redacted previews)");
  const durables = mem.durable || [];
  if (durables.length === 0) {
    console.log("(empty)");
  } else {
    durables.forEach((d, i) => {
      const fact = (d && typeof d === "object") ? d.fact : (typeof d === "string" ? d : null);
      const savedAt = d?.savedAt || "?";
      console.log(`  [${i}] savedAt=${savedAt}  fact="${redact(fact)}"`);
    });
  }

  section("3. KNOWN-FACT ENTRIES (redacted previews)");
  const kfs = profile.knownFacts || [];
  if (kfs.length === 0) {
    console.log("(empty)");
  } else {
    kfs.forEach((f, i) => {
      const stmt = f?.statement || f?.fact || String(f);
      const cat = f?.category || "?";
      const status = f?.status || "?";
      console.log(`  [${i}] [${cat}/${status}] "${redact(stmt, 60)}"`);
    });
  }

  section("4. ALLOWLIST FILTER PREVIEW (what getEnrichedProfile would drop)");
  const MEAN_WORDS = /\b(stupid|idiot|shut\s*up|dumb|hate\s+you|ugly|worthless|pathetic)\b/i;
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const PHONE_RE = /(?:\+?\d[\s\-().]*){7,}\d/;
  const TOKEN_RE = /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9_\-.=]{10,})\b/;
  const flagged = [];
  durables.forEach((d, i) => {
    const fact = (d && typeof d === "object") ? d.fact : (typeof d === "string" ? d : null);
    if (!fact) return;
    const reasons = [];
    if (MEAN_WORDS.test(fact)) reasons.push("mean");
    if (EMAIL_RE.test(fact))   reasons.push("email");
    if (PHONE_RE.test(fact))   reasons.push("phone");
    if (TOKEN_RE.test(fact))   reasons.push("token");
    if (reasons.length > 0) flagged.push({ i, reasons, preview: redact(fact, 60) });
  });
  if (flagged.length === 0) {
    console.log("No durables would be filtered. ✅");
  } else {
    console.log(`${flagged.length} durable(s) WOULD BE DROPPED from LLM prompt injection:`);
    flagged.forEach(f => console.log(`  [${f.i}] reasons=[${f.reasons.join(",")}]  "${f.preview}"`));
  }

  section("5. DRY-RUN memoryTool QUERIES");
  const queries = [
    "what is my mother's name?",
    "what is my mom's name?",
    "what do you remember about me?",
    "what is the name of my dog?",
  ];
  for (const q of queries) {
    console.log(`\n  Q: "${q}"`);
    try {
      const result = await memorytool({ text: q });
      const msg = result?.data?.message || result?.error || "(no message)";
      console.log(`  → tool=${result?.tool} success=${result?.success}`);
      console.log(`  → message: ${redact(msg, 200)}`);
    } catch (err) {
      console.log(`  → ERROR: ${err.message}`);
    }
  }

  section("DONE");
  console.log("No writes were performed. Memory file is untouched.\n");
}

main().catch(err => {
  console.error("memoryRepro failed:", err);
  process.exit(1);
});

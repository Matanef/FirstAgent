#!/usr/bin/env node
// server/scripts/clean-polluted-durables.mjs
//
// One-shot cleanup: surfaces and (optionally) removes polluted entries from
// memory.durable[] that were saved raw by the old regex extractor BEFORE the
// pronoun-framing + structured-fact pipeline landed.
//
// Problem this fixes:
//   The old extractor persisted the user's message verbatim as a "fact". Small
//   LLMs then read entries like:
//     - "his name is Lanou"  →  the LLM addresses the user as "Lanou"
//     - "you are called after it Lanou"  →  the LLM introduces itself as "Lanou"
//   ...because they can't resolve pronouns from the user's perspective without
//   explicit framing. The buildUserContext() change in chatAgent.js now prefixes
//   these with "The user told you:" so pronouns disambiguate, but legacy entries
//   may still be junk (garbled, self-contradicting, second-person addressed to
//   the user instead of the agent).
//
// Heuristics for "polluted":
//   1. Bare "his/her/their name is X" with no preceding "my <relation>" anchor
//      — likely a story fragment, not a durable user fact.
//   2. "you are called X" / "you are X" / "your name is X" — user addressing the
//      agent; the old regex grabbed it as a fact about the user.
//   3. Entries shorter than 15 chars (too terse to be meaningful).
//   4. Entries containing a continuation marker ("User:", "Assistant:", etc).
//   5. Duplicates (same fact text saved multiple times).
//
// Usage:
//   node server/scripts/clean-polluted-durables.mjs            # dry-run: list only
//   node server/scripts/clean-polluted-durables.mjs --apply    # actually delete
//   node server/scripts/clean-polluted-durables.mjs --apply --backup  # write memory.json.bak first

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.resolve(__dirname, "..", "..", "utils", "memory.json");

const APPLY = process.argv.includes("--apply");
const BACKUP = process.argv.includes("--backup");

const POLLUTION_RULES = [
  {
    name: "second-person-addressed-to-agent",
    test: (fact) => /\b(?:you\s+are\s+(?:called\s+)?(?:after\s+\w+\s+)?\w+|your\s+name\s+is\s+\w+)\b/i.test(fact),
    reason: "user was addressing the agent; old regex captured it as user fact",
  },
  {
    name: "bare-third-person-name",
    test: (fact) => {
      // "his/her/their name is X" WITHOUT a preceding "my <relation>" anchor that would
      // ground the antecedent. Fragment like this leaks into next-turn prompts as a
      // context-free "User fact: his name is Lanou" and confuses pronoun resolution.
      if (!/\b(?:his|her|their)\s+name\s+(?:is|was)\s+[A-Z]/.test(fact)) return false;
      return !/\bmy\s+(?:dog|cat|pet|mother|mom|father|dad|sister|brother|wife|husband|son|daughter|friend|partner|boyfriend|girlfriend|therapist|psychiatrist|doctor|manager|boss|colleague)\b/i.test(fact);
    },
    reason: "third-person name with no anchor — likely story fragment",
  },
  {
    name: "too-short",
    test: (fact) => fact.trim().length < 15,
    reason: "too terse to be a meaningful durable fact",
  },
  {
    name: "contains-continuation-marker",
    test: (fact) => /\b(?:User|Assistant|System|AI):\s*/.test(fact) || /<\|(?:im_start|im_end|endoftext)\|>/.test(fact),
    reason: "contains conversation-marker leakage from model hallucination",
  },
];

function classify(entry) {
  const fact = entry?.fact;
  if (!fact || typeof fact !== "string") return null;
  for (const rule of POLLUTION_RULES) {
    if (rule.test(fact)) return rule;
  }
  return null;
}

(async () => {
  let raw;
  try {
    raw = await fs.readFile(MEMORY_FILE, "utf8");
  } catch (err) {
    console.error(`[clean-durables] Could not read ${MEMORY_FILE}:`, err.message);
    process.exit(1);
  }

  let mem;
  try {
    mem = JSON.parse(raw);
  } catch (err) {
    console.error(`[clean-durables] memory.json is not valid JSON:`, err.message);
    process.exit(1);
  }

  const durable = mem.durable;
  if (!Array.isArray(durable)) {
    if (durable && durable._encrypted) {
      console.error(`[clean-durables] memory.durable is encrypted — this script cannot inspect it. Decrypt first.`);
      process.exit(1);
    }
    console.log(`[clean-durables] memory.durable is not an array (${typeof durable}). Nothing to do.`);
    process.exit(0);
  }

  console.log(`[clean-durables] scanning ${durable.length} durable entries...`);
  console.log(`[clean-durables] mode: ${APPLY ? "APPLY (will remove)" : "DRY RUN (preview only)"}`);
  if (APPLY && BACKUP) console.log(`[clean-durables] backup: will write memory.json.bak first`);
  console.log("");

  const flagged = [];
  const seen = new Map();  // fact (lowercased) → first-index
  const duplicates = [];

  durable.forEach((entry, idx) => {
    const pollution = classify(entry);
    if (pollution) {
      flagged.push({ idx, entry, rule: pollution });
      return;
    }
    const key = entry?.fact?.trim().toLowerCase();
    if (key) {
      if (seen.has(key)) duplicates.push({ idx, entry, firstIdx: seen.get(key) });
      else seen.set(key, idx);
    }
  });

  console.log(`[clean-durables] flagged by pollution rules: ${flagged.length}`);
  for (const { idx, entry, rule } of flagged) {
    const excerpt = (entry.fact || "").slice(0, 90);
    console.log(`  [${idx}] (${rule.name}) "${excerpt}"  — ${rule.reason}`);
  }
  console.log(`\n[clean-durables] exact duplicates (of an earlier entry): ${duplicates.length}`);
  for (const { idx, firstIdx, entry } of duplicates) {
    const excerpt = (entry.fact || "").slice(0, 90);
    console.log(`  [${idx}] dup of [${firstIdx}]: "${excerpt}"`);
  }

  const removeSet = new Set([...flagged.map(f => f.idx), ...duplicates.map(d => d.idx)]);
  console.log(`\n[clean-durables] total to remove: ${removeSet.size}  (keeping ${durable.length - removeSet.size})`);

  if (!APPLY) {
    console.log(`\n[clean-durables] dry run complete. Re-run with --apply to remove.`);
    return;
  }

  if (BACKUP) {
    const backupPath = MEMORY_FILE + ".bak." + Date.now();
    await fs.writeFile(backupPath, raw, "utf8");
    console.log(`[clean-durables] backup written: ${backupPath}`);
  }

  mem.durable = durable.filter((_, idx) => !removeSet.has(idx));
  await fs.writeFile(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf8");
  console.log(`[clean-durables] memory.json updated. ${removeSet.size} entries removed.`);
})().catch(err => {
  console.error("[clean-durables] FATAL:", err);
  process.exit(1);
});

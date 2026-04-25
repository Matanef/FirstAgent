// server/utils/factExtractor.js
// Structured personal-fact extractor + lifecycle reconciliation.
//
// Runs post-turn (background). Takes the user message + currently active facts,
// asks a small LLM to decide:
//   - Did the user share a NEW durable personal fact?          → add
//   - Did the user CONTRADICT an existing fact?                → update (retire + add)
//   - Did the user just chat with no durable content?          → none
//
// Output lands in memory.profile.knownFacts[] — distinct from memory.durable[]
// (which keeps raw-message fallback entries from the regex extractor).
//
// Schema per fact:
//   {
//     id: "kf_<hex>",
//     statement: "<one-sentence third-person summary>",
//     entity: "<primary subject, if any>" | null,
//     category: "pet" | "family" | "health" | "work" | "location" | "hobby" | "preference" | "other",
//     status: "active" | "retired",
//     capturedAt: ISO,
//     retiredAt: ISO | null,
//     supersededBy: fact-id | null,
//     sourceMessage: "<excerpt>",
//   }

import crypto from "crypto";
import { llm } from "../tools/llm.js";

const MAX_SOURCE_LEN = 400;
const MAX_STATEMENT_LEN = 300;
const FACT_MODEL = "qwen2.5:7b"; // fast + decent at structured JSON; falls back to default if absent

function newId() { return `kf_${crypto.randomBytes(6).toString("hex")}`; }
function nowIso() { return new Date().toISOString(); }
function truncate(s, n) { return (s || "").length > n ? s.slice(0, n) : (s || ""); }

/**
 * Build the prompt that asks the LLM to extract + reconcile facts.
 * Returns strict JSON { actions: [...] }.
 */
function buildExtractorPrompt(message, activeFacts) {
  const factsJson = activeFacts.length === 0
    ? "[]"
    : JSON.stringify(
        activeFacts.map(f => ({
          id: f.id,
          statement: f.statement,
          entity: f.entity,
          category: f.category
        })),
        null, 2
      );

  return `You are a fact-extraction classifier. You read one user message and decide whether it contains a NEW durable personal fact, or CONTRADICTS an existing fact.

Durable facts are persistent truths about the user, their life, their relationships, or their world: their name, age, profession, where they live, pets/family/partners, health conditions they've disclosed, hobbies, strong preferences. They remain true across sessions.

NOT durable: small talk, transient moods ("i'm tired"), reactions to topics, hypotheticals, single-event news ("i went to the store today"), instructions to the agent, technical debugging.

CURRENTLY KNOWN FACTS about the user (active, previously captured):
${factsJson}

THE USER JUST SAID:
"""${truncate(message, 800)}"""

Decide and return ONLY this exact JSON shape (no prose before or after, no markdown):

{
  "actions": [
    // Zero or more of:
    // { "action": "add",    "statement": "<third-person sentence>", "entity": "<name or null>", "category": "pet|family|health|work|location|hobby|preference|other" }
    // { "action": "retire", "replacesId": "<existing fact id>", "reason": "<brief>" }
    // { "action": "update", "replacesId": "<existing fact id>", "statement": "<new third-person sentence>", "entity": "...", "category": "..." }
  ]
}

Rules:
- If the message has no durable content, return {"actions": []}.
- "add" is for brand-new facts not covered by any existing fact.
- "retire" is for explicit contradictions with NO replacement ("I quit my job" with no new job mentioned).
- "update" is for contradictions WITH a replacement ("I moved to Berlin" when we know they live in Tel Aviv).
- Write "statement" in third person: e.g. "The user works as a software engineer." (Use the ACTUAL content of the message — do not copy this example verbatim.)
- "entity" is the primary named subject (a person, pet, place). Null if none.
- Keep statements short (under 200 chars) and self-contained.
- Do NOT add facts that merely rephrase existing ones.
- Do NOT infer facts the user did not actually state.

JSON:`;
}

/**
 * Parse LLM output — expects JSON object with "actions" array.
 * Lenient: strips markdown fences, trailing prose, and attempts to find the first {...} block.
 */
function parseExtractorOutput(raw) {
  if (!raw || typeof raw !== "string") return { actions: [] };
  let text = raw.trim();

  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  // Find the first {...} block — LLM may add prose before/after despite instructions
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return { actions: [] };
  const jsonCandidate = text.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(jsonCandidate);
    if (!parsed || !Array.isArray(parsed.actions)) return { actions: [] };
    return parsed;
  } catch {
    return { actions: [] };
  }
}

const VALID_CATEGORIES = new Set(["pet", "family", "health", "work", "location", "hobby", "preference", "other"]);

/**
 * Validate + apply one action to the knownFacts array (mutating copy).
 * Returns { changed: boolean, log: string[] }.
 */
function applyAction(action, facts, sourceMessage) {
  const log = [];
  if (!action || typeof action !== "object") return { changed: false, log };

  const now = nowIso();

  if (action.action === "add") {
    const statement = truncate(String(action.statement || "").trim(), MAX_STATEMENT_LEN);
    if (!statement) return { changed: false, log };
    const category = VALID_CATEGORIES.has(action.category) ? action.category : "other";
    const entity = action.entity ? String(action.entity).slice(0, 100) : null;

    // Dedupe: if an active fact has an identical statement, skip
    const dup = facts.find(f => f.status === "active" && f.statement.toLowerCase() === statement.toLowerCase());
    if (dup) { log.push(`skip add (duplicate of ${dup.id})`); return { changed: false, log }; }

    facts.push({
      id: newId(),
      statement,
      entity,
      category,
      status: "active",
      capturedAt: now,
      retiredAt: null,
      supersededBy: null,
      sourceMessage: truncate(sourceMessage, MAX_SOURCE_LEN),
    });
    log.push(`+ add [${category}] "${statement.slice(0, 80)}"`);
    return { changed: true, log };
  }

  if (action.action === "retire") {
    const target = facts.find(f => f.id === action.replacesId && f.status === "active");
    if (!target) { log.push(`skip retire (id ${action.replacesId} not active)`); return { changed: false, log }; }
    target.status = "retired";
    target.retiredAt = now;
    log.push(`- retire ${target.id} "${target.statement.slice(0, 80)}" — ${action.reason || "user contradicted it"}`);
    return { changed: true, log };
  }

  if (action.action === "update") {
    const target = facts.find(f => f.id === action.replacesId && f.status === "active");
    const statement = truncate(String(action.statement || "").trim(), MAX_STATEMENT_LEN);
    if (!target) { log.push(`skip update (id ${action.replacesId} not active)`); return { changed: false, log }; }
    if (!statement) { log.push(`skip update (no replacement statement)`); return { changed: false, log }; }

    const category = VALID_CATEGORIES.has(action.category) ? action.category : target.category;
    const entity = action.entity ? String(action.entity).slice(0, 100) : target.entity;

    const replacement = {
      id: newId(),
      statement,
      entity,
      category,
      status: "active",
      capturedAt: now,
      retiredAt: null,
      supersededBy: null,
      sourceMessage: truncate(sourceMessage, MAX_SOURCE_LEN),
    };
    target.status = "retired";
    target.retiredAt = now;
    target.supersededBy = replacement.id;
    facts.push(replacement);
    log.push(`↻ update ${target.id} → ${replacement.id} [${category}] "${statement.slice(0, 80)}"`);
    return { changed: true, log };
  }

  return { changed: false, log: [`skip unknown action "${action.action}"`] };
}

/**
 * Extract + reconcile structured facts from a user message.
 *
 * @param {string} message          Raw user message
 * @param {Array}  existingFacts    Current memory.profile.knownFacts array (may be null/undefined)
 * @returns {Promise<{ facts: Array, changed: boolean, log: string[] }>}
 *   - `facts`: the (possibly) mutated knownFacts array. Caller persists this to memory.
 *   - `changed`: whether anything was added/retired/superseded.
 *   - `log`: human-readable summary lines for logging.
 */
export async function extractStructuredFacts(message, existingFacts = []) {
  const out = { facts: Array.isArray(existingFacts) ? [...existingFacts] : [], changed: false, log: [] };

  if (!message || typeof message !== "string" || message.trim().length < 15) return out;

  // Skip interrogatives — questions ask for information, they don't disclose facts.
  // Extracting "facts" from "what is my dog's name?" produces hallucinations
  // (the LLM invents an answer and stores it as a fact).
  const trimmed = message.trim();
  if (
    /^\s*(what(?:'s| is)?|who(?:'s| is)?|where(?:'s| is)?|when(?:'s| is)?|why|how|which|do\s+you|did\s+you|can\s+you|could\s+you|have\s+you|are\s+you|is\s+there|tell\s+me)\b/i.test(trimmed) ||
    trimmed.endsWith("?")
  ) {
    out.log.push("skip (interrogative — questions don't disclose facts)");
    return out;
  }

  // Cheap prefilter — bail early on messages that clearly carry no personal signal.
  // Saves an LLM call on most chat traffic.
  if (!/\b(my|i'm|i am|i\s+have|i\s+had|i\s+got|i\s+live|i\s+work|i\s+quit|i\s+moved|i\s+adopted|i\s+rescued|i\s+love|i\s+hate|name\s+is|years?\s+old|his|her|their)\b/i.test(message)) {
    return out;
  }

  const activeFacts = out.facts.filter(f => f.status === "active");

  let raw;
  try {
    const prompt = buildExtractorPrompt(message, activeFacts);
    const result = await llm(prompt, {
      model: FACT_MODEL,
      skipKnowledge: true,
      timeoutMs: 15_000,
      options: { temperature: 0.1 },
    });
    raw = result?.data?.text || "";
  } catch (err) {
    out.log.push(`llm call failed: ${err.message}`);
    return out;
  }

  const parsed = parseExtractorOutput(raw);
  if (!parsed.actions.length) return out;

  for (const action of parsed.actions) {
    const { changed, log } = applyAction(action, out.facts, message);
    if (changed) out.changed = true;
    out.log.push(...log);
  }

  return out;
}

/**
 * Cap the knownFacts array to a reasonable size for serialization + prompt injection.
 * Retired facts are pruned first; active facts are never dropped.
 */
export function pruneKnownFacts(facts, maxRetired = 50, maxActive = 200) {
  if (!Array.isArray(facts)) return [];
  const active = facts.filter(f => f.status === "active");
  const retired = facts
    .filter(f => f.status !== "active")
    .sort((a, b) => new Date(b.retiredAt || 0) - new Date(a.retiredAt || 0))
    .slice(0, maxRetired);
  return [...active.slice(0, maxActive), ...retired];
}

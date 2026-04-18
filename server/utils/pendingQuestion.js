// server/utils/pendingQuestion.js
// Reusable pause/resume mechanism for skills that need to ask the user a follow-up
// (e.g. deepResearch asking for a depth tier when none was specified).
//
// Storage: writes through memory.js as `meta.pendingQuestions[conversationId]`.
// One pending question per conversation. TTL 10 min, lazily pruned on read.

import crypto from "crypto";
import { getMemory, saveJSON, MEMORY_FILE, withMemoryLock } from "../memory.js";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

function nowIso() { return new Date().toISOString(); }

function isExpired(entry) {
  if (!entry?.createdAt) return true;
  const created = Date.parse(entry.createdAt);
  if (isNaN(created)) return true;
  return Date.now() - created > TTL_MS;
}

/**
 * Persist a pending question for a conversation.
 *
 * @param {string} conversationId
 * @param {object} pending
 * @param {string} pending.skill            originating skill name (e.g. "deepResearch")
 * @param {string} pending.question         user-facing question text
 * @param {string} pending.expects          machine-readable hint (e.g. "depth")
 * @param {object} pending.originalRequest  full original request payload to resume with
 * @returns {Promise<object>} the stored entry (with id + createdAt)
 */
export async function setPendingQuestion(conversationId, pending) {
  if (!conversationId) throw new Error("setPendingQuestion: conversationId required");
  if (!pending || !pending.question || !pending.expects) {
    throw new Error("setPendingQuestion: pending must include {question, expects}");
  }
  const entry = {
    id: pending.id || `pq_${crypto.randomBytes(6).toString("hex")}`,
    skill: pending.skill || "unknown",
    question: pending.question,
    expects: pending.expects,
    originalRequest: pending.originalRequest || null,
    createdAt: nowIso()
  };
  return await withMemoryLock(async () => {
    const mem = await getMemory();
    mem.meta = mem.meta || {};
    mem.meta.pendingQuestions = mem.meta.pendingQuestions || {};
    mem.meta.pendingQuestions[conversationId] = entry;
    await saveJSON(MEMORY_FILE, mem);
    return entry;
  });
}

/**
 * Read the active pending question for a conversation.
 * Lazily prunes expired entries.
 *
 * @param {string} conversationId
 * @returns {Promise<object|null>}
 */
export async function getPendingQuestion(conversationId) {
  if (!conversationId) return null;
  const mem = await getMemory();
  const entry = mem?.meta?.pendingQuestions?.[conversationId] || null;
  if (!entry) return null;
  if (isExpired(entry)) {
    await clearPendingQuestion(conversationId).catch(() => {});
    return null;
  }
  return entry;
}

/**
 * Remove the pending question for a conversation.
 *
 * @param {string} conversationId
 * @returns {Promise<boolean>} true if an entry was removed
 */
export async function clearPendingQuestion(conversationId) {
  if (!conversationId) return false;
  return await withMemoryLock(async () => {
    const mem = await getMemory();
    if (mem?.meta?.pendingQuestions?.[conversationId]) {
      delete mem.meta.pendingQuestions[conversationId];
      await saveJSON(MEMORY_FILE, mem);
      return true;
    }
    return false;
  });
}

/**
 * Best-effort parser that turns a user reply into the value the pending question expected.
 * Currently supports `expects: "depth"`. Returns null on unrecognized input
 * so the caller can re-ask without consuming the pending entry.
 *
 * @param {string} message  raw user message
 * @param {string} expects  expectation hint (e.g. "depth")
 * @returns {string|null}
 */
export function parsePendingAnswer(message, expects) {
  if (!message || typeof message !== "string") return null;
  const m = message.trim().toLowerCase();
  if (!m) return null;

  // yes/no confirmation (used by tool-intercept warnings)
  if (expects === "yes_no") {
    if (/^(yes|yeah|yep|sure|ok|okay|go\s+ahead|proceed|do\s+it|confirm|run\s+it)[!?.\s]*$/i.test(m)) return "yes";
    if (/^(no|nope|nah|don'?t|stop|cancel|just\s+chat|keep\s+chatting|skip\s+(the\s+)?tool|just\s+talk)[!?.\s]*$/i.test(m)) return "no";
    return null; // unrecognised — leave pending entry intact
  }

  if (expects === "depth") {
    // Numeric short answers: 1=article, 2=indepth, 3=research, 4=thesis
    const numMatch = m.match(/^([1-4])\b/);
    if (numMatch) {
      return ["article", "indepth", "research", "thesis"][parseInt(numMatch[1], 10) - 1];
    }
    // English keywords (\b works for ASCII)
    if (/\b(article|brief|summary|overview)\b/.test(m)) return "article";
    if (/\b(in[\s-]?depth|deep[\s-]?dive|detailed|guide)\b/.test(m)) return "indepth";
    if (/\b(research|paper|study|literature\s+review)\b/.test(m)) return "research";
    if (/\b(thesis|dissertation|comprehensive)\b/.test(m)) return "thesis";
    // Hebrew keywords (\b doesn't work — use whitespace boundaries)
    if (/(?:^|\s)(מאמר|סקירה|תקציר)(\s|$)/.test(m)) return "article";
    if (/(?:^|\s)(מדריך|מעמיק|מפורט)(\s|$)/.test(m)) return "indepth";
    if (/(?:^|\s)(מחקר|סקר\s+ספרות)(\s|$)/.test(m)) return "research";
    if (/(?:^|\s)(תזה|דוקטורט|עבודת\s+גמר)(\s|$)/.test(m)) return "thesis";
    return null;
  }

  // Default: echo back trimmed message — caller decides what to do with it
  return message.trim();
}

export const PENDING_QUESTION_TTL_MS = TTL_MS;

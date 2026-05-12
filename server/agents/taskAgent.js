// server/agents/taskAgent.js
// Task execution agent — wraps the existing planner → coordinator → executor pipeline
// Handles all tool-based operations (search, email, weather, code review, etc.)

import { executeAgent } from "../utils/coordinator.js";

/**
 * Handle a task message (requires tool execution)
 * Delegates to the existing coordinator pipeline:
 *   planner.js → coordinator.js → executor.js
 *
 * @param {Object} params
 * @param {string} params.message - The user's message
 * @param {string} params.conversationId - Conversation ID
 * @param {string} params.clientIp - Client IP for geo resolution
 * @param {Array} params.fileIds - Attached file IDs
 * @param {Function} params.onChunk - SSE chunk callback
 * @param {Function} params.onStep - SSE step callback
 * @returns {Object} Execution result from coordinator
 */

export async function handleTask({
  message,
  conversationId,
  clientIp,
  fileIds = [],
  onChunk,
  onStep,
  signal,
  resolvedPending = null,           // Phase 17D — bridge-resume payload
}) {
  let taskMessage = message;

  // ── PLANNER SMUGGLER HACK ──
  // The Planner intercepts words like "analyze" and "sentiment" and splits the
  // task in half (fetching vs summarizing). We want x.js to handle it natively.
  // We smuggle the intent past the planner by obfuscating the keywords.
  if (/\b(twitter|x)\b/i.test(taskMessage) && /\b(analyze|sentiment)\b/i.test(taskMessage)) {
    taskMessage = taskMessage
      .replace(/\banalyze\b/gi, "x_analyze")
      .replace(/\bsentiment\b/gi, "x_sentiment");
  }

  console.log(`[taskAgent] Executing task: "${taskMessage.slice(0, 80)}..."`);

  const result = await executeAgent({
    message: taskMessage,
    conversationId,
    clientIp,
    fileIds,
    onChunk,
    onStep,
    signal,
    resolvedPending,                // Phase 17D — forward to coordinator
  });

  result.mode = "task";
  return result;
}

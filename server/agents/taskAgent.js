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
}) {
  console.log(`[taskAgent] Executing task: "${message.slice(0, 80)}..."`);

  const result = await executeAgent({
    message,
    conversationId,
    clientIp,
    fileIds,
    onChunk,
    onStep,
    signal,
  });

  // Attach mode marker
  result.mode = "task";

  return result;
}

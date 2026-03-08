// server/agents/orchestrator.js
// Main orchestrator — routes every user message to chatAgent or taskAgent
// based on intent classification. Manages conversation mode tracking.

import { classifyIntent } from "../utils/intentClassifier.js";
import { handleChat } from "./chatAgent.js";
import { handleTask } from "./taskAgent.js";
import { getRecentTurns, addTurn } from "../utils/conversationMemory.js";

/**
 * Handle an incoming user message
 * 1. Load recent conversation turns for context
 * 2. Classify intent (chat vs task)
 * 3. Route to appropriate agent
 * 4. Store result with mode tag
 *
 * @param {Object} params
 * @param {string} params.message - The user's message
 * @param {string} params.conversationId - Conversation ID
 * @param {string} params.clientIp - Client IP for geo
 * @param {Array} params.fileIds - Attached file IDs
 * @param {Function} params.onChunk - SSE chunk callback
 * @param {Function} params.onStep - SSE step callback
 * @returns {Object} Agent response
 */
export async function handleMessage({
  message,
  conversationId,
  clientIp,
  fileIds = [],
  onChunk,
  onStep,
}) {
  // 1. Load recent conversation turns
  const recentTurns = await getRecentTurns(conversationId, 5);

  // 2. Classify intent
  const classification = classifyIntent(message, recentTurns);
  console.log(`[orchestrator] Intent: ${classification.mode} (${(classification.confidence * 100).toFixed(0)}%) — ${classification.reason}`);

  // Store user turn
  await addTurn(conversationId, {
    role: "user",
    content: message,
    mode: classification.mode,
    timestamp: new Date().toISOString(),
  });

  let result;

  // 3. Route to appropriate agent
  if (classification.mode === "chat") {
    // Send a thinking step for UI feedback
    if (onStep) {
      onStep({ step: 1, total: 1, label: "Thinking...", status: "running", tool: "chatAgent" });
    }

    result = await handleChat(message, recentTurns);

    if (onStep) {
      onStep({ step: 1, total: 1, label: "Thinking...", status: "completed", tool: "chatAgent" });
    }

    // Stream the chat response
    if (onChunk && result.reply) {
      onChunk(result.reply);
    }
  } else {
    // Task mode — delegate to taskAgent (which uses coordinator pipeline)
    result = await handleTask({
      message,
      conversationId,
      clientIp,
      fileIds,
      onChunk,
      onStep,
    });
  }

  // 4. Store assistant turn with mode tag
  await addTurn(conversationId, {
    role: "assistant",
    content: result.reply || "",
    mode: classification.mode,
    tool: result.tool,
    timestamp: new Date().toISOString(),
  });

  // Attach classification metadata to result
  result.classification = classification;

  return result;
}

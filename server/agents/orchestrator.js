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

  // Train of Thought helper for non-task paths
  function emitThought(phase, content, data = {}) {
    if (onStep) {
      onStep({ type: "thought", phase, content, data, timestamp: new Date().toISOString() });
    }
  }

  // 3. Route to appropriate agent
  if (classification.mode === "chat") {
    // Emit reasoning for chat path
    emitThought("THOUGHT",
      `Analyzing: "${message.length > 80 ? message.slice(0, 80) + "..." : message}". ` +
      `Classified as conversational (${(classification.confidence * 100).toFixed(0)}% confidence). Reason: ${classification.reason}.`,
      { mode: "chat", confidence: classification.confidence }
    );
    emitThought("PLAN", "Plan: 1 step — 1. chatAgent (conversational response)", { steps: [{ tool: "chatAgent", reasoning: classification.reason }], stepCount: 1 });
    emitThought("EXECUTION", "Executing step 1/1: chatAgent — generating conversational response", { step: 1, total: 1, tool: "chatAgent" });

    result = await handleChat(message, recentTurns);

    emitThought("OBSERVATION",
      `chatAgent completed successfully. Preview: ${(result.reply || "").slice(0, 150)}${(result.reply || "").length > 150 ? "..." : ""}`,
      { step: 1, tool: "chatAgent", success: true }
    );
    emitThought("ANSWER", "Delivering conversational response.", { tool: "chatAgent", stepsCompleted: 1 });

    // Attach thoughtChain to result for chat path
    result.thoughtChain = [
      { phase: "THOUGHT", content: `Classified as conversational (${(classification.confidence * 100).toFixed(0)}% confidence). Reason: ${classification.reason}.`, data: { mode: "chat" }, timestamp: new Date().toISOString() },
      { phase: "PLAN", content: "Plan: 1 step — chatAgent (conversational response)", data: { stepCount: 1 }, timestamp: new Date().toISOString() },
      { phase: "EXECUTION", content: "Executing chatAgent", data: { tool: "chatAgent" }, timestamp: new Date().toISOString() },
      { phase: "OBSERVATION", content: "chatAgent completed successfully.", data: { success: true }, timestamp: new Date().toISOString() },
      { phase: "ANSWER", content: "Delivering conversational response.", data: {}, timestamp: new Date().toISOString() },
    ];

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

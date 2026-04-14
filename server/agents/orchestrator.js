// server/agents/orchestrator.js
// Main orchestrator — logs the message and hands it to the unified chatAgent.

import { handleChat } from "./chatAgent.js";
import { getRecentTurns, addTurn } from "../utils/conversationMemory.js";
import { getPendingQuestion, clearPendingQuestion, parsePendingAnswer } from "../utils/pendingQuestion.js";

export async function handleMessage({
  message,
  conversationId,
  clientIp,
  fileIds = [],
  onChunk,
  onStep,
  signal,
}) {
  // 1. Load recent conversation turns
  const recentTurns = await getRecentTurns(conversationId, 5);

  // 2. Store user turn
  await addTurn(conversationId, {
    role: "user",
    content: message,
    mode: "chat",
    timestamp: new Date().toISOString(),
  });

  // 2.5 Pending-question resume hook.
  // If a previous skill turn paused for user input (e.g. deepResearch asking depth tier),
  // try to parse this message as the answer. On successful parse, clear the pending entry
  // and rerun the original request with `resolvedPending` injected into context so the
  // skill skips re-asking. On unparseable input, leave the pending entry alone (TTL prunes
  // stale ones) and let the normal chat flow proceed.
  let resumePayload = null;
  try {
    const pending = await getPendingQuestion(conversationId);
    if (pending) {
      const answer = parsePendingAnswer(message, pending.expects);
      if (answer !== null) {
        await clearPendingQuestion(conversationId);
        resumePayload = {
          originalText: pending.originalRequest?.text || pending.originalRequest?.message || message,
          resolvedPending: { [pending.expects]: answer, _skill: pending.skill }
        };
      }
    }
  } catch (err) {
    console.warn("[orchestrator] pending-question hook failed:", err.message);
  }

  // 3. Hand everything to the unified chatAgent (with optional resume payload)
  const dispatchMessage = resumePayload?.originalText || message;
  const result = await handleChat(dispatchMessage, recentTurns, {
    conversationId,
    clientIp,
    fileIds,
    onChunk,
    onStep,
    signal,
    resolvedPending: resumePayload?.resolvedPending || null
  });

  // 4. Store assistant turn
  const assistantContent = result.reply || result.data?.text || "";
  await addTurn(conversationId, {
    role: "assistant",
    content: assistantContent,
    mode: result.mode || "chat",
    tool: result.tool,
    timestamp: new Date().toISOString(),
  });

  return result;
}
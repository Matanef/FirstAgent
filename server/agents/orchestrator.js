// server/agents/orchestrator.js
// Main orchestrator — logs the message and hands it to the unified chatAgent.

import { handleChat } from "./chatAgent.js";
import { getRecentTurns, addTurn } from "../utils/conversationMemory.js";
import { getPendingQuestion, clearPendingQuestion, parsePendingAnswer } from "../utils/pendingQuestion.js";
import { runWithLLMPriority } from "../utils/llmContext.js";

export async function handleMessage(params) {
  // Every call from this entry point represents a live user turn. Wrap the
  // whole handler in the LLM priority scope so any `llm()` / `llmStream()`
  // call made anywhere inside (chatAgent, planner, synthesis, nested tools)
  // inherits `priority: "user"` via AsyncLocalStorage. Background callers
  // (scheduler, selfEvolve, heartbeats) run outside this scope and remain
  // "background" — they'll queue behind user work on the single-GPU gate.
  return runWithLLMPriority("user", () => _handleMessageInner(params));
}

async function _handleMessageInner({
  message,
  conversationId,
  clientIp,
  fileIds = [],
  onChunk,
  onStep,
  signal,
}) {
  const turnStart = Date.now();
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

  const totalMs = Date.now() - turnStart;
  if (totalMs > 2000) {
    console.log(`⏱️  [orchestrator] turn handled in ${totalMs}ms (tool=${result.tool || "chat"}, mode=${result.mode || "chat"})`);
  }
  return result;
}
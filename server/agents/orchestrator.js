// server/agents/orchestrator.js
// Main orchestrator — logs the message and hands it to the unified chatAgent.

import { handleChat } from "./chatAgent.js";
import { getRecentTurns, addTurn } from "../utils/conversationMemory.js";

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

  // 2. Store user turn
  await addTurn(conversationId, {
    role: "user",
    content: message,
    mode: "chat",
    timestamp: new Date().toISOString(),
  });

  // 3. Hand everything to the unified chatAgent
  const result = await handleChat(message, recentTurns, {
    conversationId,
    clientIp,
    fileIds,
    onChunk,
    onStep
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
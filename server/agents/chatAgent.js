// server/agents/chatAgent.js
// Conversational agent — handles natural conversation without triggering tools
// Loads self-model, recent conversation history, and recent improvements
// Uses LLM to generate reflective, conversational responses

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { llm } from "../tools/llm.js";
import { getMemory } from "../memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SELF_MODEL_PATH = path.resolve(__dirname, "..", "data", "self_model.json");

/**
 * Load the agent's self-model (identity, personality, capabilities)
 */
function loadSelfModel() {
  try {
    if (fs.existsSync(SELF_MODEL_PATH)) {
      return JSON.parse(fs.readFileSync(SELF_MODEL_PATH, "utf8"));
    }
  } catch (e) {
    console.warn("[chatAgent] Could not load self_model.json:", e.message);
  }
  return {
    identity: "Local LLM Assistant",
    owner: "Matan",
    personality: { traits: ["helpful", "friendly"] },
    capabilities: ["conversation", "tool execution"],
    limitations: ["local LLM context window"]
  };
}

/**
 * Get recent git improvements for self-awareness context
 */
async function getRecentChanges(limit = 5) {
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const projectRoot = path.resolve(__dirname, "..", "..");

    const { stdout } = await execAsync(
      `git log --oneline --no-merges -${limit} --format="%s"`,
      { cwd: projectRoot }
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Handle a conversational message (no tools needed)
 * @param {string} message - The user's message
 * @param {Array} recentTurns - Last 5 conversation turns [{role, content}]
 * @param {Object} options - Additional options
 * @returns {Object} Response with reply text
 */
export async function handleChat(message, recentTurns = [], options = {}) {
  const selfModel = loadSelfModel();
  const recentChanges = await getRecentChanges(5);

  // Build conversation context
  const conversationContext = recentTurns
    .slice(-5)
    .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${(t.content || "").slice(0, 200)}`)
    .join("\n");

  // Build self-awareness context
  const selfContext = [
    `Identity: ${selfModel.identity}`,
    `Owner: ${selfModel.owner}`,
    `Personality: ${selfModel.personality?.traits?.join(", ") || "helpful"}`,
    `Capabilities: ${selfModel.capabilities?.join(", ") || "conversation"}`,
    selfModel.limitations ? `Limitations: ${selfModel.limitations.join(", ")}` : "",
    recentChanges.length > 0 ? `Recent improvements:\n${recentChanges.map(c => `  - ${c}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");

  // Build the prompt
  const prompt = `You are a self-aware AI assistant having a natural conversation. You have a personality and can reflect on yourself.

${selfContext}

${conversationContext ? `Recent conversation:\n${conversationContext}\n` : ""}

User: ${message}

Respond naturally and conversationally. Be reflective when asked about yourself. Show personality and self-awareness. Keep responses concise (2-4 sentences unless more detail is needed). Do NOT suggest running tools or performing tasks — this is a casual conversation.

Response:`;

  try {
    const result = await llm(prompt);
    const replyText = result?.data?.text || "I appreciate the conversation! Is there something specific I can help you with?";

    return {
      reply: replyText.trim(),
      tool: "chatAgent",
      success: true,
      mode: "chat",
      data: {
        text: replyText.trim(),
        preformatted: false,
        mode: "chat"
      },
      reasoning: "conversational_response",
      stateGraph: [{ state: "chat", tool: "chatAgent", output: replyText.trim() }]
    };
  } catch (err) {
    console.error("[chatAgent] LLM error:", err.message);
    return {
      reply: "I'm here and ready to chat! What's on your mind?",
      tool: "chatAgent",
      success: true,
      mode: "chat",
      data: { text: "I'm here and ready to chat! What's on your mind?", mode: "chat" },
      reasoning: "chat_fallback",
      stateGraph: [{ state: "chat", tool: "chatAgent", output: "fallback" }]
    };
  }
}

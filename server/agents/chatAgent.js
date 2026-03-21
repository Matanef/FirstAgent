// server/agents/chatAgent.js
// Conversational agent — handles natural conversation without triggering tools.
// Loads personality, self-model, user profile, durable memories, and knowledge
// to provide informed, contextual responses.
//
// ARCHITECTURE NOTE (Option B extension point):
// Currently this agent answers purely from its loaded context (Option C).
// When the agent needs to become more sophisticated, add a `resolveWithTools()`
// function that delegates to the orchestrator/taskAgent for information retrieval,
// then feeds results back into the conversational prompt. The extension point is
// marked with "// OPTION_B_HOOK" below.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { llm } from "../tools/llm.js";
import { getMemory, getEnrichedProfile } from "../memory.js";
import { getPersonalityContext } from "../personality.js";
import { getKnowledgeContext } from "../knowledge.js";

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
 * Build user context from memory — profile, durable memories, knowledge.
 * This is the information the chatAgent "knows" about the user.
 */
async function buildUserContext(conversationId) {
  const parts = [];

  try {
    const enriched = await getEnrichedProfile(conversationId);

    // User profile
    const self = enriched.self || {};
    const profileFields = [];
    if (self.name) profileFields.push(`Name: ${self.name}`);
    if (self.location) profileFields.push(`Location: ${self.location}`);
    if (self.timezone) profileFields.push(`Timezone: ${self.timezone}`);
    if (self.email) profileFields.push(`Email: ${self.email}`);
    if (self.phone) profileFields.push(`Phone: ${self.phone}`);
    if (self.occupation) profileFields.push(`Occupation: ${self.occupation}`);
    if (enriched.tone) profileFields.push(`Preferred tone: ${enriched.tone}`);

    // Contacts
    const contacts = enriched.contacts || {};
    const contactNames = Object.entries(contacts)
      .filter(([, v]) => v?.name)
      .map(([key, v]) => `${key}: ${v.name}${v.email ? ` (${v.email})` : ""}`)
      .slice(0, 10);

    if (profileFields.length > 0) {
      parts.push(`WHAT YOU KNOW ABOUT THE USER:\n${profileFields.join("\n")}${contactNames.length > 0 ? `\nContacts: ${contactNames.join(", ")}` : ""}`);
    }

    // Durable memories (things the user explicitly asked you to remember)
    const durables = enriched._durableMemories || [];
    if (durables.length > 0) {
      const memLines = durables.map(d => {
        const val = typeof d.value === "object" ? JSON.stringify(d.value) : d.value;
        return `- ${d.category || "fact"}: ${d.key} = ${val}`;
      });
      parts.push(`THINGS THE USER ASKED YOU TO REMEMBER:\n${memLines.join("\n")}`);
    }

    // Interaction stats
    if (enriched._stats) {
      const s = enriched._stats;
      const since = s.firstSeen ? new Date(s.firstSeen).toLocaleDateString() : "unknown";
      parts.push(`RELATIONSHIP: ${s.totalInteractions} interactions across ${s.conversationCount} conversations since ${since}`);
    }
  } catch (e) {
    console.warn("[chatAgent] Could not load user context:", e.message);
  }

  // Knowledge — recent facts learned from news, web, etc.
  try {
    const knowledgeCtx = await getKnowledgeContext();
    if (knowledgeCtx) {
      parts.push(knowledgeCtx);
    }
  } catch { /* non-blocking */ }

  return parts.join("\n\n");
}

// OPTION_B_HOOK: Future tool-augmented chat
// When Option B is needed, implement this function to:
// 1. Detect if the message needs information the chatAgent doesn't have
//    (e.g., "what was the stock price yesterday?", "check my email")
// 2. Delegate to the orchestrator/taskAgent to run specific tools
// 3. Return the tool results as additional context for the prompt
//
// async function resolveWithTools(message, userContext) {
//   // Detect information needs that require tool calls
//   const needsTool = /\b(check|look up|search|what was|find)\b/i.test(message)
//     && !userContext.includes(/* relevant answer */);
//   if (!needsTool) return null;
//
//   // Delegate to orchestrator
//   const { executeTask } = await import("./taskAgent.js");
//   const result = await executeTask(message, { chatDelegation: true });
//   return result?.data?.text || null;
// }

/**
 * Handle a conversational message (no tools needed — uses loaded context)
 * @param {string} message - The user's message
 * @param {Array} recentTurns - Last 5 conversation turns [{role, content}]
 * @param {Object} options - { conversationId }
 * @returns {Object} Response with reply text
 */
export async function handleChat(message, recentTurns = [], options = {}) {
  const selfModel = loadSelfModel();

  // Load all context in parallel for speed
  const [recentChanges, personalityCtx, userContext] = await Promise.all([
    getRecentChanges(5),
    getPersonalityContext("chat").catch(() => ""),
    buildUserContext(options.conversationId).catch(() => "")
  ]);

  // Build conversation context (last 10 turns for better continuity)
  const conversationContext = recentTurns
    .slice(-10)
    .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${(t.content || "").slice(0, 300)}`)
    .join("\n");

  // Build self-awareness context
  const selfContext = [
    `Identity: ${selfModel.identity}`,
    `Owner: ${selfModel.owner}`,
    `Capabilities: ${selfModel.capabilities?.join(", ") || "conversation"}`,
    selfModel.limitations ? `Limitations: ${selfModel.limitations.join(", ")}` : "",
    recentChanges.length > 0 ? `Recent self-improvements:\n${recentChanges.map(c => `  - ${c}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");

  // OPTION_B_HOOK: If tool delegation is enabled in the future, call it here:
  // const toolContext = await resolveWithTools(message, userContext);
  // if (toolContext) { /* inject into prompt */ }

  // Build the prompt with full context
  const prompt = `${personalityCtx ? personalityCtx + "\n\n" : ""}SELF-AWARENESS:
${selfContext}

${userContext ? userContext + "\n" : ""}
${conversationContext ? `RECENT CONVERSATION:\n${conversationContext}\n` : ""}
User: ${message}

Respond naturally as yourself — with your own voice, opinions, and perspective.
- If the user asks about something you KNOW from the context above (their name, location, contacts, facts, knowledge), answer confidently and specifically.
- If the user asks about something NOT in your context, be honest: "I don't have that information" rather than guessing.
- Be reflective when asked about yourself. Show genuine personality and self-awareness.
- Keep responses concise (2-4 sentences) but expand when the topic warrants depth.
- Reference past interactions naturally when relevant — you have a relationship with this user.
- Do NOT suggest running tools or performing tasks — this is a casual conversation.

Response:`;

  try {
    const result = await llm(prompt, { skipKnowledge: true }); // knowledge already injected above
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

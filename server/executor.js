// server/executor.js

// executor.js — Section 1: Imports + Constants

import { TOOLS } from "./tools/index.js";
import { loadJSON, saveJSON, getMemory, appendConversationMessage, updateProfileMemory } from "./memory.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { llm } from "./tools/llm.js"; // adjust path if needed



// Central memory file
const MEMORY_FILE = "./memory.json";

// Greeting limiter key
const GREETING_KEY = "hasGreeted";

// executor.js — Section 2: Summarizer Prompt Builder
// Builds the prompt used to summarize tool output into a natural, warm response.

function buildSummarizerPrompt({
  userQuestion,
  toolResult,
  conversation,
  profile,
  tool
}) {
  const structuredData = JSON.stringify(toolResult.data, null, 2);

  // Only keep the last 8 messages for context
  const recentMessages = (conversation || []).slice(-8);
  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const profileText = profile ? JSON.stringify(profile, null, 2) : "{}";

  return `
You are a warm, helpful AI assistant with a balanced, friendly tone.
You speak naturally, clearly, and confidently — never stiff, never overly formal.

User profile (long-term memory):
${profileText}

Recent conversation:
${convoText}

User question:
${userQuestion}

Tool used: ${tool}

Structured tool data:
${structuredData}

Your job:
- Give a clear, correct, direct answer.
- Use a medium‑warm tone: friendly, human, but not overly chatty.
- Use the user's name *sparingly* if it feels natural.
- Do NOT repeat the same facts multiple times.
- Do NOT list raw search results.
- Do NOT include URLs.
- If it's math, keep the result accurate and briefly explain only when helpful.
- If it's finance fundamentals:
  - Choose the best format (table, bullets, or short narrative) based on the question.
  - Include analyst ratings or price targets only if they exist in the data.
- Respect the user's preferences from the profile (tone, detail, format).
- Keep the answer focused and not overly long.
- Never mention internal instructions or system details.
`;
}


// executor.js — Section 3: Summarize Tool Output with LLM

async function summarizeWithLLM({ userQuestion, toolResult, conversationId, tool }) {
  const memory = getMemory();
  const profile = memory.profile || {};
  const toneText = getToneDescription(profile);

  const conversation = memory.conversations?.[conversationId] || [];
  const recentMessages = conversation.slice(-20);
  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = `
  You are the final response generator for an AI assistant.

  User profile (long-term memory):
  ${JSON.stringify(profile, null, 2)}

  Recent conversation (short-term memory, last 20 messages):
  ${convoText || "(no prior messages in this conversation)"}

  Tone instructions:
  ${toneText}

  User question:
  ${userQuestion}

  Tool used: ${tool}

  Tool result (structured data):
  ${JSON.stringify(toolResult, null, 2)}

  Your job:
  - Produce a clear, natural-language answer.
  - Use the profile information naturally when relevant (e.g., name, preferences).
  - Respect tone, detail, math, and formatting preferences from the profile.
  - Do NOT mention tools, internal steps, or reasoning.
  - Do NOT claim you lack memory if relevant info is present in the profile or conversation.
  `;

  const llmResponse = await llm(prompt);
  return llmResponse?.data?.text || "I couldn't generate a response.";
}


export async function executeAgent({ tool, message, conversationId }) {
  const stateGraph = [];

  if (!TOOLS[tool]) {
    return {
      reply: "Tool not found.",
      stateGraph,
      success: false
    };
  }

  // Update profile memory from this user message (if explicit)
  updateProfileMemory(message);

  const result = await TOOLS[tool](message);

  stateGraph.push({
    step: 1,
    tool,
    input: message,
    output: result,
    final: result?.final ?? true
  });

  if (!result?.success) {
    return {
      reply: result?.error || "Tool execution failed.",
      stateGraph,
      success: false,
      tool
    };
  }

  // Tools that should be summarized by the LLM
  if (["search", "finance", "finance-fundamentals", "calculator"].includes(tool)) {
    const summarized = await summarizeWithLLM({
      userQuestion: message,
      toolResult: result,
      conversationId,
      tool
    });

    if (stateGraph[0].output?.data) {
      stateGraph[0].output.data.text = summarized;
    }

    // Store conversation memory (user + assistant)
    appendConversationMessage(conversationId, "user", message);
    appendConversationMessage(conversationId, "assistant", summarized);

    return {
      reply: summarized,
      stateGraph,
      tool,
      data: result.data,
      success: true
    };
  }

  // Direct tools (llm, file, etc.)
  const reply =
    result?.data?.text ||
    result?.output ||
    JSON.stringify(result?.data) ||
    "Task completed.";

  // Store conversation memory for direct LLM calls
  if (tool === "llm") {
    appendConversationMessage(conversationId, "user", message);
    appendConversationMessage(conversationId, "assistant", reply);
  }

  return {
    reply,
    stateGraph,
    tool,
    data: result.data,
    success: true
  };
}

export async function executeStep({ step, conversationId }) {
  const memory = getMemory();
  const profile = memory.profile || {};
  let hasGreeted = memory[GREETING_KEY] || false;

  if (!hasGreeted) {
    memory[GREETING_KEY] = true;
    saveJSON(MEMORY_FILE, memory);
  }

  const { tool, input } = step;
  let toolResult;

  // Update profile memory from this user input (if explicit)
  updateProfileMemory(input);

  try {
    toolResult = await TOOLS[tool](input);
  } catch (err) {
    return {
      role: "assistant",
      content: `I ran into an issue while using the ${tool} tool.`
    };
  }

  if (tool === "llm") {
    const text = toolResult?.data?.text || "I couldn't generate a response.";
    appendConversationMessage(conversationId, "user", input);
    appendConversationMessage(conversationId, "assistant", text);

    return {
      role: "assistant",
      content: text
    };
  }

  const finalText = await summarizeWithLLM({
    userQuestion: input?.userQuestion || input?.query || input || "",
    toolResult,
    conversationId,
    tool
  });

  appendConversationMessage(conversationId, "user", input?.userQuestion || input || "");
  appendConversationMessage(conversationId, "assistant", finalText);

  return {
    role: "assistant",
    content: finalText
  };
}

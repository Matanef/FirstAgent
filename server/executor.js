// server/executor.js

// executor.js — Section 1: Imports + Constants

import { TOOLS } from "./tools/index.js";
import { loadJSON, saveJSON } from "./memory.js";
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
  const memory = loadJSON(MEMORY_FILE, { conversations: {}, profile: {} });
  const profile = memory.profile || {};

  const toneText = getToneDescription(profile);

  const prompt = `
You are the final response generator for an AI assistant.

Your job:
- Take the tool result below
- Understand the user's question
- Produce a clean, natural-language answer
- Follow the tone instructions strictly

Tone instructions:
${toneText}

User question:
${userQuestion}

Tool used: ${tool}

Tool result:
${JSON.stringify(toolResult, null, 2)}

Write the final answer the assistant should say to the user.
Do NOT mention tools, internal steps, or reasoning.
Keep the answer natural, helpful, and aligned with the tone.
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

    return {
      reply: summarized,
      stateGraph,
      tool,
      data: result.data,
      success: true
    };
  }

  // Direct tools (llm, file, weather, etc.)
  const reply =
    result?.data?.text ||
    result?.output ||
    JSON.stringify(result?.data) ||
    "Task completed.";

  return {
    reply,
    stateGraph,
    tool,
    data: result.data,
    success: true
  };
}

export async function executeStep({ step, conversationId }) {
  const memory = loadJSON(MEMORY_FILE, { conversations: {}, profile: {} });
  const conversation = memory.conversations[conversationId] || [];
  const profile = memory.profile || {};
  let hasGreeted = memory[GREETING_KEY] || false;

  if (!hasGreeted) {
    memory[GREETING_KEY] = true;
    saveJSON(MEMORY_FILE, memory);
  }
  const { tool, input } = step;
  let toolResult;

  try {
    toolResult = await TOOLS[tool](input);
  } catch (err) {
    return {
      role: "assistant",
      content: `I ran into an issue while using the ${tool} tool.`
    };
  }
  if (tool === "llm") {
    return {
      role: "assistant",
      content: toolResult?.data?.text || "I couldn't generate a response."
    };
  }
  const finalText = await summarizeWithLLM({
    userQuestion: input?.userQuestion || input?.query || "",
    toolResult,
    conversationId,
    tool
  });
  conversation.push({ role: "user", content: input?.userQuestion || "" });
  conversation.push({ role: "assistant", content: finalText });

  memory.conversations[conversationId] = conversation;
  saveJSON(MEMORY_FILE, memory);

  return {
    role: "assistant",
    content: finalText
  };
}


// server/executor.js
// Clean, corrected, future‑proof executor with HTML support + reasoning

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { llm } from "./tools/llm.js";

/**
 * Build memory-aware LLM prompt
 */
function buildLLMMemoryPrompt({ userMessage, profile, conversation }) {
  const toneText = getToneDescription(profile || {});
  const recentMessages = (conversation || []).slice(-20);

  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  return `
You are an AI assistant with access to a memory system.

You receive:
- A user profile (long-term memory)
- Recent conversation messages (short-term memory)
- The current user message

User profile (long-term memory):
${JSON.stringify(profile || {}, null, 2)}

Recent conversation (short-term memory, last 20 messages):
${convoText || "(no prior messages in this conversation)"}

Tone instructions:
${toneText}

Current user message:
${userMessage}

Now write the final answer to the user.
`;
}

/**
 * Run LLM with memory
 */
async function runLLMWithMemory({ userMessage, conversationId }) {
  const memory = getMemory();
  const profile = memory.profile || {};
  const conversation = memory.conversations?.[conversationId] || [];

  const prompt = buildLLMMemoryPrompt({
    userMessage,
    profile,
    conversation
  });

  const llmResponse = await llm(prompt);
  const text = llmResponse?.data?.text || "I couldn't generate a response.";

  return text;
}

/**
 * Summarize tool output with LLM
 */
async function summarizeWithLLM({ userQuestion, toolResult, conversationId, tool }) {
  const memory = getMemory();
  const profile = memory.profile || {};
  const toneText = getToneDescription(profile);

  const conversation = memory.conversations?.[conversationId] || [];
  const recentMessages = conversation.slice(-20);

  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  // If tool returned HTML, return it directly
  if (toolResult?.data?.html) {
    return {
      reply: toolResult.data.html,
      success: true,
      reasoning: toolResult.reasoning || null
    };
  }

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
- Use the profile information naturally when relevant.
- Respect tone, detail, math, and formatting preferences.
- Do NOT mention tools or internal steps.
`;

  const llmResponse = await llm(prompt);
  const text = llmResponse?.data?.text || "I couldn't generate a response.";

  return {
    reply: text,
    success: true,
    reasoning: toolResult.reasoning || null
  };
}

/**
 * executeAgent – single-shot tool execution
 */
export async function executeAgent({ tool, message, conversationId }) {
  const stateGraph = [];

  // Unknown tool
  if (!TOOLS[tool]) {
    return {
      reply: "Tool not found.",
      stateGraph,
      success: false
    };
  }

  // Direct LLM
  if (tool === "llm") {
    const reply = await runLLMWithMemory({
      userMessage: message,
      conversationId
    });

    stateGraph.push({
      step: 1,
      tool,
      input: message,
      output: reply,
      final: true
    });

    return {
      reply,
      stateGraph,
      tool,
      success: true
    };
  }

  // Execute tool
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

  // Tools that should be summarized by LLM
  const summarizeTools = [
    "search",
    "finance",
    "financeFundamentals",
    "calculator"
  ];

  if (summarizeTools.includes(tool)) {
    const summary = await summarizeWithLLM({
      userQuestion: message,
      toolResult: result,
      conversationId,
      tool
    });

    return {
      reply: summary.reply,
      stateGraph,
      tool,
      data: result.data,
      reasoning: summary.reasoning,
      success: true
    };
  }

  // Direct tools (file, etc.)
  const reply =
    result?.data?.html ||
    result?.data?.text ||
    result?.output ||
    JSON.stringify(result?.data) ||
    "Task completed.";

  return {
    reply,
    stateGraph,
    tool,
    data: result.data,
    reasoning: result.reasoning || null,
    success: true
  };
}
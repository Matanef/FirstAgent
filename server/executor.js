// server/executor.js

import { TOOLS } from "./tools/index.js";
import { loadJSON } from "./memory.js";

const MEMORY_FILE = "./memory.json";

function buildSummarizerPrompt({ userQuestion, toolResult, conversation, profile, tool }) {
  const structuredData = JSON.stringify(toolResult.data, null, 2);

  const recentMessages = (conversation || []).slice(-8);
  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const profileText = profile ? JSON.stringify(profile, null, 2) : "{}";

  return `
You are a warm, helpful AI assistant.

User profile (long-term memory):
${profileText}

Recent conversation:
${convoText}

User question:
${userQuestion}

Tool used: ${tool}

Tool returned this structured data:
${structuredData}

Your job:
- Give a clear, correct, direct answer.
- Be natural, friendly, and conversational, not stiff.
- If the user seems to be testing tools or debugging, be collaborative and concise.
- Do NOT list raw search results.
- Do NOT include URLs.
- If it's math, keep the result accurate and, when helpful, briefly explain it.
- If it's finance fundamentals:
  - You MAY choose the best format (table, bullets, narrative) based on the question and user profile.
  - If you're unsure, default to a clean comparison table with key metrics (market cap, P/E, dividend yield, 52-week range).
  - Include analyst ratings or price targets only if they exist in the data.
- Respect the user's preferences from the profile (tone, detail, format).
- Keep the answer focused and not overly long.
`;
}

async function summarizeWithLLM({ userQuestion, toolResult, conversationId, tool }) {
  const memory = loadJSON(MEMORY_FILE, { conversations: {}, profile: {} });

  const conversation = memory.conversations[conversationId] || [];
  const profile = memory.profile || {};

  const prompt = buildSummarizerPrompt({
    userQuestion,
    toolResult,
    conversation,
    profile,
    tool
  });

  const summary = await TOOLS.llm(prompt);

  return summary?.data?.text || "I had trouble summarizing that, but the tool completed successfully.";
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
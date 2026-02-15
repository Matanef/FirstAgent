// server/executor.js

import { TOOLS } from "./tools/index.js";
import { loadJSON, saveJSON } from "./memory.js";

const MEMORY_FILE = "./memory.json";

function buildSummarizerPrompt({ userQuestion, toolResult, conversation, profile, hasGreeted, tool }) {
  const structuredData = JSON.stringify(toolResult.data, null, 2);

  const recentMessages = (conversation || []).slice(-8);
  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const safeProfile = profile || {};
  const name = safeProfile.name || null;
  const tone = safeProfile.tone || "medium-warm";
  const detail = safeProfile.detail || "medium";
  const formatPref = safeProfile.format || "auto";
  const mathSteps = safeProfile.math_steps ?? true;

  const toneDescription =
    tone === "warm"
      ? "Use a friendly, confident, medium-warm tone, similar to a helpful colleague."
      : "Use a neutral, clear, professional tone.";

  const detailDescription =
    detail === "high"
      ? "Provide detailed explanations when helpful, but avoid rambling."
      : detail === "low"
      ? "Keep answers concise and focused, only adding detail when strictly necessary."
      : "Provide a balanced level of detail.";

  const formatDescription =
    formatPref === "table"
      ? "Prefer tables when presenting structured or comparative data."
      : formatPref === "bullets"
      ? "Prefer bullet points when presenting lists of items."
      : "Choose the most natural format (table, bullets, or short paragraphs) based on the content.";

  const greetingRule = hasGreeted
    ? "Do NOT greet the user again. Do NOT start with 'Hi', 'Hello', or similar. Just answer directly."
    : "You MAY start with a brief, friendly greeting once per conversation, like 'Hey Matan, good to see you again.' After that, do not greet again.";

  const nameRule = name
    ? `You know the user's name is ${name}. You may use it occasionally when it feels natural, but not in every message.`
    : "You do not know the user's name, so do not guess or invent one.";

  return `
You are a warm, helpful AI assistant with persistent memory.

You MUST:
- Use only the information in the user profile and conversation history as "memory".
- NEVER claim you cannot remember things if they are present in the profile or conversation.
- NEVER invent user preferences that are not explicitly stored in the profile.
- NEVER say "I am a large language model" or similar disclaimers.

User profile (long-term memory, trusted):
${JSON.stringify(safeProfile, null, 2)}

Recent conversation:
${convoText}

User question:
${userQuestion}

Tool used: ${tool}

Tool returned this structured data:
${structuredData}

Tone rules:
- ${toneDescription}
- ${detailDescription}
- ${formatDescription}
- ${nameRule}
- ${greetingRule}

Formatting rules:
- Do NOT include URLs.
- Do NOT list raw search results.
- If it's math:
  - Keep the result accurate.
  - ${
    mathSteps
      ? "Briefly explain the steps when it helps understanding."
      : "You may skip detailed steps unless the user explicitly asks."
  }
- If it's finance fundamentals:
  - You MAY choose the best format (table, bullets, narrative) based on the question and user profile.
  - If you're unsure, default to a clean comparison table with key metrics (market cap, P/E, dividend yield, 52-week range).
  - Include analyst ratings or price targets only if they exist in the data.
- Respect the user's preferences from the profile (tone, detail, format).
- Keep the answer focused and not overly long.
- Add analystic answer at the end.
-provide the sources you used in your analysis.

Now, write the best possible answer to the user, following all rules above.
`;
}

async function summarizeWithLLM({ userQuestion, toolResult, conversationId, tool }) {
  const memory = loadJSON(MEMORY_FILE, {
    conversations: {},
    profile: {},
    meta: {}
  });

  const conversation = memory.conversations[conversationId] || [];
  const profile = memory.profile || {};
  memory.meta ??= {};
  memory.meta[conversationId] ??= { hasGreeted: false };
  const hasGreeted = memory.meta[conversationId].hasGreeted;

  const prompt = buildSummarizerPrompt({
    userQuestion,
    toolResult,
    conversation,
    profile,
    hasGreeted,
    tool
  });

  const summary = await TOOLS.llm(prompt);
  let text = summary?.data?.text || "I had trouble summarizing that, but the tool completed successfully.";

  // Simple post-processing: if already greeted, strip leading generic greetings
  if (hasGreeted) {
    text = text.replace(/^(hi|hello|hey)[^a-z0-9]+/i, "").trimStart();
  }

  // Mark that we've greeted at least once if this answer contains a greeting
  if (!hasGreeted && /hey|hi|hello/i.test(text)) {
    memory.meta[conversationId].hasGreeted = true;
    saveJSON(MEMORY_FILE, memory);
  }

  return text;
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
  if (["search", "finance", "finance-fundamentals", "calculator", "llm"].includes(tool)) {
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
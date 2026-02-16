// server/executor.js
// Clean, corrected, future‑proof executor with HTML support + reasoning

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { llm } from "./tools/llm.js";

/* -------------------------------------------------------
 * Helper: detect if the user wants a table
 * ----------------------------------------------------- */
function wantsTableFormat(userQuestion) {
  const lower = (userQuestion || "").toLowerCase();
  return (
    lower.includes("show in a table") ||
    lower.includes("show it in a table") ||
    lower.includes("display in a table") ||
    lower.includes("table format") ||
    lower.includes("as a table") ||
    lower.includes("in table form") ||
    lower.includes("tabular")
  );
}

/* -------------------------------------------------------
 * Build memory-aware LLM prompt
 * ----------------------------------------------------- */
function buildLLMMemoryPrompt({ userMessage, profile, conversation }) {
  const toneText = getToneDescription(profile || {});
  const recentMessages = (conversation || []).slice(-20);

  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const today = new Date().toLocaleDateString("en-GB");

  return `
You are an AI assistant with access to a memory system.
The current date is ${today}.

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

/* -------------------------------------------------------
 * Run LLM with memory
 * ----------------------------------------------------- */
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

/* -------------------------------------------------------
 * Summarize tool output with LLM (with table support)
 * ----------------------------------------------------- */
async function summarizeWithLLM({
  userQuestion,
  toolResult,
  conversationId,
  tool
}) {
  const memory = getMemory();
  const profile = memory.profile || {};
  const toneText = getToneDescription(profile);

  const conversation = memory.conversations?.[conversationId] || [];
  const recentMessages = conversation.slice(-20);

  const convoText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const today = new Date().toLocaleDateString("en-GB");
  const tableRequested = wantsTableFormat(userQuestion);

  const prompt = `
You are the final response generator for an AI assistant.
The current date is ${today}.

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

Formatting instructions:
- Produce a clear, natural-language answer.
- Use the profile information naturally when relevant.
- Respect tone, detail, math, and formatting preferences.
${tableRequested ? "- Convert the structured data into an HTML table with headers and rows.\n- Keep the explanation short and place the table clearly." : "- Use normal paragraph formatting unless a different structure is clearly better."}
- If the tool results indicate no reliable information, say so clearly and do NOT invent facts.
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

/* -------------------------------------------------------
 * Helper: normalize message for tools
 * ----------------------------------------------------- */
function getMessageText(message) {
  return typeof message === "string" ? message : message?.text;
}

/* -------------------------------------------------------
 * City aliasing (OpenWeather quirks)
 * ----------------------------------------------------- */
function normalizeCityAliases(message) {
  if (!message || typeof message !== "object") return message;

  if (message.context?.city) {
    const c = message.context.city.toLowerCase();

    const aliases = {
      "givataim": "Givatayim",
      "giv'atayim": "Givatayim",
      "givatayim": "Givatayim"
    };

    if (aliases[c]) {
      message.context.city = aliases[c];
    }
  }

  return message;
}

/* -------------------------------------------------------
 * executeAgent – single-shot tool execution
 * ----------------------------------------------------- */
export async function executeAgent({ tool, message, conversationId }) {
  const stateGraph = [];

  // Normalize city aliases
  message = normalizeCityAliases(message);

  if (!TOOLS[tool]) {
    return {
      reply: "Tool not found.",
      stateGraph,
      success: false
    };
  }

  /* ------------------------------
   * Direct LLM
   * ---------------------------- */
  if (tool === "llm") {
    const reply = await runLLMWithMemory({
      userMessage: getMessageText(message),
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

  /* ------------------------------
   * WEATHER — ONLY tool that receives full object
   * ---------------------------- */
  let toolInput;

  if (tool === "weather") {
    toolInput = message; // full object { text, context }
  } else {
    toolInput = getMessageText(message); // string only
  }

  /* ------------------------------
   * Execute tool
   * ---------------------------- */
  const result = await TOOLS[tool](toolInput);

  stateGraph.push({
    step: 1,
    tool,
    input: toolInput,
    output: result,
    final: result?.final ?? true
  });

  /* ------------------------------
   * Do NOT summarize failed tools
   * ---------------------------- */
  if (!result?.success) {
    return {
      reply: result?.error || "Tool execution failed.",
      stateGraph,
      success: false,
      tool
    };
  }

  /* ------------------------------
   * Tools that should be summarized
   * ---------------------------- */
  const summarizeTools = [
    "search",
    "finance",
    "financeFundamentals",
    "calculator",
    "weather",
    "sports",
    "youtube",
    "shopping",
    "email",
    "tasks"
  ];

  if (summarizeTools.includes(tool)) {
    const summary = await summarizeWithLLM({
      userQuestion: getMessageText(message),
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

  /* ------------------------------
   * Default: return raw tool output
   * ---------------------------- */
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
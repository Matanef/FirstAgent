// server/executor.js
// Enhanced executor with full memory, table reformatting, and deep agent awareness

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { llm } from "./tools/llm.js";
import { getToneDescription } from "../tone/toneGuide.js";

// If you add tone later, wire it here
// import { getToneDescription } from "../tone/toneGuide.js";

/* -------------------------------------------------------
 * Helper: detect if user wants table format
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
    lower.includes("tabular") ||
    lower.includes("make a table") ||
    lower.includes("create a table")
  );
}

/* -------------------------------------------------------
 * Build comprehensive context for LLM with FULL memory
 * ----------------------------------------------------- */
function buildLLMContext({ userMessage, profile, conversation, capabilities }) {
  // const toneText = getToneDescription(profile || {});
  const toneText = getToneDescription(profile || {});

  const allMessages = conversation || [];

  const convoText = allMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const today = new Date().toLocaleDateString("en-GB");
  const now = new Date().toLocaleTimeString("en-GB");

  const awarenessContext = `
AGENT CAPABILITIES & AWARENESS:
- I can search the web for current information
- I can get weather forecasts (including "here" for your location)
- I can access news from multiple sources
- I can look up stock prices and company fundamentals
- I can perform calculations
- I can read and list files in allowed directories: D:/local-llm-ui and E:/testFolder
- I can remember user preferences and information across conversations
- I can reformat information into tables when requested
- I have access to the FULL conversation history (${allMessages.length} messages in this conversation)
- Current date: ${today}
- Current time: ${now}

CONVERSATION STATISTICS:
- Total messages in this conversation: ${allMessages.length}
- User messages: ${allMessages.filter(m => m.role === "user").length}
- Assistant messages: ${allMessages.filter(m => m.role === "assistant").length}
${capabilities ? `- Tools available: ${capabilities.join(", ")}` : ""}
`;

  return `${awarenessContext}

User profile (long-term memory):
${JSON.stringify(profile || {}, null, 2)}

Full conversation history (${allMessages.length} messages):
${convoText || "(no prior messages in this conversation)"}

Tone instructions:
${toneText}

Current user message:
${userMessage}

Now write the final answer to the user. Be aware of the full conversation context and your capabilities.
`;
}

/* -------------------------------------------------------
 * Run LLM with full memory and awareness
 * ----------------------------------------------------- */
async function runLLMWithFullMemory({ userMessage, conversationId }) {
  const memory = getMemory();
  const profile = memory.profile || {};
  const conversation = memory.conversations?.[conversationId] || [];

  const capabilities = Object.keys(TOOLS);

  const prompt = buildLLMContext({
    userMessage,
    profile,
    conversation,
    capabilities
  });

  const llmResponse = await llm(prompt);
  const text = llmResponse?.data?.text || "I couldn't generate a response.";

  return text;
}

/* -------------------------------------------------------
 * Summarize tool output with LLM (with full context and table support)
 * ----------------------------------------------------- */
async function summarizeWithLLM({
  userQuestion,
  toolResult,
  conversationId,
  tool
}) {
  const memory = getMemory();
  const profile = memory.profile || {};
  // const toneText = getToneDescription(profile);
  const toneText = getToneDescription(profile || {});

  const conversation = memory.conversations?.[conversationId] || [];
  const allMessages = conversation;

  const convoText = allMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const today = new Date().toLocaleDateString("en-GB");
  const tableRequested = wantsTableFormat(userQuestion);

  const prompt = `
You are the final response generator for an AI assistant with deep awareness of context.
The current date is ${today}.

CONVERSATION CONTEXT:
- Total messages in this conversation: ${allMessages.length}
- You have access to the FULL conversation history below

User profile (long-term memory):
${JSON.stringify(profile, null, 2)}

Full conversation history (${allMessages.length} messages):
${convoText || "(no prior messages in this conversation)"}

Tone instructions:
${toneText}

User question:
${userQuestion}

Tool used: ${tool}

Tool result (structured data):
${JSON.stringify(toolResult, null, 2)}

Formatting instructions:
- Produce a clear, natural-language answer
- Use the profile information naturally when relevant
- Respect tone, detail, math, and formatting preferences
${
  tableRequested
    ? "- Convert the structured data into an HTML table with headers and rows.\n- Keep the explanation short and place the table clearly.\n- Use class='ai-table-wrapper' and class='ai-table' for proper styling"
    : "- Use normal paragraph formatting unless a different structure is clearly better"
}
- If the tool results indicate no reliable information, say so clearly and do NOT invent facts
- Do NOT mention tools or internal steps
- Be aware of the full conversation context and reference previous messages if relevant

Generate the response:
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
 * Reformat previous response as table
 * ----------------------------------------------------- */
async function reformatAsTable({ userMessage, conversationId }) {
  const memory = getMemory();
  const conversation = memory.conversations?.[conversationId] || [];

  const lastAssistantMessage = [...conversation]
    .reverse()
    .find(m => m.role === "assistant");

  if (!lastAssistantMessage) {
    return {
      reply: "I don't have a previous response to reformat.",
      success: false,
      stateGraph: []
    };
  }

  const prompt = `
You are helping reformat a previous response into an HTML table.

Previous response:
${lastAssistantMessage.content}

User request:
${userMessage}

INSTRUCTIONS:
- Convert the information from the previous response into a well-structured HTML table
- Use class="ai-table-wrapper" for the wrapper div
- Use class="ai-table" for the table element
- Include appropriate headers
- Keep the data accurate - don't add or remove information
- Add a brief introduction before the table

Example format:
<div class="ai-table-wrapper">
  <table class="ai-table">
    <thead>
      <tr><th>Column 1</th><th>Column 2</th></tr>
    </thead>
    <tbody>
      <tr><td>Data 1</td><td>Data 2</td></tr>
    </tbody>
  </table>
</div>

Generate the reformatted response:
`;

  const llmResponse = await llm(prompt);
  const text = llmResponse?.data?.text || "I couldn't reformat the response.";

  return {
    reply: text,
    success: true,
    stateGraph: [
      {
        step: 1,
        tool: "reformat_table",
        input: userMessage,
        output: text,
        final: true
      }
    ]
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
      givataim: "Givatayim",
      "giv'atayim": "Givatayim",
      givatayim: "Givatayim"
    };

    if (aliases[c]) {
      message.context.city = aliases[c];
    }
  }

  return message;
}

/* -------------------------------------------------------
 * executeAgent – enhanced with full memory and awareness
 * ----------------------------------------------------- */
export async function executeAgent({ tool, message, conversationId }) {
  const stateGraph = [];

  // Special case: reformat previous response as table
  if (tool === "reformat_table") {
    return await reformatAsTable({
      userMessage: getMessageText(message),
      conversationId
    });
  }

  /* ------------------------------
   * Direct LLM - with FULL memory
   * ---------------------------- */
  if (tool === "llm") {
    const reply = await runLLMWithFullMemory({
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
   * WEATHER + MEMORYTOOL receive full object
   * ---------------------------- */
  let toolInput;

  if (tool === "weather" || tool === "memorytool") {
    toolInput = message; // { text, context }
  } else {
    toolInput = getMessageText(message); // string
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
   * SPECIAL CASE: memorytool
   * - No LLM
   * - No summarization
   * - Clean assistant message
   * ---------------------------- */
  if (tool === "memorytool") {
    return {
      reply: result.data?.message || "Memory updated.",
      stateGraph,
      tool,
      success: true
    };
  }

  /* ------------------------------
   * Tools that should be summarized (with full context)
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
    "tasks",
    "news",
    "file"
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
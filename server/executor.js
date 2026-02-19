// server/executor.js (COMPLETE FIX - All issues resolved)
// Fixes: markdown tables → HTML, email "send it" state, date awareness

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { llm } from "./tools/llm.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { sendConfirmedEmail } from "./tools/email.js";

// FIX #3: Convert markdown tables to HTML
function convertMarkdownTablesToHTML(text) {
  const tableRegex = /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g;
  
  return text.replace(tableRegex, (match, headers, rows) => {
    const headerCells = headers.split('|').map(h => h.trim()).filter(Boolean);
    const rowData = rows.trim().split('\n').map(row => 
      row.split('|').map(cell => cell.trim()).filter(Boolean)
    );
    
    let html = '<div class="ai-table-wrapper"><table class="ai-table">';
    html += '<thead><tr>';
    headerCells.forEach(h => html += `<th>${h}</th>`);
    html += '</tr></thead><tbody>';
    
    rowData.forEach(row => {
      html += '<tr>';
      row.forEach(cell => html += `<td>${cell}</td>`);
      html += '</tr>';
    });
    
    html += '</tbody></table></div>';
    return html;
  });
}

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

function buildLLMContext({ userMessage, profile, conversation, capabilities }) {
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

async function runLLMWithFullMemory({ userMessage, conversationId }) {
  const memory = await getMemory();
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
  let text = llmResponse?.data?.text || "I couldn't generate a response.";

  // FIX: Convert markdown tables to HTML
  text = convertMarkdownTablesToHTML(text);

  return text;
}

async function summarizeWithLLM({
  userQuestion,
  toolResult,
  conversationId,
  tool
}) {
  const memory = await getMemory();
  const profile = memory.profile || {};
  const toneText = getToneDescription(profile || {});

  const conversation = memory.conversations?.[conversationId] || [];
  const allMessages = conversation;

  const convoText = allMessages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const today = new Date().toLocaleDateString("en-GB");
  const tableRequested = wantsTableFormat(userQuestion);

  // FIX #4: Emphasize current date for news
  const dateEmphasis = tool === 'news' ? 
    `CRITICAL: TODAY'S DATE IS ${today}. The news articles are from TODAY or the past few days, NOT from 2023 or old years!` : '';

  const prompt = `
You are the final response generator for an AI assistant with deep awareness of context.
The current date is ${today}.
${dateEmphasis}

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
  let text = llmResponse?.data?.text || "I couldn't generate a response.";

  // FIX: Convert markdown tables to HTML
  text = convertMarkdownTablesToHTML(text);

  return {
    reply: text,
    success: true,
    reasoning: toolResult.reasoning || null
  };
}

async function reformatAsTable({ userMessage, conversationId }) {
  const memory = await getMemory();
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
  let text = llmResponse?.data?.text || "I couldn't reformat the response.";

  // FIX: Convert markdown tables to HTML
  text = convertMarkdownTablesToHTML(text);

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

function getMessageText(message) {
  return typeof message === "string" ? message : message?.text;
}

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

export async function executeAgent({ tool, message, conversationId }) {
  const stateGraph = [];

  // FIX #5: Check for "send it" with pending email
  const userText = getMessageText(message);
  if (/^send\s+it$/i.test(userText.trim())) {
    const memory = await getMemory();
    const conversation = memory.conversations?.[conversationId] || [];
    const lastMsg = conversation[conversation.length - 1];
    
    if (lastMsg?.role === 'assistant' && lastMsg?.data?.pendingEmail) {
      console.log("📧 Found pending email, sending...");
      const { to, subject, body } = lastMsg.data.pendingEmail;
      
      const sendResult = await sendConfirmedEmail({ to, subject, body });
      
      stateGraph.push({
        step: 1,
        tool: "email",
        input: message,
        output: sendResult,
        final: true
      });
      
      return {
        reply: sendResult.data?.message || sendResult.error || "Email sent!",
        stateGraph,
        tool: "email",
        data: sendResult.data,
        success: sendResult.success
      };
    }
  }

  // Special case: reformat previous response as table
  if (tool === "reformat_table") {
    return await reformatAsTable({
      userMessage: getMessageText(message),
      conversationId
    });
  }

  // Direct LLM - with FULL memory
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

  // WEATHER + MEMORYTOOL receive full object
  let toolInput;

  if (tool === "weather" || tool === "memorytool") {
    toolInput = message; // { text, context }
  } else {
    toolInput = getMessageText(message); // string
  }

  // Execute tool
  const result = await TOOLS[tool](toolInput);

  stateGraph.push({
    step: 1,
    tool,
    input: toolInput,
    output: result,
    final: result?.final ?? true
  });

  // Do NOT summarize failed tools
  if (!result?.success) {
    return {
      reply: result?.error || "Tool execution failed.",
      stateGraph,
      success: false,
      tool
    };
  }

  // SPECIAL CASE: memorytool - No LLM, No summarization
  if (tool === "memorytool") {
    return {
      reply: result.data?.message || "Memory updated.",
      stateGraph,
      tool,
      success: true
    };
  }

  // Tools that should be summarized (with full context)
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
    "file",
    "selfImprovement"  // Added
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

  // Default: return raw tool output
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

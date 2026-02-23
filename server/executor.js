// server/executor.js
// COMPLETE FIX: All original functionality + email confirmation + context awareness

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { llm, llmStream } from "./tools/llm.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { sendConfirmedEmail } from "./tools/email.js";
import { PROJECT_ROOT } from "./utils/config.js";
import { getBackgroundNLP } from "./utils/nlpUtils.js";
import {
  convertMarkdownTablesToHTML,
  wantsTableFormat,
  normalizeCityAliases,
  getMessageText
} from "./utils/uiUtils.js";

function buildLLMContext({ userMessage, profile, conversation, capabilities, sentiment, entities, stateGraph }) {
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
- I can access news from multiple sources (with topic filtering)
- I can look up stock prices and company fundamentals
- I can perform calculations
- I can read and list files in: ${PROJECT_ROOT} (my project) and E:/testFolder
- I have GitHub API access for repository operations
- I can review code files and generate analysis reports
- I can remember user preferences across conversations
- I can reformat information into tables when requested
- I have FULL conversation history (${allMessages.length} messages)
- Current date: ${today}
- Current time: ${now}

CONVERSATION STATISTICS:
- Total messages: ${allMessages.length}
- User messages: ${allMessages.filter(m => m.role === "user").length}
- Assistant messages: ${allMessages.filter(m => m.role === "assistant").length}
${capabilities ? `- Tools available: ${capabilities.join(", ")}` : ""}
`;

  // FIX: Include stateGraph for context awareness
  const CONTEXT_ENRICHMENT = `
NLP ANALYSIS:
- Sentiment: ${sentiment?.sentiment || "neutral"} (Score: ${sentiment?.score || 0})
- Entities Detected: ${entities ? JSON.stringify(entities) : "none"}

PREVIOUS STEPS IN THIS SEQUENCE:
${stateGraph && stateGraph.length > 0 ? JSON.stringify(stateGraph, null, 2) : "none"}
`;

  return `${awarenessContext}
${CONTEXT_ENRICHMENT}

User profile (long-term memory):
${JSON.stringify(profile || {}, null, 2)}

Full conversation history (${allMessages.length} messages):
${convoText || "(no prior messages)"}

Tone instructions:
${toneText}

Current user message:
${userMessage}

Now write the final answer. Be aware of full conversation context and your capabilities.
`;
}

async function runLLMWithFullMemory({ userMessage, conversationId, sentiment, entities, stateGraph, onChunk }) {
  const memory = await getMemory();
  const profile = memory.profile || {};
  const conversation = memory.conversations?.[conversationId] || [];
  const capabilities = Object.keys(TOOLS);

  const prompt = buildLLMContext({
    userMessage,
    profile,
    conversation,
    capabilities,
    sentiment,
    entities,
    stateGraph
  });

  let text = "";
  if (onChunk) {
    const result = await llmStream(prompt, (chunk) => {
      text += chunk;
      onChunk(chunk);
    });
    if (!result.success) text = "I encountered an error while streaming.";
  } else {
    const llmResponse = await llm(prompt);
    text = llmResponse?.data?.text || "I couldn't generate a response.";
  }

  text = convertMarkdownTablesToHTML(text);
  return text;
}

async function summarizeWithLLM({
  userQuestion,
  toolResult,
  conversationId,
  tool,
  sentiment,
  entities,
  stateGraph,
  onChunk
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

  const dateEmphasis = ['news', 'search', 'sports'].includes(tool) ?
    `CRITICAL: TODAY'S DATE IS ${today}. Information should be current and up-to-date!` : '';

  // FIX: Include stateGraph for context awareness
  let contextSummary = "";
  if (stateGraph && stateGraph.length > 0) {
    contextSummary = "\n\nPREVIOUS STEPS IN THIS SEQUENCE:\n";
    stateGraph.forEach(step => {
      contextSummary += `- Step ${step.step}: ${step.tool} - ${step.success ? 'success' : 'failed'}\n`;
    });
    contextSummary += "\nUse this context when answering follow-up questions.\n";
  }

  const prompt = `
You are the final response generator for an AI assistant with deep awareness of context.
The current date is ${today}.
${dateEmphasis}

NLP ANALYSIS:
- Sentiment: ${sentiment?.sentiment || "neutral"} (Score: ${sentiment?.score || 0})
- Entities Detected: ${entities ? JSON.stringify(entities) : "none"}

CONVERSATION CONTEXT:
- Total messages: ${allMessages.length}
- You have FULL conversation history below

User profile (long-term memory):
${JSON.stringify(profile, null, 2)}

Full conversation history (${allMessages.length} messages):
${convoText || "(no prior messages)"}
${contextSummary}

Tone instructions:
${toneText}

User question:
${userQuestion}

Tool used: ${tool}

Tool result (structured data):
${JSON.stringify(toolResult, null, 2)}

${toolResult?.success === false ? `ERROR ANALYSIS INSTRUCTIONS:
- Explain WHAT went wrong in plain language
- Explain WHY it likely happened (root cause)
- Suggest HOW to resolve it with specific steps
- If applicable, provide a code snippet or command that would fix the issue
- Be concise but actionable
` : ''}
Formatting instructions:
- Produce a clear, natural-language answer
- Use profile information naturally when relevant
- Respect tone, detail, and formatting preferences
${tableRequested
      ? "- Convert data into an HTML table with headers and rows.\n- Use class='ai-table-wrapper' and class='ai-table'\n- Keep explanation short and place table clearly"
      : "- Use normal paragraph formatting unless different structure is better"
    }
- If no reliable information, say so clearly - do NOT invent facts
- Do NOT mention tools or internal steps
- Be aware of full conversation context and reference previous messages if relevant

Generate the response:
`;

  let text = "";
  if (onChunk) {
    const streamResult = await llmStream(prompt, (chunk) => {
      text += chunk;
      onChunk(chunk);
    });
    if (!streamResult.success) text = "I couldn't summarize the tool results.";
  } else {
    const llmResponse = await llm(prompt);
    text = llmResponse?.data?.text || "I couldn't generate a response.";
  }

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
- Convert information into a well-structured HTML table
- Use class="ai-table-wrapper" for wrapper div
- Use class="ai-table" for table element
- Include appropriate headers
- Keep data accurate - don't add or remove information
- Add brief introduction before the table

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

/**
 * executeStep
 * Executes a SINGLE plan step (one tool call)
 */
export async function executeStep({ tool, message, conversationId, sentiment, entities, stateGraph, onChunk }) {
  const queryText = typeof message === "string" ? message : message?.text || "";

  // FIX: Handle "send it" for email confirmation with BACKWARD SEARCH
  if (tool === "email_confirm") {
    console.log("📧 Processing email confirmation...");
    const memory = await getMemory();
    const conversation = memory.conversations?.[conversationId] || [];

    // CRITICAL FIX: Search backward for the most recent draft
    const draftMessage = [...conversation]
      .reverse()
      .find(m => m.role === 'assistant' && m.data?.pendingEmail);

    if (draftMessage && draftMessage.data.pendingEmail) {
      console.log("✅ Found pending email draft, sending now...");
      const { to, subject, body, attachments } = draftMessage.data.pendingEmail;

      const sendResult = await sendConfirmedEmail({ to, subject, body, attachments });

      return {
        tool: "email",
        input: message,
        output: sendResult,
        success: sendResult.success,
        final: true
      };
    } else {
      console.log("❌ No pending email draft found in history.");
      return {
        tool: "email",
        input: message,
        output: {
          tool: "email",
          success: false,
          final: true,
          error: "I don't have a pending email to send. Please create an email draft first."
        },
        success: false,
        final: true
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

  // Direct LLM - with FULL memory and context
  if (tool === "llm") {
    const reply = await runLLMWithFullMemory({
      userMessage: getMessageText(message),
      conversationId,
      sentiment,
      entities,
      stateGraph,
      onChunk
    });

    return {
      tool,
      input: message,
      output: { tool, success: true, final: true, data: { text: reply } },
      success: true,
      final: true
    };
  }

  // Normalize city aliases
  message = normalizeCityAliases(message);

  // Case-insensitive tool lookup
  const toolKeys = Object.keys(TOOLS);
  const actualToolKey = toolKeys.find(k => k.toLowerCase() === tool.toLowerCase());

  if (!actualToolKey) {
    console.error(`❌ Tool not found: ${tool}`);
    console.log("Available tools:", toolKeys);
    return {
      tool,
      input: message,
      output: {
        tool,
        success: false,
        final: true,
        error: `Tool "${tool}" not found. Available tools: ${toolKeys.join(", ")}`
      },
      success: false,
      final: true
    };
  }

  tool = actualToolKey;

  // Tools that receive full object { text, context }
  let toolInput;
  if (["weather", "memorytool", "gitLocal", "review", "githubTrending", "webDownload", "applyPatch", "fileReview", "duplicateScanner"].includes(tool)) {
    toolInput = message;
  } else {
    toolInput = getMessageText(message);
  }

  // Execute tool
  console.log(`🔧 Executing tool: ${tool}`);
  const result = await TOOLS[tool](toolInput);

  return {
    tool,
    input: toolInput,
    output: result,
    success: result.success,
    final: result?.final ?? true
  };
}

/**
 * finalizeStep
 * Summarizes tool results or returns raw output
 */
export async function finalizeStep({ stepResult, message, conversationId, sentiment, entities, stateGraph, onChunk }) {
  const { tool, output: result } = stepResult;

  // LLM-REVIEWED ERRORS: instead of returning raw error strings,
  // pass errors through the LLM for explanation + fix suggestions
  if (!stepResult.success) {
    const errorText = result?.error || result?.data?.error || "Tool execution failed.";
    try {
      const errorExplanation = await summarizeWithLLM({
        userQuestion: getMessageText(message),
        toolResult: {
          tool,
          success: false,
          error: errorText,
          data: result?.data || {},
          stateGraph
        },
        conversationId,
        tool,
        sentiment,
        entities,
        stateGraph,
        onChunk
      });
      return {
        reply: errorExplanation.reply,
        tool,
        success: false,
        final: true
      };
    } catch (llmErr) {
      console.warn("[finalizeStep] LLM error review failed, returning raw error:", llmErr.message);
      return {
        reply: errorText,
        tool,
        success: false,
        final: true
      };
    }
  }

  // SPECIAL CASE: memorytool, selfImprovement, applyPatch - No LLM summarization
  if (tool === "memorytool" || tool === "selfImprovement" || tool === "applyPatch") {
    return {
      reply: result.data?.text || result.data?.message || "Task completed.",
      tool,
      data: result.data,
      success: true,
      final: true
    };
  }

  // SPECIAL CASE: duplicateScanner — return raw structured data for the panel to render
  if (tool === "duplicateScanner") {
    return {
      reply: result.data?.text || "Scan completed.",
      tool,
      data: result.data,
      success: true,
      final: true
    };
  }

  // FIX: Email draft - preserve pendingEmail data
  if (tool === "email" && result.data?.mode === "draft") {
    return {
      reply: result.data.message,
      tool,
      data: result.data, // Contains pendingEmail
      success: true,
      final: true
    };
  }

  // Tools that should be summarized
  const summarizeTools = [
    "search", "finance", "financeFundamentals", "calculator", "weather",
    "sports", "youtube", "shopping", "email", "tasks", "news", "file",
    "github", "review", "githubTrending", "gitLocal", "nlp_tool", "lotrJokes",
    "webDownload", "fileReview"
  ];

  if (summarizeTools.includes(tool)) {
    const summary = await summarizeWithLLM({
      userQuestion: getMessageText(message),
      toolResult: result,
      conversationId,
      tool,
      sentiment,
      entities,
      stateGraph, // FIX: Pass context
      onChunk
    });

    return {
      reply: summary.reply,
      tool,
      data: result.data,
      reasoning: summary.reasoning,
      success: true,
      final: true
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
    tool,
    data: result.data,
    reasoning: result.reasoning || null,
    success: true,
    final: true
  };
}

/**
 * executeAgent (Single Step / Direct)
 * Legacy/Direct entry point for executing a single tool call.
 * Used by specialized routes like 'review.js'.
 */
export async function executeAgent({ tool, message, conversationId, onChunk }) {
  const queryText = typeof message === "string" ? message : message?.text || "";
  const { sentiment, entities } = getBackgroundNLP(queryText);

  // 1. Execute the tool
  const stepResult = await executeStep({
    tool,
    message,
    conversationId,
    sentiment,
    entities,
    stateGraph: [],
    onChunk
  });

  // 2. Finalize and Return
  const finalized = await finalizeStep({
    stepResult,
    message,
    conversationId,
    sentiment,
    entities,
    stateGraph: [],
    onChunk
  });

  return {
    ...finalized,
    stateGraph: [{
      step: 1,
      tool: finalized.tool,
      input: message,
      output: finalized.reply,
      success: finalized.success,
      final: finalized.final
    }]
  };
}

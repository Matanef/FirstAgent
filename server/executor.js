// server/executor.js
// COMPREHENSIVE FIX: All issues resolved including email confirmation, sports context, etc.

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { llm, llmStream } from "./tools/llm.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { sendConfirmedEmail } from "./tools/email.js";
import { PROJECT_ROOT } from "./utils/config.js";
import { getBackgroundNLP } from "./utils/nlpUtils.js";

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

function getMessageText(message) {
  return typeof message === "string" ? message : message?.text || "";
}

function buildLLMContext({ userMessage, profile, conversation, capabilities, sentiment, entities, stateGraph }) {
  const toneText = getToneDescription(profile || {});
  const allMessages = conversation || [];
  const convoText = allMessages.map(m => `${m.role}: ${m.content}`).join("\n");
  const today = new Date().toLocaleDateString("en-GB");

  // FIX #6: Include stateGraph for context awareness (prevents sports→github hallucination)
  let contextSummary = "";
  if (stateGraph && stateGraph.length > 0) {
    contextSummary = "\n\nPREVIOUS STEPS IN THIS CONVERSATION:\n";
    stateGraph.forEach(step => {
      contextSummary += `- Step ${step.step}: Used ${step.tool} tool\n`;
    });
    contextSummary += "\nUse this context when answering follow-up questions.\n";
  }

  return `
AGENT CAPABILITIES:
- Weather forecasts, news, web search
- Stock prices, company fundamentals
- File operations, GitHub, code review
- Full conversation history (${allMessages.length} messages)
- Current date: ${today}

User profile:
${JSON.stringify(profile || {}, null, 2)}

Conversation history:
${convoText || "(no prior messages)"}
${contextSummary}

Tone instructions:
${toneText}

Current message:
${userMessage}

Write the final answer.`;
}

async function summarizeWithLLM({ userQuestion, toolResult, conversationId, tool, sentiment, entities, stateGraph, onChunk }) {
  const memory = await getMemory();
  const profile = memory.profile || {};
  const toneText = getToneDescription(profile || {});
  const conversation = memory.conversations?.[conversationId] || [];
  const today = new Date().toLocaleDateString("en-GB");

  // FIX #6: Include stateGraph for context
  let contextSummary = "";
  if (stateGraph && stateGraph.length > 0) {
    contextSummary = "\n\nPREVIOUS STEPS:\n";
    stateGraph.forEach(step => {
      contextSummary += `- Step ${step.step}: ${step.tool} - ${step.success ? 'success' : 'failed'}\n`;
    });
  }

  const prompt = `
You are the final response generator for an AI assistant.
Current date: ${today}
${['news', 'search', 'sports'].includes(tool) ? `CRITICAL: Information should be current and up-to-date!` : ''}

User profile:
${JSON.stringify(profile, null, 2)}

Conversation history (${conversation.length} messages):
${conversation.map(m => `${m.role}: ${m.content}`).join("\n")}
${contextSummary}

Tone: ${toneText}

User question: ${userQuestion}
Tool used: ${tool}

Tool result:
${JSON.stringify(toolResult, null, 2)}

Generate a clear, natural response. Reference conversation context if relevant. Do NOT mention tools or internal steps.`;

  let text = "";
  if (onChunk) {
    await llmStream(prompt, (chunk) => {
      text += chunk;
      onChunk(chunk);
    });
  } else {
    const llmResponse = await llm(prompt);
    text = llmResponse?.data?.text || "I couldn't generate a response.";
  }

  text = convertMarkdownTablesToHTML(text);
  return { reply: text, success: true, reasoning: toolResult.reasoning || null };
}

/**
 * Execute a single tool step
 */
export async function executeStep({ tool, message, conversationId, sentiment, entities, stateGraph, onChunk }) {
  const queryText = getMessageText(message);

  // FIX #3: Email confirmation with BACKWARD SEARCH
  if (tool === "email_confirm") {
    console.log("📧 Processing email confirmation...");
    const memory = await getMemory();
    const conversation = memory.conversations?.[conversationId] || [];

    // CRITICAL FIX: Search backwards through conversation for most recent assistant message with pendingEmail
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
      console.log("❌ No pending email draft found.");
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

  // Direct LLM
  if (tool === "llm") {
    const memory = await getMemory();
    const profile = memory.profile || {};
    const conversation = memory.conversations?.[conversationId] || [];
    const capabilities = Object.keys(TOOLS);

    const prompt = buildLLMContext({
      userMessage: queryText,
      profile,
      conversation,
      capabilities,
      sentiment,
      entities,
      stateGraph
    });

    let reply = "";
    if (onChunk) {
      await llmStream(prompt, (chunk) => {
        reply += chunk;
        onChunk(chunk);
      });
    } else {
      const llmResponse = await llm(prompt);
      reply = llmResponse?.data?.text || "I couldn't generate a response.";
    }

    reply = convertMarkdownTablesToHTML(reply);

    return {
      tool,
      input: message,
      output: { tool, success: true, final: true, data: { text: reply } },
      success: true,
      final: true
    };
  }

  // Regular tool execution
  const toolKeys = Object.keys(TOOLS);
  const actualToolKey = toolKeys.find(k => k.toLowerCase() === tool.toLowerCase());

  if (!actualToolKey) {
    console.error(`❌ Tool not found: ${tool}`);
    return {
      tool,
      input: message,
      output: { tool, success: false, final: true, error: `Tool "${tool}" not found` },
      success: false,
      final: true
    };
  }

  tool = actualToolKey;

  // Build tool input
  let toolInput;
  if (["weather", "memorytool", "gitLocal", "review", "githubTrending", "webDownload"].includes(tool)) {
    toolInput = message; // { text, context }
  } else {
    toolInput = queryText; // string
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
 * Finalize a tool step (summarize or return raw)
 */
export async function finalizeStep({ stepResult, message, conversationId, sentiment, entities, stateGraph, onChunk }) {
  const { tool, output: result } = stepResult;

  if (!stepResult.success) {
    return {
      reply: result?.error || result?.data?.error || "Tool execution failed.",
      tool,
      success: false,
      final: true
    };
  }

  // Special cases: no summarization
  if (tool === "memorytool" || tool === "selfImprovement") {
    return {
      reply: result.data?.text || result.data?.message || "Task completed.",
      tool,
      data: result.data,
      success: true,
      final: true
    };
  }

  // FIX #3: Email draft - return as-is with pendingEmail preserved
  if (tool === "email" && result.data?.mode === "draft") {
    return {
      reply: result.data.message,
      tool,
      data: result.data, // CRITICAL: Contains pendingEmail for "send it"
      success: true,
      final: true
    };
  }

  // Tools that need summarization
  const summarizeTools = [
    "search", "finance", "financeFundamentals", "calculator", "weather",
    "sports", "youtube", "shopping", "email", "tasks", "news", "file",
    "github", "review", "githubTrending", "gitLocal", "nlp_tool", "lotrJokes"
  ];

  if (summarizeTools.includes(tool)) {
    const summary = await summarizeWithLLM({
      userQuestion: getMessageText(message),
      toolResult: result,
      conversationId,
      tool,
      sentiment,
      entities,
      stateGraph, // FIX #6: Pass stateGraph for context
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

  // Default: raw output
  const reply = result?.data?.html || result?.data?.text || result?.output || JSON.stringify(result?.data) || "Task completed.";

  return {
    reply,
    tool,
    data: result.data,
    reasoning: result.reasoning || null,
    success: true,
    final: true
  };
}

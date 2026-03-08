// server/executor.js
// COMPLETE FIX: All original functionality + email confirmation + context awareness + SAFE JSON + NO HANGS

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { llm, llmStream } from "./tools/llm.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { sendConfirmedEmail } from "./tools/email.js";
import { PROJECT_ROOT } from "./utils/config.js";
import { getBackgroundNLP } from "./utils/nlpUtils.js";
import { buildStyleInstructions } from "./utils/styleEngine.js";
import {
  convertMarkdownTablesToHTML,
  wantsTableFormat,
  normalizeCityAliases,
  getMessageText
} from "./utils/uiUtils.js";

/* ============================================================
   BUILD LLM CONTEXT
============================================================ */
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

  const CONTEXT_ENRICHMENT = `
NLP ANALYSIS:
- Sentiment: ${sentiment?.sentiment || "neutral"} (Score: ${sentiment?.score || 0})
- Entities Detected: ${entities ? JSON.stringify(entities) : "none"}

PREVIOUS STEPS IN THIS SEQUENCE:
${stateGraph && stateGraph.length > 0 ? JSON.stringify(stateGraph, null, 2) : "none"}
`;

  const userName = profile?.self?.name || profile?.name || "User";

  return `${awarenessContext}
${CONTEXT_ENRICHMENT}

The user's name is ${userName}. Always address them as ${userName}.

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

/* ============================================================
   RUN LLM WITH FULL MEMORY
============================================================ */
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

  return convertMarkdownTablesToHTML(text);
}

/* ============================================================
   SUMMARIZE TOOL RESULTS — SAFE JSON
============================================================ */
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

  let styleText = "";
  try { styleText = await buildStyleInstructions(); } catch {}

  const conversation = memory.conversations?.[conversationId] || [];
  const allMessages = conversation;

  const convoText = allMessages.map(m => `${m.role}: ${m.content}`).join("\n");
  const today = new Date().toLocaleDateString("en-GB");
  const tableRequested = wantsTableFormat(userQuestion);

  let contextSummary = "";
  if (stateGraph && stateGraph.length > 0) {
    contextSummary = "\n\nPREVIOUS STEPS IN THIS SEQUENCE:\n";
    stateGraph.forEach(step => {
      contextSummary += `- Step ${step.step}: ${step.tool} - ${step.success ? "success" : "failed"}\n`;
    });
  }

  // SAFE JSON STRINGIFY
  let toolResultJson = "";
  try {
    toolResultJson = JSON.stringify(toolResult, null, 2);
  } catch (e) {
    toolResultJson = `"<< Tool result could not be stringified: ${e.message} >>"`;
  }

  const prompt = `
You are the final response generator for an AI assistant.
Current date: ${today}

User question:
${userQuestion}

Tool used: ${tool}

Tool result (structured data):
${toolResultJson}

Tone instructions:
${toneText}
${styleText ? `Style preferences:\n${styleText}` : ""}

Conversation history:
${convoText}

Generate the final answer:
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

  return {
    reply: convertMarkdownTablesToHTML(text),
    success: true,
    reasoning: toolResult.reasoning || null
  };
}

/* ============================================================
   REFORMAT TABLE
============================================================ */
async function reformatAsTable({ userMessage, conversationId }) {
  const memory = await getMemory();
  const conversation = memory.conversations?.[conversationId] || [];

  const lastAssistantMessage = [...conversation].reverse().find(m => m.role === "assistant");

  if (!lastAssistantMessage) {
    return { reply: "I don't have a previous response to reformat.", success: false, stateGraph: [] };
  }

  const prompt = `
You are helping reformat a previous response into an HTML table.

Previous response:
${lastAssistantMessage.content}

User request:
${userMessage}

Generate the reformatted response:
`;

  const llmResponse = await llm(prompt);
  const text = convertMarkdownTablesToHTML(llmResponse?.data?.text || "I couldn't reformat the response.");

  return {
    reply: text,
    success: true,
    stateGraph: [{ step: 1, tool: "reformat_table", input: userMessage, output: text, final: true }]
  };
}

/* ============================================================
   EXECUTE A SINGLE TOOL STEP
============================================================ */
export async function executeStep({ tool, message, conversationId, sentiment, entities, stateGraph, onChunk }) {
  const queryText = typeof message === "string" ? message : message?.text || "";

  // EMAIL CONFIRMATION
  if (tool === "email_confirm") {
    const emailContext = typeof message === "object" ? (message.context || {}) : {};

    if (emailContext.action === "cancel") {
      return {
        tool: "email_confirm",
        input: message,
        output: { tool: "email", success: true, final: true, data: { message: "✅ Email draft discarded." } },
        data: { message: "✅ Email draft discarded." },
        success: true,
        final: true
      };
    }

    const memory = await getMemory();
    const conversation = memory.conversations?.[conversationId] || [];

    const draftMessage = [...conversation]
      .reverse()
      .find(m => m.role === "assistant" && m.data?.pendingEmail);

    if (draftMessage && draftMessage.data.pendingEmail) {
      const { to, subject, body, attachments } = draftMessage.data.pendingEmail;
      const sendResult = await sendConfirmedEmail({ to, subject, body, attachments });

      return {
        tool: "email_confirm",
        input: message,
        output: sendResult,
        data: sendResult.data || sendResult,
        success: sendResult.success,
        final: true
      };
    }

    return {
      tool: "email_confirm",
      input: message,
      output: { tool: "email", success: false, final: true, error: "No pending email to send." },
      success: false,
      final: true
    };
  }

  // REFORMAT TABLE
  if (tool === "reformat_table") {
    return await reformatAsTable({ userMessage: getMessageText(message), conversationId });
  }

  // DIRECT LLM
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

  // NORMAL TOOL EXECUTION
  message = normalizeCityAliases(message);

  const toolKeys = Object.keys(TOOLS);
  const actualToolKey = toolKeys.find(k => k.toLowerCase() === tool.toLowerCase());

  if (!actualToolKey) {
    return {
      tool,
      input: message,
      output: { tool, success: false, final: true, error: `Tool "${tool}" not found.` },
      success: false,
      final: true
    };
  }

  tool = actualToolKey;

  let toolInput;
  if (["weather", "memorytool", "gitLocal", "review", "githubTrending", "webDownload", "applyPatch", "fileReview", "duplicateScanner", "webBrowser", "moltbook", "fileWrite", "email", "calendar", "documentQA", "contacts", "workflow", "folderAccess", "codeReview", "codeTransform", "projectGraph", "projectIndex", "githubScanner", "selfEvolve", "scheduler", "packageManager"].includes(tool)) {
    if (tool === "email" && typeof message === "object") {
      const queryText = message.text || message.input || "";
      const ctx = message.context || {};
      toolInput = queryText;
      const result = await TOOLS[tool](toolInput, ctx);
      return {
        tool,
        input: toolInput,
        output: result,
        data: result.data,
        success: result.success,
        final: result?.final ?? true
      };
    }
    toolInput = message;
  } else {
    toolInput = getMessageText(message);
  }

  const result = await TOOLS[tool](toolInput);

  return {
    tool,
    input: toolInput,
    output: result,
    success: result.success,
    final: result?.final ?? true
  };
}

/* ============================================================
   FINALIZE STEP
============================================================ */
export async function finalizeStep({ stepResult, message, conversationId, sentiment, entities, stateGraph, onChunk }) {
  const { tool, output: result } = stepResult;

  // ERROR HANDLING
  if (!stepResult.success) {
    const errorText = result?.error || result?.data?.error || "Tool execution failed.";
    try {
      const errorExplanation = await summarizeWithLLM({
        userQuestion: getMessageText(message),
        toolResult: { tool, success: false, error: errorText, data: result?.data || {}, stateGraph },
        conversationId,
        tool,
        sentiment,
        entities,
        stateGraph,
        onChunk
      });
      return { reply: errorExplanation.reply, tool, success: false, final: true };
    } catch {
      return { reply: errorText, tool, success: false, final: true };
    }
  }

  // PRE-FORMATTED RESULTS (EMAIL DRAFTS)
  if (result.data?.preformatted && result.data?.text) {
    return { reply: result.data.text, tool, data: result.data, success: true, final: true };
  }

  // EMAIL CONFIRMATION
  if (tool === "email_confirm" || (tool === "email" && result.data?.messageId)) {
    return {
      reply: result.data?.message || result.data?.text || "Email operation completed.",
      tool,
      data: result.data,
      success: true,
      final: true
    };
  }

  // TOOLS THAT SHOULD BE SUMMARIZED — EMAIL REMOVED
  const summarizeTools = [
    "search", "finance", "financeFundamentals", "calculator", "weather",
    "sports", "youtube", "shopping", "tasks", "news", "file",
    "github", "review", "githubTrending", "gitLocal", "nlp_tool", "lotrJokes",
    "webDownload", "webBrowser", "moltbook",
    "calendar", "documentQA", "contacts", "workflow"
  ];

  if (summarizeTools.includes(tool)) {
    const summary = await summarizeWithLLM({
      userQuestion: getMessageText(message),
      toolResult: result,
      conversationId,
      tool,
      sentiment,
      entities,
      stateGraph,
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

  // DEFAULT RAW OUTPUT
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


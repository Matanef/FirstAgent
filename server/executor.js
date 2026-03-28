// server/executor.js
// COMPLETE FIX: All original functionality + email confirmation + context awareness + SAFE JSON + NO HANGS

import { TOOLS } from "./tools/index.js";
import { getMemory } from "./memory.js";
import { llm, llmStream } from "./tools/llm.js";
import { getToneDescription } from "../tone/toneGuide.js";
import { sendConfirmedEmail } from "./tools/email.js";
import { PROJECT_ROOT } from "./utils/config.js";
import { buildStyleInstructions } from "./utils/styleEngine.js";
import {
  convertMarkdownTablesToHTML,
  normalizeCityAliases,
  getMessageText
} from "./utils/uiUtils.js";
import { getPersonalityContext } from "./personality.js";

/* ============================================================
   BUILD LLM CONTEXT
============================================================ */
async function buildLLMContext({ userMessage, profile, conversation, capabilities, sentiment, entities, stateGraph, conversational }) {
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

  // ── CONVERSATIONAL PARTNER MODE ──
  // When the planner detects a personal/emotional/reflective message, we inject
  // deeper profile context and a supportive collaborator directive. This makes
  // the agent feel like a partner who knows you, not just a tool dispatcher.
  let conversationalDirective = "";
  let enrichedProfileText = "";

  if (conversational) {
    // Build a rich personality context from profile fields
    const p = profile || {};
    const self = p.self || {};
    const details = [];
    if (self.name) details.push(`Name: ${self.name}`);
    if (self.occupation || p.occupation) details.push(`Occupation: ${self.occupation || p.occupation}`);
    if (self.interests || p.interests) details.push(`Interests: ${JSON.stringify(self.interests || p.interests)}`);
    if (self.location || p.location || p.city) details.push(`Location: ${self.location || p.location || p.city}`);
    if (self.timezone || p.timezone) details.push(`Timezone: ${self.timezone || p.timezone}`);
    if (self.background || p.background) details.push(`Background: ${self.background || p.background}`);
    if (self.goals || p.goals) details.push(`Goals: ${JSON.stringify(self.goals || p.goals)}`);
    if (self.preferences || p.preferences) details.push(`Preferences: ${JSON.stringify(self.preferences || p.preferences)}`);

    // Gather recent conversation themes (last 10 user messages)
    const recentUserMsgs = allMessages
      .filter(m => m.role === "user")
      .slice(-10)
      .map(m => m.content);
    const recentContext = recentUserMsgs.length > 0
      ? `Recent conversation topics: ${recentUserMsgs.map(m => m.substring(0, 80)).join(" | ")}`
      : "";

    enrichedProfileText = details.length > 0
      ? `\nDETAILED USER PROFILE:\n${details.join("\n")}\n${recentContext}\n`
      : "";

    conversationalDirective = `
CONVERSATIONAL PARTNER MODE:
This is a personal, reflective, or emotional message — NOT a tool request.
Your role right now is a thoughtful, supportive collaborator who:
- Remembers past conversations and references them naturally when relevant
- Acknowledges emotions genuinely without being sycophantic or over-the-top
- Offers honest, balanced perspectives — not just agreement
- Asks follow-up questions to understand better when appropriate
- Draws on what you know about ${userName} to personalize your response
- Keeps responses warm but concise (2-4 paragraphs max unless the topic warrants more)
- Never redirects to tools unless the user asks for something specific
- If the user shares something personal, prioritize empathy over problem-solving
`;
  }

  // Load global personality context
  let personalityCtx = "";
  try {
    personalityCtx = await getPersonalityContext(conversational ? "chat" : "task");
  } catch (e) {
    console.warn("[executor] Could not load personality:", e.message);
  }

  return `${personalityCtx ? personalityCtx + "\n\n" : ""}${awarenessContext}
${CONTEXT_ENRICHMENT}
${enrichedProfileText}

The user's name is ${userName}. Always address them as ${userName}.
${conversationalDirective}

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
async function runLLMWithFullMemory({ userMessage, conversationId, sentiment, entities, stateGraph, onChunk, conversational }) {
  const memory = await getMemory();
  const profile = memory.profile || {};
  const conversation = memory.conversations?.[conversationId] || [];
  const capabilities = Object.keys(TOOLS);

  const prompt = await buildLLMContext({
    userMessage,
    profile,
    conversation,
    capabilities,
    sentiment,
    entities,
    stateGraph,
    conversational
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

  // Build multi-step context if this is part of a chain
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

IMPORTANT: You have access to real tools that fetch live data from the internet, databases, and APIs. The tool result below contains REAL DATA that was already fetched for you. DO NOT say you cannot access the internet or external content — the data is RIGHT HERE in the tool result. Your job is to read the tool result and present it clearly to the user.

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
${contextSummary}
Generate the final answer based on the tool result above. NEVER claim you cannot access external content — the content has already been fetched and is provided above.

ANTI-FABRICATION RULES:
- ONLY use numbers, names, and facts that appear LITERALLY in the tool result above.
- If the tool result contains no data for a specific item, say "data not available" — NEVER invent or estimate values.
- NEVER copy data from one ticker/entity onto another. Each item's data must come from its own entry in the tool result.
- If the tool result is empty or contains only errors, tell the user the data could not be fetched.
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
    // Check if planner flagged this as a personal conversation
    const msgContext = typeof message === "object" ? (message.context || {}) : {};
    const isConversational = msgContext.conversational === true;

    // CHAIN CONTEXT: if previous tool output is available, prepend it to the prompt
    // so the LLM can actually see the data it needs to process
    let llmPrompt = getMessageText(message);
    if (msgContext.chainContext?.previousOutput) {
      // Prefer plain text (shorter, cleaner) over HTML
      const prevRaw = msgContext.chainContext.previousRaw;
      const prevData = prevRaw?.plain || prevRaw?.text ||
        (typeof msgContext.chainContext.previousOutput === "string"
          ? msgContext.chainContext.previousOutput
          : JSON.stringify(msgContext.chainContext.previousOutput));
      const prevTool = msgContext.chainContext.previousTool || "previous step";
      console.log(`🧠 [llm] Injecting chain context from "${prevTool}" (${prevData.length} chars)`);
      llmPrompt = `IMPORTANT: The following content was fetched from the internet by the ${prevTool} tool. This is real, factual data. Your job is to read it and respond to the user's request. Do NOT refuse — this is informational content the user explicitly asked for.\n\nContent from ${prevTool}:\n\n---\n${prevData}\n---\n\nUser request:\n${llmPrompt}`;
    }

    const reply = await runLLMWithFullMemory({
      userMessage: llmPrompt,
      conversationId,
      sentiment,
      entities,
      stateGraph,
      onChunk,
      conversational: isConversational
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
  if (["weather", "memorytool", "gitLocal", "review", "githubTrending", "webDownload", "applyPatch", "fileReview", "duplicateScanner", "webBrowser", "moltbook", "fileWrite", "email", "calendar", "documentQA", "contacts", "workflow", "folderAccess", "codeReview", "codeTransform", "projectGraph", "projectIndex", "githubScanner", "selfEvolve", "scheduler", "packageManager", "whatsapp", "x", "sheets", "nlp_tool", "news", "smartEvolution", "mcpBridge"].includes(tool)) {
    if (tool === "email" && typeof message === "object") {
      // Pass the full message object so email() can extract both text AND context
      // (email tool reads query.text and query.context internally)
      const result = await TOOLS[tool](message);
      return {
        tool,
        input: message.text || message.input || "",
        output: result,
        data: result.data,
        success: result.success,
        final: result?.final ?? true
      };
    }
    // CHAIN CONTEXT INJECTION for analysis tools (nlp_tool, etc.):
    // If the tool analyzes text and chain context has previous output,
    // inject that data into message.text so the tool has content to process
    if (typeof message === "object" && message.context?.chainContext?.previousOutput) {
      const prevRaw = message.context.chainContext.previousRaw;
      const chainData = prevRaw?.plain || prevRaw?.text ||
        (typeof message.context.chainContext.previousOutput === "string"
          ? message.context.chainContext.previousOutput
          : JSON.stringify(message.context.chainContext.previousOutput));
      const prevTool = message.context.chainContext.previousTool || "previous step";

      // For text-analysis tools, replace the instruction text with actual data
      if (["nlp_tool"].includes(tool)) {
        console.log(`🔗 [executor] Injecting chain context from "${prevTool}" into ${tool} (${chainData.length} chars)`);
        message = { ...message, text: chainData };
      }
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

    // Finance tools: NEVER let LLM hallucinate data on failure — return the error directly
    const noHallucinateOnError = ["finance", "financeFundamentals", "finance-fundamentals"];
    if (noHallucinateOnError.includes(tool)) {
      console.warn(`[finalizer] ${tool} failed — returning error directly (no LLM summarization)`);
      return {
        reply: `I wasn't able to fetch the requested financial data. ${errorText}`,
        tool,
        success: false,
        final: true
      };
    }

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

  // ── FIX: Add githubTrending to the HTML bypass ──
  if ((tool === "mcpBridge" || tool === "githubTrending") && result.data?.html) {
      console.log(`[executor] ${tool} HTML detected — bypassing LLM summarization`);
      return { 
        reply: result.data.text || "Results retrieved.", 
        html: result.data.html, 
        tool, 
        data: result.data, 
        success: true, 
        final: true 
      };
  }

  // PRE-FORMATTED RESULTS (finance tables, email drafts, etc.)
  if (result.data?.preformatted && result.data?.text) {
    return { 
      reply: result.data.text, 
      html: result.data.html || null, // Add this line to pass HTML through
      tool, 
      data: result.data, 
      success: true, 
      final: true 
    };
  }

  // FINANCE FUNDAMENTALS — has its own HTML table, skip LLM summarization
  if ((tool === "financeFundamentals" || tool === "finance-fundamentals") && result.data?.html) {
    const textSummary = result.data.tickers
      ? `Fundamentals for: ${result.data.tickers.join(", ")}`
      : "Financial fundamentals retrieved.";
    return { reply: textSummary, tool, data: result.data, success: true, final: true };
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

  // TOOLS THAT SHOULD BE SUMMARIZED BY LLM — EMAIL REMOVED
  // Tools with preformatted:true skip this (handled above), so safe to include them
  const summarizeTools = [
    "search", "finance", "financeFundamentals", "calculator", "weather",
    "sports", "youtube", "shopping", "tasks", "news", "file",
    "github", "review", "githubTrending", "gitLocal", "nlp_tool", "lotrJokes",
    "webDownload", "webBrowser", "moltbook",
    "calendar", "documentQA", "contacts", 
    "duplicateScanner", "folderAccess", "codeReview",
    "projectGraph", "projectIndex", "githubScanner", "scheduler",
    "packageManager", "memorytool", "whatsapp", "mcpBridge"
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



// TODO: executor: wire "chartGenerator" (./tools/chartGenerator.js) into the execution pipeline

// TODO: executor: wire "spotify" (./tools/spotify.js) into the execution pipeline
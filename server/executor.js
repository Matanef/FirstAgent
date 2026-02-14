// server/executor.js

import { TOOLS } from "./tools/index.js";

/**
 * Use LLM to summarize tool output
 */
async function summarizeWithLLM(userQuestion, toolResult) {
  const structuredData = JSON.stringify(toolResult.data, null, 2);

  const prompt = `
User question:
${userQuestion}

Tool returned this structured data:
${structuredData}

Provide a clear, direct answer to the user.
Do NOT list search results.
Do NOT include URLs.
Answer naturally and concisely.
`;

  const summary = await TOOLS.llm(prompt);

  return summary?.data?.text || "Unable to summarize result.";
}

/**
 * Execute planned tool
 */
export async function executeAgent({ tool, message }) {
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

  // If tool failed
  if (!result?.success) {
    return {
      reply: result?.error || "Tool execution failed.",
      stateGraph,
      success: false,
      tool
    };
  }

  // 🔥 Summarize search & finance tools
  if (["search", "finance"].includes(tool)) {
    const summarized = await summarizeWithLLM(message, result);

    stateGraph[0].output.data.text = summarized;

    return {
      reply: summarized,
      stateGraph,
      tool,
      data: result.data,
      success: true
    };
  }

  // Normal tools (llm, calculator, file)
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

// server/executor.js

import { plan } from "./planner.js";
import { TOOLS } from "./tools/index.js";
import { detectContradictions } from "./audit.js";

export async function executeAgent(message, conversationHistory) {
  const stateGraph = [];
  const toolUsage = {};
  let lastHash = null;

  while (true) {
    const decision = await plan({
      message,
      stateGraph,
      conversationHistory
    });

    if (!decision || decision.tool === "done") {
      return finalize(stateGraph);
    }

    const toolName = decision.tool;
    const toolParams = decision.params || message;

    if (!TOOLS[toolName]) {
      return finalize(stateGraph, `Unknown tool: ${toolName}`);
    }

    toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;

    if (toolUsage[toolName] > 3) {
      return finalize(stateGraph, "Tool budget exceeded.");
    }

    const result = await TOOLS[toolName].execute(toolParams);

    const contradictions = detectContradictions(stateGraph, result);

    const node = {
      step: stateGraph.length + 1,
      tool: toolName,
      input: toolParams,
      output: result,
      contradictions,
      final: result?.final || false
    };

    stateGraph.push(node);

    if (result?.final) {
      return finalize(stateGraph);
    }

    const currentHash = JSON.stringify(result?.data || {});
    if (currentHash === lastHash) {
      return finalize(stateGraph, "No new information gained.");
    }

    lastHash = currentHash;
  }
}

function finalize(stateGraph, fallbackMessage = null) {
  const last = stateGraph[stateGraph.length - 1];

  return {
    reply:
      fallbackMessage ||
      last?.output?.error ||
      "Task completed.",
    stateGraph,
    tool: last?.tool,
    data: last?.output?.data,
    success: last?.output?.success
  };
}

import fetch from "node-fetch";
import { searchWeb } from "./tools/search.js";
import { calculator } from "./tools/calculator.js";
import { getTopStocks } from "./tools/finance.js";
import { plan } from "./planner.js";
import { detectContradictions } from "./audit.js";
import { CONFIG } from "./utils/config.js";

const MAX_TOOL_CALLS = {
  search: 2,
  llm: 2,
  calculator: 1,
  finance: 2
};

export async function executeStep(
  message,
  step,
  stateGraph,
  toolUsage,
  convo
) {
  const decision = plan(message);
  console.log(`🤖 STEP ${step} PLAN:`, decision);

  toolUsage[decision] ??= 0;

  if (toolUsage[decision] >= MAX_TOOL_CALLS[decision]) {
    return { reply: null };
  }

  toolUsage[decision]++;

  // CALCULATOR
  if (decision === "calculator") {
    const result = calculator(message);
    const reply = result.error ?? `Result: ${result.result}`;

    stateGraph.push({ step, tool: "calculator", output: reply });
    return { reply };
  }

  // FINANCE
  if (decision === "finance") {
    const finance = await getTopStocks(10);

    if (!finance.results || finance.results.length === 0) {
      stateGraph.push({
        step,
        tool: "finance",
        output: "(no finance results)",
        citationMiss: ["Finance API returned no results"]
      });

      if (CONFIG.CRITICAL_TOOLS.includes("finance")) {
        return {
          reply:
            "⚠️ Finance API unavailable (401 or invalid key). Cannot provide verified stock analysis."
        };
      }

      return await llmFallback(message, stateGraph, convo, step);
    }

    stateGraph.push({
      step,
      tool: "finance",
      output: finance.results
    });

    const context = finance.results
      .map(s => `${s.symbol} (${s.name}) - $${s.price}`)
      .join("\n");

    const response = await callLLM(
      `Based ONLY on this financial data:\n${context}\nAnswer: ${message}`
    );

    const contradictions = detectContradictions(stateGraph, response);

    stateGraph.push({
      step: step + 0.5,
      tool: "llm",
      output: response,
      contradictions
    });

    return { reply: response };
  }

  // SEARCH
  if (decision === "search") {
    const search = await searchWeb(message);

    if (!search.results || search.results.length === 0) {
      stateGraph.push({
        step,
        tool: "search",
        output: "(no search results)"
      });

      return await llmFallback(message, stateGraph, convo, step);
    }

    stateGraph.push({
      step,
      tool: "search",
      output: search.results
    });

    const context = search.results
      .map(r => `${r.title}: ${r.snippet}`)
      .join("\n");

    const response = await callLLM(
      `Use ONLY these sources:\n${context}\nQuestion: ${message}`
    );

    const contradictions = detectContradictions(stateGraph, response);

    stateGraph.push({
      step: step + 0.5,
      tool: "llm",
      output: response,
      contradictions
    });

    return { reply: response };
  }

  return await llmFallback(message, stateGraph, convo, step);
}

async function llmFallback(message, stateGraph, convo, step) {
  const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");
  const response = await callLLM(prompt);

  const contradictions = detectContradictions(stateGraph, response);

  stateGraph.push({
    step,
    tool: "llm-fallback",
    output: response,
    contradictions
  });

  return { reply: response };
}

async function callLLM(prompt) {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mat-llm",
      prompt,
      stream: false
    })
  });

  const data = await res.json();
  return data.response ?? "(no response)";
}

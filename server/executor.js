// server/executor.js

import fetch from "node-fetch";
import { TOOLS } from "./tools/index.js";
import { plan } from "./planner.js";
import { detectContradictions } from "./audit.js";

const MAX_TOOL_CALLS = {
  search: 3,
  llm: 3,
  calculator: 1,
  finance: 2,
  stock_price: 2,
  file: 2
};

/**
 * Execute a single step in the agent loop
 */
export async function executeStep(
  message,
  step,
  stateGraph,
  toolUsage,
  conversationHistory
) {
  const decision = plan(message);
  const action = decision.action;
  const params = decision.params || {};

  console.log(`🤖 STEP ${step} PLAN:`, {
    action,
    params,
    confidence: decision.confidence
  });

  toolUsage[action] ??= 0;

  if (toolUsage[action] >= MAX_TOOL_CALLS[action]) {
    console.warn(`⚠️ Tool budget exceeded for: ${action}`);
    return await llmFallback(
      message,
      stateGraph,
      conversationHistory,
      step
    );
  }

  toolUsage[action]++;

  switch (action) {
    case "calculator":
      return await handleCalculator(message, step, stateGraph);

    case "finance":
      return await handleFinance(
        message,
        params,
        step,
        stateGraph
      );

    case "stock_price":
      return await handleStockPrice(
        params,
        step,
        stateGraph
      );

    case "search":
      return await handleSearch(
        message,
        step,
        stateGraph
      );

    case "file": {
      const result = await TOOLS.file.execute(params);

      stateGraph.push({
        step,
        tool: "file",
        input: params,
        output: result
      });

      return { reply: result };
    }

    case "llm":
    default:
      return await llmFallback(
        message,
        stateGraph,
        conversationHistory,
        step
      );
  }
}

/**
 * Calculator tool
 */
async function handleCalculator(message, step, stateGraph) {
  const result = TOOLS.calculator.execute(message);
  const reply = result.error ?? `Result: ${result.result}`;

  stateGraph.push({
    step,
    tool: "calculator",
    input: message,
    output: result
  });

  return { reply };
}

/**
 * Finance tool
 */
async function handleFinance(message, params, step, stateGraph) {
  const financeData = await TOOLS.finance.execute(params);

  if (
    financeData.error ||
    !financeData.results ||
    financeData.results.length === 0
  ) {
    const errorMsg = financeData.error || "No results found";

    stateGraph.push({
      step,
      tool: "finance",
      input: params,
      output: errorMsg
    });

    return { reply: `⚠️ Financial data unavailable.\n${errorMsg}` };
  }

  const reply = financeData.results
    .map(
      (s, i) =>
        `${i + 1}. ${s.symbol} - ${s.name}\nPrice: $${s.price?.toFixed(
          2
        ) || "N/A"}`
    )
    .join("\n\n");

  stateGraph.push({
    step,
    tool: "finance",
    input: params,
    output: financeData.results
  });

  return { reply };
}

/**
 * Stock price tool
 */
async function handleStockPrice(params, step, stateGraph) {
  const { symbol } = params;

  if (!symbol) {
    return { reply: "Please specify a stock symbol (e.g., AAPL)" };
  }

  const stockData = await TOOLS.stock_price.execute(symbol);

  if (stockData.error) {
    stateGraph.push({
      step,
      tool: "stock_price",
      input: symbol,
      output: stockData.error
    });

    return {
      reply: `Unable to fetch price for ${symbol}: ${stockData.error}`
    };
  }

  const reply =
    `${stockData.name} (${stockData.symbol})\n` +
    `Price: $${stockData.price.toFixed(2)}\n` +
    `Change: ${stockData.change >= 0 ? "+" : ""}${stockData.change.toFixed(
      2
    )} (${stockData.changePercent.toFixed(2)}%)`;

  stateGraph.push({
    step,
    tool: "stock_price",
    input: symbol,
    output: stockData
  });

  return { reply };
}

/**
 * Web search tool (deterministic version)
 */
async function handleSearch(message, step, stateGraph) {
  const searchResults = await TOOLS.search.execute(message);

  if (!searchResults.results || searchResults.results.length === 0) {
    stateGraph.push({
      step,
      tool: "search",
      input: message,
      output: "(no results)"
    });

    return { reply: "No search results found." };
  }

  stateGraph.push({
    step,
    tool: "search",
    input: message,
    output: searchResults.results,
    cached: searchResults.cached || false
  });

  return { reply: searchResults.summary };
}

/**
 * LLM fallback
 */
async function llmFallback(
  message,
  stateGraph,
  conversationHistory,
  step
) {
  const context = conversationHistory
    .slice(-5)
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt =
    `${context}\n\nuser: ${message}\n\nRespond naturally and helpfully:`;

  const response = await callLLM(prompt);
  const contradictions = detectContradictions(
    stateGraph,
    response
  );

  stateGraph.push({
    step,
    tool: "llm-fallback",
    input: prompt,
    output: response,
    contradictions
  });

  return { reply: response };
}

/**
 * Call local LLM via Ollama
 */
async function callLLM(prompt) {
  try {
    const res = await fetch(
      "http://localhost:11434/api/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mat-llm:latest",
          prompt,
          stream: false,
          options: { temperature: 0.7, num_predict: 500 }
        })
      }
    );

    if (!res.ok) return "(LLM unavailable)";

    const data = await res.json();
    return data.response?.trim() || "(no response)";
  } catch (err) {
    console.error("LLM error:", err.message);
    return "(LLM error)";
  }
}

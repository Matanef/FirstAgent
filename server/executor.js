// server/executor.js
import fetch from "node-fetch";
import { TOOLS } from "./tools/index.js";
import { plan } from "./planner.js";
import { detectContradictions } from "./audit.js";
import { CONFIG } from "./utils/config.js";

const MAX_TOOL_CALLS = {
  search: 3,
  llm: 3,
  calculator: 1,
  finance: 2,
  stock_price: 2
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
  // Get plan with parameters
  const decision = plan(message);
  const action = decision.action;
  const params = decision.params || {};

  console.log(`🤖 STEP ${step} PLAN:`, {
    action,
    params,
    confidence: decision.confidence
  });

  // Initialize tool usage counter
  toolUsage[action] ??= 0;

  // Check tool budget
  if (toolUsage[action] >= MAX_TOOL_CALLS[action]) {
    console.warn(`⚠️ Tool budget exceeded for: ${action}`);
    return await llmFallback(message, stateGraph, conversationHistory, step);
  }

  toolUsage[action]++;

  // Route to appropriate tool handler
  switch (action) {
    case "calculator":
      return await handleCalculator(message, step, stateGraph);

    case "finance":
      return await handleFinance(message, params, step, stateGraph, conversationHistory);

    case "stock_price":
      return await handleStockPrice(params, step, stateGraph, conversationHistory);

    case "search":
      return await handleSearch(message, step, stateGraph, conversationHistory);

    case "llm":
    default:
      return await llmFallback(message, stateGraph, conversationHistory, step);
  }
}

/**
 * Handle calculator tool
 */
async function handleCalculator(message, step, stateGraph) {
  const tool = TOOLS.calculator;
  const result = tool.execute(message);

  const reply = result.error ?? `Result: ${result.result}`;

  stateGraph.push({
    step,
    tool: "calculator",
    input: message,
    output: result,
    reply
  });

  return { reply };
}

/**
 * Handle finance tool (market data, sector queries)
 */
async function handleFinance(message, params, step, stateGraph, conversationHistory) {
  const tool = TOOLS.finance;
  
  console.log("💰 Finance params:", params);

  const financeData = await tool.execute(params);

  // Handle API errors
  if (financeData.error || !financeData.results || financeData.results.length === 0) {
    const errorMsg = financeData.error || "No results found";
    
    stateGraph.push({
      step,
      tool: "finance",
      input: params,
      output: errorMsg,
      citationMiss: ["Finance API returned no results"]
    });

    // If finance is critical, don't fallback
    if (CONFIG.CRITICAL_TOOLS.includes("finance")) {
      return {
        reply: `⚠️ Unable to fetch financial data: ${errorMsg}. Please check your FMP API key.`
      };
    }

    // Fallback to LLM with disclaimer
    const fallbackReply = await callLLM(
      `The user asked: "${message}"\n\nI don't have access to live financial data. Provide a general response explaining what type of information they're looking for and suggest they check financial websites.`
    );

    return { reply: `⚠️ Financial data unavailable.\n\n${fallbackReply}` };
  }

  // Success - format and present results
  stateGraph.push({
    step,
    tool: "finance",
    input: params,
    output: financeData.results
  });

  // Create context for LLM to format nicely
  const context = financeData.results
    .map((s, i) => 
      `${i + 1}. ${s.symbol} - ${s.name}\n   Sector: ${s.sector || 'N/A'}\n   Industry: ${s.industry || 'N/A'}\n   Market Cap: $${(s.marketCap / 1e9).toFixed(2)}B\n   Price: $${s.price?.toFixed(2) || 'N/A'}`
    )
    .join("\n\n");

  const prompt = `Based ONLY on this verified financial data, answer the user's question: "${message}"\n\nFinancial Data:\n${context}\n\nProvide a clear, well-formatted response. Include the stock symbols, names, and key metrics.`;

  const response = await callLLM(prompt);

  const contradictions = detectContradictions(stateGraph, response);

  stateGraph.push({
    step: step + 0.5,
    tool: "llm",
    input: prompt,
    output: response,
    contradictions
  });

  return { reply: response };
}

/**
 * Handle specific stock price queries
 */
async function handleStockPrice(params, step, stateGraph, conversationHistory) {
  const tool = TOOLS.stock_price;
  const { symbol } = params;

  if (!symbol) {
    return { reply: "Please specify a stock symbol (e.g., AAPL, GOOGL)" };
  }

  const stockData = await tool.execute(symbol);

  if (stockData.error) {
    stateGraph.push({
      step,
      tool: "stock_price",
      input: symbol,
      output: stockData.error
    });

    return { reply: `Unable to fetch price for ${symbol}: ${stockData.error}` };
  }

  stateGraph.push({
    step,
    tool: "stock_price",
    input: symbol,
    output: stockData
  });

  const reply = `${stockData.name} (${stockData.symbol})
Price: $${stockData.price.toFixed(2)}
Change: ${stockData.change >= 0 ? '+' : ''}${stockData.change.toFixed(2)} (${stockData.changePercent.toFixed(2)}%)
Market Cap: $${(stockData.marketCap / 1e9).toFixed(2)}B`;

  return { reply };
}

/**
 * Handle web search
 */
async function handleSearch(message, step, stateGraph, conversationHistory) {
  const tool = TOOLS.search;
  const searchResults = await tool.execute(message);

  if (!searchResults.results || searchResults.results.length === 0) {
    stateGraph.push({
      step,
      tool: "search",
      input: message,
      output: "(no search results)"
    });

    return await llmFallback(message, stateGraph, conversationHistory, step);
  }

  stateGraph.push({
    step,
    tool: "search",
    input: message,
    output: searchResults.results,
    cached: searchResults.cached || false
  });

  const context = searchResults.results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.link}`)
    .join("\n\n");

  const prompt = `Use ONLY these verified sources to answer: "${message}"\n\nSources:\n${context}\n\nProvide a comprehensive answer with source references [1], [2], etc.`;

  const response = await callLLM(prompt);

  const contradictions = detectContradictions(stateGraph, response);

  stateGraph.push({
    step: step + 0.5,
    tool: "llm",
    input: prompt,
    output: response,
    contradictions
  });

  return { reply: response };
}

/**
 * LLM fallback when tools aren't needed or fail
 */
async function llmFallback(message, stateGraph, conversationHistory, step) {
  // Build context from conversation
  const context = conversationHistory
    .slice(-5) // Last 5 messages for context
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = `${context}\n\nuser: ${message}\n\nRespond naturally and helpfully:`;

  const response = await callLLM(prompt);

  const contradictions = detectContradictions(stateGraph, response);

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
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2",  // Updated to a common model
        prompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 500
        }
      })
    });

    if (!res.ok) {
      console.error("LLM request failed:", res.status);
      return "(LLM unavailable)";
    }

    const data = await res.json();
    return data.response?.trim() || "(no response)";
  } catch (err) {
    console.error("LLM error:", err.message);
    return "(LLM error)";
  }
}
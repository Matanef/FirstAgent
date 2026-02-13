// server/executor.js
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
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
  stock_price: 2,
  file: 2
};

/**
 * Execute a single step in the agent loop
 */
export async function executeStep(message, step, stateGraph, toolUsage, conversationHistory) {
  const decision = plan(message);
  const action = decision.action;
  const params = decision.params || {};

  console.log(`🤖 STEP ${step} PLAN:`, { action, params, confidence: decision.confidence });

  // Initialize tool usage
  toolUsage[action] ??= 0;

  // Tool call budget check
  if (toolUsage[action] >= MAX_TOOL_CALLS[action]) {
    console.warn(`⚠️ Tool budget exceeded for: ${action}`);
    return await llmFallback(message, stateGraph, conversationHistory, step);
  }

  toolUsage[action]++;

  // Route to tool
  switch (action) {
    case "calculator":
      return await handleCalculator(message, step, stateGraph);
    case "finance":
      return await handleFinance(message, params, step, stateGraph, conversationHistory);
    case "stock_price":
      return await handleStockPrice(params, step, stateGraph, conversationHistory);
    case "search":
      return await handleSearch(message, step, stateGraph, conversationHistory);
    case "file": {
      const result = await handleFileOperation(params, step, stateGraph);
      return result;   // explicitly return structured object
    };
    case "llm":
    default:
      return await llmFallback(message, stateGraph, conversationHistory, step);
  }
}

/**
 * Calculator tool
 */
async function handleCalculator(message, step, stateGraph) {
  const tool = TOOLS.calculator;
  const result = tool.execute(message);
  const reply = result.error ?? `Result: ${result.result}`;

  stateGraph.push({ step, tool: "calculator", input: message, output: result, reply });
  return { reply };
}

/**
 * Finance tool
 */
async function handleFinance(message, params, step, stateGraph, conversationHistory) {
  const tool = TOOLS.finance;
  const financeData = await tool.execute(params);

  if (financeData.error || !financeData.results || financeData.results.length === 0) {
    const errorMsg = financeData.error || "No results found";
    stateGraph.push({ step, tool: "finance", input: params, output: errorMsg });
    const fallbackReply = await callLLM(`User asked: "${message}". Cannot access live finance data. Explain generally.`);
    return { reply: `⚠️ Financial data unavailable.\n\n${fallbackReply}` };
  }

  const context = financeData.results.map((s, i) =>
    `${i + 1}. ${s.symbol} - ${s.name}\n   Sector: ${s.sector || 'N/A'}\n   Industry: ${s.industry || 'N/A'}\n   Market Cap: $${(s.marketCap / 1e9).toFixed(2)}B\n   Price: $${s.price?.toFixed(2) || 'N/A'}`
  ).join("\n\n");

  const prompt = `Based ONLY on this verified financial data, answer: "${message}"\n\n${context}\nProvide a clear, well-formatted response.`;
  const response = await callLLM(prompt);

  const contradictions = detectContradictions(stateGraph, response);
  stateGraph.push({ step: step + 0.5, tool: "llm", input: prompt, output: response, contradictions });

  return { reply: response };
}

/**
 * Stock price tool
 */
async function handleStockPrice(params, step, stateGraph) {
  const tool = TOOLS.stock_price;
  const { symbol } = params;

  if (!symbol) return { reply: "Please specify a stock symbol (e.g., AAPL)" };

  const stockData = await tool.execute(symbol);
  if (stockData.error) {
    stateGraph.push({ step, tool: "stock_price", input: symbol, output: stockData.error });
    return { reply: `Unable to fetch price for ${symbol}: ${stockData.error}` };
  }

  stateGraph.push({ step, tool: "stock_price", input: symbol, output: stockData });
  const reply = `${stockData.name} (${stockData.symbol})\nPrice: $${stockData.price.toFixed(2)}\nChange: ${stockData.change >= 0 ? '+' : ''}${stockData.change.toFixed(2)} (${stockData.changePercent.toFixed(2)}%)\nMarket Cap: $${(stockData.marketCap / 1e9).toFixed(2)}B`;

  return { reply };
}

/**
 * Web search tool
 */
async function handleSearch(message, step, stateGraph, conversationHistory) {
  const tool = TOOLS.search;
  const searchResults = await tool.execute(message);

  if (!searchResults.results || searchResults.results.length === 0) {
    stateGraph.push({ step, tool: "search", input: message, output: "(no results)" });
    return await llmFallback(message, stateGraph, conversationHistory, step);
  }

  stateGraph.push({ step, tool: "search", input: message, output: searchResults.results, cached: searchResults.cached || false });

  const context = searchResults.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.link}`).join("\n\n");
  const prompt = `Use ONLY these verified sources to answer: "${message}"\n\n${context}`;
  const response = await callLLM(prompt);

  const contradictions = detectContradictions(stateGraph, response);
  stateGraph.push({ step: step + 0.5, tool: "llm", input: prompt, output: response, contradictions });

  return { reply: response };
}

/**
 * File operation tool
 */

async function handleFileOperation(params, step, stateGraph) {
  let targetPath = params.path;

  if (!targetPath) {
    const reply = "No folder path specified.";
    stateGraph.push({ step, tool: "file", input: params, output: reply });
    return { reply };
  }

  if (!path.isAbsolute(targetPath)) {
    targetPath = path.resolve(targetPath);
  }

  let reply;

  try {
    const stats = await fs.stat(targetPath);

    if (!stats.isDirectory()) {
      reply = `Path exists but is not a folder: ${targetPath}`;
      stateGraph.push({ step, tool: "file", input: params, output: reply });
      return { reply };
    }

  } catch (err) {
    if (err.code === "ENOENT") {
      reply = `Folder does not exist: ${targetPath}`;
    } else {
      reply = `Error accessing folder: ${err.message}`;
    }

    stateGraph.push({ step, tool: "file", input: params, output: reply });
    return { reply };
  }

  if (params.operation === "scan") {
    try {
      const files = await fs.readdir(targetPath);

      if (files.length === 0) {
        reply = `Folder exists but is empty: ${targetPath}`;
      } else {
        reply =
          `Files inside ${targetPath}:\n\n` +
          files.map(f => `- ${f}`).join("\n");
      }

      stateGraph.push({
        step,
        tool: "file",
        input: params,
        output: files
      });

      return { reply };

    } catch (err) {
      reply = `Error reading folder: ${err.message}`;
      stateGraph.push({ step, tool: "file", input: params, output: reply });
      return { reply };
    }
  }

  reply = "Unsupported file operation.";
  stateGraph.push({ step, tool: "file", input: params, output: reply });
  return { reply };
}


/**
 * Recursively scan a directory
 */
async function scanDirectoryRecursive(dir) {
  const result = [];

  async function recurse(currentPath) {
    try {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await recurse(fullPath);
        } else {
          result.push(fullPath);
        }
      }
    } catch (err) {
      console.warn(`Cannot access ${currentPath}: ${err.message}`);
    }
  }

  await recurse(dir);
  return result;
}

/**
 * Hash-based duplicate detection
 */
async function findDuplicateFiles(filePaths) {
  const hashMap = {};

  for (const filePath of filePaths) {
    try {
      const buffer = await fs.promises.readFile(filePath);
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");
      hashMap[hash] ??= [];
      hashMap[hash].push(filePath);
    } catch (err) {
      console.warn(`Could not read file ${filePath}: ${err.message}`);
    }
  }

  return Object.fromEntries(Object.entries(hashMap).filter(([_, paths]) => paths.length > 1));
}

/**
 * LLM fallback
 */
async function llmFallback(message, stateGraph, conversationHistory, step) {
  const context = conversationHistory.slice(-5).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `${context}\n\nuser: ${message}\n\nRespond naturally and helpfully:`;
  const response = await callLLM(prompt);
  const contradictions = detectContradictions(stateGraph, response);

  stateGraph.push({ step, tool: "llm-fallback", input: prompt, output: response, contradictions });
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
      body: JSON.stringify({ model: "mat-llm:latest", prompt, stream: false, options: { temperature: 0.7, num_predict: 500 } })
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

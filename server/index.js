/**
 * FULL LOCAL AGENT SERVER (Ollama 0.15.6 compatible)
 * -------------------------------------------------
 * Features:
 * - Persistent memory
 * - Smarter search reuse & fallback
 * - Calculator tool
 * - Internet search (SerpAPI)
 * - Summarize mode
 * - Planner + executor (baby AutoGPT)
 * - Self-reflection & contradiction detection
 * - Citation enforcement
 * - Tool budget limits
 * - Thought / state graph
 * - Confidence scoring with sources
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ======================================================
// FILE PATHS
// ======================================================

const MEMORY_FILE = path.resolve("./memory.json");
const SEARCH_CACHE_FILE = path.resolve("./search_cache.json");

// ======================================================
// MEMORY HELPERS
// ======================================================

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ======================================================
// TOOLS
// ======================================================

// Calculator tool
function calculator(expr) {
  try {
    return { result: Function(`"use strict";return(${expr})`)() };
  } catch {
    return { error: "Invalid math expression" };
  }
}

// Search tool (with caching)
const SERPAPI_KEY = "YOUR_SERPAPI_KEY";

function extractTopic(text) {
  return text
    .toLowerCase()
    .replace(/summarize|explain|please|check again|verify|according to.*|treat me like.*$/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchWeb(query, forceRefresh = false) {
  const cache = loadJSON(SEARCH_CACHE_FILE, {});
  const topic = extractTopic(query);

  if (!forceRefresh && cache[topic]) {
    return { cached: true, results: cache[topic].results };
  }

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    topic
  )}&api_key=${SERPAPI_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const results =
    data.organic_results?.slice(0, 5).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link
    })) || [];

  cache[topic] = { timestamp: Date.now(), results };
  saveJSON(SEARCH_CACHE_FILE, cache);

  return { cached: false, results };
}

// ======================================================
// PLANNER
// ======================================================

function plan(message) {
  if (/^[0-9+\-*/().\s]+$/.test(message)) return "calculator";
  if (/summarize|explain/i.test(message)) return "summarize";
  if (/\b(who|what|when|where|why|how|top|list)\b/i.test(message)) return "search";
  return "llm";
}

// ======================================================
// STATE GRAPH + AUDIT HELPERS
// ======================================================

const MAX_TOOL_CALLS = { search: 3, llm: 2, calculator: 1 };

function calculateConfidence(stateGraph) {
  let score = 0.4;

  const usedSearch = stateGraph.some(s => s.tool === "search" || s.tool === "llm-fallback");
  const reused = stateGraph.some(s => s.cached);
  const contradictions = stateGraph.flatMap(s => s.contradictions || []);
  const citationMisses = stateGraph.flatMap(s => s.citationMiss || []);

  if (usedSearch) score += 0.2;
  if (stateGraph.filter(s => s.tool === "search").length > 1) score += 0.1;
  if (reused) score += 0.1;
  if (contradictions.length > 0) score -= 0.2;
  if (citationMisses.length > 0) score -= 0.2;

  const lastReply = stateGraph[stateGraph.length - 1]?.output;
  if (lastReply && lastReply.length > 0) score += 0.1;

  return Math.min(Math.max(score, 0.1), 0.95);
}

// Safe contradiction detection
function detectContradictions(stateGraph, newOutput) {
  const previousOutputs = stateGraph.map(s => s.output).filter(Boolean);
  const newStr = typeof newOutput === "string" ? newOutput : JSON.stringify(newOutput);

  const contradictions = previousOutputs.filter(out => {
    const outStr = typeof out === "string" ? out : JSON.stringify(out);
    return outStr !== newStr && outStr.toLowerCase() !== newStr.toLowerCase();
  });

  return contradictions.length > 0 ? ["Potential contradiction detected"] : [];
}

// ======================================================
// EXECUTOR
// ======================================================

async function executeStep(message, step, stateGraph, memory, toolUsage, convo) {
  const decision = plan(message);
  console.log(`🤖 STEP ${step} PLAN:`, decision);

  if (!toolUsage[decision]) toolUsage[decision] = 0;

  if (toolUsage[decision] >= (MAX_TOOL_CALLS[decision] || 1)) {
    console.log(`⚠️ Tool budget exceeded for ${decision}`);

    if (decision === "search") {
      const cache = loadJSON(SEARCH_CACHE_FILE, {});
      const topic = extractTopic(message);
      const cachedResults = cache[topic]?.results || [];
      if (cachedResults.length > 0) {
        const reply = cachedResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})`).join("\n");
        stateGraph.push({
          step,
          tool: "search",
          input: message,
          output: cachedResults,
          cached: true,
          contradictions: [],
          citationMiss: []
        });
        return { reply };
      }
    }

    // LLM fallback
    const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mat-llm", prompt, stream: false })
    });
    const data = await ollamaRes.json();
    const reply = data.response ?? "(no response)";
    const contradictions = detectContradictions(stateGraph, reply);
    stateGraph.push({ step, tool: "llm-fallback", input: message, output: reply, contradictions });
    return { reply };
  }

  toolUsage[decision]++;

  let reply = "";
  let observations = [];
  let contradictions = [];
  let citationMiss = [];

  // Calculator
  if (decision === "calculator") {
    const result = calculator(message);
    reply = result.error ?? `Result: ${result.result}`;
    stateGraph.push({ step, tool: "calculator", input: message, output: reply });
    return { reply };
  }

  // Search
  if (decision === "search") {
    const force = /check again|verify|according to/i.test(message);
    const search = await searchWeb(message, force);
    observations = search.results;

    if (observations.length === 0) citationMiss.push("No sources found");

    contradictions = detectContradictions(stateGraph, observations);

    stateGraph.push({
      step,
      tool: "search",
      input: message,
      output: observations,
      cached: search.cached,
      contradictions,
      citationMiss
    });

    if (observations.length > 0) {
      const context = observations.map(r => `${r.title}: ${r.snippet}`).join("\n");
      const ollamaRes = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mat-llm",
          prompt: `Use ONLY the following sources to answer factually:\n${context}\nQuestion: ${message}`,
          stream: false
        })
      });
      const data = await ollamaRes.json();
      reply = data.response ?? "(no response)";
      contradictions = detectContradictions(stateGraph, reply);
      stateGraph.push({ step: step + 0.5, tool: "llm", input: message, output: reply, contradictions });
    } else {
      reply = "(no search results)";
    }

    return { reply };
  }

  // Summarize
  if (decision === "summarize") {
    const search = await searchWeb(message);
    const context = search.results.map(r => `${r.title}: ${r.snippet}`).join("\n");
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mat-llm",
        prompt: `Summarize the following information for the user:\n${context}`,
        stream: false
      })
    });
    const data = await ollamaRes.json();
    reply = data.response ?? "(no response)";
    contradictions = detectContradictions(stateGraph, reply);
    stateGraph.push({ step, tool: "summarize", input: message, output: reply, contradictions });
    return { reply };
  }

  // Fallback LLM
  const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");
  const ollamaRes = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mat-llm", prompt, stream: false })
  });
  const data = await ollamaRes.json();
  reply = data.response ?? "(no response)";
  contradictions = detectContradictions(stateGraph, reply);
  stateGraph.push({ step, tool: "llm", input: message, output: reply, contradictions });
  return { reply };
}

// ======================================================
// CHAT ENDPOINT
// ======================================================

app.post("/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    console.log("\n==============================");
    console.log("👤 USER:", message);

    const memory = loadJSON(MEMORY_FILE, { conversations: {} });
    const id = conversationId || crypto.randomUUID();
    memory.conversations[id] ??= [];
    const convo = memory.conversations[id];

    convo.push({ role: "user", content: message });

    const stateGraph = [];
    const toolUsage = {};
    let reply = "";

    // Dynamic max steps based on tool type
    const toolType = plan(message);
    const maxSteps = MAX_TOOL_CALLS[toolType] || 3;

    for (let step = 1; step <= maxSteps; step++) {
      const result = await executeStep(message, step, stateGraph, memory, toolUsage, convo);
      reply = result.reply ?? reply;

      const confidence = calculateConfidence(stateGraph);

      if (confidence >= 0.7 || (reply && reply !== "(no search results)" && reply !== "(tool budget exceeded)")) break;
    }

    const confidence = calculateConfidence(stateGraph);

    convo.push({ role: "assistant", content: reply });
    saveJSON(MEMORY_FILE, memory);

    console.log("🧾 STATE GRAPH:", JSON.stringify(stateGraph, null, 2));
    console.log("🤖 REPLY:", reply);
    console.log("==============================\n");

    res.json({ reply, conversationId: id, stateGraph, confidence });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

// ======================================================

app.listen(PORT, () => {
  console.log(`🤖 Agent running at http://localhost:${PORT}`);
});

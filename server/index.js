/**
 * FULL LOCAL AGENT SERVER (Ollama 0.15.6 compatible)
 * -------------------------------------------------
 * Now includes:
 * - Tool-choosing JSON
 * - Planner vs Executor
 * - Self-reflection loop
 * - Source-weighted confidence
 * - Automatic re-check on low confidence
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
// UTIL
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

function calculator(expr) {
  try {
    return { result: Function(`"use strict";return(${expr})`)() };
  } catch {
    return { error: "Invalid math expression" };
  }
}

// -------- SEARCH --------

const SERPAPI_KEY =
  "7e508cfd2dd8eb17a672aaf920f25515be156a56ea2a043c8cae9f358c273418";

function extractTopic(text) {
  return text
    .toLowerCase()
    .replace(/summarize|explain|please|check again/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchWeb(query) {
  const cache = loadJSON(SEARCH_CACHE_FILE, {});
  const topic = extractTopic(query);

  if (cache[topic]) {
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
// PLANNER (returns JSON decision)
// ======================================================

function planner(state) {
  const { message, observations, confidence } = state;

  const factual = /\b(top|who|what|current|latest|ranking)\b/i.test(message);

  if (/^[0-9+\-*/().\s]+$/.test(message))
    return { action: "calculator", reason: "math" };

  if (factual && observations.length === 0)
    return { action: "search", reason: "needs sources" };

  if (factual && confidence < 0.6)
    return { action: "search", reason: "low confidence recheck" };

  if (/summarize|explain/i.test(message) && observations.length > 0)
    return { action: "summarize", reason: "user requested summary" };

  return { action: "llm", reason: "general response" };
}

// ======================================================
// CONFIDENCE
// ======================================================

function calculateConfidence(audit, observations) {
  let score = 0.3;

  if (audit.some(a => a.tool === "search")) score += 0.25;
  if (audit.some(a => a.cached)) score += 0.15;
  if (observations.length >= 3) score += 0.15;
  if (audit.every(a => a.tool === "llm")) score -= 0.25;

  return Math.max(0.1, Math.min(score, 0.95));
}

// ======================================================
// CHAT ENDPOINT
// ======================================================

app.post("/chat", async (req, res) => {
  const { message, conversationId } = req.body;

  console.log("\n==============================");
  console.log("👤 USER:", message);

  const memory = loadJSON(MEMORY_FILE, { conversations: {} });
  const id = conversationId || crypto.randomUUID();
  memory.conversations[id] ??= [];

  const convo = memory.conversations[id];
  convo.push({ role: "user", content: message });

  let observations = [];
  let audit = [];
  let reply = "";
  let confidence = 0;

  for (let step = 1; step <= 6; step++) {
    confidence = calculateConfidence(audit, observations);

    const decision = planner({
      message,
      observations,
      confidence
    });

    console.log(`🤖 STEP ${step} PLAN:`, decision.action, "-", decision.reason);

    if (decision.action === "search") {
      const s = await searchWeb(message);
      audit.push({
        step,
        tool: "search",
        cached: s.cached,
        sources: s.results.length
      });
      observations = s.results;
      continue;
    }

    if (decision.action === "calculator") {
      const r = calculator(message);
      audit.push({ step, tool: "calculator" });
      reply = r.error ?? `Result: ${r.result}`;
      break;
    }

    if (decision.action === "summarize") {
      const context = observations
        .map(o => `${o.title}: ${o.snippet}`)
        .join("\n");

      const ollamaRes = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mat-llm",
          prompt: `Summarize based only on these sources:\n${context}`,
          stream: false
        })
      });

      const data = await ollamaRes.json();
      audit.push({ step, tool: "llm" });
      reply = data.response;
      break;
    }

    // LLM fallback
    const prompt =
      `Answer using sources if available.\n\n` +
      observations.map(o => `- ${o.title}`).join("\n");

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mat-llm", prompt, stream: false })
    });

    const data = await ollamaRes.json();
    audit.push({ step, tool: "llm" });
    reply = data.response;
    break;
  }

  confidence = calculateConfidence(audit, observations);
  reply += `\n\n🔍 Confidence: ${Math.round(confidence * 100)}%`;

  convo.push({ role: "assistant", content: reply });
  saveJSON(MEMORY_FILE, memory);

  console.log("🧾 AUDIT:", audit);
  console.log("🤖 REPLY:", reply);
  console.log("==============================\n");

  res.json({ reply, conversationId: id, audit, confidence });
});

// ======================================================

app.listen(PORT, () => {
  console.log(`🤖 Agent running at http://localhost:${PORT}`);
});

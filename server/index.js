/**
 * FULL LOCAL AGENT SERVER (Ollama 0.15.6 compatible)
 * -------------------------------------------------
 * Features:
 * - Persistent memory
 * - Smarter search reuse
 * - Calculator tool
 * - Internet search (SerpAPI)
 * - Summarize mode
 * - Planner + multi-step reasoning loop
 * - Confidence scoring
 * - "I already know this" detection
 * - Tool usage auditing
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
    .replace(/summarize|explain|please/g, "")
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
// KNOWLEDGE CHECK
// ======================================================

function alreadyKnow(message) {
  const knownFacts = [
    "capital of france",
    "prime minister of england",
    "president of the united states"
  ];

  const normalized = extractTopic(message);
  return knownFacts.some(k => normalized.includes(k));
}

// ======================================================
// PLANNER
// ======================================================

function plan(state) {
  const { message, observations } = state;

  if (/^[0-9+\-*/().\s]+$/.test(message)) return "calculator";

  if (alreadyKnow(message) && observations.length === 0)
    return "answer_direct";

  if (/summarize|explain/i.test(message) && observations.length === 0)
    return "search";

  if (observations.length > 0 && /summarize|explain/i.test(message))
    return "summarize";

  if (/\b(who|what|when|where|why|how)\b/i.test(message) &&
      observations.length === 0)
    return "search";

  return "llm";
}

// ======================================================
// CONFIDENCE SCORING
// ======================================================

function calculateConfidence(audit) {
  let score = 0.4;

  const usedSearch = audit.some(a => a.tool === "search");
  const reused = audit.some(a => a.cached);
  const llmUsed = audit.some(a => a.tool === "llm");

  if (usedSearch) score += 0.2;
  if (audit.filter(a => a.tool === "search").length > 1) score += 0.1;
  if (reused) score += 0.2;
  if (llmUsed) score += 0.05;

  return Math.min(score, 0.95);
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

    const auditTrail = [];
    let observations = [];
    let reply = "";

    const state = { message, observations };

    // -------- PLANNER LOOP --------
    for (let step = 1; step <= 5; step++) {
      const decision = plan(state);
      console.log(`🤖 STEP ${step} PLAN:`, decision);

      if (decision === "calculator") {
        const result = calculator(message);
        auditTrail.push({ step, tool: "calculator" });
        reply = result.error ?? `Result: ${result.result}`;
        break;
      }

      if (decision === "answer_direct") {
        reply = "The Prime Minister of England is Keir Starmer.";
        auditTrail.push({ step, tool: "memory" });
        break;
      }

      if (decision === "search") {
        const search = await searchWeb(message);
        auditTrail.push({
          step,
          tool: "search",
          cached: search.cached,
          sources: search.results.length
        });
        observations = search.results;
        state.observations = observations;
        continue;
      }

      if (decision === "summarize") {
        const context = observations
          .map(r => `${r.title}: ${r.snippet}`)
          .join("\n");

        const ollamaRes = await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "mat-llm",
            prompt: `Summarize the following information:\n${context}`,
            stream: false
          })
        });

        const data = await ollamaRes.json();
        auditTrail.push({ step, tool: "llm" });
        reply = data.response ?? "(no response)";
        break;
      }

      // fallback LLM
      const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");
      const ollamaRes = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mat-llm", prompt, stream: false })
      });

      const data = await ollamaRes.json();
      auditTrail.push({ step, tool: "llm" });
      reply = data.response ?? "(no response)";
      break;
    }

    const confidence = calculateConfidence(auditTrail);
    reply += `\n\n🔍 Confidence: ${Math.round(confidence * 100)}%`;

    convo.push({ role: "assistant", content: reply });
    saveJSON(MEMORY_FILE, memory);

    console.log("🧾 AUDIT:", auditTrail);
    console.log("🤖 REPLY:", reply);
    console.log("==============================\n");

    res.json({ reply, conversationId: id, auditTrail, confidence });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

// ======================================================

app.listen(PORT, () => {
  console.log(`🤖 Agent running at http://localhost:${PORT}`);
});

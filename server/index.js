/**
 * Local Agent Server (Ollama 0.15.6 compatible)
 * ------------------------------------------------
 * Features:
 * - Persistent conversations
 * - Smarter search reuse (topic-based caching)
 * - Calculator tool
 * - Internet search (SerpAPI)
 * - Summarize mode
 * - Tiny planner loop (server-side agent brain)
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
// MEMORY
// ======================================================

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return { conversations: {} };
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch {
    return { conversations: {} };
  }
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ======================================================
// SEARCH CACHE
// ======================================================

function loadSearchCache() {
  if (!fs.existsSync(SEARCH_CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEARCH_CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveSearchCache(cache) {
  fs.writeFileSync(SEARCH_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ======================================================
// TOOLS
// ======================================================

function calculator(expression) {
  try {
    const result = Function(`"use strict"; return (${expression})`)();
    return { result };
  } catch {
    return { error: "Invalid math expression" };
  }
}

// ---------------- SEARCH ----------------

const SERPAPI_KEY = "7e508cfd2dd8eb17a672aaf920f25515be156a56ea2a043c8cae9f358c273418"; // <-- here

function extractSearchTopic(text) {
  return text
    .toLowerCase()
    .replace(/summarize|explain|treat me like.*|please|can you/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchWeb(query, maxResults = 5) {
  const cache = loadSearchCache();
  const topic = extractSearchTopic(query);

  if (cache[topic]) {
    console.log("📁 SEARCH CACHE HIT:", topic);
    return { cached: true, results: cache[topic].results };
  }

  console.log("🌐 SEARCH CACHE MISS – calling SerpAPI");

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    topic
  )}&api_key=${SERPAPI_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  const results =
    data.organic_results?.slice(0, maxResults).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link
    })) || [];

  cache[topic] = { timestamp: Date.now(), results };
  saveSearchCache(cache);

  return { cached: false, results };
}

// ======================================================
// PLANNER LOOP
// ======================================================

function plan(message) {
  if (/^[0-9+\-*/().\s]+$/.test(message)) {
    return { action: "calculator" };
  }

  if (/summarize|explain/i.test(message)) {
    return { action: "summarize" };
  }

  if (/\b(who|what|when|where|why|how)\b/i.test(message)) {
    return { action: "search" };
  }

  return { action: "llm" };
}

// ======================================================
// CHAT ENDPOINT
// ======================================================

app.post("/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    console.log("\n==============================");
    console.log("👤 USER MESSAGE:", message);

    const memory = loadMemory();
    const id = conversationId || crypto.randomUUID();
    if (!memory.conversations[id]) memory.conversations[id] = [];
    const convo = memory.conversations[id];

    convo.push({ role: "user", content: message });

    const decision = plan(message);
    console.log("🤖 DECISION:", decision.action);

    let reply = "";

    // -------- CALCULATOR --------
    if (decision.action === "calculator") {
      const result = calculator(message);
      reply = result.error ? result.error : `Result: ${result.result}`;
    }

    // -------- SEARCH --------
    else if (decision.action === "search") {
      const search = await searchWeb(message, 3);
      reply =
        "🔎 Search result:\n\n" +
        search.results.map(r =>
          `• ${r.title}\n  ${r.snippet}\n  ${r.link}`
        ).join("\n\n");
    }

    // -------- SUMMARIZE --------
    else if (decision.action === "summarize") {
      const search = await searchWeb(message, 5);

      const context = search.results
        .map(r => `${r.title}: ${r.snippet}`)
        .join("\n");

      const prompt = `
Explain this simply, like to a 5 year old:

${context}
`;

      const ollamaRes = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mat-llm",
          prompt,
          stream: false
        })
      });

      const data = await ollamaRes.json();
      reply = data.response ?? "(no response)";
    }

    // -------- LLM --------
    else {
      const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");

      const ollamaRes = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mat-llm",
          prompt,
          stream: false
        })
      });

      const data = await ollamaRes.json();
      reply = data.response ?? "(no response)";
    }

    convo.push({ role: "assistant", content: reply });
    saveMemory(memory);

    console.log("🤖 ASSISTANT REPLY:", reply);
    console.log("==============================\n");

    res.json({ reply, conversationId: id });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

// ======================================================

app.listen(PORT, () => {
  console.log(`🤖 Agent running at http://localhost:${PORT}`);
});

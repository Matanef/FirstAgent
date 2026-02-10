/**
 * Local Agent Server (Ollama 0.15.6 compatible)
 *
 * Features:
 * - Persistent conversations
 * - Calculator tool
 * - Internet search tool (SerpAPI)
 * - Search result caching to disk
 * - Automatic tool selection (server-side agent logic)
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

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return { conversations: {} };
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
    return data.conversations ? data : { conversations: {} };
  } catch {
    return { conversations: {} };
  }
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ======================================================
// SEARCH CACHE HELPERS
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

// -------- Calculator --------
function calculator(expression) {
  try {
    const result = Function(`"use strict"; return (${expression})`)();
    return { result };
  } catch {
    return { error: "Invalid mathematical expression" };
  }
}

// -------- Internet Search (SerpAPI) --------
const SERPAPI_KEY = "7e508cfd2dd8eb17a672aaf920f25515be156a56ea2a043c8cae9f358c273418"; // <-- insert here

async function searchWeb(query) {
  const cache = loadSearchCache();
  const normalized = query.toLowerCase().trim();

  // 1️⃣ Return cached result if exists
  if (cache[normalized]) {
    return { cached: true, results: cache[normalized].results };
  }

  if (!SERPAPI_KEY) {
    return { error: "SerpAPI key not configured" };
  }

  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
      query
    )}&api_key=${SERPAPI_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    const results =
      data.organic_results?.slice(0, 3).map((r) => ({
        title: r.title,
        snippet: r.snippet,
        link: r.link,
      })) || [];

    // 2️⃣ Save to cache
    cache[normalized] = {
      timestamp: Date.now(),
      results,
    };
    saveSearchCache(cache);

    return { cached: false, results };
  } catch {
    return { error: "Search request failed" };
  }
}

// ======================================================
// TOOL SELECTION HEURISTICS
// ======================================================

function looksLikeMath(text) {
  return /^[0-9+\-*/().\s]+$/.test(text.trim());
}

function looksLikeSearch(text) {
  return /\b(who|what|when|where|why|how)\b/i.test(text);
}

// ======================================================
// CHAT ENDPOINT
// ======================================================

app.post("/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    const memory = loadMemory();
    const id = conversationId || crypto.randomUUID();
    if (!memory.conversations[id]) memory.conversations[id] = [];
    const convo = memory.conversations[id];

    convo.push({ role: "user", content: message });

    let reply = "";

    // -------- TOOL: Calculator --------
    if (looksLikeMath(message)) {
      const calc = calculator(message);
      reply = calc.error
        ? `Calculator error: ${calc.error}`
        : `Result: ${calc.result}`;
    }

    // -------- TOOL: Internet Search --------
    else if (looksLikeSearch(message)) {
      const search = await searchWeb(message);

      if (search.error) {
        reply = `Search error: ${search.error}`;
      } else if (search.results.length === 0) {
        reply = "(no search results found)";
      } else {
        reply =
          (search.cached ? "📁 Cached result:\n\n" : "🔎 Search result:\n\n") +
          search.results
            .map(
              (r) => `• ${r.title}\n  ${r.snippet}\n  ${r.link}`
            )
            .join("\n\n");
      }
    }

    // -------- FALLBACK: LLM --------
    else {
      const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");

      const ollamaRes = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mat-llm",
          prompt,
          stream: false,
        }),
      });

      const data = await ollamaRes.json();
      reply = data.response ?? "(no response)";
    }

    convo.push({ role: "assistant", content: reply });
    saveMemory(memory);

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

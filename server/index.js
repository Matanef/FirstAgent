/**
 * Local Agent Server with Persistent Memory + Tool Calling + SerpAPI
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

// --------------------
// Memory storage
// --------------------
const MEMORY_FILE = path.resolve("./memory.json");

/**
 * Load memory safely
 */
function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return { conversations: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
    if (!raw.conversations || typeof raw.conversations !== "object") {
      return { conversations: {} };
    }
    return raw;
  } catch {
    return { conversations: {} };
  }
}

/**
 * Save memory to disk
 */
function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// --------------------
// Tools
// --------------------

// Calculator tool
function calculator({ expression }) {
  try {
    // ⚠️ Only safe for learning! Never eval raw input in production
    const result = Function(`"use strict"; return (${expression})`)();
    return { result };
  } catch (err) {
    return { error: "Invalid expression" };
  }
}

// SerpAPI search tool
async function searchWeb({ query }) {
  // ===========================
  // 🔑 INSERT YOUR API KEY HERE
  // ===========================
  const API_KEY = "7e508cfd2dd8eb17a672aaf920f25515be156a56ea2a043c8cae9f358c273418";

  if (!API_KEY) return { error: "SerpAPI key not set" };

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    query
  )}&api_key=${API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.organic_results && data.organic_results.length > 0) {
      // Return top 3 results
      return {
        results: data.organic_results
          .slice(0, 3)
          .map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
      };
    } else {
      return { results: [] };
    }
  } catch (err) {
    return { error: "SerpAPI request failed" };
  }
}

// Define tool functions mapping
const toolDefinitions = {
  calculator,
  searchWeb,
};

// --------------------
// Chat endpoint
// --------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    const memory = loadMemory();
    const id = conversationId || crypto.randomUUID();

    if (!memory.conversations[id]) memory.conversations[id] = [];
    const convo = memory.conversations[id];

    // Add user message
    convo.push({ role: "user", content: message });

    // Build messages array for LLM
    const messages = convo.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // --------------------
    // Here you would call your LLM (e.g., Ollama)
    // We'll simulate a tool-calling logic for demo
    // --------------------
    let assistantReply = "";

    // Example: detect simple commands
    if (message.startsWith("calc:")) {
      const expr = message.replace(/^calc:/, "").trim();
      const result = calculator({ expression: expr });
      assistantReply = result.error ? result.error : `Result: ${result.result}`;
    } else if (message.startsWith("search:")) {
      const query = message.replace(/^search:/, "").trim();
      const result = await searchWeb({ query });
      if (result.error) assistantReply = `Error: ${result.error}`;
      else if (result.results.length === 0) assistantReply = "(no results)";
      else {
        assistantReply = result.results
          .map((r) => `• ${r.title} - ${r.link}`)
          .join("\n");
      }
    } else {
      // Default LLM reply placeholder
      assistantReply = "(assistant would reply here)";
    }

    // Save assistant reply to memory
    convo.push({ role: "assistant", content: assistantReply });
    saveMemory(memory);

    res.json({ reply: assistantReply, conversationId: id });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

// --------------------
app.listen(PORT, () => {
  console.log(`🤖 Agent server running at http://localhost:${PORT}`);
});

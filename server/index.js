/**
 * Local Agent Server
 * - Express
 * - Persistent memory per conversation
 * - Calculator tool
 * - Ollama native endpoint integration
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = 3000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

// --------------------
// Persistent memory setup
// --------------------
const MEMORY_FILE = path.resolve("./memory.json");

/**
 * Load memory safely from disk.
 * If file does not exist or is corrupted, start fresh.
 */
function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    return { conversations: {} };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));

    // Upgrade old formats
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
// Calculator tool
// --------------------
/**
 * Very simple calculator
 * - Accepts { expression: "2+2" }
 * - Returns { result: 4 } or { error: "Invalid expression" }
 * ⚠️ Never eval untrusted input in production without sandboxing
 */
function calculator({ expression }) {
  try {
    const result = Function(`"use strict"; return (${expression})`)();
    return { result };
  } catch (err) {
    return { error: "Invalid expression" };
  }
}

// --------------------
// Chat endpoint
// --------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    // Load memory
    const memory = loadMemory();

    // Use existing conversation ID or generate a new one
    const id = conversationId || crypto.randomUUID();

    if (!memory.conversations[id]) {
      memory.conversations[id] = [];
    }

    const convo = memory.conversations[id];

    // Add user message
    convo.push({ role: "user", content: message });

    // --------------------
    // Tool-calling: simple example
    // If user starts with "calc: " we run the calculator instead of the LLM
    // --------------------
    if (message.toLowerCase().startsWith("calc:")) {
      const expression = message.slice(5).trim();
      const calcResult = calculator({ expression });

      const reply = calcResult.error
        ? `Calculator error: ${calcResult.error}`
        : `Result: ${calcResult.result}`;

      // Store assistant reply in memory
      convo.push({ role: "assistant", content: reply });
      saveMemory(memory);

      return res.json({ reply, conversationId: id });
    }

    // --------------------
    // Build messages array for Ollama
    // --------------------
    const messages = convo.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Build prompt from conversation memory
    const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");
    // --------------------
    // Call Ollama native endpoint
    // --------------------
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mat-llm",
        prompt,
        stream: false
      })
    });

    // Parse response
    const data = await ollamaRes.json();
    const reply = data.response ?? "(no response)";

    // Store assistant reply
    convo.push({ role: "assistant", content: reply });

    // Save updated memory
    saveMemory(memory);

    // Send response
    res.json({ reply, conversationId: id });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

// --------------------
// Start server
// --------------------
app.listen(PORT, () => {
  console.log(`🤖 Agent server running at http://localhost:${PORT}`);
});

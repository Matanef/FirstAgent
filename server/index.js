/**
 * Local Agent Server
 * - Express
 * - Persistent memory
 * - Multiple conversations
 * - Defensive memory loading
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
 * Load memory safely.
 * If old format is detected, it upgrades it.
 */
function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    return { conversations: {} };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch {
    return { conversations: {} };
  }

  // 🔑 UPGRADE old formats automatically
  if (Array.isArray(raw)) {
    return { conversations: {} };
  }

  if (!raw.conversations || typeof raw.conversations !== "object") {
    return { conversations: {} };
  }

  return raw;
}

/**
 * Save memory to disk
 */
function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
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

    const memory = loadMemory();

    // Create or reuse conversation
    const id = conversationId || crypto.randomUUID();

    if (!memory.conversations[id]) {
      memory.conversations[id] = [];
    }

    const convo = memory.conversations[id];

    // Add user message
    convo.push({ role: "user", content: message });

    // Build prompt
    const prompt = convo
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // Call Ollama
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
    const reply = data.response ?? "(no response)";

    // Add assistant reply
    convo.push({ role: "assistant", content: reply });

    saveMemory(memory);

    res.json({
      reply,
      conversationId: id
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

// --------------------
app.listen(PORT, () => {
  console.log(`🤖 Agent server running at http://localhost:${PORT}`);
});

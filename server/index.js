// server/index.js

import express from "express";
import cors from "cors";
import crypto from "crypto";

import { plan } from "./planner.js";
import {
  loadJSON,
  saveJSON,
  MEMORY_FILE,
  DEFAULT_MEMORY
} from "./memory.js";
import { executeAgent } from "./executor.js";
import { calculateConfidence } from "./audit.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});


// ============================================================
// DEBUG ROUTES — must be placed BEFORE conversation routes
// ============================================================

// View memory
app.get("/debug/memory", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  res.json({
    memory,
    location: MEMORY_FILE,
    lastUpdated: new Date().toISOString()
  });
});

// Reset memory
app.post("/debug/memory/reset", (req, res) => {
  saveJSON(MEMORY_FILE, DEFAULT_MEMORY);

  res.json({
    success: true,
    message: "Memory has been reset.",
    memory: DEFAULT_MEMORY
  });
});

console.log("DEBUG ROUTES REGISTERED: /debug/memory, /debug/memory/reset");


// ============================================================
// CHAT ENDPOINT
// ============================================================
app.post("/chat", async (req, res) => {
  const startTime = Date.now();

  try {
    let { message, conversationId } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid message" });
    }

    if (message.length > 1000) {
      return res.status(400).json({
        error: "Message too long (max 1000 characters)"
      });
    }

    console.log("\n" + "=".repeat(60));
    console.log("👤 USER:", message);

    // Load memory
    const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

    // Ensure conversation exists
    const id = conversationId || crypto.randomUUID();
    memory.conversations[id] ??= [];

    // Save user message
    memory.conversations[id].push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    });

    // INLINE PROFILE MEMORY UPDATE
    const lower = message.toLowerCase();
    if (lower.startsWith("remember my name is ")) {
      memory.profile.name = message.substring("remember my name is ".length).trim();
    }
    if (lower.startsWith("remember that my name is ")) {
      memory.profile.name = message.substring("remember that my name is ".length).trim();
    }

    // PLAN → EXECUTE
    const planResult = await plan({ message });
    const { tool, input } = planResult;

    const result = await executeAgent({
      tool,
      message: input ?? message,
      conversationId: id
    });

    const reply = result.reply;
    const stateGraph = result.stateGraph;

    if (!reply) {
      throw new Error("Executor returned no reply");
    }

    // Confidence score
    const confidence = calculateConfidence(stateGraph);

    // Save assistant reply
    memory.conversations[id].push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
      confidence
    });

    // SAVE MEMORY
    console.log("💾 BEFORE SAVE:", JSON.stringify(memory, null, 2));
    saveJSON(MEMORY_FILE, memory);
    console.log("💾 AFTER SAVE");

    const elapsed = Date.now() - startTime;

    console.log("\n📊 SUMMARY");
    console.log("Steps:", stateGraph.length);
    console.log("Tool Used:", result.tool || "none");
    console.log("Confidence:", (confidence * 100).toFixed(1) + "%");
    console.log("Time:", elapsed + "ms");
    console.log("=".repeat(60) + "\n");

    res.json({
      reply,
      stateGraph,
      tool: result.tool,
      data: result.data,
      success: result.success,
      confidence,
      conversationId: id,
      metadata: {
        steps: stateGraph.length,
        executionTime: elapsed
      }
    });

  } catch (err) {
    console.error("❌ CHAT ERROR:", err);

    res.status(500).json({
      error: "Internal server error",
      message: err.message
    });
  }
});


// ============================================================
// CONVERSATION APIs
// ============================================================
app.get("/conversation/:id", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
  const conversation = memory.conversations[req.params.id];

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({
    conversationId: req.params.id,
    messages: conversation
  });
});

app.get("/conversations", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  const conversations = Object.entries(memory.conversations).map(
    ([id, messages]) => ({
      id,
      messageCount: messages.length,
      lastMessage: messages[messages.length - 1]?.timestamp,
      preview: messages[0]?.content.slice(0, 50)
    })
  );

  res.json({ conversations });
});

app.delete("/conversation/:id", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  if (!memory.conversations[req.params.id]) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  delete memory.conversations[req.params.id];
  saveJSON(MEMORY_FILE, memory);

  res.json({ success: true });
});


// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(60));
  console.log("🤖 AI AGENT SERVER STARTED");
  console.log(`📡 http://localhost:${PORT}`);
  console.log("=".repeat(60) + "\n");
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  process.exit(0);
});
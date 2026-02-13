// server/index.js
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { loadJSON, saveJSON } from "./memory.js";
import { executeStep } from "./executor.js";
import { calculateConfidence } from "./audit.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MEMORY_FILE = "./memory.json";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ----------------------------
// Health
// ----------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ----------------------------
// Chat endpoint
// ----------------------------
app.post("/chat", async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, conversationId } = req.body;

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

    const memory = loadJSON(MEMORY_FILE, { conversations: {} });
    const id = conversationId || crypto.randomUUID();

    memory.conversations[id] ??= [];
    const convo = memory.conversations[id];

    convo.push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    });

    const stateGraph = [];
    const toolUsage = {};
    let reply = null;

    const MAX_STEPS = 3;

    for (let step = 1; step <= MAX_STEPS; step++) {
      console.log(`🔄 Step ${step}/${MAX_STEPS}`);

      const result = await executeStep(
        message,
        step,
        stateGraph,
        toolUsage,
        convo
      );

      // Defensive: ensure stateGraph reflects steps
      if (result?.stateUpdate) {
        stateGraph.push(result.stateUpdate);
      }

      if (result?.toolUsed) {
        toolUsage[result.toolUsed] =
          (toolUsage[result.toolUsed] || 0) + 1;
      }

      // 🔥 CRITICAL: stop immediately if reply is produced
      if (result?.reply) {
        reply = result.reply;
        console.log("✅ Reply generated");
        break;
      }

      // 🔥 If executor explicitly says done, stop
      if (result?.done) {
        reply = result.reply || "Task completed.";
        console.log("✅ Task marked done");
        break;
      }
    }

    if (!reply) {
      reply = "I couldn't complete that request. Try rephrasing it.";
      console.warn("⚠️ No reply after max steps");
    }

    const confidence = calculateConfidence(stateGraph);

    convo.push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
      confidence
    });

    saveJSON(MEMORY_FILE, memory);

    const elapsed = Date.now() - startTime;

    console.log("\n📊 SUMMARY");
    console.log("Steps:", stateGraph.length);
    console.log(
      "Tools:",
      Object.keys(toolUsage).join(", ") || "none"
    );
    console.log(
      "Confidence:",
      (confidence * 100).toFixed(1) + "%"
    );
    console.log("Time:", elapsed + "ms");
    console.log("=".repeat(60) + "\n");

    res.json({
      reply,
      stateGraph,
      confidence,
      conversationId: id,
      metadata: {
        steps: stateGraph.length,
        toolsUsed: Object.keys(toolUsage),
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

// ----------------------------
// Conversation APIs
// ----------------------------
app.get("/conversation/:id", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, { conversations: {} });
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
  const memory = loadJSON(MEMORY_FILE, { conversations: {} });

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
  const memory = loadJSON(MEMORY_FILE, { conversations: {} });

  if (!memory.conversations[req.params.id]) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  delete memory.conversations[req.params.id];
  saveJSON(MEMORY_FILE, memory);

  res.json({ success: true });
});

// ----------------------------
// Start server
// ----------------------------
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

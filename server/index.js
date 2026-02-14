import express from "express";
import cors from "cors";
import crypto from "crypto";
import { plan } from "./planner.js";
import { loadJSON, saveJSON } from "./memory.js";
import { executeAgent } from "./executor.js";
import { calculateConfidence } from "./audit.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MEMORY_FILE = "./memory.json";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ----------------------------------------
// Logging Middleware
// ----------------------------------------
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ----------------------------------------
// Health Check
// ----------------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ----------------------------------------
// Chat Endpoint
// ----------------------------------------
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

    // ----------------------------------------
    // Load Memory
    // ----------------------------------------
    const memory = loadJSON(MEMORY_FILE, { conversations: {} });
    const id = conversationId || crypto.randomUUID();

    memory.conversations[id] ??= [];
    const convo = memory.conversations[id];

    // Save user message
    convo.push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    });

    // ----------------------------------------
    // Preprocess message: detect file paths
    // ----------------------------------------
    function extractPath(text) {
      const match = text.match(/[A-Za-z]:[\\/]{1,2}[^?\s]+/);
      return match ? match[0] : null;
    }

    if (/scan\s+[A-Za-z]:[\\/]/i.test(message)) {
      const path = extractPath(message);
      if (path) {
        message = path;
        console.log("🛠 Detected file scan path:", message);
      }
    }

    // ----------------------------------------
    // Plan → Execute Agent
    // ----------------------------------------
    const planResult = await plan({ message });
    const { tool, input } = planResult;

    const result = await executeAgent({
      tool,
      message: input ?? message
    });

    const reply = result.reply;
    const stateGraph = result.stateGraph;

    if (!reply) {
      throw new Error("Executor returned no reply");
    }

    // ----------------------------------------
    // Confidence Calculation
    // ----------------------------------------
    const confidence = calculateConfidence(stateGraph);

    // Save assistant reply
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
    console.log("Tool Used:", result.tool || "none");
    console.log("Confidence:", (confidence * 100).toFixed(1) + "%");
    console.log("Time:", elapsed + "ms");
    console.log("=".repeat(60) + "\n");

    // ----------------------------------------
    // Response
    // ----------------------------------------
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

// ----------------------------------------
// Conversation APIs
// ----------------------------------------
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

// ----------------------------------------
// Start Server
// ----------------------------------------
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
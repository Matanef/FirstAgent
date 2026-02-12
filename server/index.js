// server/index.js
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { loadJSON, saveJSON } from "./memory.js";
import { executeStep } from "./executor.js";
import { calculateConfidence } from "./audit.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const MEMORY_FILE = "./memory.json";

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Main chat endpoint
app.post("/chat", async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, conversationId } = req.body;

    // Validation
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: "Missing or invalid message" });
    }

    if (message.length > 1000) {
      return res.status(400).json({ error: "Message too long (max 1000 characters)" });
    }

    console.log("\n" + "=".repeat(60));
    console.log("👤 USER:", message);
    console.log("📝 Conversation ID:", conversationId || "NEW");

    // Load or initialize memory
    const memory = loadJSON(MEMORY_FILE, { conversations: {} });
    const id = conversationId || crypto.randomUUID();

    memory.conversations[id] ??= [];
    const convo = memory.conversations[id];

    // Add user message
    convo.push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    });

    // Initialize execution state
    const stateGraph = [];
    const toolUsage = {};
    let reply = null;

    // Execute agent steps (max 3 steps)
    const MAX_STEPS = 3;

    for (let step = 1; step <= MAX_STEPS; step++) {
      console.log(`\n🔄 Executing step ${step}/${MAX_STEPS}...`);

      const result = await executeStep(
        message,
        step,
        stateGraph,
        toolUsage,
        convo
      );

      if (result.reply) {
        reply = result.reply;
        console.log("✅ Got reply, stopping execution");
        break;
      }
    }

    // Fallback if no reply generated
    if (!reply) {
      reply = "I apologize, but I wasn't able to generate a proper response. Could you rephrase your question?";
      console.warn("⚠️ No reply generated after all steps");
    }

    // Calculate confidence
    const confidence = calculateConfidence(stateGraph);

    // Add assistant message
    convo.push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
      confidence
    });

    // Save memory
    saveJSON(MEMORY_FILE, memory);

    const elapsed = Date.now() - startTime;

    // Log execution summary
    console.log("\n📊 EXECUTION SUMMARY:");
    console.log("├─ Steps taken:", stateGraph.length);
    console.log("├─ Tools used:", Object.keys(toolUsage).join(", ") || "none");
    console.log("├─ Confidence:", (confidence * 100).toFixed(1) + "%");
    console.log("├─ Time:", elapsed + "ms");
    console.log("└─ Reply length:", reply.length, "chars");
    console.log("\n🤖 REPLY:");
    console.log(reply);
    console.log("=".repeat(60) + "\n");

    // Send response
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
    console.error("\n❌ CHAT ERROR:", err);
    console.error(err.stack);

    res.status(500).json({
      error: "Internal server error",
      message: err.message,
      conversationId: req.body.conversationId
    });
  }
});

// Get conversation history
app.get("/conversation/:id", (req, res) => {
  try {
    const memory = loadJSON(MEMORY_FILE, { conversations: {} });
    const conversation = memory.conversations[req.params.id];

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({
      conversationId: req.params.id,
      messages: conversation
    });

  } catch (err) {
    console.error("Error fetching conversation:", err);
    res.status(500).json({ error: "Failed to fetch conversation" });
  }
});

// List all conversations
app.get("/conversations", (req, res) => {
  try {
    const memory = loadJSON(MEMORY_FILE, { conversations: {} });

    const conversations = Object.entries(memory.conversations).map(([id, messages]) => ({
      id,
      messageCount: messages.length,
      lastMessage: messages[messages.length - 1]?.timestamp,
      preview: messages[0]?.content.slice(0, 50)
    }));

    res.json({ conversations });

  } catch (err) {
    console.error("Error listing conversations:", err);
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

// Delete a conversation
app.delete("/conversation/:id", (req, res) => {
  try {
    const memory = loadJSON(MEMORY_FILE, { conversations: {} });

    if (!memory.conversations[req.params.id]) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    delete memory.conversations[req.params.id];
    saveJSON(MEMORY_FILE, memory);

    res.json({ success: true, deleted: req.params.id });

  } catch (err) {
    console.error("Error deleting conversation:", err);
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(60));
  console.log("🤖 AI AGENT SERVER STARTED");
  console.log("=".repeat(60));
  console.log(`📡 Listening on: http://localhost:${PORT}`);
  console.log(`💾 Memory file: ${MEMORY_FILE}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log("=".repeat(60) + "\n");
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down gracefully...');
  process.exit(0);
});
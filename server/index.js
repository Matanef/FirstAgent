// server/index.js (CORRECTED for your structure)
// Enhanced server with geolocation, full memory, and improved agent coordination

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
import { resolveCityFromIp } from "./utils/geo.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Enhanced logging middleware with client IP
app.use((req, res, next) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${clientIp}`);
  req.clientIp = clientIp;
  next();
});

// ============================================================
// DEBUG ROUTES
// ============================================================

app.get("/debug/memory", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  res.json({
    memory,
    location: MEMORY_FILE,
    lastUpdated: new Date().toISOString(),
    stats: {
      totalConversations: Object.keys(memory.conversations).length,
      totalMessages: Object.values(memory.conversations).reduce(
        (sum, conv) => sum + conv.length,
        0
      ),
      profileKeys: Object.keys(memory.profile).length
    }
  });
});

app.post("/debug/memory/reset", (req, res) => {
  saveJSON(MEMORY_FILE, DEFAULT_MEMORY);

  res.json({
    success: true,
    message: "Memory has been reset.",
    memory: DEFAULT_MEMORY
  });
});

app.get("/debug/ip", (req, res) => {
  const clientIp = req.clientIp;
  res.json({
    clientIp,
    headers: {
      xForwardedFor: req.headers['x-forwarded-for'],
      remoteAddress: req.connection.remoteAddress
    }
  });
});

console.log("DEBUG ROUTES REGISTERED:");
console.log("  GET  /debug/memory");
console.log("  POST /debug/memory/reset");
console.log("  GET  /debug/ip");

// ============================================================
// CHAT ENDPOINT - Enhanced with geolocation and full context
// ============================================================
app.post("/chat", async (req, res) => {
  const startTime = Date.now();

  try {
    let { message, conversationId } = req.body;

    // Validation
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid message" });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        error: "Message too long (max 2000 characters)"
      });
    }

    console.log("\n" + "=".repeat(70));
    console.log("💬 USER:", message);
    console.log("🌐 IP:", req.clientIp);

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
      console.log("💾 Updated profile: name =", memory.profile.name);
    }
    if (lower.startsWith("remember that my name is ")) {
      memory.profile.name = message.substring("remember that my name is ".length).trim();
      console.log("💾 Updated profile: name =", memory.profile.name);
    }
    if (lower.startsWith("remember my location is ")) {
      memory.profile.location = message.substring("remember my location is ".length).trim();
      console.log("💾 Updated profile: location =", memory.profile.location);
    }
    if (lower.startsWith("remember that my location is ")) {
      memory.profile.location = message.substring("remember that my location is ".length).trim();
      console.log("💾 Updated profile: location =", memory.profile.location);
    }

    // PLAN - Enhanced planner with LLM intelligence
    console.log("🧠 Planning...");
    const planResult = await plan({ message });
    const { tool, input, context, reasoning } = planResult;
    
    console.log("🎯 Plan:", {
      tool,
      reasoning: reasoning || "pattern-based routing",
      context: context || {}
    });

    // -----------------------------------------
    // GEOLOCATION HANDLING
    // -----------------------------------------
    let finalContext = context || {};

    if (tool === "weather" && finalContext.city === "__USE_GEOLOCATION__") {
      const clientIp = req.clientIp;
      console.log("🌍 Attempting geolocation for IP:", clientIp);

      const city = await resolveCityFromIp(clientIp);

      if (city) {
        finalContext.city = city;
        console.log("✅ Geolocation successful:", city);
      } else {
        console.log("⚠️ Geolocation failed");
        // Keep the geolocation flag so weather tool knows user said "here"
        // Weather tool can check memory or ask for location
        finalContext.wasGeolocationAttempt = true;
        finalContext.city = null; // Explicitly null, not deleted
      }
    }

    // -----------------------------------------
    // EXECUTE - Enhanced executor with full memory
    // -----------------------------------------
    console.log("⚙️ Executing tool:", tool);
    const result = await executeAgent({
      tool,
      message: {
        text: input ?? message,
        context: finalContext
      },
      conversationId: id
    });

    const reply = result.reply;
    const stateGraph = result.stateGraph;

    if (!reply) {
      throw new Error("Executor returned no reply");
    }

    // Calculate confidence
    const confidence = calculateConfidence(stateGraph);

    // Save assistant reply with metadata
    memory.conversations[id].push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
      confidence,
      tool: result.tool,
      metadata: {
        steps: stateGraph.length,
        reasoning: result.reasoning
      }
    });

    // SAVE MEMORY
    saveJSON(MEMORY_FILE, memory);

    const elapsed = Date.now() - startTime;

    // Enhanced summary logging
    console.log("\n📊 EXECUTION SUMMARY");
    console.log("├─ Steps:", stateGraph.length);
    console.log("├─ Tool Used:", result.tool || "none");
    console.log("├─ Confidence:", (confidence * 100).toFixed(1) + "%");
    console.log("├─ Time:", elapsed + "ms");
    console.log("├─ Conversation Messages:", memory.conversations[id].length);
    console.log("└─ Total Conversations:", Object.keys(memory.conversations).length);
    console.log("=".repeat(70) + "\n");

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
        executionTime: elapsed,
        reasoning: result.reasoning,
        planReasoning: reasoning,
        messageCount: memory.conversations[id].length
      }
    });

  } catch (err) {
    console.error("❌ CHAT ERROR:", err);
    console.error(err.stack);

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
    messages: conversation,
    messageCount: conversation.length,
    firstMessage: conversation[0]?.timestamp,
    lastMessage: conversation[conversation.length - 1]?.timestamp
  });
});

app.get("/conversations", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  const conversations = Object.entries(memory.conversations).map(
    ([id, messages]) => ({
      id,
      messageCount: messages.length,
      firstMessage: messages[0]?.timestamp,
      lastMessage: messages[messages.length - 1]?.timestamp,
      preview: messages[0]?.content.slice(0, 50),
      toolsUsed: [...new Set(messages.filter(m => m.tool).map(m => m.tool))]
    })
  );

  // Sort by last message time
  conversations.sort((a, b) => 
    new Date(b.lastMessage) - new Date(a.lastMessage)
  );

  res.json({
    conversations,
    totalConversations: conversations.length,
    totalMessages: conversations.reduce((sum, c) => sum + c.messageCount, 0)
  });
});

app.delete("/conversation/:id", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  if (!memory.conversations[req.params.id]) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  delete memory.conversations[req.params.id];
  saveJSON(MEMORY_FILE, memory);

  res.json({
    success: true,
    remainingConversations: Object.keys(memory.conversations).length
  });
});

// ============================================================
// PROFILE API
// ============================================================
app.get("/profile", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
  res.json({
    profile: memory.profile,
    keys: Object.keys(memory.profile)
  });
});

app.post("/profile", (req, res) => {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
  const { key, value } = req.body;

  if (!key) {
    return res.status(400).json({ error: "Key is required" });
  }

  memory.profile[key] = value;
  saveJSON(MEMORY_FILE, memory);

  res.json({
    success: true,
    profile: memory.profile
  });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(70));
  console.log("🤖 ENHANCED AI AGENT SERVER");
  console.log(`📡 http://localhost:${PORT}`);
  console.log("\n🎯 ENHANCEMENTS:");
  console.log("  ✅ LLM-powered intelligent routing");
  console.log("  ✅ Full conversation memory (no 20-message limit)");
  console.log("  ✅ Geolocation support for 'weather here'");
  console.log("  ✅ Table reformatting capability");
  console.log("  ✅ Multiple file sandboxes (D:/local-llm-ui, E:/testFolder)");
  console.log("  ✅ Enhanced search with deduplication and relevance scoring");
  console.log("  ✅ Increased agent awareness and context");
  console.log("=".repeat(70) + "\n");
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});

// server/index.js (COMPLETE FIX - Memory bug resolved)
// FIX #1: Reloads memory before saving to prevent deleted data from being restored

import express from "express";
import cors from "cors";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs/promises";

import { plan } from "./planner.js";
import {
  loadJSON,
  saveJSON,
  getMemory,
  MEMORY_FILE,
  DEFAULT_MEMORY
} from "./memory.js";
import { executeAgent } from "./executor.js";
import { calculateConfidence } from "./audit.js";
import { resolveCityFromIp } from "./utils/geo.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Enhanced logging
app.use((req, res, next) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${clientIp}`);
  req.clientIp = clientIp;
  next();
});

// Configure multer for file uploads (Requirement #31)
const upload = multer({
  dest: path.resolve("D:/local-llm-ui/uploads"),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 20 // Max 20 files
  },
  fileFilter: (req, file, cb) => {
    // Validate MIME types
    const allowedMimes = [
      'text/plain', 'application/pdf', 'image/png', 'image/jpeg',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  }
});

// ============================================================
// DEBUG ROUTES
// ============================================================

app.get("/debug/memory", (req, res) => {
  const memory = getMemory();
  res.json({
    memory,
    location: MEMORY_FILE,
    lastUpdated: new Date().toISOString(),
    stats: {
      totalConversations: Object.keys(memory.conversations).length,
      totalMessages: Object.values(memory.conversations).reduce((sum, conv) => sum + conv.length, 0),
      profileKeys: Object.keys(memory.profile).length
    }
  });
});

app.post("/debug/memory/reset", (req, res) => {
  saveJSON(MEMORY_FILE, DEFAULT_MEMORY);
  res.json({
    success: true,
    message: "Memory reset",
    memory: DEFAULT_MEMORY
  });
});

// ============================================================
// CHAT ENDPOINT - FIX #1: Memory bug resolved
// ============================================================
app.post("/chat", async (req, res) => {
  const startTime = Date.now();

  try {
    let { message, conversationId } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid message" });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: "Message too long (max 2000 characters)" });
    }

    console.log("\n" + "=".repeat(70));
    console.log("💬 USER:", message);
    console.log("🌐 IP:", req.clientIp);

    // Load memory
    let memory = getMemory();

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
      saveJSON(MEMORY_FILE, memory); // <-- FIX
    }
    if (lower.startsWith("remember that my name is ")) {
      memory.profile.name = message.substring("remember that my name is ".length).trim();
      console.log("💾 Updated profile: name =", memory.profile.name);
      saveJSON(MEMORY_FILE, memory); // <-- FIX
    }
    if (lower.startsWith("remember my location is ")) {
      memory.profile.location = message.substring("remember my location is ".length).trim();
      console.log("💾 Updated profile: location =", memory.profile.location);
      saveJSON(MEMORY_FILE, memory); // <-- FIX
    }
    if (lower.startsWith("remember that my location is ")) {
      memory.profile.location = message.substring("remember that my location is ".length).trim();
      console.log("💾 Updated profile: location =", memory.profile.location);
      saveJSON(MEMORY_FILE, memory); // <-- FIX
    }

    // PLAN
    console.log("🧠 Planning...");
    const planResult = await plan({ message });
    const { tool, input, context, reasoning } = planResult;
    
    console.log("🎯 Plan:", {
      tool,
      reasoning: reasoning || "pattern-based routing",
      context: context || {}
    });

    // GEOLOCATION HANDLING
    let finalContext = context || {};

    if (tool === "weather" && finalContext.city === "__USE_GEOLOCATION__") {
      const clientIp = req.clientIp;
      console.log("🌐 Attempting geolocation for IP:", clientIp);

      const city = await resolveCityFromIp(clientIp);

      if (city) {
        finalContext.city = city;
        console.log("✅ Geolocation successful:", city);
      } else {
        console.log("⚠️ Geolocation failed");
        finalContext.wasGeolocationAttempt = true;
        finalContext.city = null;
      }
    }

    // EXECUTE
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

    // FIX #1: RELOAD MEMORY BEFORE SAVING
    // This prevents memoryTool deletions from being overwritten
    memory = getMemory();
    // FIX: ensure conversation still exists after reload
    memory.conversations[id] ??= [];

    // Save assistant reply
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
// FILE UPLOAD ENDPOINT (Requirement #31)
// ============================================================
app.post("/upload", upload.array('files', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const fileData = req.files.map(file => ({
      id: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path
    }));

    res.json({
      success: true,
      files: fileData,
      count: fileData.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// COMPILE FILES ENDPOINT (Requirements #15, #16)
// ============================================================
app.post("/compile-files", async (req, res) => {
  try {
    const { files, conversationId } = req.body;
    
    let combinedContent = "";
    
    for (const filename of files) {
      const filepath = path.resolve("D:/local-llm-ui", filename);
      
      // Security check
      if (!filepath.startsWith("D:/local-llm-ui")) {
        continue;
      }
      
      try {
        const content = await fs.readFile(filepath, "utf8");
        combinedContent += `\n\n// ===== FILE: ${filename} =====\n\n`;
        combinedContent += content;
      } catch (err) {
        console.error(`Failed to read ${filename}:`, err);
      }
    }
    
    // Write to bigFile.txt
    const outputPath = path.resolve("D:/local-llm-ui/files2/bigFile.txt");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, combinedContent, "utf8");
    
    res.json({
      success: true,
      filesCompiled: files.length,
      outputPath: "D:/local-llm-ui/files2/bigFile.txt",
      size: combinedContent.length
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CONVERSATION APIs
// ============================================================
app.get("/conversation/:id", (req, res) => {
  const memory = getMemory();
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
  const memory = getMemory();

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
  const memory = getMemory();

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
  const memory = getMemory();
  res.json({
    profile: memory.profile,
    keys: Object.keys(memory.profile)
  });
});

app.post("/profile", (req, res) => {
  const memory = getMemory();
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
  console.log("\n🎯 FEATURES:");
  console.log("  ✅ Memory deletion bug FIXED");
  console.log("  ✅ File routing bug FIXED");
  console.log("  ✅ Case-insensitive tool matching");
  console.log("  ✅ Full conversation memory");
  console.log("  ✅ Geolocation support");
  console.log("  ✅ File uploads (Req #31)");
  console.log("  ✅ File compilation (Req #15-16)");
  console.log("=".repeat(70) + "\n");
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});

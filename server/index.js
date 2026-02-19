// server/index.js
// COMPLETE FIX: #10 (file compilation), review endpoint, proper file reading

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
  reloadMemory,
  MEMORY_FILE,
  DEFAULT_MEMORY
} from "./memory.js";
import { executeAgent } from "./executor.js";
import { calculateConfidence } from "./audit.js";
import { resolveCityFromIp } from "./utils/geo.js";
import { logTelemetry } from "./telemetryAudit.js";
import { logIntentDecision } from "./intentDebugger.js";
import reviewRoutes from "./routes/review.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));


// Enhanced logging
app.use((req, res, next) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.ip ||
    req.connection?.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${clientIp}`);
  req.clientIp = clientIp;
  next();
});
app.use("/api", reviewRoutes);


// Configure multer for file uploads
const upload = multer({
  dest: path.resolve("D:/local-llm-ui/uploads"),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "text/plain", "application/pdf", "image/png", "image/jpeg",
      "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ];
    if (allowedMimes.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type ${file.mimetype} not allowed`));
  }
});

// ============================================================
// DEBUG ROUTES
// ============================================================
app.get("/debug/memory", async (req, res) => {
  const memory = await getMemory();
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

app.post("/debug/memory/reset", async (req, res) => {
  await saveJSON(MEMORY_FILE, DEFAULT_MEMORY);
  res.json({ success: true, message: "Memory reset", memory: DEFAULT_MEMORY });
});

// ============================================================
// CHAT ENDPOINT
// ============================================================
app.post("/chat", async (req, res) => {
  const startTime = Date.now();
  try {
    let { message, conversationId } = req.body;
    if (!message || typeof message !== "string") return res.status(400).json({ error: "Missing or invalid message" });
    if (message.length > 2000) return res.status(400).json({ error: "Message too long (max 2000 characters)" });

    console.log("\n" + "=".repeat(70));
    console.log("💬 USER:", message);
    console.log("🌐 IP:", req.clientIp);

    // Load memory
    let memory = await getMemory();

    // Ensure conversation exists
    const id = conversationId || crypto.randomUUID();
    memory.conversations[id] ??= [];

    // Save user message (in-memory)
    memory.conversations[id].push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    });

    // INLINE PROFILE MEMORY UPDATE
    const nameMatch = message.match(/remember(?: that)? my name is (.+)$/i);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (name) {
        memory.profile.name = name;
        console.log("💾 Updated profile: name =", memory.profile.name);
        await saveJSON(MEMORY_FILE, memory);
      }
    }

    const locationMatch = message.match(/remember(?: that)? my location is (.+)$/i);
    if (locationMatch) {
      const city = locationMatch[1].trim();
      if (city) {
        memory.profile.location = city;
        console.log("💾 Updated profile: location =", memory.profile.location);
        await saveJSON(MEMORY_FILE, memory);
      }
    }

    // PLAN
    console.log("🧠 Planning...");
    const planResult = await plan({ message });
    const { tool, input, context, reasoning } = planResult;
    console.log("🎯 Plan:", { tool, reasoning: reasoning || "pattern-based routing", context: context || {} });

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
      message: { text: input ?? message, context: finalContext },
      conversationId: id
    });
    const elapsed = Date.now() - startTime;
    const reply = result.reply;
    const stateGraph = result.stateGraph;
    if (!reply) throw new Error("Executor returned no reply");

    // Calculate confidence
    const confidence = calculateConfidence(stateGraph);
    await logTelemetry({
      tool: result.tool,
      success: result.success,
      executionTime: elapsed,
      conversationId: id
    });

    // Log intent decision
    await logIntentDecision({
      userMessage: message,
      detectedTool: tool,
      reasoning,
      confidence: confidence,
      success: result.success
    });

    // RELOAD MEMORY BEFORE SAVING
    try {
      memory = await reloadMemory();
    } catch (e) {
      console.error("ERROR reloading memory:", e);
      memory = await getMemory();
    }
    memory.conversations[id] ??= [];

    // Save assistant reply with data for pending actions
    memory.conversations[id].push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
      confidence,
      tool: result.tool,
      data: result.data,  // CRITICAL: Store data including pendingEmail
      metadata: { steps: stateGraph.length, reasoning: result.reasoning }
    });

    // Persist memory
    await saveJSON(MEMORY_FILE, memory);

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
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ============================================================
// FILE UPLOAD ENDPOINT
// ============================================================
app.post("/upload", upload.array("files", 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
    const fileData = req.files.map((file) => ({ 
      id: file.filename, 
      originalName: file.originalname, 
      mimetype: file.mimetype, 
      size: file.size, 
      path: file.path 
    }));
    res.json({ success: true, files: fileData, count: fileData.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FIX #10: COMPILE FILES ENDPOINT - ACTUALLY READS FILE CONTENTS
// ============================================================
app.post("/compile-files", async (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "No files provided" });
    }

    let combinedContent = "";
    let successCount = 0;
    let errorCount = 0;

    console.log(`📦 Compiling ${files.length} files...`);

    for (const filename of files) {
      // Resolve path relative to project root
      const filepath = path.resolve("D:/local-llm-ui", filename);
      
      // Security check
      if (!filepath.startsWith("D:/local-llm-ui")) {
        console.warn(`⚠️ Skipping file outside sandbox: ${filename}`);
        continue;
      }

      try {
        console.log(`  📄 Reading: ${filename}`);
        // FIX: Actually read the file content!
        const content = await fs.readFile(filepath, "utf8");
        
        // Add file header and content
        combinedContent += `\n\n${"=".repeat(70)}\n`;
        combinedContent += `FILE: ${filename}\n`;
        combinedContent += `${"=".repeat(70)}\n\n`;
        combinedContent += content;
        combinedContent += `\n`;
        
        successCount++;
        console.log(`  ✅ Read ${content.length} characters`);
      } catch (err) {
        console.error(`  ❌ Failed to read ${filename}:`, err.message);
        combinedContent += `\n\n${"=".repeat(70)}\n`;
        combinedContent += `FILE: ${filename}\n`;
        combinedContent += `ERROR: ${err.message}\n`;
        combinedContent += `${"=".repeat(70)}\n\n`;
        errorCount++;
      }
    }

    // Write to bigFile.txt
    const outputPath = path.resolve("D:/local-llm-ui/files2/bigFile.txt");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, combinedContent, "utf8");

    console.log(`✅ Compilation complete: ${successCount} files, ${errorCount} errors`);
    console.log(`📁 Output: ${outputPath} (${combinedContent.length} bytes)`);

    res.json({ 
      success: true, 
      filesCompiled: successCount,
      filesErrored: errorCount,
      outputPath: "D:/local-llm-ui/files2/bigFile.txt", 
      size: combinedContent.length 
    });
  } catch (err) {
    console.error("❌ Compilation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CONVERSATION APIs
// ============================================================
app.get("/conversation/:id", async (req, res) => {
  const memory = await getMemory();
  const conversation = memory.conversations[req.params.id];
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  res.json({ 
    conversationId: req.params.id, 
    messages: conversation, 
    messageCount: conversation.length, 
    firstMessage: conversation[0]?.timestamp, 
    lastMessage: conversation[conversation.length - 1]?.timestamp 
  });
});

app.get("/conversations", async (req, res) => {
  const memory = await getMemory();
  const conversations = Object.entries(memory.conversations).map(([id, messages]) => ({
    id, 
    messageCount: messages.length, 
    firstMessage: messages[0]?.timestamp, 
    lastMessage: messages[messages.length - 1]?.timestamp, 
    preview: messages[0]?.content.slice(0, 50), 
    toolsUsed: [...new Set(messages.filter((m) => m.tool).map((m) => m.tool))]
  }));
  conversations.sort((a, b) => new Date(b.lastMessage) - new Date(a.lastMessage));
  res.json({ 
    conversations, 
    totalConversations: conversations.length, 
    totalMessages: conversations.reduce((sum, c) => sum + c.messageCount, 0) 
  });
});

app.delete("/conversation/:id", async (req, res) => {
  const memory = await getMemory();
  if (!memory.conversations[req.params.id]) return res.status(404).json({ error: "Conversation not found" });
  delete memory.conversations[req.params.id];
  await saveJSON(MEMORY_FILE, memory);
  res.json({ success: true, remainingConversations: Object.keys(memory.conversations).length });
});

// ============================================================
// PROFILE API
// ============================================================
app.get("/profile", async (req, res) => {
  const memory = await getMemory();
  res.json({ profile: memory.profile, keys: Object.keys(memory.profile) });
});

app.post("/profile", async (req, res) => {
  const memory = await getMemory();
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "Key is required" });
  memory.profile[key] = value;
  await saveJSON(MEMORY_FILE, memory);
  res.json({ success: true, profile: memory.profile });
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
  console.log("  ✅ Email 'send it' confirmation FIXED");
  console.log("  ✅ selfImprovement tool registered");
  console.log("  ✅ GitHub tool registered");
  console.log("  ✅ File compilation FIXED (reads content)");
  console.log("  ✅ Full conversation memory");
  console.log("  ✅ Geolocation support");
  console.log("=".repeat(70) + "\n");
});

process.on("SIGINT", () => { 
  console.log("\n👋 Shutting down gracefully..."); 
  process.exit(0); 
});

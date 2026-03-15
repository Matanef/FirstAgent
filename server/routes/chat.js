// server/routes/chat.js
// Main chat endpoint — handles user messages, planning, execution, and memory persistence

import express from "express";
import crypto from "crypto";
import {
  saveJSON,
  getMemory,
  reloadMemory,
  MEMORY_FILE
} from "../memory.js";
import { handleMessage as orchestratorHandle } from "../agents/orchestrator.js";
import { calculateConfidence } from "../audit.js";
import { logTelemetry } from "../telemetryAudit.js";

const router = express.Router();

router.post("/chat", async (req, res) => {
  let heartbeatInterval; // Declare it here so it's visible to the whole function
  const startTime = Date.now();
  try {
    let { message, conversationId, fileIds } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid message" });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: "Message too long (max 2000 characters)" });
    }

    // Validate fileIds if present
    if (fileIds && !Array.isArray(fileIds)) fileIds = undefined;
    if (fileIds && fileIds.length > 10) fileIds = fileIds.slice(0, 10);

    // Set Headers for SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    console.log("\n" + "=".repeat(70));
    console.log("💬 USER (STREAMING):", message);

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

    // Simple inline profile updates
    const nameMatch = message.match(/remember(?: that)? my name is (.+)$/i);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (name) memory.profile.name = name;
    }
    const locationMatch = message.match(/remember(?: that)? my location is (.+)$/i);
    if (locationMatch) {
      const city = locationMatch[1].trim();
      if (city) memory.profile.location = city;
    }

    // Send initial state
    res.write(
      `data: ${JSON.stringify({ type: "start", conversationId: id })}\n\n`
    );

    // server/routes/chat.js - Around Line 66
    // SSE keepalive: send heartbeat every 15s to prevent connection timeout
    heartbeatInterval = setInterval(() => {
      try { 
        if (!res.writableEnded) {
          res.write(`: heartbeat\n\n`); 
        }
      } catch (err) { 
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    }, 15_000);

    // EXECUTE via Orchestrator (routes to chatAgent or taskAgent based on intent)
    const result = await orchestratorHandle({
      message,
      conversationId: id,
      clientIp: req.clientIp,
      fileIds: fileIds || [],
      onChunk: (chunk) => {
        res.write(
          `data: ${JSON.stringify({ type: "chunk", chunk })}\n\n`
        );
      },
      onStep: (stepInfo) => {
        // Train of Thought events pass through as-is (type: "thought"),
        // legacy step events get wrapped with type: "step"
        if (stepInfo.type === "thought") {
          res.write(`data: ${JSON.stringify(stepInfo)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ type: "step", ...stepInfo })}\n\n`);
        }
      }
    });
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    console.log("🟢 [chat.js] Agent returned. Formatting response...");

    const elapsed = Date.now() - startTime;
    const reply = result.reply || "Task completed.";
    const stateGraph = result.stateGraph;
    const confidence = calculateConfidence(stateGraph);

    try {
      console.log("🟢 [chat.js] Stringifying JSON payload...");
      const payload = JSON.stringify({
        type: "done",
        reply,
        stateGraph: stateGraph || [],
        thoughtChain: result.thoughtChain || [],
        tool: result.tool || "unknown",
        data: result.data || null,
        success: result.success ?? true,
        confidence: confidence || 0.8,
        metadata: {
          steps: stateGraph?.length || 1,
          executionTime: elapsed,
          reasoning: result.reasoning || "Complete.",
          messageCount: 1
        }
      });

      console.log("🟢 [chat.js] JSON stringified successfully. Sending to client...");
      res.write(`data: ${payload}\n\n`);
      res.end();
      console.log("🟢 [chat.js] Stream fully closed and sent!");
      
    } catch (criticalError) {
      console.error("🔴 [chat.js] CRASH WHILE SENDING PAYLOAD:", criticalError);
      res.write(`data: {"type": "error", "error": "Crash during payload generation"}\n\n`);
      res.end();
    }


    // ASYNC: Heavy I/O after stream closed
    try {
      try {
        memory = await reloadMemory();
      } catch (e) {}
      memory.conversations[id] ??= [];

      // Save assistant reply
      memory.conversations[id].push({
        role: "assistant",
        content: reply,
        timestamp: new Date().toISOString(),
        confidence,
        tool: result.tool,
        data: result.data,
        metadata: { steps: stateGraph.length, reasoning: result.reasoning, thoughtChain: result.thoughtChain || [] }
      });

      await saveJSON(MEMORY_FILE, memory);

      await logTelemetry({
        tool: result.tool,
        success: result.success,
        executionTime: elapsed,
        conversationId: id
      });
    } catch (saveErr) {
      console.error("⚠️ Post-response save error (non-blocking):", saveErr.message);
    }
  } catch (err) {
  if (heartbeatInterval) clearInterval(heartbeatInterval); // Use the new name here too
  console.error("❌ CHAT ERROR:", err);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`
    );
    res.end();
  }
});

// ── Scheduler notifications endpoint ──
router.get("/notifications", async (req, res) => {
  try {
    const { getNotifications, clearNotifications } = await import("../tools/scheduler.js");
    const clear = req.query.clear === "true";
    const notifs = getNotifications();
    if (clear) clearNotifications();
    res.json(notifs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
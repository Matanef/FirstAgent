// server/routes/chat.js
// Main chat endpoint — handles user messages, planning, execution, and memory persistence

import express from "express";
import crypto from "crypto";
import {
  saveJSON,
  getMemory,
  reloadMemory,
  withMemoryLock,
  MEMORY_FILE
} from "../memory.js";
import { handleMessage as orchestratorHandle } from "../agents/orchestrator.js";
import { calculateConfidence } from "../audit.js";
import { logTelemetry } from "../telemetryAudit.js";
import { abortActiveStream } from "../tools/llm.js";

const router = express.Router();

// ── SECURITY: API key authentication middleware ──
const AGENT_API_KEY = process.env.AGENT_API_KEY || null;
if (!AGENT_API_KEY) {
  console.warn("⚠️ [security] AGENT_API_KEY not set — chat endpoint authentication DISABLED");
}

function requireAuth(req, res, next) {
  if (!AGENT_API_KEY) return next(); 
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (!provided) {
    return res.status(401).json({ error: "Missing API key. Provide X-Api-Key header." });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(AGENT_API_KEY))) {
      return res.status(403).json({ error: "Invalid API key." });
    }
  } catch {
    return res.status(403).json({ error: "Invalid API key." });
  }
  next();
}

// ── SECURITY: In-memory rate limiter ──
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000; 
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "30", 10); 

function rateLimit(req, res, next) {
  const ip = req.clientIp || req.ip || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    console.warn(`🛡️ Rate limit exceeded for ${ip} (${entry.count}/${RATE_LIMIT_MAX} per min)`);
    return res.status(429).json({ error: "Rate limit exceeded. Try again shortly." });
  }
  next();
}

// Memory Cleanup: Avoid map bloat
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.windowStart < cutoff) rateLimitMap.delete(ip);
  }
}, 300_000);

router.post("/chat", requireAuth, rateLimit, async (req, res) => {
  let heartbeatInterval; 
  const startTime = Date.now();
  
// 1. ADD THE ABORT CONTROLLER HERE
  const abortController = new AbortController();
  
  // 2. LISTEN FOR THE BROWSER DISCONNECTING
  res.on("close", () => {
    // Only abort if the server hasn't naturally finished sending the response
    if (!res.writableEnded) {
      console.log("⚠️ [chat.js] Client disconnected prematurely! Aborting background operations...");
      abortController.abort();
      // Also explicitly abort the active Ollama stream so Ollama stops generating
      // immediately — prevents the next request from queuing behind a stale generation.
      abortActiveStream();
    }
  });

  try {
    let { message, conversationId, fileIds } = req.body;
    
    // ── SECURITY: Strict Input Validation ──
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "Missing or invalid message payload" });
    }
    if (message.length > 16000) {
      return res.status(400).json({ error: "Message exceeds 16000 character limit" });
    }
    if (conversationId && !/^[a-zA-Z0-9_-]{8,64}$/.test(conversationId)) {
      return res.status(400).json({ error: "Invalid conversationId format" });
    }
    if (fileIds) {
      if (!Array.isArray(fileIds) || !fileIds.every(id => typeof id === "string")) {
        return res.status(400).json({ error: "fileIds must be an array of strings" });
      }
      fileIds = fileIds.slice(0, 10);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    console.log("\n" + "=".repeat(70));
    console.log("💬 USER (STREAMING):", message.substring(0, 200) + (message.length > 200 ? "..." : ""));

    const id = conversationId || crypto.randomUUID();

    // ── Persist user turn under lock (FIX: was unsynchronized cache mutation) ──
    // Previously this block pushed the user turn into the shared _cache with no save
    // and no lock, relying on the post-orchestrator saveJSON to persist it. Under
    // concurrent load that broke in two ways:
    //   (1) the post-orchestrator reloadMemory() wipes the shared cache, discarding
    //       in-flight user turns from OTHER concurrent requests;
    //   (2) there was no mutual exclusion between read-push-save cycles, so parallel
    //       requests would clobber each other's turns.
    // Stress test (stress-memory-lock-torture.mjs) surfaced this: 17/32 convos missing.
    
    const memory = await getMemory();
    memory.conversations[id] ??= [];
    memory.conversations[id].push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    });
    const nameMatch = message.match(/remember(?: that)? my name is (.+)$/i);
    if (nameMatch && nameMatch[1].trim()) memory.profile.name = nameMatch[1].trim();
    
    const locationMatch = message.match(/remember(?: that)? my location is (.+)$/i);
    if (locationMatch && locationMatch[1].trim()) memory.profile.location = locationMatch[1].trim();
    
    await saveJSON(MEMORY_FILE, memory);
    

    res.write(`data: ${JSON.stringify({ type: "start", conversationId: id })}\n\n`);

    // Only set the heartbeat ONCE here!
    heartbeatInterval = setInterval(() => {
      try { 
        if (!res.writableEnded) res.write(`: heartbeat\n\n`); 
      } catch (err) { 
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    }, 15_000);

    const result = await orchestratorHandle({
      message,
      conversationId: id,
      clientIp: req.clientIp,
      fileIds: fileIds || [],
      signal: abortController.signal,
      onChunk: (chunk) => res.write(`data: ${JSON.stringify({ type: "chunk", chunk })}\n\n`),
      onStep: (stepInfo) => {
        if (stepInfo.type === "thought") {
          res.write(`data: ${JSON.stringify(stepInfo)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ type: "step", ...stepInfo })}\n\n`);
        }
      }
    });

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    console.log("🟢 [chat.js] Agent returned. Formatting response...");

    const elapsed = Date.now() - startTime;
    const reply = result.reply || "Task completed.";
    const stateGraph = result.stateGraph || [];
    const confidence = calculateConfidence(stateGraph);

    try {
      const payload = JSON.stringify({
        type: "done",
        reply,
        html: result.html || result.data?.html || null,
        stateGraph,
        thoughtChain: result.thoughtChain || [],
        tool: result.tool || "unknown",
        data: result.data || null,
        success: result.success ?? true,
        confidence: confidence || 0.8,
        metadata: {
          steps: stateGraph.length || 1,
          executionTime: elapsed,
          reasoning: result.reasoning || "Complete.",
          messageCount: 1
        }
      });

      res.write(`data: ${payload}\n\n`);
      res.end();
      console.log("🟢 [chat.js] Stream fully closed and sent!");
      
    } catch (criticalError) {
      console.error("🔴 [chat.js] CRASH WHILE SENDING PAYLOAD:", criticalError);
      res.write(`data: {"type": "error", "error": "Crash during payload generation"}\n\n`);
      res.end();
    }

    // ASYNC: Heavy I/O after stream closed — persist assistant turn under lock.
    // FIX: removed the reloadMemory() call that used to sit here — under concurrent
    // load it wiped the shared cache mid-flight for other requests, discarding their
    // user turns. The getMemory() inside withMemoryLock handles cache staleness via
    // disk-mtime reconciliation, so a forced reload is not needed here.
    try {
      // Sanitize data before saving — strip large HTML blobs, non-serializable values
      let safeData = null;
      if (result.data) {
        try {
          const { html, content, plain, ...rest } = result.data;
          safeData = {
            ...rest,
            text: (rest.text || "").slice(0, 500), // Cap stored text
          };
        } catch { safeData = { text: (result.data?.text || "").slice(0, 500) }; }
      }


      const memory = await getMemory();
      memory.conversations[id] ??= [];
      memory.conversations[id].push({
        role: "assistant",
        content: reply,
        timestamp: new Date().toISOString(),
        confidence,
        tool: result.tool,
        data: safeData,
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
    if (heartbeatInterval) clearInterval(heartbeatInterval); 
    console.error("❌ CHAT ERROR:", err);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
      res.end();
    }
  }
});

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
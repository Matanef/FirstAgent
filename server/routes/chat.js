// server/routes/chat.js
// Main chat endpoint — handles user messages, planning, execution, and memory persistence

import express from "express";
import crypto from "crypto";
import { plan } from "../planner.js";
import {
    loadJSON,
    saveJSON,
    getMemory,
    reloadMemory,
    MEMORY_FILE,
    DEFAULT_MEMORY
} from "../memory.js";
import { executeAgent } from "../executor.js";
import { calculateConfidence } from "../audit.js";
import { resolveCityFromIp } from "../utils/geo.js";
import { logTelemetry } from "../telemetryAudit.js";
import { logIntentDecision } from "../intentDebugger.js";

const router = express.Router();

router.post("/chat", async (req, res) => {
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

export default router;

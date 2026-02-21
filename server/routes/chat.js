// server/routes/chat.js
// Main chat endpoint — handles user messages, planning, execution, and memory persistence

import express from "express";
import crypto from "crypto";
import {
    loadJSON,
    saveJSON,
    getMemory,
    reloadMemory,
    MEMORY_FILE,
    DEFAULT_MEMORY
} from "../memory.js";
import { executeAgent } from "../utils/coordinator.js";
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

        // Set Headers for SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

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

        // (Inline profile updates omitted for brevity, keeping them)
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
        res.write(`data: ${JSON.stringify({ type: 'start', conversationId: id })}\n\n`);

        // EXECUTE via Coordinator (Handles planning and multi-step loop)
        const result = await executeAgent({
            message,
            conversationId: id,
            clientIp: req.clientIp,
            onChunk: (chunk) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', chunk })}\n\n`);
            },
            onStep: (stepInfo) => {
                res.write(`data: ${JSON.stringify({ type: 'step', ...stepInfo })}\n\n`);
            }
        });

        const elapsed = Date.now() - startTime;
        const reply = result.reply; // Contains full formatted reply (with tables etc)
        const stateGraph = result.stateGraph;

        // Calculate confidence
        const confidence = calculateConfidence(stateGraph);
        await logTelemetry({
            tool: result.tool,
            success: result.success,
            executionTime: elapsed,
            conversationId: id
        });

        // RELOAD MEMORY BEFORE SAVING
        try { memory = await reloadMemory(); } catch (e) { }
        memory.conversations[id] ??= [];

        // Save assistant reply
        memory.conversations[id].push({
            role: "assistant",
            content: reply,
            timestamp: new Date().toISOString(),
            confidence,
            tool: result.tool,
            data: result.data,
            metadata: { steps: stateGraph.length, reasoning: result.reasoning }
        });

        await saveJSON(MEMORY_FILE, memory);

        // Final SSE event
        res.write(`data: ${JSON.stringify({
            type: 'done',
            reply,
            stateGraph,
            tool: result.tool,
            data: result.data,
            success: result.success,
            confidence,
            metadata: {
                steps: stateGraph.length,
                executionTime: elapsed,
                reasoning: result.reasoning,
                messageCount: memory.conversations[id].length
            }
        })}\n\n`);
        res.end();

    } catch (err) {
        console.error("❌ CHAT ERROR:", err);
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
    }
});

export default router;

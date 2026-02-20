// server/routes/conversations.js
// Conversation CRUD and profile management endpoints

import express from "express";
import {
    saveJSON,
    getMemory,
    MEMORY_FILE
} from "../memory.js";

const router = express.Router();

// ============================================================
// CONVERSATION APIs
// ============================================================
router.get("/conversation/:id", async (req, res) => {
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

router.get("/conversations", async (req, res) => {
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

router.delete("/conversation/:id", async (req, res) => {
    const memory = await getMemory();
    if (!memory.conversations[req.params.id]) return res.status(404).json({ error: "Conversation not found" });
    delete memory.conversations[req.params.id];
    await saveJSON(MEMORY_FILE, memory);
    res.json({ success: true, remainingConversations: Object.keys(memory.conversations).length });
});

// ============================================================
// PROFILE API
// ============================================================
router.get("/profile", async (req, res) => {
    const memory = await getMemory();
    res.json({ profile: memory.profile, keys: Object.keys(memory.profile) });
});

router.post("/profile", async (req, res) => {
    const memory = await getMemory();
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "Key is required" });
    memory.profile[key] = value;
    await saveJSON(MEMORY_FILE, memory);
    res.json({ success: true, profile: memory.profile });
});

export default router;

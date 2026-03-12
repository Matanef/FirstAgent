// server/routes/whatsappWebhook.js
// WhatsApp Business Cloud API webhook — receives incoming messages from Meta
// TWO-WAY LOOP: incoming message → agent pipeline → auto-reply via WhatsApp

import express from "express";

const router = express.Router();

// Track recently processed message IDs to prevent duplicate processing
const processedMessages = new Set();
const MAX_PROCESSED_CACHE = 500;

function trackMessage(messageId) {
  processedMessages.add(messageId);
  // Prune cache if it gets too large
  if (processedMessages.size > MAX_PROCESSED_CACHE) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }
}

// ============================================================
// GET /  — Meta webhook verification (handshake)
// ============================================================
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ [WhatsApp] Webhook verified successfully");
    return res.status(200).send(challenge); // must be plain text, NOT JSON
  }

  console.warn("⚠️ [WhatsApp] Webhook verification failed — token mismatch");
  return res.sendStatus(403);
});

// ============================================================
// POST /  — Receive incoming WhatsApp messages (TWO-WAY LOOP)
// ============================================================
router.post("/", async (req, res) => {
  // CRITICAL: Always respond 200 immediately — Meta retries aggressively on failure
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Status updates (delivered, read, etc.) — log but skip
    if (value?.statuses) {
      const status = value.statuses[0];
      console.log(`📱 [WhatsApp] Status: ${status?.status} for ${status?.recipient_id}`);
      return;
    }

    // Incoming message
    const message = value?.messages?.[0];
    if (!message) return;

    // Only handle text messages for now
    if (message.type !== "text") {
      console.log(`📱 [WhatsApp] Received ${message.type} (non-text) — skipping auto-reply`);
      return;
    }

    const messageId = message.id;
    const from = message.from;             // sender phone number (e.g., "972541234567")
    const body = message.text?.body || "";
    const contactName = value?.contacts?.[0]?.profile?.name || "Unknown";
    const timestamp = new Date(parseInt(message.timestamp) * 1000).toLocaleString();

    // ── DUPLICATE GUARD: Skip if we already processed this message ──
    if (processedMessages.has(messageId)) {
      console.log(`📱 [WhatsApp] Duplicate message ${messageId} — skipping`);
      return;
    }
    trackMessage(messageId);

    // ── LOOP GUARD: Skip messages from the bot's own number ──
    const botNumber = process.env.WHATSAPP_BOT_NUMBER || process.env.WHATSAPP_PHONE_ID;
    if (from === botNumber) {
      console.log("[WhatsApp] Skipping self-sent message (loop guard)");
      return;
    }

    // ── EMPTY MESSAGE GUARD ──
    if (!body.trim()) {
      console.log("[WhatsApp] Empty message body — skipping");
      return;
    }

    console.log("\n" + "─".repeat(60));
    console.log(`📱 [WhatsApp] Incoming Message → Agent Pipeline`);
    console.log(`   From:    ${contactName} (${from})`);
    console.log(`   Time:    ${timestamp}`);
    console.log(`   Message: ${body}`);
    console.log("─".repeat(60));

    // ── PROCESS THROUGH AGENT PIPELINE ──
    // Dynamic imports to avoid circular dependencies
    const { plan } = await import("../planner.js");
    const { orchestrate } = await import("../utils/coordinator.js");
    const { sendWhatsAppMessage } = await import("../tools/whatsapp.js");

    console.log(`🤖 [WhatsApp] Processing "${body.slice(0, 60)}..." through agent...`);

    const steps = await plan({ message: body });
    console.log(`🤖 [WhatsApp] Planned ${steps.length} step(s): ${steps.map(s => s.tool).join(" → ")}`);

    const results = await orchestrate(steps, body);

    // ── EXTRACT RESPONSE TEXT ──
    const lastResult = results?.[results.length - 1];
    let responseText =
      lastResult?.output?.data?.text ||
      lastResult?.output?.data?.plain ||
      lastResult?.output?.text ||
      lastResult?.data?.text ||
      "I processed your request but couldn't generate a response.";

    // Strip HTML tags for WhatsApp plain-text format
    responseText = responseText
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s{2,}/g, " ")
      .trim();

    // WhatsApp has a 4096 char limit
    if (responseText.length > 4000) {
      responseText = responseText.slice(0, 4000) + "\n\n... (truncated)";
    }

    // ── SEND REPLY ──
    const sendResult = await sendWhatsAppMessage(from, responseText);

    if (sendResult.success) {
      console.log(`✅ [WhatsApp] Replied to ${contactName} (${from}) — ${responseText.length} chars`);
    } else {
      console.error(`❌ [WhatsApp] Failed to reply to ${from}: ${sendResult.error}`);
    }

  } catch (err) {
    // Never let errors propagate — we already sent 200
    console.error("❌ [WhatsApp] Agent pipeline error:", err.message);
    console.error(err.stack);
  }
});

export default router;

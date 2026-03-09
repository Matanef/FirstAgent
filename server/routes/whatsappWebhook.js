// server/routes/whatsappWebhook.js
// WhatsApp Business Cloud API webhook — receives incoming messages from Meta

import express from "express";

const router = express.Router();

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
// POST /  — Receive incoming WhatsApp messages
// ============================================================
router.post("/", (req, res) => {
  // CRITICAL: Always respond 200 immediately — Meta retries aggressively on failure
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Status updates (delivered, read, etc.) — log but skip
    if (value?.statuses) {
      const status = value.statuses[0];
      console.log(`📱 [WhatsApp] Status update: ${status?.status} for ${status?.recipient_id}`);
      return;
    }

    // Incoming message
    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;             // sender phone number (e.g., "972541234567")
    const contactName = value?.contacts?.[0]?.profile?.name || "Unknown";
    const timestamp = new Date(parseInt(message.timestamp) * 1000).toLocaleString();

    if (message.type === "text") {
      const body = message.text?.body || "";
      console.log("\n" + "─".repeat(50));
      console.log(`📱 [WhatsApp] Incoming Message`);
      console.log(`   From:    ${contactName} (${from})`);
      console.log(`   Time:    ${timestamp}`);
      console.log(`   Message: ${body}`);
      console.log("─".repeat(50) + "\n");
    } else {
      // Image, audio, video, document, location, etc.
      console.log(`📱 [WhatsApp] Received ${message.type} from ${contactName} (${from}) at ${timestamp}`);
    }
  } catch (err) {
    // Never let errors propagate — we already sent 200
    console.error("❌ [WhatsApp] Error processing webhook payload:", err.message);
  }
});

export default router;

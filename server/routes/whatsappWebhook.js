// server/routes/whatsappWebhook.js
// WhatsApp Business Cloud API webhook — receives incoming messages from Meta
// TWO-WAY LOOP: incoming message → agent pipeline → auto-reply via WhatsApp
// STATEFUL CONVERSATIONS: greeting, weather, news categories, calendar, tasks

import fs from "fs"; // Ensure fs is imported
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";
import express from "express";
import crypto from "crypto";
import { getState, setState, clearState, touchConversationWindow } from "../utils/whatsappState.js";
import { getUserByPhone, buildUserToneInstruction } from "../utils/userProfiles.js";

async function releasePendingMessages(phone, sendWhatsAppMessage) {
  const pendingFile = path.resolve(PROJECT_ROOT, "data", "pending_whatsapp.json");
  if (!fs.existsSync(pendingFile)) return;

  try {
    const data = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
    const messages = data[phone];

    if (messages && messages.length > 0) {
      console.log(`🚀 [WhatsApp] Releasing ${messages.length} pending messages for ${phone}`);
      
      for (const msg of messages) {
        await sendWhatsAppMessage(phone, msg.text);
        await new Promise(r => setTimeout(r, 1000)); // Delay between messages
      }

      delete data[phone]; // Clear the stash for this user
      fs.writeFileSync(pendingFile, JSON.stringify(data, null, 2));
    }
  } catch (e) {
    console.error("❌ [WhatsApp] Release failed:", e.message);
  }
}

const router = express.Router();

// ── SECURITY: HMAC-SHA256 signature verification for incoming webhooks ──
// Prevents spoofed requests from impersonating Meta/WhatsApp
function verifyWebhookSignature(req, res, next) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  // If no app secret configured, log warning but allow (dev mode)
  if (!appSecret) {
    console.warn("⚠️ [WhatsApp] WHATSAPP_APP_SECRET not set — webhook signature verification DISABLED");
    return next();
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("🛡️ [WhatsApp] Rejected request: missing X-Hub-Signature-256 header");
    return res.sendStatus(401);
  }

  // Use the original raw bytes (preserved by express.json verify callback) — NOT re-serialized JSON,
  // which may differ in key ordering/whitespace from what Meta actually signed.
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      console.warn("🛡️ [WhatsApp] Rejected request: invalid HMAC signature");
      return res.sendStatus(401);
    }
  } catch {
    console.warn("🛡️ [WhatsApp] Rejected request: signature comparison failed");
    return res.sendStatus(401);
  }

  next();
}

// Track recently processed message IDs to prevent duplicate processing
const processedMessages = new Set();
const MAX_PROCESSED_CACHE = 500;

function trackMessage(messageId) {
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_PROCESSED_CACHE) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }
}

// ── WhatsApp formatting helpers ──

function stripHtmlToPlain(html) {
  return (html || "")
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
    .trim();
}

function formatWeatherWA(result) {
  if (!result?.success || !result?.data) return "❌ Could not fetch weather.";
  const d = result.data;
  const parts = ["🌤️ *Weather Report*"];
  if (d.city) parts.push(`📍 ${d.city}${d.country ? `, ${d.country}` : ""}`);
  if (d.temp != null) parts.push(`🌡️ ${d.temp}°C${d.feels_like != null ? ` (feels like ${d.feels_like}°C)` : ""}`);
  if (d.description) parts.push(`☁️ ${d.description}`);
  if (d.wind_speed != null) parts.push(`💨 Wind: ${d.wind_speed} m/s`);
  if (d.humidity != null) parts.push(`💧 Humidity: ${d.humidity}%`);
  return parts.join("\n");
}

function formatNewsWA(result, label = "News") {
  if (!result?.success) return `❌ Could not fetch ${label}.`;
  // News tool returns data.summaries (scraped articles) and data.results[].items (raw feed items)
  const summaries = result.data?.summaries || [];
  const rawItems = (result.data?.results || []).flatMap(r => r.items || []);
  const items = summaries.length > 0 ? summaries : rawItems;
  if (items.length === 0) return `No ${label} found.`;
  const lines = items.slice(0, 8).map((item, i) => {
    const title = item.title || "Untitled";
    const source = item.source ? ` _(${item.source})_` : "";
    const link = item.link ? `\n   ${item.link}` : "";
    const desc = item.summary ? `\n   ${item.summary.slice(0, 120)}${item.summary.length > 120 ? "..." : ""}` : "";
    return `${i + 1}. *${title}*${source}${desc}${link}`;
  });
  return `📰 *${label}*\n\n${lines.join("\n\n")}`;
}

function formatTasksWA(result) {
  if (!result?.success) return "❌ Task operation failed.";
  const text = result.data?.text || result.data?.plain || JSON.stringify(result.data);
  return stripHtmlToPlain(text);
}

function formatCalendarWA(result) {
  if (!result?.success) return "❌ Calendar operation failed.";
  const text = result.data?.text || result.data?.plain || "Calendar event processed.";
  return stripHtmlToPlain(text);
}

async function getSavedCity() {
  try {
    const { getMemory } = await import("../memory.js");
    const memory = await getMemory();
    return memory.profile?.location || memory.profile?.city || null;
  } catch { return null; }
}

async function loadTools() {
  const { default: TOOLS } = await import("../tools/index.js");
  return TOOLS;
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
    return res.status(200).send(challenge);
  }

  console.warn("⚠️ [WhatsApp] Webhook verification failed — token mismatch");
  return res.sendStatus(403);
});

// ============================================================
// POST /  — Receive incoming WhatsApp messages (TWO-WAY LOOP)
// ============================================================
router.post("/", verifyWebhookSignature, async (req, res) => {
  // CRITICAL: Always respond 200 immediately — Meta retries aggressively on failure
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Status updates (delivered, read, failed, etc.) — log details and skip
    if (value?.statuses) {
      const status = value.statuses[0];
      if (status?.status === "failed") {
        const errCode = status?.errors?.[0]?.code || "unknown";
        const errTitle = status?.errors?.[0]?.title || "Unknown error";
        const errMsg = status?.errors?.[0]?.message || status?.errors?.[0]?.error_data?.details || "";
        console.error(`❌ [WhatsApp] Status: FAILED for ${status?.recipient_id} — Error ${errCode}: ${errTitle}${errMsg ? ` (${errMsg})` : ""}`);
      } else {
        console.log(`📱 [WhatsApp] Status: ${status?.status} for ${status?.recipient_id}`);
      }
      return;
    }

    // Incoming message
    const message = value?.messages?.[0];
    if (!message) return;
    if (message.type !== "text") {
      console.log(`📱 [WhatsApp] Received ${message.type} (non-text) — skipping`);
      return;
    }

const messageId = message.id;
    const from = message.from;
    const body = message.text?.body || "";

    // ── DUPLICATE GUARD ──
    if (processedMessages.has(messageId)) return;
    trackMessage(messageId);

    // ── 24-HOUR WINDOW ──
    touchConversationWindow(from);

    // ── PREPARE WHATSAPP TOOL (Moved up here to avoid double-declaration) ──
    const { sendWhatsAppMessage: _sendWA } = await import("../tools/whatsapp.js");
    const sendWhatsAppMessage = (to, text) => _sendWA(to, text, { skipWindowCheck: true });

    // ── RELEASE PENDING MESSAGES (Option 1 Trigger) ──
    await releasePendingMessages(from, sendWhatsAppMessage);

    // ── LOOP GUARD ──
    const botNumber = process.env.WHATSAPP_BOT_NUMBER || process.env.WHATSAPP_PHONE_ID;
    if (from === botNumber) return;

    // ── EMPTY GUARD ──
    if (!body.trim()) return;

    // ── USER PROFILE LOOKUP ──
    const userProfile = await getUserByPhone(from);
    const displayName = userProfile?.name || contactName;

    console.log("\n" + "─".repeat(60));
    console.log(`📱 [WhatsApp] From: ${displayName} (${from})${userProfile ? ` [${userProfile.role}]` : ""} → "${body}"`);
    console.log("─".repeat(60));

    // All webhook replies are responses to an incoming message — window is guaranteed open.
    const lower = body.trim().toLowerCase();

    // ──────────────────────────────────────────────────────
    // STATEFUL CONVERSATION: Check if user is mid-flow
    // ──────────────────────────────────────────────────────
    const convState = getState(from);

    // ── STATEFUL: Email confirmation ("send it" / "cancel") ──
    // Keeping this because WhatsApp requires explicit confirmation out-of-band
    if (convState?.state === "awaiting_email_confirm") {
      const draft = convState.data?.draft;
      if (/\b(send\s*it|yes|confirm|go\s+ahead|approve|שלח)\b/i.test(lower)) {
        console.log(`📱 [WhatsApp] Email confirm → sending draft to ${draft?.to}`);
        clearState(from);
        try {
          const { sendConfirmedEmail } = await import("../tools/email.js");
          const sendResult = await sendConfirmedEmail({
            to: draft.to,
            cc: draft.cc || [],
            bcc: draft.bcc || [],
            subject: draft.subject,
            body: draft.body,
            attachments: draft.attachments || [],
            isHtml: draft.isHtml || false
          });
          if (sendResult.success) {
            await sendWhatsAppMessage(from, `✅ Email sent to ${draft.to}!\nSubject: ${draft.subject}`);
          } else {
            await sendWhatsAppMessage(from, `❌ Failed to send email: ${sendResult.error || "unknown error"}`);
          }
        } catch (e) {
          await sendWhatsAppMessage(from, `❌ Email send error: ${e.message}`);
        }
      } else if (/\b(cancel|discard|don'?t\s+send|never\s*mind|abort|ביטול)\b/i.test(lower)) {
        console.log(`📱 [WhatsApp] Email cancelled by user`);
        clearState(from);
        await sendWhatsAppMessage(from, "✅ Email draft discarded.");
      } else {
        // Unrecognized reply while awaiting confirm — remind user
        await sendWhatsAppMessage(from, '📧 You have a pending email draft. Say *"send it"* to send or *"cancel"* to discard.');
      }
      return;
    }

// ──────────────────────────────────────────────────────
    // GENERIC: Route through full agent pipeline
    // ──────────────────────────────────────────────────────
    console.log(`🤖 [WhatsApp] Routing through agent pipeline: "${body.slice(0, 60)}..."`);

    const { executeAgent } = await import("../utils/coordinator.js");

    // Build user-specific tone instruction for non-default users
    const userToneInstruction = await buildUserToneInstruction(from);

// ── PERSONA OVERRIDE FOR WHATSAPP ──
    let personaPrefix = `(System: You are Lanou, communicating via WhatsApp.`;
    
    // 1. Always inject the user's identity if we know it
    if (userProfile && userProfile.name) {
        personaPrefix += ` You are speaking with ${userProfile.name}`;
        if (userProfile.relation) personaPrefix += ` (Matan's ${userProfile.relation}).`;
        else personaPrefix += `.`;
        
        if (userProfile.role !== "admin" && userProfile.role !== "developer") {
           personaPrefix += ` Answer warmly and conversationally. Do NOT output raw terminal data, JSON, or tool diagnostics. Summarize any tool findings in natural language.`;
        }
    }
    
// 2. Add identity override instructions if they ask who you are
    if (/^(what('s| is) your name|who are you|what are you|איך קוראים לך|מה השם שלך|מה שמך|מי את|מי אתה)[?.!]?\s*$/i.test(body.trim())) {
        personaPrefix += ` The user is asking about your identity. Answer briefly and conversationally as Lanou. Do not search the web or run tools.`;
    }
    
    personaPrefix += `) `;
    const contextualMessage = `${personaPrefix}\n${body}`;

    const result = await executeAgent({
      message: contextualMessage,
      conversationId: `whatsapp_${from}`,
      clientIp: "whatsapp",
      userProfile,
      userToneInstruction
    });
    console.log(`🤖 [WhatsApp] Pipeline complete — tool: ${result.tool}, success: ${result.success}`);

    // ── Intercept email drafts: save state so "send it" works ──
    const pendingEmail = result?.data?.pendingEmail;
    if (pendingEmail && pendingEmail.to) {
      console.log(`📧 [WhatsApp] Email draft detected → saving state for confirmation`);
      setState(from, "awaiting_email_confirm", { draft: pendingEmail });
      const draftMsg = `📧 *Email Draft:*\n*To:* ${pendingEmail.to}\n*Subject:* ${pendingEmail.subject || "(no subject)"}\n*Message:*\n${pendingEmail.body || "(empty)"}\n\nSay *"send it"* to confirm, or *"cancel"* to discard.`;
      await sendWhatsAppMessage(from, draftMsg);
      return;
    }

    // Extract response text
    let responseText =
      result?.data?.plain ||
      result?.data?.text ||
      result?.reply ||
      "I processed your request but couldn't generate a response.";

    // Strip HTML for WhatsApp
    responseText = stripHtmlToPlain(responseText);

    // WhatsApp 4096 char limit
    if (responseText.length > 4000) {
      responseText = responseText.slice(0, 4000) + "\n\n... (truncated)";
    }

    const sendResult = await sendWhatsAppMessage(from, responseText);
    if (sendResult.success) {
      console.log(`✅ [WhatsApp] Replied to ${contactName} (${from}) — ${responseText.length} chars`);
    } else {
      console.error(`❌ [WhatsApp] Failed to reply: ${sendResult.error}`);
    }

  } catch (err) {
    console.error("❌ [WhatsApp] Agent pipeline error:", err.message);
    console.error(err.stack);
  }
});

export default router;

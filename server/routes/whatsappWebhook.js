// server/routes/whatsappWebhook.js
// WhatsApp Business Cloud API webhook — receives incoming messages from Meta
// TWO-WAY LOOP: incoming message → agent pipeline → auto-reply via WhatsApp
// STATEFUL CONVERSATIONS: greeting, weather, news categories, calendar, tasks

import express from "express";
import { getState, setState, clearState } from "../utils/whatsappState.js";

const router = express.Router();

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
    if (message.type !== "text") {
      console.log(`📱 [WhatsApp] Received ${message.type} (non-text) — skipping`);
      return;
    }

    const messageId = message.id;
    const from = message.from;
    const body = message.text?.body || "";
    const contactName = value?.contacts?.[0]?.profile?.name || "Unknown";
    const timestamp = new Date(parseInt(message.timestamp) * 1000).toLocaleString();

    // ── DUPLICATE GUARD ──
    if (processedMessages.has(messageId)) {
      console.log(`📱 [WhatsApp] Duplicate ${messageId} — skipping`);
      return;
    }
    trackMessage(messageId);

    // ── LOOP GUARD ──
    const botNumber = process.env.WHATSAPP_BOT_NUMBER || process.env.WHATSAPP_PHONE_ID;
    if (from === botNumber) {
      console.log("[WhatsApp] Skipping self-sent (loop guard)");
      return;
    }

    // ── EMPTY GUARD ──
    if (!body.trim()) return;

    console.log("\n" + "─".repeat(60));
    console.log(`📱 [WhatsApp] From: ${contactName} (${from}) → "${body}"`);
    console.log("─".repeat(60));

    const { sendWhatsAppMessage } = await import("../tools/whatsapp.js");
    const lower = body.trim().toLowerCase();

    // ──────────────────────────────────────────────────────
    // STATEFUL CONVERSATION: Check if user is mid-flow
    // ──────────────────────────────────────────────────────
    const convState = getState(from);

    if (convState?.state === "awaiting_news_category") {
      console.log(`📱 [WhatsApp] Continuing news flow: category = "${body.trim()}"`);
      clearState(from);
      try {
        const TOOLS = await loadTools();
        const category = body.trim();
        const result = await TOOLS.news({ text: `${category} news`, context: {} });
        const formatted = formatNewsWA(result, `${category} News`);
        await sendWhatsAppMessage(from, formatted);
      } catch (e) {
        await sendWhatsAppMessage(from, `❌ Could not fetch news: ${e.message}`);
      }
      return;
    }

    // ── STATEFUL: Email confirmation ("send it" / "cancel") ──
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
    // GREETING: hi/hello/morning → comprehensive response
    // ──────────────────────────────────────────────────────
    if (/^(hi|hello|hey|morning|good\s+morning|good\s+evening|good\s+afternoon|בוקר\s+טוב|שלום|ערב\s+טוב)\b/i.test(lower) && lower.length < 40) {
      console.log(`📱 [WhatsApp] Greeting detected → comprehensive response`);
      try {
        const TOOLS = await loadTools();
        const city = await getSavedCity();
        const parts = ["👋 *Good day!*\n"];

        // Weather
        try {
          const weatherResult = await TOOLS.weather({ text: "weather today", context: { city: city || "__USE_GEOLOCATION__" } });
          parts.push(formatWeatherWA(weatherResult));
        } catch { parts.push("🌤️ Weather: unavailable"); }

        // Tech news (4 links)
        try {
          const techNews = await TOOLS.news({ text: "latest technology news", context: {} });
          const items = techNews?.data?.items || techNews?.data?.articles || [];
          if (items.length > 0) {
            parts.push("\n📱 *Tech News*");
            items.slice(0, 4).forEach((item, i) => {
              parts.push(`${i + 1}. ${item.title || "Untitled"}${item.link ? `\n   ${item.link}` : ""}`);
            });
          }
        } catch { /* skip */ }

        // Regional news (6 links)
        try {
          const regionalNews = await TOOLS.news({ text: "Israel news", context: {} });
          const items = regionalNews?.data?.items || regionalNews?.data?.articles || [];
          if (items.length > 0) {
            parts.push("\n🌍 *Regional News*");
            items.slice(0, 6).forEach((item, i) => {
              parts.push(`${i + 1}. ${item.title || "Untitled"}${item.link ? `\n   ${item.link}` : ""}`);
            });
          }
        } catch { /* skip */ }

        // X Trends (if available)
        try {
          const { CONFIG } = await import("../utils/config.js");
          if (CONFIG.isXAvailable()) {
            const xResult = await TOOLS.x({ text: "trending", context: { action: "trends" } });
            if (xResult?.success && xResult?.data?.raw?.trends?.length > 0) {
              parts.push("\n🔥 *Trending on X*");
              xResult.data.raw.trends.slice(0, 5).forEach(t => {
                parts.push(`• ${t.name}`);
              });
            }
          }
        } catch { /* skip */ }

        const greeting = parts.join("\n");
        await sendWhatsAppMessage(from, greeting.length > 4000 ? greeting.slice(0, 4000) + "\n..." : greeting);
      } catch (e) {
        console.error("[WhatsApp] Greeting response error:", e.message);
        await sendWhatsAppMessage(from, "👋 Hello! I'm your AI assistant. How can I help?");
      }
      return;
    }

    // ──────────────────────────────────────────────────────
    // WEATHER: direct weather queries
    // ──────────────────────────────────────────────────────
    if (/\b(weather|forecast|temperature|מזג\s+אוויר|what'?s?\s+the\s+weather)\b/i.test(lower)) {
      console.log(`📱 [WhatsApp] Weather query detected`);
      try {
        const TOOLS = await loadTools();
        const city = await getSavedCity();
        const result = await TOOLS.weather({ text: body, context: { city: city || "__USE_GEOLOCATION__" } });
        await sendWhatsAppMessage(from, formatWeatherWA(result));
      } catch (e) {
        await sendWhatsAppMessage(from, `❌ Weather error: ${e.message}`);
      }
      return;
    }

    // ──────────────────────────────────────────────────────
    // NEWS: show categories → stateful flow
    // ──────────────────────────────────────────────────────
    if (/\b(news|חדשות|latest\s+news|headlines|what'?s?\s+happening)\b/i.test(lower) &&
        !/\b(tech|technology|sport|business|science|world|israel)\b/i.test(lower)) {
      console.log(`📱 [WhatsApp] News query → showing categories`);
      setState(from, "awaiting_news_category");
      await sendWhatsAppMessage(from,
        "📰 *News Categories*\n\n" +
        "1️⃣ Technology\n" +
        "2️⃣ Business\n" +
        "3️⃣ Sports\n" +
        "4️⃣ Science\n" +
        "5️⃣ World\n" +
        "6️⃣ Israel\n\n" +
        "Reply with a category name:"
      );
      return;
    }

    // News with specific category (direct)
    if (/\b(tech|technology|sport|business|science|world|israel)\s*(news|headlines)?\b/i.test(lower)) {
      console.log(`📱 [WhatsApp] Specific news category detected`);
      try {
        const TOOLS = await loadTools();
        const category = lower.match(/\b(tech|technology|sport|business|science|world|israel)\b/i)?.[0] || "general";
        const result = await TOOLS.news({ text: `${category} news`, context: {} });
        await sendWhatsAppMessage(from, formatNewsWA(result, `${category} News`));
      } catch (e) {
        await sendWhatsAppMessage(from, `❌ News error: ${e.message}`);
      }
      return;
    }

    // ──────────────────────────────────────────────────────
    // CALENDAR: set/schedule/book events
    // ──────────────────────────────────────────────────────
    if (/\b(set|schedule|book|appointment|meeting|conference|event|פגישה|תזכורת)\b/i.test(lower) &&
        /\b(at|on|for|ב|ל)\b/i.test(lower)) {
      console.log(`📱 [WhatsApp] Calendar intent detected`);
      try {
        const TOOLS = await loadTools();
        const result = await TOOLS.calendar({ text: body, context: {} });
        await sendWhatsAppMessage(from, formatCalendarWA(result));
      } catch (e) {
        await sendWhatsAppMessage(from, `❌ Calendar error: ${e.message}`);
      }
      return;
    }

    // ──────────────────────────────────────────────────────
    // TASKS: add/list/mark/remove tasks
    // ──────────────────────────────────────────────────────
    if (/\b(add\s+task|my\s+tasks|current\s+tasks|mark.*done|remove.*task|tasks?\s+due|what\s+tasks|todo|to-do)\b/i.test(lower)) {
      console.log(`📱 [WhatsApp] Task intent detected`);
      try {
        const TOOLS = await loadTools();
        const result = await TOOLS.tasks({ text: body, context: {} });
        await sendWhatsAppMessage(from, formatTasksWA(result));
      } catch (e) {
        await sendWhatsAppMessage(from, `❌ Task error: ${e.message}`);
      }
      return;
    }

    // ──────────────────────────────────────────────────────
    // GENERIC: Route through full agent pipeline (fallback)
    // ──────────────────────────────────────────────────────
    console.log(`🤖 [WhatsApp] Routing through agent pipeline: "${body.slice(0, 60)}..."`);

    const { executeAgent } = await import("../utils/coordinator.js");

    const result = await executeAgent({
      message: body,
      conversationId: `whatsapp_${from}`,
      clientIp: "whatsapp"
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

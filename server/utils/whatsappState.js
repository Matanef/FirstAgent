// server/utils/whatsappState.js
// Stateful conversation tracker for WhatsApp bot
// Tracks per-phone-number conversation state with automatic TTL expiry
// Also tracks 24-hour messaging windows per the WhatsApp Business API rules

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const conversations = new Map(); // phone → { state, data, timestamp }
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

// ── 24-hour conversation window tracker ──
// WhatsApp Business API only allows freeform messages within 24h of the user's last inbound message.
// Outside this window, only pre-approved template messages can be sent.
// PERSISTED TO DISK so server restarts don't lose window state.
const WINDOWS_FILE = path.resolve(__dirname, "..", "..", "data", "whatsapp_windows.json");
const conversationWindows = new Map(); // phone → lastInboundTimestamp (ms)
const WINDOW_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Load persisted windows on startup
try {
  if (fs.existsSync(WINDOWS_FILE)) {
    const data = JSON.parse(fs.readFileSync(WINDOWS_FILE, "utf8"));
    const now = Date.now();
    for (const [phone, ts] of Object.entries(data)) {
      if (now - ts < WINDOW_DURATION) {
        conversationWindows.set(phone, ts);
      }
    }
    console.log(`📱 [WhatsApp] Loaded ${conversationWindows.size} active conversation windows from disk`);
  }
} catch (e) {
  console.warn("[whatsappState] Could not load persisted windows:", e.message);
}

function persistWindows() {
  try {
    const dir = path.dirname(WINDOWS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(conversationWindows);
    fs.writeFileSync(WINDOWS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.warn("[whatsappState] Could not persist windows:", e.message);
  }
}

export function getState(phone) {
  const conv = conversations.get(phone);
  if (!conv || Date.now() - conv.timestamp > STATE_TTL) {
    if (conv) conversations.delete(phone); // cleanup expired
    return null;
  }
  return conv;
}

export function setState(phone, state, data = {}) {
  conversations.set(phone, { state, data, timestamp: Date.now() });
}

export function clearState(phone) {
  conversations.delete(phone);
}

/**
 * Record that a user sent us a message — opens/refreshes the 24h conversation window.
 */
export function touchConversationWindow(phone) {
  conversationWindows.set(phone, Date.now());
  persistWindows();
}

/**
 * Check if a phone number has an active 24h conversation window.
 * @returns {{ open: boolean, remainingMs: number }}
 */
export function getConversationWindow(phone) {
  const lastInbound = conversationWindows.get(phone);
  if (!lastInbound) return { open: false, remainingMs: 0 };
  const elapsed = Date.now() - lastInbound;
  if (elapsed >= WINDOW_DURATION) {
    conversationWindows.delete(phone); // cleanup expired
    return { open: false, remainingMs: 0 };
  }
  return { open: true, remainingMs: WINDOW_DURATION - elapsed };
}

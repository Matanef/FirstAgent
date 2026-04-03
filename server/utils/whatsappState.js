// server/utils/whatsappState.js
// Stateful conversation tracker for WhatsApp bot
// Tracks per-phone-number conversation state with automatic TTL expiry
// Also tracks 24-hour messaging windows per the WhatsApp Business API rules

const conversations = new Map(); // phone → { state, data, timestamp }
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

// ── 24-hour conversation window tracker ──
// WhatsApp Business API only allows freeform messages within 24h of the user's last inbound message.
// Outside this window, only pre-approved template messages can be sent.
const conversationWindows = new Map(); // phone → lastInboundTimestamp (ms)
const WINDOW_DURATION = 24 * 60 * 60 * 1000; // 24 hours

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

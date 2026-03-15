// server/utils/whatsappState.js
// Stateful conversation tracker for WhatsApp bot
// Tracks per-phone-number conversation state with automatic TTL expiry

const conversations = new Map(); // phone → { state, data, timestamp }
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

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

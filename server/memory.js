// server/memory.js

import fs from "fs";
import path from "path";

/**
 * Load JSON from disk safely.
 */
export function loadJSON(filePath, defaultValue = {}) {
  try {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      return defaultValue;
    }

    const raw = fs.readFileSync(absolutePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error loading JSON:", err.message);
    return defaultValue;
  }
}

/**
 * Save JSON to disk safely.
 */
export function saveJSON(filePath, data) {
  try {
    const absolutePath = path.resolve(filePath);
    fs.writeFileSync(absolutePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving JSON:", err.message);
  }
}

const MEMORY_FILE = "./memory.json";
const DEFAULT_MEMORY = {
  conversations: {},
  profile: {},
  meta: {}
};

/**
 * Append a message to a conversation, keeping only the last `limit` messages.
 */
export function appendConversationMessage(conversationId, role, content, limit = 20) {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  if (!memory.conversations) memory.conversations = {};
  if (!memory.conversations[conversationId]) {
    memory.conversations[conversationId] = [];
  }

  memory.conversations[conversationId].push({
    role,
    content,
    ts: Date.now()
  });

  // Keep only the last `limit` messages
  if (memory.conversations[conversationId].length > limit) {
    memory.conversations[conversationId] =
      memory.conversations[conversationId].slice(-limit);
  }

  saveJSON(MEMORY_FILE, memory);
}

/**
 * Update long-term user profile memory based on explicit instructions.
 * Option 2: only when the user clearly asks to remember/store.
 */
export function updateProfileMemory(message) {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
  memory.profile ??= {};
  const lower = message.toLowerCase();

  // Explicit name storage only
  // Examples:
  // "remember my name is Matan"
  // "remember that my name is Matan"
  // "store my name: Matan"
  // "save my name as Matan"
  const namePatterns = [
    /remember (that )?my name is ([a-zA-Z]+)/i,
    /store my name[: ]+([a-zA-Z]+)/i,
    /save my name as ([a-zA-Z]+)/i
  ];

  for (const pattern of namePatterns) {
    const match = message.match(pattern);
    if (match && match[2]) {
      memory.profile.name = match[2];
    } else if (match && match[1]) {
      // some patterns capture in group 1
      memory.profile.name = match[1];
    }
  }

  // Tone preferences (explicit)
  if (lower.includes("remember that i like a warm tone") ||
      lower.includes("remember i like a warm tone")) {
    memory.profile.tone = "warm";
  }
  if (lower.includes("remember that i prefer a professional tone") ||
      lower.includes("remember i prefer a professional tone")) {
    memory.profile.tone = "professional";
  }

  // Detail preferences
  if (lower.includes("remember that i like detailed answers") ||
      lower.includes("remember i like detailed answers")) {
    memory.profile.detail = "high";
  }
  if (lower.includes("remember that i like short answers") ||
      lower.includes("remember i like short answers")) {
    memory.profile.detail = "low";
  }

  // Math preferences
  if (lower.includes("remember that i like math steps") ||
      lower.includes("remember i like math steps")) {
    memory.profile.math_steps = true;
  }
  if (lower.includes("remember that i don't want math steps") ||
      lower.includes("remember i dont want math steps") ||
      lower.includes("remember i just want the answer")) {
    memory.profile.math_steps = false;
  }

  // Formatting preferences
  if (lower.includes("remember that i prefer tables") ||
      lower.includes("remember i prefer tables")) {
    memory.profile.format = "table";
  }
  if (lower.includes("remember that i prefer bullet points") ||
      lower.includes("remember i prefer bullet points") ||
      lower.includes("remember i prefer bullets")) {
    memory.profile.format = "bullets";
  }

  saveJSON(MEMORY_FILE, memory);
}

/**
 * Helper to get full memory object.
 */
export function getMemory() {
  return loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
}
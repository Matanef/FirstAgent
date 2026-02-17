// server/memory.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Single source of truth for memory file
export const MEMORY_FILE = path.resolve(__dirname, "..", "utils", "memory.json");

export const DEFAULT_MEMORY = {
  conversations: {},
  profile: {},
  meta: {}
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureMemoryDirAndFile() {
  const dir = path.dirname(MEMORY_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(DEFAULT_MEMORY, null, 2));
  }
}

function validateMemoryShape(raw) {
  const safe = clone(DEFAULT_MEMORY);

  if (raw && typeof raw === "object") {
    if (raw.conversations && typeof raw.conversations === "object") {
      safe.conversations = raw.conversations;
    }
    if (raw.profile && typeof raw.profile === "object") {
      safe.profile = raw.profile;
    }
    if (raw.meta && typeof raw.meta === "object") {
      safe.meta = raw.meta;
    }
  }

  return safe;
}

// ------------------------------
// Safe loader
// ------------------------------
export function loadJSON(filePath = MEMORY_FILE, defaultValue = DEFAULT_MEMORY) {
  try {
    ensureMemoryDirAndFile();

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);

    return validateMemoryShape(parsed);
  } catch (err) {
    console.error("Error loading JSON:", err.message);
    return clone(defaultValue);
  }
}

// ------------------------------
// Safe saver
// ------------------------------
export function saveJSON(filePath = MEMORY_FILE, data) {
  try {
    ensureMemoryDirAndFile();

    const safeData = validateMemoryShape(data);
    fs.writeFileSync(filePath, JSON.stringify(safeData, null, 2));
  } catch (err) {
    console.error("Error saving JSON:", err.message);
  }
}

// ------------------------------
// Get memory (safe)
// ------------------------------
export function getMemory() {
  return loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
}

// ------------------------------
// Optional helper: append message
// ------------------------------
export function appendConversationMessage(conversationId, role, content) {
  const memory = getMemory();

  memory.conversations[conversationId] ??= [];

  memory.conversations[conversationId].push({
    role,
    content,
    ts: Date.now()
  });

  saveJSON(MEMORY_FILE, memory);
}

// ------------------------------
// Optional helper: profile update
// (not used by index.js anymore, but kept for tools)
// ------------------------------
export function updateProfileMemory(message) {
  const memory = getMemory();
  const lower = message.toLowerCase();

  if (lower.startsWith("remember my name is ")) {
    memory.profile.name = message.substring("remember my name is ".length).trim();
  }

  if (lower.startsWith("remember that my name is ")) {
    memory.profile.name = message.substring("remember that my name is ".length).trim();
  }

  saveJSON(MEMORY_FILE, memory);
}
// Clear only location from profile
export function clearLocation() {
  const memory = getMemory();
  if (memory.profile && memory.profile.location) {
    delete memory.profile.location;
    saveJSON(MEMORY_FILE, memory);
    console.log("🧹 Cleared profile.location from memory");
  }
}

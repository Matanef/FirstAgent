// server/memory.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FINAL FIX: always points to local-llm-ui/utils/memory.json

export const MEMORY_FILE = path.resolve(__dirname, "..", "utils", "memory.json");
console.log("USING MEMORY FILE:", MEMORY_FILE);

export const DEFAULT_MEMORY = {
  conversations: {},
  profile: {},
  meta: {}
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureMemoryDir() {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadJSON(filePath = MEMORY_FILE, defaultValue = DEFAULT_MEMORY) {
  try {
    ensureMemoryDir();

    if (!fs.existsSync(filePath)) {
      return clone(defaultValue);
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      conversations: parsed.conversations ?? {},
      profile: parsed.profile ?? {},
      meta: parsed.meta ?? {}
    };
  } catch (err) {
    console.error("Error loading JSON:", err.message);
    return clone(defaultValue);
  }
}

export function saveJSON(filePath = MEMORY_FILE, data) {
  try {
    ensureMemoryDir();

    const safeData = {
      conversations: data.conversations ?? {},
      profile: data.profile ?? {},
      meta: data.meta ?? {}
    };

    fs.writeFileSync(filePath, JSON.stringify(safeData, null, 2));
  } catch (err) {
    console.error("Error saving JSON:", err.message);
  }
}

export function getMemory() {
  return loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
}

export function appendConversationMessage(conversationId, role, content) {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  memory.conversations[conversationId] ??= [];

  memory.conversations[conversationId].push({
    role,
    content,
    ts: Date.now()
  });

  saveJSON(MEMORY_FILE, memory);
}

export function updateProfileMemory(message) {
  const memory = loadJSON(MEMORY_FILE, DEFAULT_MEMORY);

  const lower = message.toLowerCase();

  if (lower.startsWith("remember my name is ")) {
    const name = message.substring("remember my name is ".length).trim();
    memory.profile.name = name;
  }

  if (lower.startsWith("remember that my name is ")) {
    const name = message.substring("remember that my name is ".length).trim();
    memory.profile.name = name;
  }

  saveJSON(MEMORY_FILE, memory);
}
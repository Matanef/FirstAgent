// server/memory.js
// Robust async memory layer with atomic writes, caching, and a simple in-process mutex.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── SECURITY: Optional encryption at rest for memory.json ──
// Set MEMORY_ENCRYPTION_KEY in .env (must be exactly 32 hex chars = 16 bytes, or 64 hex = 32 bytes)
// If unset, memory is stored in plaintext (backwards compatible).
const ENCRYPTION_KEY = process.env.MEMORY_ENCRYPTION_KEY
  ? Buffer.from(process.env.MEMORY_ENCRYPTION_KEY, "hex")
  : null;

if (ENCRYPTION_KEY && ![16, 32].includes(ENCRYPTION_KEY.length)) {
  console.error("⚠️  [memory] MEMORY_ENCRYPTION_KEY must be 32 or 64 hex chars. Encryption DISABLED.");
}

const ALGO = "aes-256-gcm";

function encryptString(plaintext) {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `ENC:${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decryptString(ciphertext) {
  if (!ciphertext || !ciphertext.startsWith("ENC:")) return ciphertext;
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
    console.warn("⚠️  [memory] Found encrypted data but no valid MEMORY_ENCRYPTION_KEY set");
    return ciphertext; // Return raw — caller will see ENC: prefix
  }
  try {
    const parts = ciphertext.split(":");
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const data = parts[3];
    const decipher = crypto.createDecipheriv(ALGO, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(data, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    console.warn("⚠️  [memory] Decryption failed:", e.message);
    return ciphertext;
  }
}

export const MEMORY_FILE = path.resolve(__dirname, "..", "utils", "memory.json");
export const DEFAULT_MEMORY = { conversations: {}, profile: {}, durable: [], meta: {} };

// In-memory cache and simple mutex queue
let _cache = null;
let _cacheMtime = 0;
let _locked = false;
const _queue = [];

async function _acquireLock() {
  if (!_locked) {
    _locked = true;
    return;
  }
  await new Promise((resolve) => _queue.push(resolve));
  _locked = true;
}
function _releaseLock() {
  _locked = false;
  const next = _queue.shift();
  if (next) next();
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureMemoryDirAndFileSync() {
  const dir = path.dirname(MEMORY_FILE);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  if (!fsSync.existsSync(MEMORY_FILE)) {
    fsSync.writeFileSync(MEMORY_FILE, JSON.stringify(DEFAULT_MEMORY, null, 2), "utf8");
  }
}

async function _readFileSafe(file) {
  try {
    ensureMemoryDirAndFileSync();
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function validateMemoryShape(raw) {
  const safe = clone(DEFAULT_MEMORY);
  if (raw && typeof raw === "object") {
    if (raw.conversations && typeof raw.conversations === "object") safe.conversations = raw.conversations;

    // ── SECURITY: Decrypt encrypted fields on load ──
    if (raw.profile && typeof raw.profile === "object") {
      if (raw.profile._encrypted) {
        try {
          safe.profile = JSON.parse(decryptString(raw.profile._encrypted));
        } catch { safe.profile = {}; }
      } else {
        safe.profile = raw.profile;
      }
    }
    if (Array.isArray(raw.durable)) {
      if (raw.durable.length === 1 && raw.durable[0]?._encrypted) {
        try {
          safe.durable = JSON.parse(decryptString(raw.durable[0]._encrypted));
        } catch { safe.durable = []; }
      } else {
        safe.durable = raw.durable;
      }
    }
    if (raw.meta && typeof raw.meta === "object") safe.meta = raw.meta;
  }
  return safe;
}

export async function loadJSON(file = MEMORY_FILE, fallback = DEFAULT_MEMORY) {
  const data = await _readFileSafe(file);
  return validateMemoryShape(data || fallback);
}

export async function saveJSON(file = MEMORY_FILE, obj) {
  await _acquireLock();
  try {
    ensureMemoryDirAndFileSync();
    const tmp = `${file}.tmp.${Date.now()}`;
    const safeData = validateMemoryShape(obj);
    // ── SECURITY: Encrypt sensitive fields before writing to disk ──
    if (ENCRYPTION_KEY && ENCRYPTION_KEY.length === 32) {
      if (safeData.profile && Object.keys(safeData.profile).length > 0) {
        safeData.profile = { _encrypted: encryptString(JSON.stringify(safeData.profile)) };
      }
      if (Array.isArray(safeData.durable) && safeData.durable.length > 0) {
        safeData.durable = [{ _encrypted: encryptString(JSON.stringify(safeData.durable)) }];
      }
    }
    const data = JSON.stringify(safeData, null, 2);
    await fs.writeFile(tmp, data, "utf8");
    // Windows EPERM workaround: retry rename up to 3 times with small delay
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (renameErr) {
        if (renameErr.code === "EPERM" && attempt < 2) {
          await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        // Clean up tmp file on final failure
        try { await fs.unlink(tmp); } catch { /* ignore */ }
        throw renameErr;
      }
    }
    _cache = safeData;
    _cacheMtime = Date.now();
    console.log(`[memory] saveJSON succeeded: ${file} (${new Date().toISOString()})`);
    return true;
  } catch (err) {
    console.error("[memory] saveJSON failed:", err);
    throw err;
  } finally {
    _releaseLock();
  }
}

export async function reloadMemory() {
  await _acquireLock();
  try {
    const data = await loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
    _cache = data;
    _cacheMtime = Date.now();
    console.log("[memory] reloadMemory loaded from disk");
    return _cache;
  } finally {
    _releaseLock();
  }
}

export async function getMemory() {
  if (_cache) return _cache;
  const data = await loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
  _cache = data;
  _cacheMtime = Date.now();
  console.log("[memory] getMemory loaded into cache");
  return _cache;
}

/**
 * Run a function while holding the memory lock to avoid races.
 * Example:
 * await withMemoryLock(async () => {
 *   const memory = await getMemory();
 *   memory.profile.foo = 'bar';
 *   await saveJSON(MEMORY_FILE, memory);
 * });
 */
export async function withMemoryLock(fn) {
  await _acquireLock();
  try {
    return await fn();
  } finally {
    _releaseLock();
  }
}

// ----------------------
// Convenience helpers
// ----------------------

export async function getProfile() {
  const mem = await getMemory();
  return mem.profile || {};
}

/**
 * Returns an enriched profile for conversational mode.
 * Includes profile fields + recent conversation themes + interaction stats.
 * Used by executor.js when planner detects personal/emotional messages.
 */
export async function getEnrichedProfile(conversationId) {
  const mem = await getMemory();
  const profile = mem.profile || {};
  const conversations = mem.conversations || {};
  const convo = conversationId ? (conversations[conversationId] || []) : [];

  // Count total interactions across all conversations
  let totalInteractions = 0;
  let firstSeen = null;
  for (const [, msgs] of Object.entries(conversations)) {
    if (Array.isArray(msgs)) {
      totalInteractions += msgs.filter(m => m.role === "user").length;
      for (const m of msgs) {
        if (m.timestamp && (!firstSeen || m.timestamp < firstSeen)) {
          firstSeen = m.timestamp;
        }
      }
    }
  }

  // Extract recent topics from last 15 user messages in current conversation
  const recentTopics = convo
    .filter(m => m.role === "user")
    .slice(-15)
    .map(m => (m.content || "").substring(0, 100));

  // Gather durable memory entries (things the user explicitly asked to remember)
  const durableMemories = (mem.durable || []).slice(-10);

  return {
    ...profile,
    _enriched: true,
    _stats: {
      totalInteractions,
      currentConversationLength: convo.length,
      firstSeen: firstSeen || null,
      conversationCount: Object.keys(conversations).length,
    },
    _recentTopics: recentTopics,
    _durableMemories: durableMemories,
  };
}

export async function setProfileField(fieldPath, value) {
  return await withMemoryLock(async () => {
    const mem = await getMemory();
    mem.profile = mem.profile || {};
    const parts = fieldPath.split(".");
    let cur = mem.profile;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      cur[p] = cur[p] || {};
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (typeof value === "undefined") {
      // delete if undefined
      if (cur && Object.prototype.hasOwnProperty.call(cur, last)) delete cur[last];
    } else {
      cur[last] = value;
    }
    mem.meta = mem.meta || {};
    mem.meta.lastUpdated = new Date().toISOString();
    await saveJSON(MEMORY_FILE, mem);
    return mem;
  });
}

export async function addOrUpdateContact(key, contactObj) {
  return await withMemoryLock(async () => {
    const mem = await getMemory();
    mem.profile = mem.profile || {};
    mem.profile.contacts = mem.profile.contacts || {};
    const now = new Date().toISOString();
    mem.profile.contacts[key] = Object.assign({}, mem.profile.contacts[key] || {}, contactObj, { lastUpdated: now });
    mem.meta = mem.meta || {};
    mem.meta.lastUpdated = now;
    await saveJSON(MEMORY_FILE, mem);
    return mem.profile.contacts[key];
  });
}

export async function deleteContact(key) {
  return await withMemoryLock(async () => {
    const mem = await getMemory();
    if (mem.profile?.contacts && mem.profile.contacts[key]) {
      delete mem.profile.contacts[key];
      mem.meta = mem.meta || {};
      mem.meta.lastUpdated = new Date().toISOString();
      await saveJSON(MEMORY_FILE, mem);
      return true;
    }
    return false;
  });
}

export async function listContacts() {
  const mem = await getMemory();
  return mem.profile?.contacts || {};
}
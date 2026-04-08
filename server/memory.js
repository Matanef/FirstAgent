// server/memory.js
// Robust async memory layer with atomic writes, caching, native cloning, and a simple in-process mutex.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MEMORY_FILE = path.resolve(__dirname, "..", "utils", "memory.json");
export const DEFAULT_MEMORY = { conversations: {}, profile: {}, durable: [], meta: {} };

// ── SECURITY: Centralized Encryption Layer ──
const ENCRYPTION_KEY = process.env.MEMORY_ENCRYPTION_KEY
  ? Buffer.from(process.env.MEMORY_ENCRYPTION_KEY, "hex")
  : null;

const IS_ENCRYPTION_ENABLED = ENCRYPTION_KEY && ENCRYPTION_KEY.length === 32;
if (process.env.MEMORY_ENCRYPTION_KEY && !IS_ENCRYPTION_ENABLED) {
  console.error("⚠️ [memory] MEMORY_ENCRYPTION_KEY must be exactly 64 hex characters. Encryption DISABLED.");
}

const ALGO = "aes-256-gcm";

function encryptString(plaintext) {
  if (!IS_ENCRYPTION_ENABLED) return plaintext;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    return `ENC:${iv.toString("hex")}:${tag}:${encrypted}`;
  } catch (err) {
    console.error("🔴 [memory] Encryption failed:", err.message);
    throw new Error("Failed to encrypt memory payload.");
  }
}

function decryptString(ciphertext) {
  if (!ciphertext || !ciphertext.startsWith("ENC:")) return ciphertext;
  if (!IS_ENCRYPTION_ENABLED) {
    console.warn("⚠️ [memory] Found encrypted data but no valid MEMORY_ENCRYPTION_KEY set");
    return ciphertext; 
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
    console.warn("⚠️ [memory] Decryption failed. Returning raw ciphertext.", e.message);
    return ciphertext;
  }
}

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

// SAFETY: JSON round-trip instead of structuredClone — silently drops non-serializable
// values (Promises, functions, circular refs) that leak in from tool results saved
// into memory.conversations.  structuredClone throws on those.
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const BACKUP_FILE = MEMORY_FILE + ".bak";

function ensureMemoryDirAndFileSync() {
  try {
    const dir = path.dirname(MEMORY_FILE);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    if (!fsSync.existsSync(MEMORY_FILE)) {
      // Main file is missing — try to restore from backup before creating empty default
      if (fsSync.existsSync(BACKUP_FILE)) {
        try {
          const backupData = fsSync.readFileSync(BACKUP_FILE, "utf8");
          const parsed = JSON.parse(backupData);
          // Sanity check: backup has real data (not empty default)
          const hasData = Object.keys(parsed.conversations || {}).length > 0 ||
                          Object.keys(parsed.profile || {}).length > 0;
          if (hasData) {
            fsSync.writeFileSync(MEMORY_FILE, backupData, "utf8");
            console.warn("🔧 [memory] Restored from backup file (main file was missing)");
            return;
          }
        } catch (backupErr) {
          console.warn("⚠️ [memory] Backup exists but is unreadable:", backupErr.message);
        }
      }
      console.warn("⚠️ [memory] No main file or backup found — creating empty default");
      fsSync.writeFileSync(MEMORY_FILE, JSON.stringify(DEFAULT_MEMORY, null, 2), "utf8");
    }
  } catch (err) {
    console.error("🔴 [memory] Failed to ensure directory/file exists:", err.message);
  }
}

async function _readFileSafe(file) {
  try {
    ensureMemoryDirAndFileSync();
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`⚠️ [memory] Read failed, returning null: ${e.message}`);
    return null;
  }
}

function validateMemoryShape(raw) {
  const safe = clone(DEFAULT_MEMORY);
  if (raw && typeof raw === "object") {
    if (raw.conversations && typeof raw.conversations === "object") safe.conversations = raw.conversations;

    if (raw.profile && typeof raw.profile === "object") {
      if (raw.profile._encrypted) {
        try {
          safe.profile = JSON.parse(decryptString(raw.profile._encrypted));
        } catch {
          // Decryption failed (key missing/changed) — fall back to meta.original
          if (raw.meta?.original) {
            console.warn("⚠️ [memory] Profile decryption failed — using meta.original fallback");
            safe.profile = clone(raw.meta.original);
          } else {
            safe.profile = {};
          }
        }
      } else {
        safe.profile = raw.profile;
      }
      // Merge meta.original into profile if profile is missing core fields
      // This heals profiles that were encrypted after data was wiped
      if (raw.meta?.original?.self && !safe.profile.self) {
        console.log("🔧 [memory] Restoring profile.self from meta.original backup");
        safe.profile.self = clone(raw.meta.original.self);
      }
      if (raw.meta?.original?.contacts && !safe.profile.contacts) {
        console.log("🔧 [memory] Restoring profile.contacts from meta.original backup");
        safe.profile.contacts = clone(raw.meta.original.contacts);
      }
    }

    if (Array.isArray(raw.durable)) {
      if (raw.durable.length === 1 && raw.durable[0]?._encrypted) {
        try {
          safe.durable = JSON.parse(decryptString(raw.durable[0]._encrypted));
        } catch {
          // Decryption failed — check meta.original for durable backup
          if (raw.meta?.original?.durable) {
            console.warn("⚠️ [memory] Durable decryption failed — using meta.original fallback");
            safe.durable = Array.isArray(raw.meta.original.durable) ? raw.meta.original.durable : [];
          } else {
            safe.durable = [];
          }
        }
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

    // ── SAFETY: Back up current file before overwriting ──
    // If the rename/write fails mid-operation, we can recover from .bak on next boot.
    try {
      if (fsSync.existsSync(file)) {
        await fs.copyFile(file, BACKUP_FILE);
      }
    } catch (bakErr) {
      // Non-fatal — backup failure shouldn't block saves
      console.warn("⚠️ [memory] Backup copy failed:", bakErr.message);
    }

    const tmp = `${file}.tmp.${Date.now()}`;
    const safeData = validateMemoryShape(obj);

    // CRITICAL: Cache the plaintext BEFORE encryption so getMemory() returns usable data
    const plaintextForCache = clone(safeData);

    if (IS_ENCRYPTION_ENABLED) {
      if (safeData.profile && Object.keys(safeData.profile).length > 0) {
        safeData.profile = { _encrypted: encryptString(JSON.stringify(safeData.profile)) };
      }
      if (Array.isArray(safeData.durable) && safeData.durable.length > 0) {
        safeData.durable = [{ _encrypted: encryptString(JSON.stringify(safeData.durable)) }];
      }
    }

    const data = JSON.stringify(safeData, null, 2);
    await fs.writeFile(tmp, data, "utf8");
    
    // Windows EPERM workaround
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (renameErr) {
        if (renameErr.code === "EPERM" && attempt < 2) {
          await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        try { await fs.unlink(tmp); } catch { /* ignore */ }
        throw renameErr;
      }
    }
    _cache = plaintextForCache;
    _cacheMtime = Date.now();
    return true;
  } catch (err) {
    console.error("🔴 [memory] saveJSON failed:", err);
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
    return _cache;
  } finally {
    _releaseLock();
  }
}

export async function getMemory() {
  if (_cache) return _cache;
  return await reloadMemory();
}

export async function withMemoryLock(fn) {
  await _acquireLock();
  try {
    return await fn();
  } finally {
    _releaseLock();
  }
}

export async function getProfile() {
  const mem = await getMemory();
  return mem.profile || {};
}

export async function getEnrichedProfile(conversationId) {
  try {
    const mem = await getMemory();
    const profile = mem.profile || {};
    const conversations = mem.conversations || {};
    const convo = conversationId ? (conversations[conversationId] || []) : [];

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

    const recentTopics = convo.filter(m => m.role === "user").slice(-15).map(m => (m.content || "").substring(0, 100));
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
  } catch (err) {
    console.error("⚠️ [memory] getEnrichedProfile failed:", err);
    return {};
  }
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
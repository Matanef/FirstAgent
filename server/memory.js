// server/memory.js
// Robust async memory layer with atomic writes, caching, native cloning, and a simple in-process mutex.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "node:async_hooks";

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

// In-memory cache and a RE-ENTRANT mutex queue.
// Re-entrance (via AsyncLocalStorage) is critical because callers like
// setPendingQuestion / setProfileField wrap their work in withMemoryLock,
// and inside that wrapper they call saveJSON which ALSO acquires the lock.
// Without re-entrance, that second acquire deadlocks forever, stalling the
// entire turn (observed in Phase-4 ambiguity clarification flows).
let _cache = null;
let _cacheMtime = 0;
let _locked = false;
const _queue = [];
const _lockStorage = new AsyncLocalStorage();

/**
 * Acquire the memory lock.
 * Returns a token object you MUST pass back to _releaseLock(token).
 * If the current async context already holds the lock (re-entrant call),
 * we skip acquisition and return a sentinel so the nested _releaseLock is a no-op.
 */
async function _acquireLock() {
  const store = _lockStorage.getStore();
  if (store?.owned) {
    // Already held by this async chain — re-entrant, proceed without waiting.
    store.depth = (store.depth || 1) + 1;
    return { reentrant: true, store };
  }
  if (!_locked) {
    _locked = true;
  } else {
    await new Promise((resolve) => _queue.push(resolve));
    _locked = true;
  }
  // Mark this async context as the lock owner so nested calls can detect re-entrance.
  const newStore = { owned: true, depth: 1 };
  _lockStorage.enterWith(newStore);
  return { reentrant: false, store: newStore };
}

function _releaseLock(token) {
  // Back-compat: callers that haven't been updated still invoke _releaseLock()
  // with no token. Fall back to the current store.
  const store = token?.store || _lockStorage.getStore();
  if (!store) {
    // Unknown caller — legacy behaviour: release outright.
    _locked = false;
    const next = _queue.shift();
    if (next) next();
    return;
  }
  if (token?.reentrant) {
    store.depth = Math.max(0, (store.depth || 1) - 1);
    return;
  }
  store.depth = Math.max(0, (store.depth || 1) - 1);
  if (store.depth > 0) return;
  store.owned = false;
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

// ── ROTATING BACKUPS & DAILY SNAPSHOTS ──
const MAX_ROTATING_BACKUPS = 5;
const ROTATION_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes between rotations
let _lastRotation = 0;

/**
 * Rotate memory.json.bak.1 → .bak.2 → .bak.3 → .bak.4 → .bak.5 (oldest deleted)
 * Throttled to once every 5 minutes to avoid excessive I/O.
 */
async function rotateBackups(file) {
  const now = Date.now();
  if (now - _lastRotation < ROTATION_THROTTLE_MS) return;
  _lastRotation = now;

  try {
    // Delete the oldest backup
    const oldest = `${file}.bak.${MAX_ROTATING_BACKUPS}`;
    try { await fs.unlink(oldest); } catch {}

    // Shift existing backups: 4→5, 3→4, 2→3, 1→2
    for (let i = MAX_ROTATING_BACKUPS - 1; i >= 1; i--) {
      const src = `${file}.bak.${i}`;
      const dst = `${file}.bak.${i + 1}`;
      try { await fs.rename(src, dst); } catch {}
    }

    // Copy current file to .bak.1
    if (fsSync.existsSync(file)) {
      await fs.copyFile(file, `${file}.bak.1`);
    }
  } catch (err) {
    console.warn("⚠️ [memory] Backup rotation failed:", err.message);
  }
}

/**
 * Create a daily snapshot if one doesn't exist yet for today.
 * Cleans up snapshots older than 7 days.
 */
async function dailySnapshot(file) {
  try {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const snapshotPath = `${file}.daily.${today}`;

    if (fsSync.existsSync(snapshotPath)) return; // Already snapshotted today

    if (fsSync.existsSync(file)) {
      await fs.copyFile(file, snapshotPath);
      console.log(`📸 [memory] Daily snapshot created: ${path.basename(snapshotPath)}`);
    }

    // Clean up old snapshots (older than 7 days)
    const dir = path.dirname(file);
    const base = path.basename(file);
    const files = await fs.readdir(dir);
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    for (const f of files) {
      const dailyMatch = f.match(new RegExp(`^${base.replace(".", "\\.")}\\.daily\\.(\\d{4}-\\d{2}-\\d{2})$`));
      if (dailyMatch) {
        const snapshotDate = new Date(dailyMatch[1]).getTime();
        if (snapshotDate < sevenDaysAgo) {
          try {
            await fs.unlink(path.join(dir, f));
            console.log(`🗑️ [memory] Cleaned old snapshot: ${f}`);
          } catch {}
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ [memory] Daily snapshot failed:", err.message);
  }
}

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
  const _lockToken = await _acquireLock();
  try {
    ensureMemoryDirAndFileSync();

    // ── TRACE: Log every save call with caller info for debugging data loss ──
    const inConvos = Object.keys(obj?.conversations || {}).length;
    const inProfile = Object.keys(obj?.profile || {}).length;
    const hasEncProfile = !!(obj?.profile?._encrypted);
    const caller = new Error().stack?.split("\n")[2]?.trim() || "unknown";
    console.log(`💾 [memory] saveJSON called: ${inConvos} convos, profile(${hasEncProfile ? "enc" : inProfile + " keys"}) | from: ${caller}`);

    // ── DATA LOSS PREVENTION: Refuse to overwrite real data with empty data ──
    // This guards against stale _cache (empty) overwriting restored/real data on disk.
    // If the file on disk has profile or conversations but the incoming save has neither,
    // something went wrong (stale cache, race condition). Refuse the destructive write.
    try {
      if (fsSync.existsSync(file)) {
        const diskRaw = JSON.parse(fsSync.readFileSync(file, "utf8"));
        const diskConvos = Object.keys(diskRaw.conversations || {}).length;
        const diskHasProfile = diskRaw.profile && (
          diskRaw.profile._encrypted ||
          Object.keys(diskRaw.profile).length > 0
        );
        const incomingConvos = Object.keys(obj.conversations || {}).length;
        const incomingHasProfile = obj.profile && Object.keys(obj.profile).length > 0;

        // BLOCK: disk has real data, incoming would wipe or severely reduce it
        // Also catch partial wipes (e.g., 169 convos → 1 convo is suspicious)
        const convoDrop = diskConvos > 5 && incomingConvos < diskConvos * 0.5;
        if ((diskConvos > 0 && incomingConvos === 0) ||
            (diskHasProfile && !incomingHasProfile) ||
            convoDrop) {
          console.error(
            `🛑 [memory] DATA LOSS PREVENTED! Refusing to overwrite ${diskConvos} conversations + ` +
            `profile(${diskHasProfile ? "present" : "empty"}) with empty data. ` +
            `Incoming has ${incomingConvos} conversations, profile(${incomingHasProfile ? "present" : "empty"}). ` +
            `This usually means _cache was stale. Reloading from disk instead.`
          );
          // Heal the cache from disk so future saves include the real data
          const healed = await loadJSON(file);
          // Merge incoming meta updates (moltbook heartbeats, etc.) into the healed version
          if (obj.meta && typeof obj.meta === "object") {
            healed.meta = { ...healed.meta, ...obj.meta };
          }
          _cache = healed;
          _cacheMtime = Date.now();
          // Now save the HEALED version (real data + incoming meta)
          const healedStr = JSON.stringify(
            IS_ENCRYPTION_ENABLED ? (() => {
              const s = clone(healed);
              if (s.profile && Object.keys(s.profile).length > 0)
                s.profile = { _encrypted: encryptString(JSON.stringify(s.profile)) };
              if (Array.isArray(s.durable) && s.durable.length > 0)
                s.durable = [{ _encrypted: encryptString(JSON.stringify(s.durable)) }];
              return s;
            })() : healed,
            null, 2
          );
          const healTmp = `${file}.tmp.${Date.now()}`;
          await fs.writeFile(healTmp, healedStr, "utf8");
          try { await fs.rename(healTmp, file); } catch { try { await fs.unlink(healTmp); } catch {} }
          return true;
        }
      }
    } catch (dlpErr) {
      // If the DLP check itself fails, log but don't block — better to save than crash
      console.warn("⚠️ [memory] Data loss prevention check failed:", dlpErr.message);
    }

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

    // ── ROTATING BACKUPS & DAILY SNAPSHOTS (non-blocking, fire-and-forget) ──
    rotateBackups(file).catch(() => {});
    dailySnapshot(file).catch(() => {});

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
    _releaseLock(_lockToken);
  }
}

export async function reloadMemory() {
  const _lockToken = await _acquireLock();
  try {
    const data = await loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
    _cache = data;
    _cacheMtime = Date.now();
    return _cache;
  } finally {
    _releaseLock(_lockToken);
  }
}

export async function getMemory() {
  if (_cache) {
    // ── STALENESS CHECK: detect if disk file was modified externally ──
    // (e.g., manual restore, another worktree, or external tool).
    // If disk mtime is newer than our cache, reload from disk.
    try {
      const stat = fsSync.statSync(MEMORY_FILE);
      const diskMtime = stat.mtimeMs;
      if (diskMtime > _cacheMtime + 1000) {
        // Disk is newer — but only reload if disk has MORE data than cache
        // (prevents a corrupted/empty disk from wiping a good cache)
        const diskData = await loadJSON(MEMORY_FILE, DEFAULT_MEMORY);
        const diskConvos = Object.keys(diskData.conversations || {}).length;
        const diskProfile = Object.keys(diskData.profile || {}).length;
        const cacheConvos = Object.keys(_cache.conversations || {}).length;
        const cacheProfile = Object.keys(_cache.profile || {}).length;

        if (diskConvos >= cacheConvos && diskProfile >= cacheProfile) {
          console.log(`🔄 [memory] Disk file is newer (${new Date(diskMtime).toISOString()}) — reloading (disk: ${diskConvos} convos, ${diskProfile} profile keys)`);
          // Preserve any in-memory meta updates (moltbook heartbeats etc.)
          if (_cache.meta && typeof _cache.meta === "object") {
            diskData.meta = { ...diskData.meta, ..._cache.meta };
          }
          _cache = diskData;
          _cacheMtime = Date.now();
        }
      }
    } catch {
      // stat/read failed — keep using cache
    }
    return _cache;
  }
  return await reloadMemory();
}

export async function withMemoryLock(fn) {
  const _lockToken = await _acquireLock();
  try {
    return await fn();
  } finally {
    _releaseLock(_lockToken);
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

    // ── DURABLE-INJECTION FILTER ──
    // Durables are injected verbatim into the chat LLM system prompt. Apply a
    // lightweight allowlist so old/mean/PII-leaking durables don't become
    // prompt-injection surfaces.
    const MEAN_WORDS = /\b(stupid|idiot|shut\s*up|dumb|hate\s+you|ugly|worthless|pathetic)\b/i;
    const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const PHONE_RE = /(?:\+?\d[\s\-().]*){7,}\d/;
    const TOKEN_RE = /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9_\-.=]{10,})\b/;

    const rawDurables = Array.isArray(mem.durable) ? mem.durable : [];
    const DURABLE_KEEP = 20; // was implicitly 10 via slice(-10); bump to 20 now that we filter
    const candidates = rawDurables.slice(-DURABLE_KEEP * 2); // over-sample then filter
    const dropReasons = { mean: 0, email: 0, phone: 0, token: 0, malformed: 0 };
    const durableMemories = [];
    for (const d of candidates) {
      const fact = (d && typeof d === "object") ? d.fact : (typeof d === "string" ? d : null);
      if (!fact || typeof fact !== "string") { dropReasons.malformed++; continue; }
      if (MEAN_WORDS.test(fact)) { dropReasons.mean++; continue; }
      if (EMAIL_RE.test(fact))   { dropReasons.email++; continue; }
      if (PHONE_RE.test(fact))   { dropReasons.phone++; continue; }
      if (TOKEN_RE.test(fact))   { dropReasons.token++; continue; }
      durableMemories.push(d);
      if (durableMemories.length >= DURABLE_KEEP) break;
    }
    const droppedTotal = Object.values(dropReasons).reduce((a, b) => a + b, 0);
    if (droppedTotal > 0 || rawDurables.length > 0) {
      const parts = Object.entries(dropReasons).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(", ");
      console.log(`[memory] durables filtered: ${durableMemories.length} kept / ${droppedTotal} dropped${parts ? ` (${parts})` : ""}`);
    }

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
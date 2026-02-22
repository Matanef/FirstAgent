// server/memory.js
// Robust async memory layer with atomic writes, caching, and a simple in-process mutex.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MEMORY_FILE = path.resolve(__dirname, "..", "utils", "memory.json");
export const DEFAULT_MEMORY = { conversations: {}, profile: {}, meta: {} };

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
    if (raw.profile && typeof raw.profile === "object") safe.profile = raw.profile;
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
    const tmp = `${file}.tmp`;
    const safeData = validateMemoryShape(obj);
    const data = JSON.stringify(safeData, null, 2);
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, file);
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
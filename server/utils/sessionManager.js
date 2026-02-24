// server/utils/sessionManager.js
// Persistent cookie jar management per named session
// Follows emailDrafts.js pattern: in-memory Map cache + JSON file persistence

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CookieJar } from "tough-cookie";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.resolve(__dirname, "..", "data", "sessions");

// In-memory cache: Map<sessionName, { jar: CookieJar, metadata: object }>
const _cache = new Map();

function ensureDir() {
  if (!fsSync.existsSync(SESSIONS_DIR)) {
    fsSync.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionFilePath(name) {
  // Sanitize name to prevent path traversal
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

/**
 * Get or create a named session with a cookie jar.
 * Lazy-loads from disk on first access.
 */
export async function getSession(name) {
  if (_cache.has(name)) {
    const cached = _cache.get(name);
    cached.metadata.lastUsedAt = new Date().toISOString();
    return cached;
  }

  ensureDir();
  const filePath = sessionFilePath(name);

  try {
    if (fsSync.existsSync(filePath)) {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw);

      // Deserialize tough-cookie jar from stored JSON
      const jar = await CookieJar.deserialize(data.cookieJar || {});
      const metadata = data.metadata || {};
      metadata.lastUsedAt = new Date().toISOString();

      const session = { jar, metadata };
      _cache.set(name, session);
      console.log(`[sessionManager] Loaded session: ${name}`);
      return session;
    }
  } catch (err) {
    console.warn(`[sessionManager] Failed to load session ${name}:`, err.message);
  }

  // Create new session
  const jar = new CookieJar();
  const metadata = {
    name,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    csrfToken: null,
    domain: null
  };

  const session = { jar, metadata };
  _cache.set(name, session);
  console.log(`[sessionManager] Created new session: ${name}`);
  return session;
}

/**
 * Persist a session's cookie jar and metadata to disk.
 */
export async function saveSession(name) {
  if (!_cache.has(name)) return;

  ensureDir();
  const session = _cache.get(name);
  const filePath = sessionFilePath(name);

  try {
    const serialized = {
      cookieJar: await session.jar.serialize(),
      metadata: session.metadata
    };

    // Atomic write via temp file
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(serialized, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    console.error(`[sessionManager] Failed to save session ${name}:`, err.message);
  }
}

/**
 * Destroy a session: clear from cache and delete file.
 */
export async function destroySession(name) {
  _cache.delete(name);

  const filePath = sessionFilePath(name);
  try {
    if (fsSync.existsSync(filePath)) {
      await fs.unlink(filePath);
    }
    console.log(`[sessionManager] Destroyed session: ${name}`);
    return true;
  } catch (err) {
    console.warn(`[sessionManager] Failed to delete session file ${name}:`, err.message);
    return false;
  }
}

/**
 * List all active session names (from cache + disk).
 */
export async function listSessions() {
  ensureDir();
  const names = new Set([..._cache.keys()]);

  try {
    const files = await fs.readdir(SESSIONS_DIR);
    for (const f of files) {
      if (f.endsWith(".json") && !f.endsWith(".tmp")) {
        names.add(f.replace(".json", ""));
      }
    }
  } catch { /* ignore */ }

  return [...names];
}

// server/utils/emailDrafts.js
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DRAFTS_DIR = path.resolve(__dirname, "..", "data", "email_drafts");
const DRAFTS_FILE = path.join(DRAFTS_DIR, "drafts.json");

let _cache = null;

async function ensureDir() {
  if (!fsSync.existsSync(DRAFTS_DIR)) {
    fsSync.mkdirSync(DRAFTS_DIR, { recursive: true });
  }
  if (!fsSync.existsSync(DRAFTS_FILE)) {
    fsSync.writeFileSync(DRAFTS_FILE, JSON.stringify({}, null, 2), "utf8");
  }
}

async function loadAll() {
  if (_cache) return _cache;
  await ensureDir();
  try {
    const raw = await fs.readFile(DRAFTS_FILE, "utf8");
    _cache = JSON.parse(raw || "{}");
  } catch {
    _cache = {};
  }
  return _cache;
}

async function saveAll(obj) {
  await ensureDir();
  _cache = obj;
  await fs.writeFile(DRAFTS_FILE + ".tmp", JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(DRAFTS_FILE + ".tmp", DRAFTS_FILE);
}

export async function getDraft(sessionId = "default") {
  const all = await loadAll();
  return all[sessionId] || null;
}

export async function saveDraft(sessionId = "default", draft = {}) {
  const all = await loadAll();
  all[sessionId] = Object.assign({}, all[sessionId] || {}, draft, { updatedAt: new Date().toISOString() });
  await saveAll(all);
  return all[sessionId];
}

export async function clearDraft(sessionId = "default") {
  const all = await loadAll();
  if (all[sessionId]) {
    delete all[sessionId];
    await saveAll(all);
    return true;
  }
  return false;
}

export async function listDrafts() {
  return await loadAll();
}
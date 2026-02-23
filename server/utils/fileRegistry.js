// server/utils/fileRegistry.js
// JSON-based file registry for uploaded files

import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "./config.js";

const REGISTRY_FILE = path.resolve(PROJECT_ROOT, "uploads", "registry.json");

let cache = null;

async function ensureDir() {
  await fs.mkdir(path.dirname(REGISTRY_FILE), { recursive: true });
}

async function load() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(REGISTRY_FILE, "utf8");
    cache = JSON.parse(raw);
  } catch {
    cache = {};
  }
  return cache;
}

async function save(data) {
  await ensureDir();
  cache = data;
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(data, null, 2), "utf8");
}

export async function registerFile({ id, originalName, mimetype, size, filePath }) {
  const registry = await load();
  registry[id] = {
    originalName,
    mimetype,
    size,
    uploadedAt: new Date().toISOString(),
    path: filePath
  };
  await save(registry);
  return registry[id];
}

export async function getFile(id) {
  const registry = await load();
  return registry[id] || null;
}

export async function listFiles() {
  return load();
}

export async function removeFile(id) {
  const registry = await load();
  const entry = registry[id];
  if (entry) {
    try { await fs.unlink(entry.path); } catch { /* already gone */ }
    delete registry[id];
    await save(registry);
  }
}

export async function cleanExpired(ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const registry = await load();
  const now = Date.now();
  let removed = 0;

  for (const [id, entry] of Object.entries(registry)) {
    const age = now - new Date(entry.uploadedAt).getTime();
    if (age > ttlMs) {
      try { await fs.unlink(entry.path); } catch { /* already gone */ }
      delete registry[id];
      removed++;
    }
  }

  if (removed > 0) {
    await save(registry);
    console.log(`🗑️ Cleaned ${removed} expired file(s) from registry`);
  }

  return removed;
}

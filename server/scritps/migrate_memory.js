// server/scripts/migrate_memory.js
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());
const MEM_PATH = path.join(PROJECT_ROOT, "utils", "memory.json");
const BACKUP_PATH = path.join(PROJECT_ROOT, "utils", `memory.json.bak.${Date.now()}`);
const NEW_PATH = MEM_PATH;

function now() { return new Date().toISOString(); }

async function safeRead(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function normalizeName(n) {
  if (!n) return null;
  return String(n).trim();
}

function migrate(old) {
  const out = {
    profile: { primary: null, self: {}, contacts: {} },
    durable: [],
    conversations: old?.conversations || {},
    meta: old?.meta || {}
  };

  // Move top-level profile fields into profile.self
  const oldProfile = old?.profile || {};
  // If oldProfile.self exists, copy it first
  if (oldProfile.self && typeof oldProfile.self === "object") {
    out.profile.self = { ...oldProfile.self };
  }

  // Copy common top-level fields into self if missing
  if (!out.profile.self.name && oldProfile.name) out.profile.self.name = normalizeName(oldProfile.name);
  if (!out.profile.self.location && oldProfile.location) out.profile.self.location = normalizeName(oldProfile.location);
  if (!out.profile.self.email && oldProfile.email) out.profile.self.email = normalizeName(oldProfile.email);
  if (!out.profile.self.phone && oldProfile.phone) out.profile.self.phone = normalizeName(oldProfile.phone);
  if (!out.profile.self.whatsapp && oldProfile.whatsapp) out.profile.self.whatsapp = normalizeName(oldProfile.whatsapp);
  if (!out.profile.self.tone && oldProfile.tone) out.profile.self.tone = normalizeName(oldProfile.tone);

  // If oldProfile.primary exists, keep it
  if (oldProfile.primary) out.profile.primary = oldProfile.primary;

  // Migrate contacts: if oldProfile.contacts is an object, normalize keys
  if (oldProfile.contacts && typeof oldProfile.contacts === "object") {
    for (const [k, v] of Object.entries(oldProfile.contacts)) {
      const key = String(k).toLowerCase().replace(/\s+/g, "_");
      out.profile.contacts[key] = {
        name: v?.name || v?.label || key,
        email: v?.email || null,
        phone: v?.phone || null,
        aliases: Array.isArray(v?.aliases) ? v.aliases : [],
        lastUpdated: v?.lastUpdated || now()
      };
    }
  }

  // If oldProfile.aliases exist at top-level, copy to self.aliases
  if (!Array.isArray(out.profile.self.aliases) && Array.isArray(oldProfile.aliases)) {
    out.profile.self.aliases = oldProfile.aliases;
  }

  // Migrate simple durable preferences (tone)
  if (out.profile.self.tone) {
    out.durable.push({ category: "preference", key: "tone", value: out.profile.self.tone, source: "migration", lastUpdated: now() });
  }

  // Preserve any other top-level keys under meta.original
  out.meta.original = oldProfile;

  return out;
}

(async () => {
  try {
    if (!fsSync.existsSync(path.dirname(MEM_PATH))) {
      fsSync.mkdirSync(path.dirname(MEM_PATH), { recursive: true });
    }

    const old = await safeRead(MEM_PATH);
    if (!old) {
      console.error("No existing memory.json found or file unreadable. Aborting migration.");
      process.exit(1);
    }

    // Backup
    await fs.copyFile(MEM_PATH, BACKUP_PATH);
    console.log("Backup created at:", BACKUP_PATH);

    const migrated = migrate(old);
    await fs.writeFile(NEW_PATH, JSON.stringify(migrated, null, 2), "utf8");
    console.log("Migration complete. New memory written to:", NEW_PATH);
    console.log("Preview:");
    console.log(JSON.stringify({ profile: migrated.profile, durable: migrated.durable }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(2);
  }
})();
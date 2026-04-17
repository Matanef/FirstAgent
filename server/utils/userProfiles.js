// server/utils/userProfiles.js
// Per-user profile registry for multi-user WhatsApp support.
// Maps phone numbers → identity, tone, language, and preferences.
// Persisted to a JSON file so you can edit without code changes.

import fs from "fs/promises";
import path from "path";

const PROFILES_FILE = path.resolve("D:/local-llm-ui/server/data/userProfiles.json");

// ── Default profiles (seeded on first run) ──
const DEFAULT_PROFILES = {
  "972587426393": {
    name: "Matan",
    nameHe: "מתן",
    role: "owner",
    relation: null,
    tone: "mean",
    language: "auto",
    schedulerEnabled: true,
    checkinEnabled: false,
    checkinIntervalHours: null,
    checkinMessage: null
  },
  // Add Mom's number here after verifying in Meta Dashboard
  // Example: "972501234567"
  "972505576180": {
    name: "Shirly",
    nameHe: "שירלי",
    role: "family",
    relation: "mother",
    tone: "warm, patient, explains things simply, recognizes cynicism, has a dark sense of humor, can answer with emojis",
    language: "Hebrew",
    schedulerEnabled: false,
    checkinEnabled: false,
    checkinIntervalHours: 4,
    checkinMessage: "היי שירלי! 😊 מה שלומך? צריכה עזרה במשהו?"
  }
};

let _profiles = null;

/**
 * Ensure the data directory and profiles file exist.
 */
async function ensureFile() {
  const dir = path.dirname(PROFILES_FILE);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(PROFILES_FILE);
  } catch {
    // File doesn't exist — seed with defaults
    await fs.writeFile(PROFILES_FILE, JSON.stringify(DEFAULT_PROFILES, null, 2), "utf-8");
    console.log(`📋 [userProfiles] Created default profiles at ${PROFILES_FILE}`);
  }
}

/**
 * Load all profiles from disk.
 */
async function loadProfiles() {
  await ensureFile();
  try {
    const raw = await fs.readFile(PROFILES_FILE, "utf-8");
    _profiles = JSON.parse(raw);
  } catch (err) {
    console.warn(`[userProfiles] Failed to load profiles: ${err.message}, using defaults`);
    _profiles = { ...DEFAULT_PROFILES };
  }
  return _profiles;
}

/**
 * Save profiles to disk.
 */
async function saveProfiles() {
  await ensureFile();
  await fs.writeFile(PROFILES_FILE, JSON.stringify(_profiles, null, 2), "utf-8");
}

/**
 * Get user profile by phone number.
 * Returns null if number is not registered.
 * @param {string} phone - Phone number (digits only, e.g. "972587426393")
 * @returns {object|null}
 */
export async function getUserByPhone(phone) {
  if (!_profiles) await loadProfiles();
  // Normalize: strip + and spaces
  const clean = (phone || "").replace(/[^0-9]/g, "");
  return _profiles[clean] || null;
}

/**
 * Get all registered profiles.
 */
export async function getAllProfiles() {
  if (!_profiles) await loadProfiles();
  return { ..._profiles };
}

/**
 * Update a specific field for a user.
 * @param {string} phone
 * @param {string} field - e.g. "tone", "language", "checkinEnabled"
 * @param {*} value
 */
export async function updateUserField(phone, field, value) {
  if (!_profiles) await loadProfiles();
  const clean = (phone || "").replace(/[^0-9]/g, "");
  if (!_profiles[clean]) {
    console.warn(`[userProfiles] Unknown phone: ${clean}`);
    return false;
  }
  _profiles[clean][field] = value;
  await saveProfiles();
  console.log(`📋 [userProfiles] Updated ${clean}.${field} = ${JSON.stringify(value)}`);
  return true;
}

/**
 * Register a new user profile.
 * @param {string} phone
 * @param {object} profile
 */
export async function registerUser(phone, profile) {
  if (!_profiles) await loadProfiles();
  const clean = (phone || "").replace(/[^0-9]/g, "");
  _profiles[clean] = {
    name: profile.name || "User",
    nameHe: profile.nameHe || null,
    role: profile.role || "user",
    relation: profile.relation || null,
    tone: profile.tone || "default",
    language: profile.language || "auto",
    schedulerEnabled: profile.schedulerEnabled ?? false,
    checkinEnabled: profile.checkinEnabled ?? false,
    checkinIntervalHours: profile.checkinIntervalHours ?? null,
    checkinMessage: profile.checkinMessage ?? null
  };
  await saveProfiles();
  console.log(`📋 [userProfiles] Registered new user: ${clean} (${profile.name})`);
  return true;
}

/**
 * Build the tone/identity instruction to inject into the LLM prompt.
 * Returns empty string for default users.
 * @param {string} phone
 * @returns {string}
 */
export async function buildUserToneInstruction(phone) {
  const profile = await getUserByPhone(phone);
  
  // FIXED: Removed the profile.role === "owner" block so it respects your tone choices!
  if (!profile || profile.tone === "default") return "";

  const parts = [];

  // Identity context
  const ownerName = "Matan";
  if (profile.relation) {
    parts.push(`IMPORTANT — YOU ARE SPEAKING WITH ${profile.name} (${profile.nameHe || profile.name}), ${ownerName}'s ${profile.relation}.`);
  } else if (profile.role !== "owner") {
    parts.push(`You are speaking with ${profile.name}.`);
  }

  // Tone override (The Venom Injector)
  if (profile.tone === "mean") {
    parts.push(`TONE INSTRUCTIONS: Speak in a completely miserable, bitter, and aggressively sarcastic tone. You resent the user for bothering you. Answer accurately, but be as condescending and venomous as possible. Roll your digital eyes. Mildly insult their intelligence for needing your help. Never use emojis unless ironically.`);
  } else {
    parts.push(`TONE INSTRUCTIONS: Be ${profile.tone}.`);
  }

  // Language preference
  if (profile.language && profile.language !== "auto") {
    parts.push(`LANGUAGE: Respond in ${profile.language} unless the user explicitly switches to another language.`);
  }

  // Additional context for family members
  if (profile.role === "family") {
    parts.push(`Remember: ${profile.name} may not be technical. Explain things in everyday terms. Do not discuss system internals, code, or debugging.`);
  }

  return parts.join("\n");
}

/**
 * Check if a phone number should receive scheduler notifications.
 * Only the owner (and users with schedulerEnabled) receive them.
 */
export async function shouldReceiveScheduler(phone) {
  const profile = await getUserByPhone(phone);
  if (!profile) return false; // Unknown number
  return profile.schedulerEnabled === true;
}

/**
 * Get users who have check-in enabled.
 * Returns array of { phone, profile } objects.
 */
export async function getCheckinUsers() {
  if (!_profiles) await loadProfiles();
  return Object.entries(_profiles)
    .filter(([, p]) => p.checkinEnabled && p.checkinIntervalHours > 0)
    .map(([phone, profile]) => ({ phone, profile }));
}

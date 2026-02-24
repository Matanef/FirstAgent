// server/utils/credentialStore.js
// AES-256-GCM encrypted credential storage
// Uses Node.js built-in crypto — no extra dependencies

import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CRED_FILE = path.join(__dirname, "..", "tokens", "credentials.enc");

function ensureDir() {
  const dir = path.dirname(CRED_FILE);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
}

function getMasterKey() {
  const key = process.env.CREDENTIAL_MASTER_KEY;
  if (!key) {
    throw new Error(
      "CREDENTIAL_MASTER_KEY not set in .env. " +
      "Add a 32+ character secret key to enable credential storage."
    );
  }
  return key;
}

function deriveKey(masterKey, salt) {
  return crypto.scryptSync(masterKey, salt, 32);
}

function encrypt(plaintext, masterKey) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(masterKey, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag,
    encrypted
  };
}

function decrypt(entry, masterKey) {
  const salt = Buffer.from(entry.salt, "hex");
  const key = deriveKey(masterKey, salt);
  const iv = Buffer.from(entry.iv, "hex");
  const authTag = Buffer.from(entry.authTag, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(entry.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function loadStore() {
  ensureDir();
  try {
    if (!fsSync.existsSync(CRED_FILE)) return {};
    const raw = await fs.readFile(CRED_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function saveStore(store) {
  ensureDir();
  const tmpPath = CRED_FILE + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmpPath, CRED_FILE);
}

/**
 * Store credentials for a service (encrypted at rest).
 * @param {string} serviceName - e.g. "moltbook"
 * @param {object} credentials - e.g. { username: "user", password: "pass" }
 */
export async function storeCredential(serviceName, credentials) {
  const masterKey = getMasterKey();
  const store = await loadStore();

  const plaintext = JSON.stringify(credentials);
  store[serviceName] = encrypt(plaintext, masterKey);
  store[serviceName].updatedAt = new Date().toISOString();

  await saveStore(store);
  console.log(`[credentialStore] Stored credentials for: ${serviceName}`);
  return true;
}

/**
 * Retrieve decrypted credentials for a service.
 * @param {string} serviceName
 * @returns {object|null} Decrypted credentials or null
 */
export async function getCredential(serviceName) {
  const masterKey = getMasterKey();
  const store = await loadStore();

  if (!store[serviceName]) return null;

  try {
    const plaintext = decrypt(store[serviceName], masterKey);
    return JSON.parse(plaintext);
  } catch (err) {
    console.error(`[credentialStore] Failed to decrypt ${serviceName}:`, err.message);
    return null;
  }
}

/**
 * Delete stored credentials for a service.
 */
export async function deleteCredential(serviceName) {
  const store = await loadStore();
  if (!store[serviceName]) return false;

  delete store[serviceName];
  await saveStore(store);
  console.log(`[credentialStore] Deleted credentials for: ${serviceName}`);
  return true;
}

/**
 * List service names with stored credentials (never returns values).
 */
export async function listCredentials() {
  const store = await loadStore();
  return Object.keys(store).map(name => ({
    service: name,
    updatedAt: store[name].updatedAt || "unknown"
  }));
}

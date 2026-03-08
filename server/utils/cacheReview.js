// server/utils/reviewCache.js
// Handles per-folder review caching with MD5 hashing and 1-day expiration

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const CACHE_DIR = path.resolve("./server/data/review-cache");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hash a folder path using MD5 to create a stable cache filename
 */
export function hashFolderPath(folderPath) {
  return crypto.createHash("md5").update(folderPath).digest("hex");
}

/**
 * Load cache for a specific folder (hashed)
 */
export async function loadReviewCache(folderPath) {
  const hash = hashFolderPath(folderPath);
  const cacheFile = path.join(CACHE_DIR, `${hash}.json`);

  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const raw = await fs.readFile(cacheFile, "utf8");
    const data = JSON.parse(raw);

    // Expire cache after 1 day
    if (Date.now() - new Date(data.timestamp).getTime() > ONE_DAY_MS) {
      return { timestamp: Date.now(), reviewedFiles: [], cacheFile };
    }

    return { ...data, cacheFile };
  } catch {
    return { timestamp: Date.now(), reviewedFiles: [], cacheFile };
  }
}

/**
 * Save updated cache
 */
export async function saveReviewCache(cacheFile, reviewedFiles) {
  const data = {
    timestamp: new Date().toISOString(),
    reviewedFiles: Array.from(new Set(reviewedFiles)) // dedupe
  };

  await fs.writeFile(cacheFile, JSON.stringify(data, null, 2), "utf8");
}
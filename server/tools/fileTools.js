// server/tools/fileTools.js

/**
 * Advanced Secure File System Tools
 *
 * Features:
 * - Safe sandbox restriction
 * - Recursive directory scanning
 * - SHA-256 duplicate detection
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// 🔒 Sandbox root directory
const SANDBOX_ROOT = "E:\\testFolder";

/**
 * Safely resolve path inside sandbox.
 * Prevents directory traversal attacks.
 */
function resolveSafePath(relativePath) {
  const resolved = path.resolve(SANDBOX_ROOT, relativePath);

  if (!resolved.startsWith(path.resolve(SANDBOX_ROOT))) {
    throw new Error("Access denied: Path outside sandbox");
  }

  return resolved;
}

/**
 * Recursively scan directory and return all file paths
 */
async function scanDirectoryRecursive(relativePath = ".") {
  const safePath = resolveSafePath(relativePath);
  const results = [];

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push({
          path: fullPath.replace(SANDBOX_ROOT, ""),
          size: (await fs.promises.stat(fullPath)).size
        });
      }
    }
  }

  await walk(safePath);

  return results;
}

/**
 * Generate SHA-256 hash of a file
 */
async function hashFile(fullPath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(fullPath);

  return new Promise((resolve, reject) => {
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Find duplicate files using SHA-256 hashing
 */
async function findDuplicateFiles(relativePath = ".") {
  const safePath = resolveSafePath(relativePath);
  const fileMap = {};
  const duplicates = [];

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const hash = await hashFile(fullPath);

        if (!fileMap[hash]) {
          fileMap[hash] = [];
        }

        fileMap[hash].push(fullPath);
      }
    }
  }

  await walk(safePath);

  for (const [hash, files] of Object.entries(fileMap)) {
    if (files.length > 1) {
      duplicates.push({
        hash,
        files: files.map(f => f.replace(SANDBOX_ROOT, ""))
      });
    }
  }

  return duplicates;
}

export const fileTools = {
  scanDirectoryRecursive,
  findDuplicateFiles
};

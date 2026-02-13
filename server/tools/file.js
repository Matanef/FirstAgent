// server/tools/file.js

import fs from "fs";
import path from "path";
import crypto from "crypto";

const SANDBOX_ROOT = "E:\\testFolder";

/**
 * Resolve path safely inside sandbox
 */
function resolveSafePath(relativePath = ".") {
  const resolved = path.resolve(SANDBOX_ROOT, relativePath);

  if (!resolved.startsWith(path.resolve(SANDBOX_ROOT))) {
    throw new Error("Access denied: Path outside sandbox");
  }

  return resolved;
}

/**
 * Determine if a path is a file or folder automatically
 */
async function detectPathType(relativePath) {
  const safePath = resolveSafePath(relativePath);

  try {
    const stats = await fs.promises.stat(safePath);
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
  } catch (err) {
    if (err.code === "ENOENT") return "not_found";
    throw err;
  }

  return "unknown";
}

/**
 * Scan directory (non-recursive)
 */
async function scanDirectory(relativePath = ".") {
  const safePath = resolveSafePath(relativePath);
  const stats = await fs.promises.stat(safePath);

  if (!stats.isDirectory()) {
    return { error: "Path exists but is not a folder." };
  }

  const files = await fs.promises.readdir(safePath);

  return {
    path: safePath,
    files
  };
}

/**
 * Recursive scan
 */
async function scanRecursive(relativePath = ".") {
  const safePath = resolveSafePath(relativePath);
  const results = [];

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push(fullPath.replace(path.resolve(SANDBOX_ROOT), ""));
      }
    }
  }

  await walk(safePath);
  return { files: results };
}

/**
 * Find duplicates
 */
async function findDuplicates(relativePath = ".") {
  const safePath = resolveSafePath(relativePath);
  const fileMap = {};

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const buffer = await fs.promises.readFile(fullPath);
        const hash = crypto.createHash("sha256").update(buffer).digest("hex");

        fileMap[hash] ??= [];
        fileMap[hash].push(fullPath);
      }
    }
  }

  await walk(safePath);

  const duplicates = Object.entries(fileMap)
    .filter(([_, files]) => files.length > 1)
    .map(([hash, files]) => ({
      hash,
      files: files.map(f => f.replace(path.resolve(SANDBOX_ROOT), ""))
    }));

  return { duplicates };
}

/**
 * Read a file as text
 */
async function readFile(relativePath) {
  const safePath = resolveSafePath(relativePath);
  const stats = await fs.promises.stat(safePath);

  if (!stats.isFile()) {
    return "Path exists but is not a file.";
  }

  const content = await fs.promises.readFile(safePath, "utf-8");
  return content;
}

/**
 * Main executor
 */
export async function execute(params = {}) {
  let { operation, path: p } = params;

  try {
    // Auto-detect if operation not explicitly set
    if (!operation) {
      const type = await detectPathType(p);
      if (type === "directory") operation = "scan";
      else if (type === "file") operation = "read";
      else return "Path does not exist.";
    }

    switch (operation) {
      case "scan":
        const result = await scanDirectory(p);
        if (result.error) return result.error;
        if (!result.files.length) return "Folder exists but is empty.";
        return "Files:\n\n" + result.files.map(f => `- ${f}`).join("\n");

      case "scan_recursive":
        const recursive = await scanRecursive(p);
        return "Files:\n\n" + recursive.files.map(f => `- ${f}`).join("\n");

      case "duplicates":
        const dup = await findDuplicates(p);
        if (!dup.duplicates.length) return "No duplicate files found.";
        return JSON.stringify(dup.duplicates, null, 2);

      case "read":
        return await readFile(p);

      default:
        return "Unsupported file operation.";
    }
  } catch (err) {
    if (err.message.includes("outside sandbox")) return err.message;
    if (err.code === "ENOENT") return "Folder or file does not exist.";
    return "File operation error: " + err.message;
  }
}

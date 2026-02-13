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
        results.push(
          fullPath.replace(path.resolve(SANDBOX_ROOT), "")
        );
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
        const hash = crypto
          .createHash("sha256")
          .update(buffer)
          .digest("hex");

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
      files: files.map(f =>
        f.replace(path.resolve(SANDBOX_ROOT), "")
      )
    }));

  return { duplicates };
}

/**
 * Main executor
 */
export async function execute(params = {}) {
  const { operation = "scan", path = "." } = params;

  try {
    switch (operation) {
      case "scan":
        const result = await scanDirectory(path);
        if (result.error) return result.error;

        if (!result.files.length)
          return "Folder exists but is empty.";

        return (
          "Files:\n\n" +
          result.files.map(f => `- ${f}`).join("\n")
        );

      case "scan_recursive":
        const recursive = await scanRecursive(path);
        return (
          "Files:\n\n" +
          recursive.files.map(f => `- ${f}`).join("\n")
        );

      case "duplicates":
        const dup = await findDuplicates(path);

        if (!dup.duplicates.length)
          return "No duplicate files found.";

        return JSON.stringify(dup.duplicates, null, 2);

      default:
        return "Unsupported file operation.";
    }
  } catch (err) {
    if (err.message.includes("outside sandbox"))
      return err.message;

    if (err.code === "ENOENT")
      return "Folder does not exist.";

    return "File operation error: " + err.message;
  }
}

// server/tools/fileWrite.js
// File writing capability for self-improvement

import fs from "fs/promises";
import path from "path";

// Sandboxes where agent can write
const WRITABLE_SANDBOXES = [
  path.resolve("D:/local-llm-ui"),
  path.resolve("E:/testFolder")
];

// Critical files that should NEVER be overwritten without backup
const PROTECTED_FILES = [
  "package.json",
  "package-lock.json",
  ".env",
  "memory.json"
];

/**
 * Check if path is within writable sandboxes
 */
function isPathWritable(resolvedPath) {
  return WRITABLE_SANDBOXES.some(root => resolvedPath.startsWith(root));
}

/**
 * Check if file is protected
 */
function isProtected(filename) {
  return PROTECTED_FILES.some(pf => filename.endsWith(pf));
}

/**
 * Create backup of file before modification
 */
async function createBackup(filepath) {
  try {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const backupPath = `${filepath}.backup-${timestamp}`;
    await fs.copyFile(filepath, backupPath);
    return backupPath;
  } catch (err) {
    return null;
  }
}

/**
 * Write or modify a file
 */
export async function fileWrite(request) {
  try {
    const { path: requestedPath, content, mode = "write", backup = true } = request;

    if (!requestedPath || !content) {
      return {
        tool: "fileWrite",
        success: false,
        final: true,
        error: "Path and content are required"
      };
    }

    // Resolve path
    const resolved = path.resolve(requestedPath);

    // Security check
    if (!isPathWritable(resolved)) {
      return {
        tool: "fileWrite",
        success: false,
        final: true,
        error: "Writing outside allowed directories is not permitted"
      };
    }

    // Protected file check
    const filename = path.basename(resolved);
    // Safety guard: refuse any attempt to modify memory.json via fileWrite
    if (filename.toLowerCase() === "memory.json") {
      return {
        tool: "fileWrite",
        success: false,
        final: true,
        error: "Direct modification of memory.json via fileWrite is disabled for safety."
      };
    }
    if (isProtected(filename)) {
      if (!backup) {
        return {
          tool: "fileWrite",
          success: false,
          final: true,
          error: `${filename} is protected. Set backup=true to modify it.`
        };
      }

      // Create backup first
      const backupPath = await createBackup(resolved);
      if (!backupPath) {
        return {
          tool: "fileWrite",
          success: false,
          final: true,
          error: `Failed to create backup of ${filename}`
        };
      }

      console.log(`📦 Created backup: ${backupPath}`);
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(resolved), { recursive: true });

    // Write file
    if (mode === "append") {
      await fs.appendFile(resolved, content, "utf8");
    } else {
      await fs.writeFile(resolved, content, "utf8");
    }

    return {
      tool: "fileWrite",
      success: true,
      final: true,
      data: {
        path: resolved,
        mode,
        size: content.length,
        message: `Successfully ${mode === "append" ? "appended to" : "wrote"} ${filename}`
      },
      reasoning: `Wrote ${content.length} bytes to ${filename}`
    };

  } catch (err) {
    return {
      tool: "fileWrite",
      success: false,
      final: true,
      error: `File write failed: ${err.message}`
    };
  }
}

// server/tools/file.js
// File system tool (sandboxed)

import fs from "fs/promises";
import path from "path";

const SANDBOX_ROOT = "E:/sandbox"; // adjust your sandbox path

/**
 * Ensure the given path is inside sandbox
 */
function sanitizePath(requestedPath) {
  const resolved = path.resolve(SANDBOX_ROOT, requestedPath);
  if (!resolved.startsWith(SANDBOX_ROOT)) throw new Error("Access outside sandbox denied");
  return resolved;
}

export async function file(request) {
  try {
    const sanitizedPath = sanitizePath(request);

    const stat = await fs.stat(sanitizedPath);
    let data = {};

    if (stat.isDirectory()) {
      const items = await fs.readdir(sanitizedPath, { withFileTypes: true });
      data.items = items.map(i => ({
        name: i.name,
        type: i.isDirectory() ? "folder" : "file"
      }));
      data.text = `Folder contents:\n${data.items.map(i => `${i.type}: ${i.name}`).join("\n")}`;
    } else if (stat.isFile()) {
      const content = await fs.readFile(sanitizedPath, "utf-8");
      data.items = [{ name: path.basename(sanitizedPath), type: "file", size: stat.size }];
      data.text = `File: ${path.basename(sanitizedPath)} (${stat.size} bytes)\nPreview:\n${content.slice(0, 500)}`;
    } else {
      data.text = "Unknown file type.";
    }

    return {
      tool: "file",
      success: true,
      final: true,
      data
    };
  } catch (err) {
    return {
      tool: "file",
      success: false,
      final: true,
      error: err.message
    };
  }
}

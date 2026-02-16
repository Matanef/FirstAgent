// server/tools/file.js
// Natural-language file system tool with safer path handling

import fs from "fs/promises";
import path from "path";

// Root folder the agent is allowed to explore
const SANDBOX_ROOT = path.resolve("D:/local-llm-ui");

/**
 * Normalize and sanitize a requested path
 */
function resolveUserPath(request) {
  if (!request || typeof request !== "string") {
    throw new Error("Invalid file request");
  }

  // Natural language cleanup
  let cleaned = request
    .replace(/\b(scan|show|list|open|read|please|folder|directory|explore|look|into)\b/gi, "")
    .replace(/\b(the|a|an|subfolder|contents|content|file|files)\b/gi, "")
    .trim();

  // If user says something like "local-llm-ui folder"
  // we avoid duplicating the root path
  if (cleaned === "" || cleaned === "/" || cleaned === ".") {
    cleaned = ".";
  }

  // Prevent accidental double-root resolution
  if (cleaned.startsWith("local-llm-ui")) {
    cleaned = cleaned.replace(/^local-llm-ui[\/\\]?/, "");
  }

  const resolved = path.resolve(SANDBOX_ROOT, cleaned);

  // Security check: ensure resolved path stays inside sandbox
  if (!resolved.startsWith(SANDBOX_ROOT)) {
    throw new Error("Access outside allowed root folder denied");
  }

  return { cleaned, resolved };
}

export async function file(request) {
  try {
    const { cleaned, resolved } = resolveUserPath(request);

    const stat = await fs.stat(resolved);
    let data = {};

    if (stat.isDirectory()) {
      const items = await fs.readdir(resolved, { withFileTypes: true });

      data.items = items.map(i => ({
        name: i.name,
        type: i.isDirectory() ? "folder" : "file"
      }));

      data.html = `
        <div class="ai-table-wrapper">
          <table class="ai-table">
            <thead>
              <tr><th>Name</th><th>Type</th></tr>
            </thead>
            <tbody>
              ${data.items
                .map(i => `<tr><td>${i.name}</td><td>${i.type}</td></tr>`)
                .join("")}
            </tbody>
          </table>
        </div>
      `;

      data.text = `Folder: ${cleaned}\n${data.items
        .map(i => `${i.type}: ${i.name}`)
        .join("\n")}`;
    }

    else if (stat.isFile()) {
      const content = await fs.readFile(resolved, "utf-8");

      data.items = [
        { name: path.basename(resolved), type: "file", size: stat.size }
      ];

      data.text = `File: ${path.basename(resolved)} (${stat.size} bytes)\n\n${content.slice(0, 500)}`;
      data.html = `<pre>${content.slice(0, 500)}</pre>`;
    }

    return {
      tool: "file",
      success: true,
      final: true,
      reasoning: `Interpreted your request as scanning: "${cleaned}"`,
      data
    };

  } catch (err) {
    return {
      tool: "file",
      success: false,
      final: true,
      error: err.message,
      reasoning: "The request could not be resolved to a valid path"
    };
  }
}
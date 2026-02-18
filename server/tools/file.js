// server/tools/file.js
// Enhanced file system tool with multiple sandboxes and intelligent path resolution

import fs from "fs/promises";
import path from "path";

// Multiple allowed sandbox roots
const SANDBOX_ROOTS = [
  path.resolve("D:/local-llm-ui"),
  path.resolve("E:/testFolder")
];

/**
 * Check if a path is within any allowed sandbox
 */
function isPathAllowed(resolvedPath) {
  return SANDBOX_ROOTS.some(root => resolvedPath.startsWith(root));
}

/**
 * Find the appropriate sandbox root for a request
 */
function findSandboxRoot(request) {
  const lower = request.toLowerCase();
  
  // Check for explicit sandbox mentions
  if (lower.includes("testfolder") || lower.includes("test folder")) {
    return SANDBOX_ROOTS[1]; // E:/testFolder
  }
  
  if (lower.includes("local-llm") || lower.includes("project")) {
    return SANDBOX_ROOTS[0]; // D:/local-llm-ui
  }
  
  // Default to project folder
  return SANDBOX_ROOTS[0];
}

/**
 * Normalize and sanitize a requested path
 */
function resolveUserPath(request) {
  if (!request || typeof request !== "string") {
    throw new Error("Invalid file request");
  }

  // Natural language cleanup
  let cleaned = request
    .replace(/\b(scan|show|list|open|read|please|folder|directory|explore|look|into|the|a|an|subfolder|contents|content|file|files)\b/gi, "")
    .trim();

  // Determine which sandbox to use
  const sandboxRoot = findSandboxRoot(request);

  // If user says something like "local-llm-ui folder" or "testFolder"
  // avoid duplicating the root path
  if (cleaned === "" || cleaned === "/" || cleaned === ".") {
    cleaned = ".";
  }

  // Remove duplicate root mentions
  const rootName = path.basename(sandboxRoot);
  if (cleaned.toLowerCase().startsWith(rootName.toLowerCase())) {
    cleaned = cleaned.substring(rootName.length).replace(/^[\/\\]/, "");
    if (!cleaned) cleaned = ".";
  }

  const resolved = path.resolve(sandboxRoot, cleaned);

  // Security check: ensure resolved path stays inside allowed sandboxes
  if (!isPathAllowed(resolved)) {
    throw new Error("Access outside allowed directories denied");
  }

  return { cleaned, resolved, sandboxRoot };
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

/**
 * Get file type icon/emoji
 */
function getFileIcon(name, isDir) {
  if (isDir) return "📁";
  const ext = path.extname(name).toLowerCase();
  const icons = {
    ".js": "📜",
    ".json": "📋",
    ".md": "📝",
    ".txt": "📄",
    ".css": "🎨",
    ".html": "🌐",
    ".jsx": "⚛️",
    ".py": "🐍",
    ".yml": "⚙️",
    ".env": "🔐"
  };
  return icons[ext] || "📄";
}

/**
 * Enhanced file system tool
 */
export async function file(request) {
  try {
    const { cleaned, resolved, sandboxRoot } = resolveUserPath(request);

    const stat = await fs.stat(resolved);
    let data = {};

    // Handle directories
    if (stat.isDirectory()) {
      const items = await fs.readdir(resolved, { withFileTypes: true });

      data.items = items.map(i => ({
        name: i.name,
        type: i.isDirectory() ? "folder" : "file",
        icon: getFileIcon(i.name, i.isDirectory())
      }));

      // Sort: folders first, then files
      data.items.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === "folder" ? -1 : 1;
      });

      data.html = `
        <div class="ai-table-wrapper">
          <p><strong>📂 Directory:</strong> ${cleaned || "root"}</p>
          <p><strong>🗂️ Sandbox:</strong> ${path.basename(sandboxRoot)}</p>
          <p><strong>📊 Total items:</strong> ${data.items.length}</p>
          <table class="ai-table">
            <thead>
              <tr>
                <th>Icon</th>
                <th>Name</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              ${data.items
                .map(i => `
                  <tr>
                    <td>${i.icon}</td>
                    <td>${i.name}</td>
                    <td>${i.type}</td>
                  </tr>
                `)
                .join("")}
            </tbody>
          </table>
        </div>
      `;

      data.text = `Directory: ${cleaned || "root"} (${data.items.length} items)\n${data.items
        .map(i => `${i.icon} ${i.type}: ${i.name}`)
        .join("\n")}`;
    }

    // Handle files
    else if (stat.isFile()) {
      const content = await fs.readFile(resolved, "utf-8");
      const lines = content.split("\n");
      const preview = lines.slice(0, 50).join("\n");

      data.items = [
        { 
          name: path.basename(resolved), 
          type: "file", 
          size: stat.size,
          sizeFormatted: formatFileSize(stat.size),
          lines: lines.length
        }
      ];

      data.text = `File: ${path.basename(resolved)} (${formatFileSize(stat.size)}, ${lines.length} lines)\n\n${preview}${lines.length > 50 ? "\n\n... (truncated)" : ""}`;
      
      data.html = `
        <div class="ai-table-wrapper">
          <p><strong>📄 File:</strong> ${path.basename(resolved)}</p>
          <p><strong>📏 Size:</strong> ${formatFileSize(stat.size)}</p>
          <p><strong>📝 Lines:</strong> ${lines.length}</p>
          <pre style="max-height: 400px; overflow-y: auto; background: var(--bg-tertiary); padding: 1rem; border-radius: 8px;">${preview}${lines.length > 50 ? "\n\n... (truncated, showing first 50 lines)" : ""}</pre>
        </div>
      `;
    }

    return {
      tool: "file",
      success: true,
      final: true,
      reasoning: `Accessed ${stat.isDirectory() ? "directory" : "file"}: "${cleaned}" in sandbox: ${path.basename(sandboxRoot)}`,
      data
    };

  } catch (err) {
    // Provide helpful error messages
    let errorMessage = err.message;
    
    if (err.code === "ENOENT") {
      errorMessage = `Path not found. Make sure the path exists in one of the allowed directories:\n- D:/local-llm-ui\n- E:/testFolder`;
    } else if (err.code === "EACCES") {
      errorMessage = "Permission denied. The file or directory cannot be accessed.";
    }

    return {
      tool: "file",
      success: false,
      final: true,
      error: errorMessage,
      reasoning: "The request could not be resolved to a valid path",
      data: {
        allowedSandboxes: SANDBOX_ROOTS.map(r => path.basename(r)),
        attemptedPath: request
      }
    };
  }
}

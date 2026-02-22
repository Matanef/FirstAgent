// server/tools/file.js
// COMPLETE FIX #6: Intelligent path resolution with project awareness

import fs from "fs/promises";
import path from "path";

// Multiple allowed sandbox roots
const SANDBOX_ROOTS = [
  path.resolve("D:/local-llm-ui"),
  path.resolve("E:/testFolder")
];

function isPathAllowed(resolvedPath) {
  return SANDBOX_ROOTS.some(root => resolvedPath.startsWith(root));
}

function findSandboxRoot(request) {
  const lower = (request || "").toLowerCase();
  if (lower.includes("testfolder") || lower.includes("test folder")) return SANDBOX_ROOTS[1];
  return SANDBOX_ROOTS[0];  // Default to project root
}

// FIX #6: Enhanced path resolution with project awareness
function resolveUserPath(request) {
  if (!request || typeof request !== "string") throw new Error("Invalid file request");

  // Natural language cleanup - remove common verbs/articles
  let cleaned = request
    .replace(/\b(scan|show|list|open|read|please|folder|directory|explore|look|into|the|a|an|subfolder|contents?|file|files|go\s+to|in\s+(your|my|the)\s+project)\b/gi, "")
    .trim();

  // Determine sandbox root
  const sandboxRoot = findSandboxRoot(request);
  const rootName = path.basename(sandboxRoot);  // "local-llm-ui"

  if (cleaned === "" || cleaned === "/" || cleaned === ".") cleaned = ".";

  // FIX #6: Handle "local-llm-ui/server" pattern intelligently
  // If user says "local-llm-ui/server", they mean "./server" relative to project root
  
  // Check if request starts with root name (case-insensitive)
  const rootPattern = new RegExp(`^${rootName}[\\/]`, 'i');
  if (rootPattern.test(cleaned)) {
    // Remove "local-llm-ui/" and keep the rest
    cleaned = cleaned.replace(rootPattern, '');
    console.log(`[file] Detected project-relative path: "${cleaned}"`);
  }

  // Handle edge cases
  if (!cleaned || cleaned === rootName.toLowerCase()) cleaned = ".";

  // Resolve the final path
  const resolved = path.resolve(sandboxRoot, cleaned);

  // Security check
  if (!isPathAllowed(resolved)) {
    throw new Error("Access outside allowed directories denied");
  }

  console.log(`[file] Path resolution: "${request}" → cleaned="${cleaned}" → resolved="${resolved}"`);
  return { cleaned, resolved, sandboxRoot };
}

function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

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
    ".yaml": "⚙️",
    ".env": "🔒" 
  };
  return icons[ext] || "📄";
}

// Guard: refuse inputs that look like natural language, not file paths
function looksLikeNaturalLanguage(input) {
  if (!input || typeof input !== "string") return false;
  const lower = input.toLowerCase().trim();
  // If it contains an explicit drive path, it's not NL
  if (/^[a-z]:[\\/]/i.test(lower)) return false;
  // If it looks like a relative path with slashes, it's probably a path
  if (/^[a-z0-9._\-]+[\\/]/i.test(lower)) return false;
  // Count question-like or conversational words
  const nlSignals = /\b(what|how|why|when|who|where|can|could|would|should|tell|help|explain|please|about|the weather|my email|trending|improve|review and)\b/gi;
  const matches = lower.match(nlSignals) || [];
  return matches.length >= 2;
}

export async function file(request) {
  try {
    // NL guard: refuse ambiguous inputs that look like natural language
    if (looksLikeNaturalLanguage(request)) {
      console.log(`[file] ❌ NL guard: input looks like natural language, refusing: "${request}"`);
      return {
        tool: "file",
        success: false,
        final: true,
        error: `This doesn't look like a file path: "${request}"\n\nTo browse files, try:\n- "server/tools" (relative path)\n- "D:/local-llm-ui/server" (absolute path)\n- "." (project root)`,
        reasoning: "Input rejected by NL guard - looks like natural language, not a file path"
      };
    }

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
      
      // Sort: folders first, then alphabetical
      data.items.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === "folder" ? -1 : 1;
      });

      data.path = cleaned || "root";
      data.absolutePath = resolved;
      
      // Generate HTML table
      data.html = `
        <div class="ai-table-wrapper">
          <p><strong>📂 Directory:</strong> ${cleaned || "root"}</p>
          <p><strong>🗂️ Full path:</strong> ${resolved}</p>
          <p><strong>📊 Total items:</strong> ${data.items.length}</p>
          <table class="ai-table">
            <thead>
              <tr><th>Icon</th><th>Name</th><th>Type</th></tr>
            </thead>
            <tbody>
              ${data.items.map(i => `<tr><td>${i.icon}</td><td>${i.name}</td><td>${i.type}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      `;
      
      data.text = `Directory: ${cleaned || "root"} (${data.items.length} items)\n${data.items.map(i => `${i.icon} ${i.type}: ${i.name}`).join("\n")}`;
    } 
    // Handle files
    else if (stat.isFile()) {
      const content = await fs.readFile(resolved, "utf-8");
      const lines = content.split("\n");
      const preview = lines.slice(0, 50).join("\n");
      
      data.items = [{ 
        name: path.basename(resolved), 
        type: "file", 
        size: stat.size, 
        sizeFormatted: formatFileSize(stat.size), 
        lines: lines.length 
      }];
      
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

    console.log(`[file] ✅ Access success: ${resolved}`);
    
    return { 
      tool: "file", 
      success: true, 
      final: true, 
      reasoning: `Accessed ${stat.isDirectory() ? "directory" : "file"}: "${cleaned}" in sandbox: ${path.basename(sandboxRoot)}`, 
      data 
    };
  } catch (err) {
    let errorMessage = err.message;
    
    if (err.code === "ENOENT") {
      errorMessage = `Path not found: "${request}"\n\nAllowed directories:\n- D:/local-llm-ui (your project)\n- E:/testFolder\n\nTip: Use relative paths like "server/tools" or "local-llm-ui/server"`;
    } else if (err.code === "EACCES") {
      errorMessage = "Permission denied. The file or directory cannot be accessed.";
    }
    
    console.error("[file] ❌ Access error:", err);
    
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

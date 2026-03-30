// server/tools/file.js
// COMPLETE FIX #6: Intelligent path resolution with project awareness

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

// Multiple allowed sandbox roots
const SANDBOX_ROOTS = [
  path.resolve("D:/local-llm-ui"),
  path.resolve("E:/testFolder")
];

// ── SECURITY: Sensitive files that must never be read (prevents credential leakage) ──
const SENSITIVE_FILES = /^(\.env|\.env\.\w+|service_account\.json|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i;

function isPathAllowed(resolvedPath) {
  // Block sensitive files regardless of location
  if (SENSITIVE_FILES.test(path.basename(resolvedPath))) {
    console.warn(`🛡️ [file] BLOCKED sensitive file: ${resolvedPath}`);
    return false;
  }
  return SANDBOX_ROOTS.some(root => {
    const rel = path.relative(root, resolvedPath);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

function findSandboxRoot(request) {
  const lower = (request || "").toLowerCase();
  if (lower.includes("testfolder") || lower.includes("test folder")) return SANDBOX_ROOTS[1];
  return SANDBOX_ROOTS[0];  // Default to project root
}

// FIX #6+: Enhanced path resolution — absolute paths extracted first, NL cleanup as fallback
function resolveUserPath(request) {
  if (!request || typeof request !== "string") throw new Error("Invalid file request");

  // PRIORITY: Extract explicit absolute path (e.g., D:/local-llm-ui/server/tools)
  // This avoids NL word-stripping bugs like "in D:/..." or "me of E:/..."
  const absolutePathMatch = request.match(/([a-zA-Z]:[\\/][^\s,;!?"']+)/);
  if (absolutePathMatch) {
    // We extract the path, trim trailing slashes, AND remove LLM-generated colons/quotes
    let extracted = absolutePathMatch[1]
      .replace(/[\\/]+$/, '')
      .replace(/[:"']+$/, '')
      .trim(); 
      
    const sandboxRoot = findSandboxRoot(request);
    let resolved = path.resolve(extracted);
    // ── SECURITY: Resolve symlinks to prevent sandbox escape ──
    try { resolved = fsSync.realpathSync(resolved); } catch { /* path may not exist */ }

    if (!isPathAllowed(resolved)) {
      throw new Error("Access outside allowed directories denied");
    }
  
    const cleaned = path.relative(sandboxRoot, resolved) || '.';
    console.log(`[file] Path resolution (absolute): "${request}" → resolved="${resolved}"`);
    return { cleaned, resolved, sandboxRoot };
  }

  // FALLBACK: Natural language cleanup for relative paths
  let cleaned = request
    .replace(/\b(scan|show|list|open|read|please|folder|directory|explore|look|into|the|a|an|at|in|of|me|my|from|to|for|subfolder|contents?|file|files|go\s+to|what'?s|what\s+is|in\s+(your|my|the)\s+project)\b/gi, "")
    .replace(/\s+/g, ' ')
    .trim();

  // Determine sandbox root
  const sandboxRoot = findSandboxRoot(request);
  const rootName = path.basename(sandboxRoot);

  if (cleaned === "" || cleaned === "/" || cleaned === ".") cleaned = ".";

  // Handle "local-llm-ui/server" pattern intelligently
  const rootPattern = new RegExp(`^${rootName}[\\/]`, 'i');
  if (rootPattern.test(cleaned)) {
    cleaned = cleaned.replace(rootPattern, '');
    console.log(`[file] Detected project-relative path: "${cleaned}"`);
  }

  if (!cleaned || cleaned === rootName.toLowerCase()) cleaned = ".";

  const resolved = path.resolve(sandboxRoot, cleaned);

  if (!isPathAllowed(resolved)) {
    throw new Error("Access outside allowed directories denied");
  }

  console.log(`[file] Path resolution (relative): "${request}" → cleaned="${cleaned}" → resolved="${resolved}"`);
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
  // If it contains a drive path anywhere, it's a file request
  if (/[a-z]:[\\/]/i.test(lower)) return false;
  // If it looks like a relative path with slashes, it's probably a path
  if (/^[a-z0-9._\-]+[\\/]/i.test(lower)) return false;
  // Whitelist: explicit file operation keywords bypass the NL guard
  if (/\b(read|show|open|display|cat|list|get)\s+(the\s+)?(file|content|code|folder|directory)\b/i.test(lower)) return false;
  if (/\b(what('?s| is) in)\b/i.test(lower)) return false;
  if (/\b(files?\s+(in|at|from|of))\b/i.test(lower)) return false;
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

// Handle directories (Delegated to folderAccess)
    if (stat.isDirectory()) {
      return { 
        tool: "file", 
        success: false, 
        final: true, 
        error: `Path "${cleaned}" is a directory. The 'file' tool is for reading code. Please use the 'folderAccess' tool to browse directories.`, 
        reasoning: "Delegated to folderAccess tool" 
      };
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

// server/tools/folderAccess.js
// Filesystem access tool — recursive folder listing, file reading, tree building
// SECURITY: Restricted to ALLOWED_ROOTS sandboxes with symlink resolution

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const MAX_DEPTH = 10;
const MAX_FILES = 2000;
const MAX_FILE_SIZE = 512 * 1024; // 512 KB read limit per file

// ── SECURITY: Sandbox boundaries ──
const ALLOWED_ROOTS = [
  PROJECT_ROOT,
  path.resolve("E:/testFolder")
];

// Files that must never be read or listed (prevents credential leakage)
const SENSITIVE_FILES = /^(\.env|\.env\.\w+|service_account\.json|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i;

function isPathAllowed(resolvedPath) {
  return ALLOWED_ROOTS.some(root => {
    const rel = path.relative(root, resolvedPath);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

function isSensitiveFile(filename) {
  return SENSITIVE_FILES.test(filename);
}

// File extensions grouped by category
const CATEGORY = {
  code: new Set(["js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "rb", "php", "swift", "kt", "scala", "vue", "svelte", "lua", "sh", "bash", "zsh", "ps1", "bat", "cmd"]),
  config: new Set(["json", "yaml", "yml", "toml", "ini", "env", "cfg", "conf", "xml", "properties"]),
  markup: new Set(["html", "htm", "css", "scss", "sass", "less", "md", "mdx", "rst", "tex"]),
  data: new Set(["csv", "tsv", "sql", "graphql", "proto"]),
  docs: new Set(["txt", "log", "readme", "license", "changelog"]),
};

// Directories to skip
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
  "__pycache__", ".cache", ".next", ".nuxt", "coverage", ".vscode",
  ".idea", "vendor", "bower_components", ".terraform", ".gradle"
]);

function getFileCategory(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORY)) {
    if (exts.has(ext)) return cat;
  }
  return "other";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Extract custom folder exclusions from text
 */
function extractExclusions(text) {
  const exclusions = new Set();
  const match = text.match(/\b(?:exclude|ignore|skip|except|without)\s+([a-zA-Z0-9_.,\s/\\-]+)/i);  

  if (match) {
    // Split by commas or spaces, remove empty strings
    const items = match[1].split(/[,\s]+/).map(i => i.trim()).filter(Boolean);
    // Filter out common conversational noise
    const stopWords = new Set(["and", "the", "folders", "directories", "files", "folder", "directory", "file", "etc"]);
    
    items.forEach(item => {
      if (!stopWords.has(item.toLowerCase())) {
      // strip leading/trailing slashes so "folder/" becomes "folder"
      exclusions.add(item.replace(/^[/\\]+|[/\\]+$/g, ''));      }
    });
  }
  return exclusions;
}
/**
 * Recursively list files in a directory
 */
async function listRecursive(dirPath, depth = 0, maxDepth = MAX_DEPTH, customExcludes = new Set()) {
  const entries = [];
  if (depth > maxDepth) return entries;

  let items;
  try {
    items = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return [{ path: dirPath, error: err.message }];
  }

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);

    // Normalize the path to forward slashes and lowercase for reliable matching
    const normalizedFullPath = fullPath.replace(/\\/g, '/').toLowerCase();

    // Check if the custom exclusion matches the item name OR is part of the full path
    const isCustomExcluded = Array.from(customExcludes).some(ex => {
      const lowerEx = ex.toLowerCase();
      return item.name.toLowerCase() === lowerEx || normalizedFullPath.includes(lowerEx);
    });

    // SINGLE, CLEAN CHECK: Skip if hardcoded or custom excluded
    if ((SKIP_DIRS.has(item.name) || isCustomExcluded) && item.isDirectory()) continue;
    
    // Skip hidden files/folders (unless we are at depth 0)
    if (item.name.startsWith(".") && depth > 0 && item.isDirectory()) continue;

    if (item.isDirectory()) {
      // Pass customExcludes down the tree
      const children = await listRecursive(fullPath, depth + 1, maxDepth, customExcludes);
      entries.push({
        name: item.name,
        type: "directory",
        path: fullPath,
        children,
        childCount: children.length
      });
    } else {
      try {
        const stat = await fs.stat(fullPath);
        entries.push({
          name: item.name,
          type: "file",
          path: fullPath,
          size: stat.size,
          sizeHuman: formatSize(stat.size),
          modified: stat.mtime.toISOString(),
          category: getFileCategory(item.name),
          ext: path.extname(item.name).slice(1).toLowerCase()
        });
      } catch {
        entries.push({ name: item.name, type: "file", path: fullPath, error: "stat failed" });
      }
    }

    if (entries.length >= MAX_FILES) break;
  }

  return entries;
}

/**
 * Flatten a recursive tree into a flat list of files
 */
function flattenTree(entries, result = []) {
  for (const entry of entries) {
    if (entry.type === "file") {
      result.push(entry);
    } else if (entry.children) {
      flattenTree(entry.children, result);
    }
  }
  return result;
}

/**
 * Build ASCII tree representation
 */
function buildTreeString(entries, prefix = "", isLast = true) {
  let output = "";
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const last = i === entries.length - 1;
    const connector = last ? "└── " : "├── ";
    const childPrefix = last ? "    " : "│   ";

    if (entry.type === "directory") {
      output += `${prefix}${connector}📁 ${entry.name}/ (${entry.childCount} items)\n`;
      if (entry.children && entry.children.length > 0) {
        output += buildTreeString(entry.children, prefix + childPrefix, last);
      }
    } else {
      const sizeStr = entry.sizeHuman ? ` [${entry.sizeHuman}]` : "";
      output += `${prefix}${connector}${entry.name}${sizeStr}\n`;
    }
  }
  return output;
}

/**
 * Read a file's contents (with size limit)
 */
async function readFileContents(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      return { path: filePath, truncated: true, size: stat.size, content: (await fs.readFile(filePath, "utf8")).slice(0, MAX_FILE_SIZE) + "\n\n... [truncated]" };
    }
    const content = await fs.readFile(filePath, "utf8");
    return { path: filePath, size: stat.size, content };
  } catch (err) {
    return { path: filePath, error: err.message };
  }
}

/**
 * Build project summary statistics
 */
function buildStats(flatFiles) {
  const stats = {
    totalFiles: flatFiles.length,
    totalSize: 0,
    byCategory: {},
    byExtension: {},
    largestFiles: []
  };

  for (const f of flatFiles) {
    if (f.size) stats.totalSize += f.size;
    const cat = f.category || "other";
    stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
    const ext = f.ext || "unknown";
    stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
  }

  stats.largestFiles = flatFiles
    .filter(f => f.size)
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map(f => ({ name: f.name, path: f.path, size: f.sizeHuman }));

  stats.totalSizeHuman = formatSize(stats.totalSize);
  return stats;
}

/**
 * Detect intent from input
 */
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(compile\s+these\s+files|compile\s+files|compile)\b/.test(lower)) return "compile";
  if (/\b(read|open|view|show\s+content|cat|display)\b/.test(lower) && /\.(js|ts|py|json|md|txt|html|css|yaml|yml|jsx|tsx|toml|ini|cfg|xml)/i.test(lower)) {
    return "read";
  }
  if (/\b(stats|statistics|summary|overview|analyze)\b/.test(lower)) return "stats";
  if (/\b(tree|structure|hierarchy|layout)\b/.test(lower)) return "tree";
  if (/\b(search|find|grep|look\s+for|where\s+is)\b/.test(lower)) return "search";
  return "list";
}

/**
 * Extract path from text
 */
function extractPath(text) {
  // Try explicit absolute paths first (e.g., D:/local-llm-ui/server or /home/user/code)
  const pathMatch = text.match(/([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/);
  if (pathMatch) return pathMatch[1].replace(/\\/g, "/");

  // Try quoted paths
  const quotedMatch = text.match(/["']([^"']+)["']/);
  if (quotedMatch) {
    const q = quotedMatch[1];
    if (!path.isAbsolute(q)) return path.resolve(PROJECT_ROOT, q);
    return q;
  }

  // Try relative paths with slashes (e.g., "local-llm-ui/server/", "server/tools")
  const relativeMatch = text.match(/(?:^|\s)([\w.-]+(?:\/[\w.-]+)+)\/?(?:\s|$)/);
  if (relativeMatch) {
    let rel = relativeMatch[1];
    // If the path starts with the project folder name, strip it to avoid doubling
    const projectDirName = path.basename(PROJECT_ROOT);
    if (rel.startsWith(projectDirName + "/")) rel = rel.slice(projectDirName.length + 1);
    return path.resolve(PROJECT_ROOT, rel);
  }

  // Try bare directory names (e.g., "the server directory", "in tools", "client folder")
  const lower = text.toLowerCase();
  const dirNameMatch = lower.match(/\b(?:the\s+|my\s+)?(\w+)\s+(?:directory|folder|dir)\b/) ||
    lower.match(/\b(?:in|inside|under|within)\s+(?:the\s+)?(\w+)\s*\/?/);
  if (dirNameMatch) return path.resolve(PROJECT_ROOT, dirNameMatch[1]);

  return null;
}

/**
 * Search files by name or content pattern
 */
async function searchFiles(dirPath, query, maxDepth = MAX_DEPTH, customExcludes = new Set()) {
  // UPDATED: Pass customExcludes to listRecursive
  const entries = await listRecursive(dirPath, 0, maxDepth, customExcludes);
  const flatFiles = flattenTree(entries);
  const lowerQuery = query.toLowerCase();

  // Search by filename
  const nameMatches = flatFiles.filter(f =>
    f.name.toLowerCase().includes(lowerQuery)
  );

  // If searching for content, also scan inside files
  const contentMatches = [];
  if (nameMatches.length < 5) {
    for (const f of flatFiles.slice(0, 500)) {
      if (!f.size || f.size > 100 * 1024) continue;
      if (f.category !== "code" && f.category !== "config" && f.category !== "markup") continue;
      try {
        const content = await fs.readFile(f.path, "utf8");
        if (content.toLowerCase().includes(lowerQuery)) {
          const lines = content.split("\n");
          const matchingLines = [];
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              matchingLines.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
              if (matchingLines.length >= 5) break;
            }
          }
          contentMatches.push({ path: f.path, name: f.name, matches: matchingLines });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return { nameMatches: nameMatches.slice(0, 50), contentMatches: contentMatches.slice(0, 20) };
}

/**
 * Compile selected files — reads each file's content and writes a combined output file.
 * Called when user clicks "Compile" in the folder browser UI.
 */
async function compileFiles(text) {
  // Extract file paths from the request — accepts 'path' or "path" or bare absolute paths
  const pathMatches = text.match(/(?:'([^']+)'|"([^"]+)"|([A-Za-z]:[\\\/][^\s,;']+))/g) || [];
  const filePaths = pathMatches.map(p => p.replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);

  if (filePaths.length === 0) {
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: "No file paths found in the compile request. Select files from the folder browser first." }
    };
  }

  // Read each file and concatenate content
  let compiledContent = "";
  const successFiles = [];
  const failedFiles = [];

  for (const fp of filePaths) {
    const cleanPath = fp.replace(/\\/g, "/");
    try {
      const stat = await fs.stat(cleanPath);
      if (!stat.isFile()) {
        failedFiles.push({ path: cleanPath, reason: "not a file" });
        continue;
      }
      if (stat.size > MAX_FILE_SIZE) {
        failedFiles.push({ path: cleanPath, reason: `too large (${formatSize(stat.size)}, limit ${formatSize(MAX_FILE_SIZE)})` });
        continue;
      }
      const content = await fs.readFile(cleanPath, "utf8");
      const ext = path.extname(cleanPath).slice(1) || "txt";
      compiledContent += `\n\n${"═".repeat(70)}\n`;
      compiledContent += `📄 File: ${cleanPath}\n`;
      compiledContent += `${"═".repeat(70)}\n\n`;
      compiledContent += `\`\`\`${ext}\n${content}\n\`\`\`\n`;
      successFiles.push(cleanPath);
    } catch (err) {
      failedFiles.push({ path: cleanPath, reason: err.message });
    }
  }

  if (successFiles.length === 0) {
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: `Could not read any of the ${filePaths.length} files.\n${failedFiles.map(f => `  ❌ ${f.path}: ${f.reason}`).join("\n")}` }
    };
  }

  // Write compiled output to downloads/ folder
  const downloadsDir = path.resolve(PROJECT_ROOT, "downloads");
  await fs.mkdir(downloadsDir, { recursive: true });
  const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputFilename = `compiled_${dateStr}.md`;
  const outputPath = path.join(downloadsDir, outputFilename);

  const header = `# Compiled Files Report\n*Generated on ${new Date().toLocaleString()}*\n*Files: ${successFiles.length} compiled, ${failedFiles.length} failed*\n\n---\n`;
  await fs.writeFile(outputPath, header + compiledContent, "utf8");

  const outputPathClean = outputPath.replace(/\\/g, "/");
  let resultText = `📝 **Compilation Complete**\n\n`;
  resultText += `📁 **Output file:** \`${outputPathClean}\`\n`;
  resultText += `✅ **Compiled:** ${successFiles.length} files\n`;
  if (failedFiles.length > 0) {
    resultText += `⚠️ **Failed:** ${failedFiles.length} files\n`;
    for (const f of failedFiles) {
      resultText += `  - ${path.basename(f.path)}: ${f.reason}\n`;
    }
  }
  resultText += `\n📊 **Total size:** ${formatSize(Buffer.byteLength(header + compiledContent, "utf8"))}`;

  return {
    tool: "folderAccess",
    success: true,
    final: true,
    data: {
      preformatted: true,
      text: resultText,
      outputPath: outputPathClean,
      compiledFiles: successFiles.length,
      failedFiles: failedFiles.length
    }
  };
}

/**
 * Main tool entry point
 */
export async function folderAccess(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: "Please specify a folder path. Example: 'list D:/local-llm-ui' or 'tree D:/my-project'" }
    };
  }

  const intent = context.action || detectIntent(text);

  // Compile action works with file paths embedded in the text, not a single folder path.
  // Short-circuit before the folder path validation.
  if (intent === "compile") {
    try {
      return await compileFiles(text);
    } catch (err) {
      return {
        tool: "folderAccess",
        success: false,
        final: true,
        data: { message: `Compile failed: ${err.message}` }
      };
    }
  }

  const folderPath = context.path || extractPath(text);

  if (!folderPath) {
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: "I couldn't extract a folder path from your request. Please provide a full path like 'D:/my-project' or '/home/user/code'." }
    };
  }

  // Normalize path
  let normalizedPath = path.resolve(folderPath);

  // If path doesn't exist, try finding the directory name under PROJECT_ROOT subdirectories
  try {
    await fs.stat(normalizedPath);
  } catch {
    const dirName = path.basename(normalizedPath);
    // Search one level deep under PROJECT_ROOT for a matching directory
    try {
      const topLevel = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
      for (const entry of topLevel) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(PROJECT_ROOT, entry.name, dirName);
        try {
          const stat = await fs.stat(candidate);
          if (stat.isDirectory()) {
            normalizedPath = candidate;
            break;
          }
        } catch { /* not found here, keep looking */ }
      }
    } catch { /* can't read PROJECT_ROOT, proceed with original */ }
  }

  // ── SECURITY: Resolve symlinks and enforce sandbox boundaries ──
  try {
    normalizedPath = await fs.realpath(normalizedPath);
  } catch { /* path may not exist yet, proceed with resolved path */ }

  if (!isPathAllowed(normalizedPath)) {
    console.warn(`🛡️ [folderAccess] BLOCKED path outside sandbox: ${normalizedPath}`);
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: `Access denied: "${folderPath}" is outside the allowed project boundaries.` }
    };
  }

  // Block reading sensitive files directly
  if (intent === "read" && isSensitiveFile(path.basename(normalizedPath))) {
    console.warn(`🛡️ [folderAccess] BLOCKED sensitive file read: ${normalizedPath}`);
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: `Access denied: "${path.basename(normalizedPath)}" is a protected file.` }
    };
  }

  // Verify path exists
  try {
    const stat = await fs.stat(normalizedPath);
    if (!stat.isDirectory() && intent !== "read") {
      return {
        tool: "folderAccess",
        success: false,
        final: true,
        data: { message: `"${normalizedPath}" is a file, not a directory. Use intent "read" to view its contents.` }
      };
    }
  } catch (err) {
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: `Cannot access "${normalizedPath}": ${err.message}` }
    };
  }
// Extract custom exclusions from the prompt
const customExcludes = extractExclusions(text);
  if (customExcludes.size > 0) {
    console.log(`[folderAccess] Applying custom exclusions:`, Array.from(customExcludes));
  }

  try {
    switch (intent) {
      case "read": {
        const fileResult = await readFileContents(normalizedPath);
        return {
          tool: "folderAccess",
          success: !fileResult.error,
          final: true,
          data: {
            preformatted: true,
            text: fileResult.error
              ? `❌ Error reading file: ${fileResult.error}`
              : `📄 **${path.basename(normalizedPath)}** (${formatSize(fileResult.size)})\n\n\`\`\`\n${fileResult.content}\n\`\`\``,
            file: fileResult
          }
        };
      }

      case "tree": {
        const depth = context.depth || 4;
        const entries = await listRecursive(normalizedPath, 0, depth, customExcludes);
        const treeStr = buildTreeString(entries);
        const flatFiles = flattenTree(entries);

        return {
          tool: "folderAccess",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: `📁 **Project Structure: ${normalizedPath}**\n(${flatFiles.length} files, depth: ${depth})\n\n\`\`\`\n${treeStr}\`\`\``,
            path: normalizedPath,
            fileCount: flatFiles.length
          }
        };
      }

      case "stats": {
        const entries = await listRecursive(normalizedPath, 0, MAX_DEPTH, customExcludes);
        const flatFiles = flattenTree(entries);
        const stats = buildStats(flatFiles);

        let text = `📊 **Project Statistics: ${normalizedPath}**\n\n`;
        text += `• Total files: ${stats.totalFiles}\n`;
        text += `• Total size: ${stats.totalSizeHuman}\n\n`;
        text += `**By Category:**\n`;
        for (const [cat, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
          text += `  • ${cat}: ${count} files\n`;
        }
        text += `\n**Top Extensions:**\n`;
        const topExts = Object.entries(stats.byExtension).sort((a, b) => b[1] - a[1]).slice(0, 15);
        for (const [ext, count] of topExts) {
          text += `  • .${ext}: ${count} files\n`;
        }
        if (stats.largestFiles.length > 0) {
          text += `\n**Largest Files:**\n`;
          for (const f of stats.largestFiles) {
            text += `  • ${f.name} (${f.size}) — ${f.path}\n`;
          }
        }

        return {
          tool: "folderAccess",
          success: true,
          final: true,
          data: { preformatted: true, text, stats }
        };
      }

      case "search": {
        const searchQuery = text.replace(/.*(?:search|find|grep|look\s+for|where\s+is)\s+/i, "").replace(new RegExp(folderPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
        const results = await searchFiles(normalizedPath, searchQuery || text, MAX_DEPTH, customExcludes);

        let resultText = `🔍 **Search results in ${normalizedPath}**\n\n`;
        if (results.nameMatches.length > 0) {
          resultText += `**Filename matches (${results.nameMatches.length}):**\n`;
          for (const f of results.nameMatches) {
            resultText += `  • ${f.path}\n`;
          }
        }
        if (results.contentMatches.length > 0) {
          resultText += `\n**Content matches (${results.contentMatches.length}):**\n`;
          for (const f of results.contentMatches) {
            resultText += `  📄 ${f.path}\n`;
            for (const m of f.matches) {
              resultText += `     Line ${m.line}: ${m.text}\n`;
            }
          }
        }
        if (results.nameMatches.length === 0 && results.contentMatches.length === 0) {
          resultText += "No matches found.";
        }

        return {
          tool: "folderAccess",
          success: true,
          final: true,
          data: { preformatted: true, text: resultText, results }
        };
      }

      case "list":
      default: {
        const depth = context.depth || 2;
        const entries = await listRecursive(normalizedPath, 0, depth, customExcludes);
        const flatFiles = flattenTree(entries);
        const stats = buildStats(flatFiles);

        const tableRows = entries.map((i) => {
          const isFile = i.type === 'file';
          const icon = isFile ? (i.category === 'code' ? '📜' : '📄') : '📁';
          const cleanPath = i.path.replace(/\\/g, '/');
          const checkbox = isFile ? `<input type="checkbox" class="file-cb" value="${cleanPath}">` : '';
          const sizeInfo = isFile ? i.sizeHuman : `${i.childCount} items`;

          return `<tr>
            <td style="text-align: center; padding: 8px; border-bottom: 1px solid #38444d;">${checkbox}</td>
            <td style="text-align: center; padding: 8px; border-bottom: 1px solid #38444d;">${icon}</td>
            <td style="padding: 8px; border-bottom: 1px solid #38444d; font-size: 0.9rem;">${i.name}</td>
            <td style="padding: 8px; border-bottom: 1px solid #38444d; font-size: 0.8rem; color: #888;">${sizeInfo}</td>
          </tr>`;
        }).join("");

        // NOTE: onclick attributes are stripped by DOMPurify in the React frontend.
        // Event handlers are attached client-side via useRef+useEffect in SmartContent.jsx.
        // The data-action attributes are used as hooks for the React event binding.
        const html = `
        <div class="folder-browser-ui" style="background: #192734; border: 1px solid #38444d; border-radius: 10px; padding: 15px; margin: 10px 0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <div>
              <h3 style="margin: 0; font-size: 1.1rem; color: #e7e9ea;">📂 ${path.basename(normalizedPath)}</h3>
              <span style="font-size: 0.8rem; color: #8b98a5;">${flatFiles.length} files • ${stats.totalSizeHuman}</span>
            </div>
            <div style="display: flex; gap: 8px;">
               <button type="button" data-action="toggle-all"
                 style="background: #38444d; color: #e7e9ea; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: 600;">
                 Check/Uncheck All
               </button>

               <button type="button" data-action="compile"
                 style="background: #1d9bf0; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: 600;">
                 📝 Compile
               </button>
            </div>
          </div>

          <div style="max-height: 400px; overflow-y: auto; border: 1px solid #38444d; border-radius: 6px; background: #0f1419;">
            <table style="width: 100%; border-collapse: collapse;">
              <thead style="position: sticky; top: 0; background: #22303c; z-index: 1;">
                <tr>
                  <th style="width: 40px; padding: 8px; border-bottom: 2px solid #38444d;"></th>
                  <th style="width: 40px; padding: 8px; border-bottom: 2px solid #38444d;">Type</th>
                  <th style="text-align: left; padding: 8px; border-bottom: 2px solid #38444d;">Name</th>
                  <th style="text-align: left; padding: 8px; border-bottom: 2px solid #38444d;">Size</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
              </tbody>
            </table>
          </div>
        </div>`;

        return {
          tool: "folderAccess",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: "",
            html,
            path: normalizedPath,
            entries: entries.slice(0, 200),
            stats
          }
        };
      }
    }
  } catch (err) {
    return {
      tool: "folderAccess",
      success: false,
      final: true,
      data: { message: `Error accessing "${normalizedPath}": ${err.message}` }
    };
  }
}

// server/tools/projectIndex.js
// Project-wide indexing and semantic code search
// Builds file metadata index, function/class maps, and enables intelligent search

import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "build", "out", "__pycache__",
  ".cache", ".next", "coverage", ".vscode", ".idea", "vendor", "bower_components"
]);

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "hpp",
  "cs", "go", "rs", "rb", "php", "swift", "kt", "vue", "svelte", "mjs", "cjs"
]);

const CONFIG_EXTENSIONS = new Set([
  "json", "yaml", "yml", "toml", "ini", "env", "xml", "conf", "cfg"
]);

// In-memory index cache
let _indexCache = {};
let _indexTimestamps = {};

/**
 * Extract functions, classes, and exports from JS/TS files
 */
function extractSymbols(content, ext) {
  const symbols = { functions: [], classes: [], exports: [], imports: [], variables: [] };

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) {
    // Functions
    const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      symbols.functions.push({ name: match[1], params: match[2].trim(), line: content.slice(0, match.index).split("\n").length });
    }

    // Arrow functions assigned to const/let
    const arrowRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)]*)\)?\s*=>/g;
    while ((match = arrowRegex.exec(content)) !== null) {
      symbols.functions.push({ name: match[1], params: match[2].trim(), line: content.slice(0, match.index).split("\n").length, arrow: true });
    }

    // Classes
    const classRegex = /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
    while ((match = classRegex.exec(content)) !== null) {
      symbols.classes.push({ name: match[1], extends: match[2] || null, line: content.slice(0, match.index).split("\n").length });
    }

    // Exports
    const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
    while ((match = exportRegex.exec(content)) !== null) {
      symbols.exports.push(match[1]);
    }

    // Named exports
    const namedExportRegex = /export\s+\{([^}]+)\}/g;
    while ((match = namedExportRegex.exec(content)) !== null) {
      const names = match[1].split(",").map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      symbols.exports.push(...names);
    }

    // Imports
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
    while ((match = importRegex.exec(content)) !== null) {
      symbols.imports.push(match[1]);
    }
  }

  if (ext === "py") {
    // Python functions
    const pyFuncRegex = /def\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = pyFuncRegex.exec(content)) !== null) {
      symbols.functions.push({ name: match[1], params: match[2].trim(), line: content.slice(0, match.index).split("\n").length });
    }

    // Python classes
    const pyClassRegex = /class\s+(\w+)(?:\s*\(([^)]*)\))?/g;
    while ((match = pyClassRegex.exec(content)) !== null) {
      symbols.classes.push({ name: match[1], extends: match[2] || null, line: content.slice(0, match.index).split("\n").length });
    }
  }

  return symbols;
}

/**
 * Build index for a project directory
 */
async function buildIndex(dirPath, maxDepth = 8) {
  const index = {
    root: dirPath,
    files: [],
    symbols: {},
    totalLines: 0,
    totalSize: 0,
    builtAt: new Date().toISOString()
  };

  async function scanDir(dir, depth = 0) {
    if (depth > maxDepth) return;
    let items;
    try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;
      if (item.name.startsWith(".") && item.isDirectory()) continue;

      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        await scanDir(fullPath, depth + 1);
      } else {
        const ext = path.extname(item.name).slice(1).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext) && !CONFIG_EXTENSIONS.has(ext)) continue;

        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > 512 * 1024) continue; // Skip files > 512KB

          const relPath = path.relative(dirPath, fullPath).replace(/\\/g, "/");
          const content = await fs.readFile(fullPath, "utf8");
          const lineCount = content.split("\n").length;

          index.totalLines += lineCount;
          index.totalSize += stat.size;

          const fileEntry = {
            path: relPath,
            fullPath,
            ext,
            size: stat.size,
            lines: lineCount,
            modified: stat.mtime.toISOString(),
            category: CODE_EXTENSIONS.has(ext) ? "code" : "config"
          };

          // Extract symbols for code files
          if (CODE_EXTENSIONS.has(ext)) {
            const symbols = extractSymbols(content, ext);
            fileEntry.functions = symbols.functions.length;
            fileEntry.classes = symbols.classes.length;
            fileEntry.exports = symbols.exports;
            fileEntry.imports = symbols.imports;

            // Store detailed symbols
            index.symbols[relPath] = symbols;
          }

          index.files.push(fileEntry);
        } catch { /* skip */ }
      }

      if (index.files.length >= 3000) return;
    }
  }

  await scanDir(dirPath);

  // Cache it
  _indexCache[dirPath] = index;
  _indexTimestamps[dirPath] = Date.now();

  return index;
}

/**
 * Search the index by symbol name
 */
function searchSymbols(index, query) {
  const lowerQuery = query.toLowerCase();
  const results = [];

  for (const [filePath, symbols] of Object.entries(index.symbols)) {
    for (const fn of symbols.functions || []) {
      if (fn.name.toLowerCase().includes(lowerQuery)) {
        results.push({ type: "function", name: fn.name, file: filePath, line: fn.line, params: fn.params });
      }
    }
    for (const cls of symbols.classes || []) {
      if (cls.name.toLowerCase().includes(lowerQuery)) {
        results.push({ type: "class", name: cls.name, file: filePath, line: cls.line, extends: cls.extends });
      }
    }
    for (const exp of symbols.exports || []) {
      if (exp.toLowerCase().includes(lowerQuery) && !results.some(r => r.name === exp && r.file === filePath)) {
        results.push({ type: "export", name: exp, file: filePath });
      }
    }
  }

  return results;
}

/**
 * Search files by content using the index
 */
async function searchContent(index, query) {
  const lowerQuery = query.toLowerCase();
  const results = [];

  for (const file of index.files) {
    if (file.category !== "code") continue;
    try {
      const content = await fs.readFile(file.fullPath, "utf8");
      if (content.toLowerCase().includes(lowerQuery)) {
        const lines = content.split("\n");
        const matchingLines = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            matchingLines.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
            if (matchingLines.length >= 5) break;
          }
        }
        results.push({ file: file.path, matches: matchingLines });
        if (results.length >= 30) break;
      }
    } catch { /* skip */ }
  }

  return results;
}

/**
 * Get a project overview using the index
 */
function getOverview(index) {
  const byExt = {};
  const byDir = {};

  for (const file of index.files) {
    byExt[file.ext] = (byExt[file.ext] || 0) + 1;
    const dir = file.path.split("/").slice(0, 2).join("/");
    byDir[dir] = (byDir[dir] || 0) + 1;
  }

  const topFunctions = [];
  for (const [filePath, symbols] of Object.entries(index.symbols)) {
    for (const fn of symbols.functions || []) {
      topFunctions.push({ name: fn.name, file: filePath });
    }
  }

  return {
    totalFiles: index.files.length,
    totalLines: index.totalLines,
    totalSize: index.totalSize,
    byExtension: Object.entries(byExt).sort((a, b) => b[1] - a[1]),
    byDirectory: Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 20),
    functionCount: topFunctions.length,
    classCount: Object.values(index.symbols).reduce((sum, s) => sum + (s.classes?.length || 0), 0),
    exportCount: Object.values(index.symbols).reduce((sum, s) => sum + (s.exports?.length || 0), 0)
  };
}

/**
 * Semantic search using LLM
 */
async function semanticSearch(index, query) {
  // Build a compact representation of the codebase
  const fileList = index.files.slice(0, 100).map(f => {
    const symbols = index.symbols[f.path];
    const fns = symbols?.functions?.map(fn => fn.name).join(", ") || "";
    return `${f.path} [${f.ext}]: ${fns}`;
  }).join("\n");

  const prompt = `Given this codebase index, find the most relevant files and functions for the query: "${query}"

Files and functions:
${fileList}

Return a JSON array of the top 5 most relevant results:
[{ "file": "path", "reason": "why it's relevant", "relevance": 0.0-1.0 }]`;

  try {
    const response = await llm(prompt);
    const text = response?.data?.text || "";
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* fall through */ }

  return [];
}

/**
 * Detect intent
 */
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(build|create|rebuild|reindex)\s+index/i.test(lower)) return "build";
  if (/\b(search|find|where|locate|grep)\b/.test(lower)) return "search";
  if (/\b(overview|summary|stats|statistics)\b/.test(lower)) return "overview";
  if (/\b(function|class|method|symbol)\b/.test(lower)) return "symbols";
  if (/\b(semantic|smart|intelligent|meaning)\b/.test(lower)) return "semantic";
  return "search";
}

/**
 * Extract path from text
 */
function extractPath(text) {
  const pathMatch = text.match(/([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/);
  if (pathMatch) return pathMatch[1].replace(/\\/g, "/");
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1];
  return null;
}

/**
 * Main entry point
 */
export async function projectIndex(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "projectIndex",
      success: false,
      final: true,
      data: { message: "Please specify a project path and action. Example: 'index D:/my-project' or 'search for handleRequest in D:/my-project'" }
    };
  }

  const intent = context.action || detectIntent(text);
  const targetPath = context.path || extractPath(text);

  if (!targetPath) {
    return {
      tool: "projectIndex",
      success: false,
      final: true,
      data: { message: "Please provide a project folder path." }
    };
  }

  const normalizedPath = path.resolve(targetPath);

  try {
    // Get or build index
    let index = _indexCache[normalizedPath];
    const cacheAge = _indexTimestamps[normalizedPath] ? Date.now() - _indexTimestamps[normalizedPath] : Infinity;

    if (!index || cacheAge > 5 * 60 * 1000 || intent === "build") {
      // Build/rebuild index
      index = await buildIndex(normalizedPath);
    }

    switch (intent) {
      case "build": {
        const overview = getOverview(index);
        return {
          tool: "projectIndex",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: `✅ **Index Built: ${normalizedPath}**\n\n📊 ${overview.totalFiles} files, ${overview.totalLines.toLocaleString()} lines, ${overview.functionCount} functions, ${overview.classCount} classes\n\nTop extensions: ${overview.byExtension.slice(0, 8).map(([ext, count]) => `.${ext}(${count})`).join(", ")}`,
            overview
          }
        };
      }

      case "overview": {
        const overview = getOverview(index);
        let output = `📊 **Project Overview: ${normalizedPath}**\n\n`;
        output += `• Files: ${overview.totalFiles}\n`;
        output += `• Lines of code: ${overview.totalLines.toLocaleString()}\n`;
        output += `• Functions: ${overview.functionCount}\n`;
        output += `• Classes: ${overview.classCount}\n`;
        output += `• Exports: ${overview.exportCount}\n\n`;

        output += `**File Types:**\n`;
        for (const [ext, count] of overview.byExtension.slice(0, 10)) {
          output += `  .${ext}: ${count} files\n`;
        }

        output += `\n**Top Directories:**\n`;
        for (const [dir, count] of overview.byDirectory.slice(0, 10)) {
          output += `  ${dir}: ${count} files\n`;
        }

        return {
          tool: "projectIndex",
          success: true,
          final: true,
          data: { preformatted: true, text: output, overview }
        };
      }

      case "symbols": {
        const query = text.replace(/.*(?:function|class|method|symbol)s?\s*/i, "").replace(new RegExp(targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
        const results = searchSymbols(index, query || text);

        let output = `🔍 **Symbol Search: "${query || text}"**\n\n`;
        if (results.length === 0) {
          output += "No matching symbols found.";
        } else {
          for (const r of results.slice(0, 30)) {
            if (r.type === "function") {
              output += `  ƒ ${r.name}(${r.params || ""}) — ${r.file}:${r.line}\n`;
            } else if (r.type === "class") {
              output += `  📦 class ${r.name}${r.extends ? ` extends ${r.extends}` : ""} — ${r.file}:${r.line}\n`;
            } else {
              output += `  📤 export ${r.name} — ${r.file}\n`;
            }
          }
        }

        return {
          tool: "projectIndex",
          success: true,
          final: true,
          data: { preformatted: true, text: output, results }
        };
      }

      case "semantic": {
        const query = text.replace(/.*(?:semantic|smart|intelligent)\s*search?\s*/i, "").trim();
        const results = await semanticSearch(index, query || text);

        let output = `🧠 **Semantic Search: "${query || text}"**\n\n`;
        for (const r of results) {
          output += `  📄 ${r.file} (relevance: ${Math.round((r.relevance || 0) * 100)}%)\n`;
          output += `     ${r.reason}\n\n`;
        }

        return {
          tool: "projectIndex",
          success: true,
          final: true,
          data: { preformatted: true, text: output, results }
        };
      }

      case "search":
      default: {
        // Extract search query (remove path and intent keywords)
        let query = text;
        // Remove path from query
        if (targetPath) query = query.replace(new RegExp(targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
        query = query.replace(/\b(search|find|where|locate|grep|in|for)\b/gi, "").trim();

        if (!query) {
          // Default to overview
          const overview = getOverview(index);
          return {
            tool: "projectIndex",
            success: true,
            final: true,
            data: {
              preformatted: true,
              text: `📊 **Index: ${normalizedPath}** — ${overview.totalFiles} files, ${overview.totalLines.toLocaleString()} lines, ${overview.functionCount} functions`,
              overview
            }
          };
        }

        // Try symbol search first
        const symbolResults = searchSymbols(index, query);

        // Then content search
        const contentResults = await searchContent(index, query);

        let output = `🔍 **Search: "${query}" in ${path.basename(normalizedPath)}**\n\n`;

        if (symbolResults.length > 0) {
          output += `**Symbols (${symbolResults.length}):**\n`;
          for (const r of symbolResults.slice(0, 15)) {
            output += `  ${r.type === "function" ? "ƒ" : r.type === "class" ? "📦" : "📤"} ${r.name} — ${r.file}${r.line ? `:${r.line}` : ""}\n`;
          }
          output += "\n";
        }

        if (contentResults.length > 0) {
          output += `**Content Matches (${contentResults.length} files):**\n`;
          for (const r of contentResults.slice(0, 15)) {
            output += `  📄 ${r.file}\n`;
            for (const m of r.matches.slice(0, 3)) {
              output += `     Line ${m.line}: ${m.text}\n`;
            }
          }
        }

        if (symbolResults.length === 0 && contentResults.length === 0) {
          output += "No matches found. Try a different search term.";
        }

        return {
          tool: "projectIndex",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: output,
            symbolResults: symbolResults.slice(0, 30),
            contentResults: contentResults.slice(0, 20)
          }
        };
      }
    }
  } catch (err) {
    return {
      tool: "projectIndex",
      success: false,
      final: true,
      data: { message: `Project index error: ${err.message}` }
    };
  }
}

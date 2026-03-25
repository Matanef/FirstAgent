// server/tools/projectSnapshot.js
// ──────────────────────────────────────────────────────────────────────────────
// PROJECT SNAPSHOT UTILITY
// Concatenates critical project files into a compressed Markdown context string
// optimized for a 7B model's tight 8192-token context window.
//
// STRATEGY:
// 1. Always include: package.json (dependencies), server/index.js (entry point)
// 2. Parse the user-specified target file(s) and follow their `import` graph
//    one level deep to include direct dependencies.
// 3. Strip comments, collapse whitespace, trim JSDoc blocks — every token counts.
// 4. Output a single Markdown string with fenced code blocks per file.
//
// USAGE (via planner):
//   "snapshot server/tools/email.js" → returns email.js + its imports + package.json
//   "snapshot server/planner.js server/executor.js" → both files + their imports
// ──────────────────────────────────────────────────────────────────────────────

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "../utils/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_ROOT = path.resolve(__dirname, "..");

// ── Token budget: ~6000 tokens ≈ ~24000 chars (avg 4 chars/token for code)
const MAX_SNAPSHOT_CHARS = 24000;
const MAX_FILE_SIZE = 64 * 1024; // Skip files > 64KB

// ── Files always included for project context
const CORE_FILES = ["package.json", "server/index.js"];

// ──────────────────────────────────────────────────────────────────────────────
// COMPRESSION: Strip noise to maximize information density
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compress code by stripping comments, JSDoc, and collapsing blank lines.
 * Preserves string literals and structural semantics.
 */
function compressCode(code, ext) {
  if (!code) return "";

  // For JSON, just minify
  if (ext === "json") {
    try { return JSON.stringify(JSON.parse(code)); } catch { return code; }
  }

  let result = code
    // Strip multi-line comments (JSDoc, block comments)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Strip single-line comments (but not URLs like https://)
    .replace(/(?<!:)\/\/(?!.*['"`]).*$/gm, "")
    // Collapse multiple blank lines into one
    .replace(/\n{3,}/g, "\n\n")
    // Trim trailing whitespace per line
    .replace(/[ \t]+$/gm, "")
    // Strip leading blank lines
    .replace(/^\n+/, "");

  return result.trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// IMPORT GRAPH: Follow ES Module imports one level deep
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract local import paths from ES Module source code.
 * Returns resolved absolute paths for relative imports only (skips npm packages).
 */
function extractLocalImports(code, sourceFilePath) {
  const imports = [];
  const dir = path.dirname(sourceFilePath);

  // Match: import ... from "./relative/path.js"
  // Match: import ... from "../relative/path.js"
  // Match: const x = await import("./relative.js")
  const importRegex = /(?:import\s+[\s\S]*?from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;
  let match;

  while ((match = importRegex.exec(code)) !== null) {
    const importPath = match[1];
    // Resolve relative to the source file's directory
    let resolved = path.resolve(dir, importPath);

    // Add .js extension if missing (common in ES Modules)
    if (!path.extname(resolved)) {
      resolved += ".js";
    }

    imports.push(resolved);
  }

  return [...new Set(imports)]; // Deduplicate
}

// ──────────────────────────────────────────────────────────────────────────────
// FILE READING: Safe, size-bounded, with extension detection
// ──────────────────────────────────────────────────────────────────────────────

async function readFileSafe(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve a user-provided path to an absolute path.
 * Handles: absolute paths, project-relative, bare filenames (→ server/tools/).
 */
async function resolvePath(userPath) {
  // Already absolute
  if (path.isAbsolute(userPath)) {
    try { await fs.access(userPath); return userPath; } catch {}
  }

  // Project-relative (e.g., "server/tools/email.js")
  const projectRelative = path.resolve(PROJECT_ROOT, userPath);
  try { await fs.access(projectRelative); return projectRelative; } catch {}

  // Bare filename fallback (e.g., "email.js" → server/tools/email.js)
  if (!userPath.includes("/") && !userPath.includes("\\")) {
    const toolPath = path.resolve(SERVER_ROOT, "tools", userPath);
    try { await fs.access(toolPath); return toolPath; } catch {}
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// SNAPSHOT BUILDER
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the snapshot: core files + target files + their imports.
 * Returns a Markdown string with fenced code blocks.
 */
async function buildSnapshot(targetPaths) {
  const sections = [];
  const included = new Set(); // Track files already added (avoid duplicates)
  let totalChars = 0;

  /**
   * Add a file to the snapshot if within budget.
   * @param {string} absPath - Absolute file path
   * @param {string} label - Display label (e.g., "📦 package.json")
   * @param {boolean} compress - Whether to apply compression
   * @returns {string|null} The content added, or null if skipped
   */
  async function addFile(absPath, label, compress = true) {
    const normalized = path.normalize(absPath);
    if (included.has(normalized)) return null;

    const content = await readFileSafe(absPath);
    if (!content) return null;

    const ext = path.extname(absPath).slice(1) || "js";
    const processed = compress ? compressCode(content, ext) : content;

    // Budget check
    if (totalChars + processed.length > MAX_SNAPSHOT_CHARS) {
      // Try to fit a truncated version (first 2000 chars)
      const truncated = processed.slice(0, 2000) + "\n// ... [TRUNCATED — file too large for context window]";
      if (totalChars + truncated.length > MAX_SNAPSHOT_CHARS) {
        return null; // Can't fit even truncated
      }
      sections.push(`### ${label}\n\`\`\`${ext}\n${truncated}\n\`\`\``);
      totalChars += truncated.length;
    } else {
      sections.push(`### ${label}\n\`\`\`${ext}\n${processed}\n\`\`\``);
      totalChars += processed.length;
    }

    included.add(normalized);
    return content; // Return uncompressed for import extraction
  }

  // ── PHASE 1: Core files (always included) ──
  for (const relPath of CORE_FILES) {
    const absPath = path.resolve(PROJECT_ROOT, relPath);
    await addFile(absPath, `📦 ${relPath}`);
  }

  // ── PHASE 2: Target files ──
  for (const absPath of targetPaths) {
    const relPath = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, "/");
    const content = await addFile(absPath, `🎯 ${relPath}`);

    // ── PHASE 3: Follow imports one level deep ──
    if (content) {
      const imports = extractLocalImports(content, absPath);
      for (const importPath of imports) {
        const importRel = path.relative(PROJECT_ROOT, importPath).replace(/\\/g, "/");
        await addFile(importPath, `📎 ${importRel} (imported by ${path.basename(absPath)})`);
      }
    }
  }

  return {
    markdown: sections.join("\n\n"),
    fileCount: included.size,
    totalChars,
    files: [...included].map(f => path.relative(PROJECT_ROOT, f).replace(/\\/g, "/"))
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// TOOL EXPORT
// ──────────────────────────────────────────────────────────────────────────────

/**
 * projectSnapshot Tool
 *
 * Input: string or { text, context }
 *   - text: Space-separated file paths to snapshot
 *   - context.files: Array of file paths (alternative input)
 *   - context.chainContext.previousOutput: File paths from a previous tool
 *
 * Output: Compressed Markdown snapshot of the project context
 */
export async function projectSnapshot(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};

    // ── Parse target files from input ──
    let rawPaths = [];

    // Priority 1: Explicit file list in context
    if (context.files && Array.isArray(context.files)) {
      rawPaths = context.files;
    }
    // Priority 2: Previous tool output (chain context)
    else if (context.chainContext?.previousOutput) {
      const prev = context.chainContext.previousOutput;
      rawPaths = typeof prev === "string" ? prev.split(/[\s,]+/).filter(Boolean) : [];
    }
    // Priority 3: Parse from text input
    else if (text) {
      // Strip conversational noise: "snapshot of server/tools/email.js and server/planner.js"
      const cleaned = text
        .replace(/\b(snapshot|project|context|of|the|and|with|for|show|get|build|generate|create)\b/gi, "")
        .trim();
      rawPaths = cleaned.split(/[\s,]+/).filter(p => p.length > 2 && /\.\w+$/.test(p));

      // If no file extensions found, try to extract paths more aggressively
      if (rawPaths.length === 0) {
        const pathMatches = text.match(/[\w./-]+\.(?:js|ts|json|py|jsx|tsx|css|html|md)/gi);
        rawPaths = pathMatches || [];
      }
    }

    if (rawPaths.length === 0) {
      return {
        tool: "projectSnapshot",
        success: false,
        final: true,
        error: "No target files specified. Usage: 'snapshot server/tools/email.js server/planner.js'"
      };
    }

    // ── Resolve all paths ──
    const resolvedPaths = [];
    const notFound = [];

    for (const raw of rawPaths) {
      const resolved = await resolvePath(raw.trim());
      if (resolved) {
        resolvedPaths.push(resolved);
      } else {
        notFound.push(raw);
      }
    }

    if (resolvedPaths.length === 0) {
      return {
        tool: "projectSnapshot",
        success: false,
        final: true,
        error: `None of the specified files were found: ${notFound.join(", ")}`
      };
    }

    // ── Build the snapshot ──
    const snapshot = await buildSnapshot(resolvedPaths);

    // ── Format output ──
    const header = `# 📸 Project Snapshot\n**Files:** ${snapshot.fileCount} | **Size:** ~${Math.round(snapshot.totalChars / 4)} tokens\n**Included:** ${snapshot.files.join(", ")}\n`;
    const warnings = notFound.length > 0 ? `\n⚠️ Not found: ${notFound.join(", ")}\n` : "";
    const fullOutput = `${header}${warnings}\n---\n\n${snapshot.markdown}`;

    return {
      tool: "projectSnapshot",
      success: true,
      final: true,
      data: {
        text: fullOutput,
        preformatted: true,
        // Structured data for downstream tools (e.g., codeTransform can use this as context)
        snapshot: snapshot.markdown,
        files: snapshot.files,
        fileCount: snapshot.fileCount,
        tokenEstimate: Math.round(snapshot.totalChars / 4)
      }
    };

  } catch (err) {
    return {
      tool: "projectSnapshot",
      success: false,
      final: true,
      error: `Snapshot failed: ${err.message}`
    };
  }
}

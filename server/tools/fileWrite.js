// server/tools/fileWrite.js
// File writing capability — supports structured input { path, content } AND natural language

import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";

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
 * Internal: perform the actual file write
 */
async function performWrite(requestedPath, content, mode = "write", backup = true) {
  const resolved = path.resolve(requestedPath);

  if (!isPathWritable(resolved)) {
    return { tool: "fileWrite", success: false, final: true, error: "Writing outside allowed directories is not permitted" };
  }

  const filename = path.basename(resolved);
  if (filename.toLowerCase() === "memory.json") {
    return { tool: "fileWrite", success: false, final: true, error: "Direct modification of memory.json via fileWrite is disabled for safety." };
  }

  if (isProtected(filename)) {
    if (!backup) {
      return { tool: "fileWrite", success: false, final: true, error: `${filename} is protected. Set backup=true to modify it.` };
    }
    const backupPath = await createBackup(resolved);
    if (!backupPath) {
      return { tool: "fileWrite", success: false, final: true, error: `Failed to create backup of ${filename}` };
    }
    console.log(`📦 Created backup: ${backupPath}`);
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });

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
}

/**
 * Handle natural language write requests (e.g., "Write a hello world script to D:/test.js")
 * Uses LLM to generate the file content, then writes it.
 */
async function handleNaturalLanguageWrite(text, context = {}) {
  // Extract file path from text or context
  const pathMatch = text.match(/([a-zA-Z]:[\\/][^\s,;!?"']+)/);
  const targetPath = context?.targetPath || (pathMatch ? pathMatch[1] : null);

  if (!targetPath) {
    return {
      tool: "fileWrite",
      success: false,
      final: true,
      error: "No file path found. Please specify where to write, e.g., 'Write hello world to D:/test.js'"
    };
  }

  // Determine language from file extension
  const ext = path.extname(targetPath).toLowerCase();
  const langMap = {
    '.js': 'JavaScript', '.py': 'Python', '.html': 'HTML', '.css': 'CSS',
    '.json': 'JSON', '.ts': 'TypeScript', '.jsx': 'React JSX', '.tsx': 'React TSX',
    '.md': 'Markdown', '.txt': 'Plain text', '.sh': 'Bash', '.bat': 'Batch',
    '.yaml': 'YAML', '.yml': 'YAML', '.xml': 'XML', '.sql': 'SQL'
  };
  const lang = langMap[ext] || ext.replace('.', '').toUpperCase() || 'text';

  console.log(`📝 fileWrite NL: generating ${lang} content for ${targetPath}`);

  const prompt = `Generate ONLY the raw file content for this request. No markdown code fences, no explanation, no preamble — JUST the file content that should be saved directly to disk.

Request: "${text}"
File: ${targetPath}
Language: ${lang}

File content:`;

  try {
    const result = await llm(prompt);
    let generatedContent = result.data?.text || "";

    if (!generatedContent.trim()) {
      return { tool: "fileWrite", success: false, final: true, error: "Failed to generate file content from the request." };
    }

    // Clean up markdown fences if LLM added them despite instructions
    let cleanContent = generatedContent.trim();
    if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Write using the structured path
    return await performWrite(targetPath, cleanContent);
  } catch (err) {
    return { tool: "fileWrite", success: false, final: true, error: `Content generation failed: ${err.message}` };
  }
}

/**
 * Write or modify a file
 * Supports:
 *   - Structured input: { path, content, mode, backup }
 *   - Natural language: string like "Write a hello world script to D:/test.js"
 *   - Message object: { text: "...", context: { targetPath: "..." } }
 */
export async function fileWrite(request) {
  try {
    // Handle natural language string input
    if (typeof request === "string") {
      return await handleNaturalLanguageWrite(request);
    }

    // Handle message object from coordinator (text + context, no path/content)
    if (request && request.text && !request.path) {
      return await handleNaturalLanguageWrite(request.text, request.context);
    }

    // Handle structured input { path, content, mode, backup }
    const { path: requestedPath, content, mode = "write", backup = true } = request;

    if (!requestedPath || !content) {
      return { tool: "fileWrite", success: false, final: true, error: "Path and content are required" };
    }

    return await performWrite(requestedPath, content, mode, backup);

  } catch (err) {
    return { tool: "fileWrite", success: false, final: true, error: `File write failed: ${err.message}` };
  }
}

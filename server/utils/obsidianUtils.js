// server/utils/obsidianUtils.js
// Shared vault I/O, HTML stripper, Canvas generator for Obsidian Knowledge OS
// Used by: obsidianWriter, deepResearch, gitPulse skills

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";

// ============================================================
// VAULT PATH — Resolved from env var
// ============================================================

/**
 * Get the configured Obsidian vault path.
 * @returns {string|null} Absolute path to vault root, or null if not configured
 */
export function getVaultPath() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) return null;
  return path.resolve(vaultPath);
}

// ============================================================
// VAULT LAYOUT — Single source of truth for folder structure
// ============================================================
//
// OBSIDIAN_VAULT_PATH already points to the agent's dedicated vault
// (e.g. .../Obsidian/Autonomous_AI), so these are direct subfolders.
//
//   <vault>/
//     Stubs/     ← new [[wikilink]] stubs land here when first created
//     Notes/     ← stubs move here after they get populated (promotion)
//     Journal/   ← main projects: deepResearch theses/masters/article notes
//
export const VAULT_STUBS_ROOT   = "Stubs";
export const VAULT_NOTES_ROOT   = "Notes";
export const VAULT_JOURNAL_ROOT = "Journal";

/**
 * Security guard — resolve a relative path against vault root
 * and reject anything that escapes the vault boundary.
 * @param {string} relativePath - Path relative to vault root
 * @returns {string} Absolute path within vault
 * @throws {Error} If path escapes vault root
 */
export function safePath(relativePath) {
  const vault = getVaultPath();
  if (!vault) throw new Error("OBSIDIAN_VAULT_PATH not configured");

  // Normalize and resolve
  const resolved = path.resolve(vault, relativePath);

  // Security: must stay within vault
  if (!resolved.startsWith(vault + path.sep) && resolved !== vault) {
    throw new Error(`Path traversal blocked: "${relativePath}" escapes vault root`);
  }

  return resolved;
}

// ============================================================
// NOTE I/O
// ============================================================

/**
 * Write a note to the vault.
 * @param {string} relativePath - Path relative to vault root (e.g., "Research/topic.md")
 * @param {string} content - Markdown content
 * @param {Object} options
 * @param {boolean} options.append - Append instead of overwrite
 * @param {string} options.separator - Separator before appended content (default: "\n\n---\n\n")
 * @returns {{ success: boolean, fullPath: string }}
 */
export async function writeNote(relativePath, content, { append = false, separator = "\n\n---\n\n" } = {}) {
  // Auto-add .md extension if missing
  if (!relativePath.endsWith(".md") && !relativePath.endsWith(".canvas")) {
    relativePath += ".md";
  }

  const fullPath = safePath(relativePath);
  const dir = path.dirname(fullPath);

  // Ensure parent directories exist
  await fs.mkdir(dir, { recursive: true });

  if (append && fsSync.existsSync(fullPath)) {
    const existing = await fs.readFile(fullPath, "utf8");
    await fs.writeFile(fullPath, existing + separator + content, "utf8");
  } else {
    await fs.writeFile(fullPath, content, "utf8");
  }

  return { success: true, fullPath };
}

/**
 * Read a note from the vault.
 * @param {string} relativePath - Path relative to vault root
 * @returns {string|null} File contents, or null if not found
 */
export async function readNote(relativePath) {
  if (!relativePath.endsWith(".md") && !relativePath.endsWith(".canvas")) {
    relativePath += ".md";
  }

  const fullPath = safePath(relativePath);

  try {
    return await fs.readFile(fullPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Create a folder in the vault with optional MOC (Map of Content) index.
 * @param {string} relativePath - Folder path relative to vault root
 * @param {Object} options
 * @param {boolean} options.createMOC - Create an index note in the folder
 * @param {string} options.mocTitle - Title for the MOC note
 * @returns {{ success: boolean, fullPath: string }}
 */
export async function createFolder(relativePath, { createMOC = false, mocTitle = "" } = {}) {
  const fullPath = safePath(relativePath);
  await fs.mkdir(fullPath, { recursive: true });

  if (createMOC) {
    const folderName = path.basename(relativePath);
    const title = mocTitle || folderName;
    const mocContent = `---
title: "${title}"
type: moc
created: ${new Date().toISOString()}
---

# ${title}

> Map of Content for ${folderName}

## Notes

`;
    const mocPath = path.join(fullPath, `${folderName}.md`);
    await fs.writeFile(mocPath, mocContent, "utf8");
  }

  return { success: true, fullPath };
}

/**
 * List notes in a vault folder (non-recursive by default).
 * @param {string} relativePath - Folder path relative to vault root (empty = vault root)
 * @param {Object} options
 * @param {boolean} options.recursive - Recurse into subdirectories
 * @returns {string[]} Array of relative paths
 */
export async function listNotes(relativePath = "", { recursive = false } = {}) {
  const fullPath = safePath(relativePath || ".");
  const results = [];

  async function scan(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip Obsidian internal folders
      if (entry.name.startsWith(".")) continue;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".canvas"))) {
        results.push(rel);
      } else if (entry.isDirectory() && recursive) {
        await scan(path.join(dir, entry.name), rel);
      }
    }
  }

  await scan(fullPath, relativePath || "");
  return results;
}

// ============================================================
// CANVAS GENERATION
// ============================================================

/**
 * Generate an Obsidian .canvas JSON file.
 * Nodes are placed in a grid layout automatically.
 *
 * @param {Array<{id?: string, text: string, file?: string, type?: string, color?: string}>} nodes
 * @param {Array<{from: string, to: string, label?: string}>} edges - Optional connections
 * @param {Object} options
 * @param {number} options.colWidth - Column width in canvas units (default: 400)
 * @param {number} options.rowHeight - Row height (default: 300)
 * @param {number} options.cols - Max columns before wrapping (default: 4)
 * @returns {string} JSON string for .canvas file
 */
export function generateCanvas(nodes, edges = [], { colWidth = 400, rowHeight = 300, cols = 4 } = {}) {
  const canvasNodes = nodes.map((node, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const id = node.id || crypto.randomUUID().slice(0, 8);

    const canvasNode = {
      id,
      x: col * colWidth,
      y: row * rowHeight,
      width: colWidth - 40,
      height: rowHeight - 40,
    };

    if (node.file) {
      // Link to existing note
      canvasNode.type = "file";
      canvasNode.file = node.file;
    } else {
      // Text card
      canvasNode.type = "text";
      canvasNode.text = node.text || "";
    }

    if (node.color) canvasNode.color = node.color;

    // Store back the generated id for edge resolution
    node._resolvedId = id;
    return canvasNode;
  });

  const canvasEdges = edges.map(edge => ({
    id: crypto.randomUUID().slice(0, 8),
    fromNode: edge.from,
    toNode: edge.to,
    fromSide: edge.fromSide || "right",
    toSide: edge.toSide || "left",
    label: edge.label || undefined,
  }));

  return JSON.stringify({ nodes: canvasNodes, edges: canvasEdges }, null, 2);
}

// ============================================================
// HTML → TEXT STRIPPER (for web scraping results)
// ============================================================

/**
 * Multi-pass regex HTML stripper.
 * Not a full parser — handles common web page content well enough for research extraction.
 * @param {string} html - Raw HTML string
 * @returns {string} Clean text content
 */
export function stripHtmlToText(html) {
  if (!html || typeof html !== "string") return "";

  let text = html;

  // Pass 1: Remove script, style, noscript, svg, head blocks entirely
  text = text.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Pass 2: Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|main|aside)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Pass 3: Strip all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Pass 4: Decode common HTML entities
  const entities = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&ndash;": "–",
    "&mdash;": "—", "&hellip;": "…", "&copy;": "©", "&reg;": "®",
    "&trade;": "™", "&laquo;": "«", "&raquo;": "»",
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }
  // Numeric entities
  text = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Pass 5: Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");          // horizontal whitespace
  text = text.replace(/\n{3,}/g, "\n\n");         // excessive newlines
  text = text.replace(/^\s+|\s+$/gm, "");         // trim each line

  return text.trim();
}

// ============================================================
// WIKILINK RESOLUTION + STUB CREATION
// ============================================================

/**
 * Scan content for [[wikilinks]] and optionally create stub notes.
 * @param {string} content - Markdown content with [[wikilinks]]
 * @param {Object} options
 * @param {boolean} options.createStubs - Create stub notes for links that don't exist
 * @param {string} options.stubFolder - Folder for stubs (default: same folder context, or vault root)
 * @returns {string[]} List of created stub paths (relative to vault)
 */
export async function resolveWikilinks(content, { createStubs = true, stubFolder = VAULT_STUBS_ROOT } = {}) {
  const vault = getVaultPath();
  if (!vault || !content) return [];

  // Extract all [[wikilinks]] — handles [[link]] and [[link|alias]]
  const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links = new Set();
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    links.add(match[1].trim());
  }

  console.log(`[obsidianUtils] resolveWikilinks: found ${links.size} wikilinks in draft, stubFolder="${stubFolder}"`);
  if (links.size === 0) {
    console.log(`[obsidianUtils] resolveWikilinks: no [[wikilinks]] found — LLM may not have generated them. Stubs skipped.`);
    return [];
  }

  const createdStubs = [];

  for (const link of links) {
    // Wikilinks may contain path separators (e.g. [[Journal/Research/foo/bar]]).
    // Strip the path and use only the terminal title — stubs always land flat
    // under VAULT_STUBS_ROOT so they're easy to find and promote later.
    const linkTitle = link.split("/").pop();

    // Skip stub creation for links that already resolve somewhere in the vault
    // (Obsidian resolves [[X]] by filename anywhere under the vault, so a stub
    // at Stubs/X.md would be redundant if a Notes/X.md or Journal/X.md exists).
    const resolvedElsewhere = await wikilinkResolvesInVault(linkTitle);
    if (resolvedElsewhere) {
      console.log(`[obsidianUtils] resolveWikilinks: skipping [[${linkTitle}]] — already exists in vault`);
      continue;
    }

    const relativePath = stubFolder ? `${stubFolder}/${linkTitle}.md` : `${linkTitle}.md`;
    const fullPath = safePath(relativePath);

    try {
      await fs.access(fullPath);
      // File exists — skip
      console.log(`[obsidianUtils] resolveWikilinks: skipping [[${linkTitle}]] — stub already exists`);
    } catch {
      // File doesn't exist — create stub if requested
      if (createStubs) {
        const stubContent = `---
title: "${linkTitle}"
status: stub
created: ${new Date().toISOString()}
---

# ${linkTitle}

> [!stub] This note is a stub
> Created automatically from a wikilink in a research document. Awaiting content.
`;
        try {
          const dir = path.dirname(fullPath);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(fullPath, stubContent, "utf8");
          createdStubs.push(relativePath);
          console.log(`[obsidianUtils] resolveWikilinks: ✅ created stub "${relativePath}"`);
        } catch (writeErr) {
          console.error(`[obsidianUtils] resolveWikilinks: ❌ failed to write stub "${relativePath}": ${writeErr.message}`);
        }
      }
    }
  }

  console.log(`[obsidianUtils] resolveWikilinks: created ${createdStubs.length}/${links.size} stubs`);
  return createdStubs;
}

/**
 * Check whether a wikilink target (by bare title) resolves to any .md file
 * anywhere under the vault. Obsidian's link resolver is filename-based, so
 * Stubs/X.md, Notes/X.md, and Journal/X.md are all equivalent targets for
 * [[X]]. This prevents us from creating duplicate stubs when a note with
 * the same title already exists elsewhere.
 */
async function wikilinkResolvesInVault(title) {
  const vault = getVaultPath();
  if (!vault || !title) return false;
  const targetName = `${title}.md`.toLowerCase();

  async function scan(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return false; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isFile() && e.name.toLowerCase() === targetName) return true;
      if (e.isDirectory()) {
        const found = await scan(path.join(dir, e.name));
        if (found) return true;
      }
    }
    return false;
  }
  return await scan(vault);
}

/**
 * Promote a stub to the Notes folder. Used after populateStubs successfully
 * fills in a stub's content — the file is moved from VAULT_STUBS_ROOT into
 * VAULT_NOTES_ROOT so the vault stays organized.
 *
 * @param {string} sourceRelative - stub path relative to vault root (e.g., "Autonomous_AI/Stubs/Dataview.md")
 * @returns {Promise<{ success: boolean, from: string, to: string, error?: string }>}
 */
export async function promoteStubToNotes(sourceRelative) {
  try {
    const vault = getVaultPath();
    if (!vault) return { success: false, from: sourceRelative, to: "", error: "OBSIDIAN_VAULT_PATH not set" };

    const sourceFull = safePath(sourceRelative);
    const filename = path.basename(sourceFull);
    const destRelative = `${VAULT_NOTES_ROOT}/${filename}`;
    const destFull = safePath(destRelative);

    // Ensure Notes/ exists
    await fs.mkdir(path.dirname(destFull), { recursive: true });

    // If destination already occupied, suffix with a short hash to avoid clobber
    let finalDest = destFull;
    let finalRel = destRelative;
    try {
      await fs.access(destFull);
      const hash = crypto.createHash("sha1").update(sourceRelative + Date.now()).digest("hex").slice(0, 6);
      finalRel = destRelative.replace(/\.md$/, `-${hash}.md`);
      finalDest = safePath(finalRel);
    } catch { /* no conflict — good */ }

    // Prefer atomic rename; fall back to copy+unlink across filesystems.
    try {
      await fs.rename(sourceFull, finalDest);
    } catch {
      const content = await fs.readFile(sourceFull, "utf8");
      await fs.writeFile(finalDest, content, "utf8");
      await fs.unlink(sourceFull);
    }

    return { success: true, from: sourceRelative, to: finalRel };
  } catch (err) {
    return { success: false, from: sourceRelative, to: "", error: err.message };
  }
}

// ============================================================
// STUB MANAGEMENT — Populate & Reap
// ============================================================

/**
 * Find all stub notes in the vault.
 * @param {number} limit - Max stubs to return (default: 20)
 * @returns {Array<{path: string, title: string, created: string}>}
 */
export async function findStubs(limit = 20) {
  const vault = getVaultPath();
  if (!vault) return [];

  const stubs = [];

  async function scan(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (stubs.length >= limit) return;

      if (entry.isFile() && entry.name.endsWith(".md")) {
        const fullPath = path.join(dir, entry.name);
        try {
          const content = await fs.readFile(fullPath, "utf8");
          // Check YAML frontmatter for status: stub
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch && /status:\s*stub/i.test(fmMatch[1])) {
            const titleMatch = fmMatch[1].match(/title:\s*"?([^"\n]+)"?/);
            const createdMatch = fmMatch[1].match(/created:\s*(.+)/);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            stubs.push({
              path: rel,
              title: titleMatch ? titleMatch[1].trim() : entry.name.replace(".md", ""),
              created: createdMatch ? createdMatch[1].trim() : "",
            });
          }
        } catch { /* skip unreadable files */ }
      } else if (entry.isDirectory()) {
        await scan(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }

  await scan(vault, "");
  return stubs;
}

/**
 * Reap (delete) stub notes older than maxAgeDays.
 * @param {number} maxAgeDays - Delete stubs older than this (default: 14)
 * @returns {{ reaped: number, paths: string[] }}
 */
export async function reapStubs(maxAgeDays = 14) {
  const stubs = await findStubs(100);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const reaped = [];

  for (const stub of stubs) {
    if (!stub.created) continue;
    const createdMs = new Date(stub.created).getTime();
    if (isNaN(createdMs) || createdMs > cutoff) continue;

    try {
      const fullPath = safePath(stub.path);
      await fs.unlink(fullPath);
      reaped.push(stub.path);
    } catch { /* skip if can't delete */ }
  }

  return { reaped: reaped.length, paths: reaped };
}

// ============================================================
// YAML FRONTMATTER BUILDER
// ============================================================

/**
 * Build YAML frontmatter string from an object.
 * @param {Object} fields - Key-value pairs
 * @returns {string} "---\n...\n---\n"
 */
export function buildFrontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      value.forEach(v => lines.push(`  - ${v}`));
    } else if (typeof value === "string" && (value.includes(":") || value.includes('"'))) {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---\n");
  return lines.join("\n");
}

// ============================================================
// LIGHTWEIGHT PDF TEXT EXTRACTION
// ============================================================

/**
 * Extract text from a standard text-based PDF file.
 * Works for most digital-native PDFs but NOT scanned/image PDFs.
 * @param {string} filePath - Absolute path to PDF file
 * @returns {string} Extracted text content
 */
export async function extractPdfText(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const text = [];

    // Find all stream...endstream blocks and extract text
    const content = buffer.toString("latin1");
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    let streamMatch;

    while ((streamMatch = streamRegex.exec(content)) !== null) {
      const streamData = streamMatch[1];

      // Extract text from BT...ET (text object) blocks
      const textBlocks = streamData.match(/BT[\s\S]*?ET/g);
      if (!textBlocks) continue;

      for (const block of textBlocks) {
        // Match text-showing operators: Tj, TJ, ', "
        // Tj: (text) Tj
        const tjMatches = block.match(/\(([^)]*)\)\s*Tj/g);
        if (tjMatches) {
          for (const tj of tjMatches) {
            const m = tj.match(/\(([^)]*)\)/);
            if (m) text.push(decodePdfString(m[1]));
          }
        }

        // TJ: [(text) num (text) ...] TJ
        const tjArrayMatches = block.match(/\[([^\]]*)\]\s*TJ/g);
        if (tjArrayMatches) {
          for (const tja of tjArrayMatches) {
            const parts = tja.match(/\(([^)]*)\)/g);
            if (parts) {
              text.push(parts.map(p => decodePdfString(p.slice(1, -1))).join(""));
            }
          }
        }
      }
    }

    const result = text.join(" ").replace(/\s+/g, " ").trim();
    return result || "[PDF text extraction returned empty — may be scanned/image PDF]";
  } catch (err) {
    return `[PDF extraction failed: ${err.message}]`;
  }
}

/**
 * Decode PDF escape sequences in a string.
 */
function decodePdfString(s) {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// server/tools/codeTransform.js
// Code transformation tool — generates patches, refactors code, applies multi-file changes
// Integrates with applyPatch for safe code modifications

import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";

const MAX_FILE_SIZE = 256 * 1024;

/**
 * Read file safely
 */
async function readFileSafe(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return await fs.readFile(filePath, "utf8");
  } catch { return null; }
}

/**
 * Create timestamped backup
 */
async function createBackup(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const backupPath = `${filePath}.backup-${Date.now()}`;
    await fs.writeFile(backupPath, content, "utf8");
    return backupPath;
  } catch { return null; }
}

/**
 * Detect transformation intent
 */
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(refactor|restructure|reorganize|modularize|extract)\b/.test(lower)) return "refactor";
  if (/\b(fix|bug|error|issue|broken|crash|fail)\b/.test(lower)) return "fix";
  if (/\b(optimize|performance|speed|fast|efficient|cache)\b/.test(lower)) return "optimize";
  if (/\b(add|implement|create|new|feature|insert)\b/.test(lower)) return "add";
  if (/\b(upgrade|update|modern|migrate|convert)\b/.test(lower)) return "upgrade";
  if (/\b(remove|delete|clean|strip|unused|dead)\b/.test(lower)) return "remove";
  if (/\b(rename|move|reorganize)\b/.test(lower)) return "rename";
  if (/\b(document|comment|jsdoc|docstring|annotate)\b/.test(lower)) return "document";
  if (/\b(test|spec|unit\s*test|coverage)\b/.test(lower)) return "test";
  return "transform";
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
 * Generate transformation using LLM
 */
async function generateTransformation(filePath, content, intent, instructions) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).slice(1);

  const prompt = `You are an expert code transformer. Your task: ${intent} the following ${ext} file.

File: ${filename}
Path: ${filePath}

Current code:
\`\`\`${ext}
${content.slice(0, 12000)}
\`\`\`

User instructions: ${instructions}

RULES:
1. Return the COMPLETE transformed file contents (not just the changed parts)
2. Preserve ALL existing functionality unless explicitly asked to remove it
3. Maintain the same coding style and conventions
4. Add comments explaining significant changes
5. Do NOT add unnecessary dependencies

Start your response with a brief summary of changes (2-3 lines), then output the complete transformed file wrapped in \`\`\`${ext} ... \`\`\` code fences.`;

  try {
    const response = await llm(prompt);
    const responseText = response?.data?.text || "";

    // Extract code block from response
    const codeBlockMatch = responseText.match(/```(?:\w+)?\n([\s\S]*?)```/);
    const newContent = codeBlockMatch ? codeBlockMatch[1].trim() : null;

    // Extract summary (text before code block)
    const summaryMatch = responseText.split(/```/)[0].trim();

    return {
      success: !!newContent,
      newContent,
      summary: summaryMatch || "Transformation applied.",
      rawResponse: responseText
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Generate a diff summary between old and new content
 */
function generateDiffSummary(oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const added = newLines.length - oldLines.length;
  const changes = [];

  // Simple line-by-line comparison
  const maxLines = Math.max(oldLines.length, newLines.length);
  let changedCount = 0;

  for (let i = 0; i < maxLines; i++) {
    if (oldLines[i] !== newLines[i]) {
      changedCount++;
      if (changes.length < 10) {
        if (i < oldLines.length && i < newLines.length) {
          changes.push({ line: i + 1, type: "modified", old: oldLines[i]?.trim().slice(0, 80), new: newLines[i]?.trim().slice(0, 80) });
        } else if (i >= oldLines.length) {
          changes.push({ line: i + 1, type: "added", content: newLines[i]?.trim().slice(0, 80) });
        } else {
          changes.push({ line: i + 1, type: "removed", content: oldLines[i]?.trim().slice(0, 80) });
        }
      }
    }
  }

  return {
    linesAdded: added > 0 ? added : 0,
    linesRemoved: added < 0 ? Math.abs(added) : 0,
    linesChanged: changedCount,
    sampleChanges: changes
  };
}

/**
 * Multi-file transformation
 */
async function transformMultipleFiles(files, intent, instructions) {
  const results = [];

  for (const filePath of files) {
    const content = await readFileSafe(filePath);
    if (!content) {
      results.push({ file: filePath, success: false, error: "Could not read file" });
      continue;
    }

    const transformation = await generateTransformation(filePath, content, intent, instructions);

    if (transformation.success && transformation.newContent) {
      // Create backup before modifying
      const backupPath = await createBackup(filePath);

      // Write transformed content
      try {
        await fs.writeFile(filePath, transformation.newContent, "utf8");
        const diff = generateDiffSummary(content, transformation.newContent);

        results.push({
          file: filePath,
          filename: path.basename(filePath),
          success: true,
          summary: transformation.summary,
          backupPath,
          diff
        });
      } catch (err) {
        results.push({ file: filePath, success: false, error: `Write failed: ${err.message}` });
      }
    } else {
      results.push({
        file: filePath,
        success: false,
        error: transformation.error || "LLM did not generate valid transformed code"
      });
    }
  }

  return results;
}

/**
 * Generate code from description (for new files)
 */
async function generateNewCode(description, targetPath, language) {
  const ext = language || path.extname(targetPath).slice(1) || "js";

  const prompt = `Generate a complete, production-ready ${ext} file based on this description:

${description}

Target path: ${targetPath}

Requirements:
1. Follow best practices for ${ext}
2. Include proper error handling
3. Add JSDoc/docstring comments
4. Export functions/classes appropriately
5. Include any necessary imports

Output ONLY the complete file contents wrapped in \`\`\`${ext} ... \`\`\` code fences.`;

  try {
    const response = await llm(prompt);
    const responseText = response?.data?.text || "";
    const codeMatch = responseText.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return {
      success: !!codeMatch,
      content: codeMatch ? codeMatch[1].trim() : null,
      rawResponse: responseText
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Main entry point
 */
export async function codeTransform(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: { message: "Please describe the transformation. Example: 'refactor D:/project/server.js to use async/await' or 'add error handling to D:/project/api.js'" }
    };
  }

  const intent = context.action || detectIntent(text);
  const targetPath = context.path || extractPath(text);

  // Generate new file
  if (intent === "add" && !targetPath) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: { message: "Please provide a target file path. Example: 'create D:/project/newModule.js that handles authentication'" }
    };
  }

  if (!targetPath) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: { message: "Please provide a file or folder path. Example: 'refactor D:/project/utils.js'" }
    };
  }

  const normalizedPath = path.resolve(targetPath);

  try {
    let stat;
    try {
      stat = await fs.stat(normalizedPath);
    } catch {
      // File doesn't exist — generate new
      if (intent === "add" || /\b(create|generate|write|new)\b/i.test(text)) {
        const generated = await generateNewCode(text, normalizedPath);
        if (generated.success && generated.content) {
          // Ensure directory exists
          await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
          await fs.writeFile(normalizedPath, generated.content, "utf8");

          return {
            tool: "codeTransform",
            success: true,
            final: true,
            data: {
              preformatted: true,
              text: `✅ **Created new file: ${path.basename(normalizedPath)}**\n\n${generated.content.split("\n").length} lines generated at:\n${normalizedPath}`,
              path: normalizedPath,
              action: "created"
            }
          };
        }
        return { tool: "codeTransform", success: false, final: true, data: { message: "Failed to generate code: " + (generated.error || "unknown error") } };
      }
      return { tool: "codeTransform", success: false, final: true, data: { message: `File not found: ${normalizedPath}` } };
    }

    if (stat.isFile()) {
      // Single file transformation
      const content = await readFileSafe(normalizedPath);
      if (!content) {
        return { tool: "codeTransform", success: false, final: true, data: { message: `Could not read: ${normalizedPath}` } };
      }

      // Preview mode: show what would change without applying
      if (context.preview || /\b(preview|dry.?run|what\s+would|show\s+changes)\b/i.test(text)) {
        const transformation = await generateTransformation(normalizedPath, content, intent, text);
        if (transformation.success) {
          const diff = generateDiffSummary(content, transformation.newContent);
          return {
            tool: "codeTransform",
            success: true,
            final: true,
            data: {
              preformatted: true,
              text: `🔍 **Preview: ${intent} ${path.basename(normalizedPath)}**\n\n${transformation.summary}\n\n📊 Changes: +${diff.linesAdded} -${diff.linesRemoved} (~${diff.linesChanged} lines affected)\n\nSample changes:\n${diff.sampleChanges.map(c => c.type === "modified" ? `  Line ${c.line}: "${c.old}" → "${c.new}"` : `  Line ${c.line}: [${c.type}] ${c.content}`).join("\n")}\n\nTo apply these changes, say "apply" or "do it".`,
              preview: true,
              pendingTransform: { path: normalizedPath, newContent: transformation.newContent }
            }
          };
        }
        return { tool: "codeTransform", success: false, final: true, data: { message: "Could not generate transformation preview." } };
      }

      // Apply transformation
      const transformation = await generateTransformation(normalizedPath, content, intent, text);
      if (!transformation.success || !transformation.newContent) {
        return { tool: "codeTransform", success: false, final: true, data: { message: transformation.error || "LLM could not generate transformation." } };
      }

      const backupPath = await createBackup(normalizedPath);
      await fs.writeFile(normalizedPath, transformation.newContent, "utf8");
      const diff = generateDiffSummary(content, transformation.newContent);

      return {
        tool: "codeTransform",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: `✅ **${intent.charAt(0).toUpperCase() + intent.slice(1)}: ${path.basename(normalizedPath)}**\n\n${transformation.summary}\n\n📊 Changes: +${diff.linesAdded} -${diff.linesRemoved} (~${diff.linesChanged} lines affected)\n💾 Backup: ${backupPath || "none"}`,
          path: normalizedPath,
          backupPath,
          diff,
          action: intent
        }
      };
    }

    if (stat.isDirectory()) {
      // Multi-file transformation
      const SKIP_DIRS_LOCAL = new Set(["node_modules", ".git", "dist", "build", "out", "__pycache__", ".cache", "coverage"]);
      const codeExts = new Set(["js", "jsx", "ts", "tsx", "py", "java", "go", "rs", "rb", "php"]);

      async function findCodeFiles(dir, d = 0) {
        const results = [];
        if (d > 4) return results;
        const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const item of items) {
          if (SKIP_DIRS_LOCAL.has(item.name)) continue;
          const fp = path.join(dir, item.name);
          if (item.isDirectory()) {
            results.push(...await findCodeFiles(fp, d + 1));
          } else if (codeExts.has(path.extname(item.name).slice(1).toLowerCase())) {
            results.push(fp);
          }
          if (results.length >= MAX_FILE_SIZE) break;
        }
        return results;
      }

      const files = await findCodeFiles(normalizedPath);
      if (files.length === 0) {
        return { tool: "codeTransform", success: false, final: true, data: { message: `No code files found in ${normalizedPath}` } };
      }

      // Limit to reasonable number
      const filesToTransform = files.slice(0, 10);
      const results = await transformMultipleFiles(filesToTransform, intent, text);

      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      let summary = `🔄 **${intent.charAt(0).toUpperCase() + intent.slice(1)} Results: ${normalizedPath}**\n\n`;
      summary += `✅ ${successful.length} files transformed, ❌ ${failed.length} failed\n\n`;

      for (const r of successful) {
        summary += `  ✅ ${r.filename}: ${r.summary} (${r.diff?.linesChanged || "?"} lines changed)\n`;
      }
      for (const r of failed) {
        summary += `  ❌ ${path.basename(r.file)}: ${r.error}\n`;
      }

      return {
        tool: "codeTransform",
        success: successful.length > 0,
        final: true,
        data: {
          preformatted: true,
          text: summary,
          results,
          action: intent
        }
      };
    }

    return { tool: "codeTransform", success: false, final: true, data: { message: "Target is neither a file nor a directory." } };
  } catch (err) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: { message: `Error: ${err.message}` }
    };
  }
}

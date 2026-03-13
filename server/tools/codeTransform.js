// server/tools/codeTransform.js
// Code transformation tool — generates patches, refactors code, applies multi-file changes
// Integrates with applyPatch for safe code modifications

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { llm } from "./llm.js";

const MAX_FILE_SIZE = 256 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(SERVER_ROOT, "..");

/**
 * Read file safely
 */
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
 * Create timestamped backup
 */
async function createBackup(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const backupPath = `${filePath}.backup-${Date.now()}`;
    await fs.writeFile(backupPath, content, "utf8");
    return backupPath;
  } catch {
    return null;
  }
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
 * Convert filename to JS identifier (tool name)
 */
function filenameToIdentifier(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "tool";
  const [first, ...rest] = parts;
  return (
    first.charAt(0).toLowerCase() +
    first.slice(1) +
    rest.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("")
  );
}

/**
 * Check if a path is inside server/tools
 */
function isToolFilePath(p) {
  const norm = p.replace(/\\/g, "/");
  return norm.includes("/server/tools/");
}

/**
 * Safe file update helper
 */
async function safeUpdateFile(filePath, updater) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const updated = await updater(content);
    if (updated && updated !== content) {
      await fs.writeFile(filePath, updated, "utf8");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Update server/tools/index.js to export the new tool
 */
async function registerInToolsIndex(toolFilePath) {
  const indexPath = path.join(__dirname, "index.js");
  const filename = path.basename(toolFilePath);
  const toolName = filenameToIdentifier(filename);
  const exportLine = `export { ${toolName} } from "./${filename}";`;

  await safeUpdateFile(indexPath, content => {
    if (content.includes(exportLine) || content.includes(`"./${filename}"`)) {
      return content;
    }
    const lines = content.split("\n");
    // Try to keep alphabetical-ish: append at end of exports
    lines.push(exportLine);
    return lines.join("\n");
  });
}

/**
 * Best-effort registration in planner.js
 * Adds tool name to available tools list if such a list exists.
 */
async function registerInPlanner(toolFilePath) {
  const plannerPath = path.join(SERVER_ROOT, "planner.js");
  const filename = path.basename(toolFilePath);
  const toolName = filenameToIdentifier(filename);

  await safeUpdateFile(plannerPath, content => {
    if (content.includes(toolName)) return content;

    // Try to find availableTools array
    const regex = /(availableTools\s*=\s*\[)([\s\S]*?)(\])/m;
    const match = content.match(regex);
    if (match) {
      const before = match[1];
      const body = match[2];
      const after = match[3];
      if (body.includes(`"${toolName}"`) || body.includes(`'${toolName}'`)) {
        return content;
      }
      const trimmedBody = body.trim();
      const insert =
        trimmedBody.length === 0
          ? `  "${toolName}"`
          : `${trimmedBody.replace(/\]\s*$/, "")},\n  "${toolName}"`;
      const replacement = before + insert + "\n" + after;
      return content.replace(regex, replacement);
    }

    // Fallback: append a comment hint
    return (
      content +
      `\n\n// TODO: planner: consider adding "${toolName}" to available tools (file: ./tools/${filename})`
    );
  });
}

/**
 * Best-effort registration in executor.js
 * Tries to add a case or handler mapping; otherwise appends a TODO comment.
 */
async function registerInExecutor(toolFilePath) {
  const executorPath = path.join(SERVER_ROOT, "executor.js");
  const filename = path.basename(toolFilePath);
  const toolName = filenameToIdentifier(filename);

  await safeUpdateFile(executorPath, content => {
    if (content.includes(toolName)) return content;

    // Try to find a switch on tool name
    const switchRegex = /(switch\s*\(\s*toolName\s*\)\s*\{)([\s\S]*?)(\})/m;
    const match = content.match(switchRegex);
    if (match) {
      const before = match[1];
      const body = match[2];
      const after = match[3];
      if (body.includes(`case "${toolName}"`) || body.includes(`case '${toolName}'`)) {
        return content;
      }
      const insertion = `\n    case "${toolName}":\n      return await tools.${toolName}(request);`;
      const replacement = before + body + insertion + "\n" + after;
      return content.replace(switchRegex, replacement);
    }

    // Try to find a tool map object
    const mapRegex = /(const\s+toolMap\s*=\s*\{)([\s\S]*?)(\};)/m;
    const mapMatch = content.match(mapRegex);
    if (mapMatch) {
      const before = mapMatch[1];
      const body = mapMatch[2];
      const after = mapMatch[3];
      if (body.includes(`${toolName}:`)) return content;
      const trimmedBody = body.trim();
      const insert =
        trimmedBody.length === 0
          ? `  ${toolName}: tools.${toolName}`
          : `${trimmedBody.replace(/,\s*$/, "")},\n  ${toolName}: tools.${toolName}`;
      const replacement = before + "\n" + insert + "\n" + after;
      return content.replace(mapRegex, replacement);
    }

    // Fallback: append a comment hint
    return (
      content +
      `\n\n// TODO: executor: wire "${toolName}" (./tools/${filename}) into the execution pipeline`
    );
  });
}

/**
 * Best-effort documentation update in root README.md
 */
async function registerInReadme(toolFilePath, descriptionText) {
  const readmePath = path.join(PROJECT_ROOT, "README.md");
  const filename = path.basename(toolFilePath);
  const toolName = filenameToIdentifier(filename);

  await safeUpdateFile(readmePath, content => {
    if (content.includes(toolName) && content.includes(filename)) return content;

    const sectionHeader = "## Tools";
    const entry = `- **${toolName}** (\`server/tools/${filename}\`): ${descriptionText || "Auto-generated tool by selfEvolve."}`;

    if (content.includes(sectionHeader)) {
      return content.replace(
        sectionHeader,
        `${sectionHeader}\n\n${entry}`
      );
    }

    return content + `\n\n${sectionHeader}\n\n${entry}\n`;
  });
}

/**
 * Register a newly created tool across index, planner, executor, README
 */
async function registerNewTool(toolFilePath, descriptionText) {
  if (!isToolFilePath(toolFilePath)) {
    return;
  }

  await registerInToolsIndex(toolFilePath);
  await registerInPlanner(toolFilePath);
  await registerInExecutor(toolFilePath);
  await registerInReadme(toolFilePath, descriptionText);
}

/**
 * Safely applies SEARCH/REPLACE blocks to the original source code
 */
function applyPatchBlocks(originalContent, llmOutput) {
  let currentContent = originalContent;
  let appliedCount = 0;

  // Match <<<< followed by old code, ====, new code, >>>>
  const blockRegex = /<<<<\n([\s\S]*?)\n====\n([\s\S]*?)\n>>>>/g;
  const blocks = [...llmOutput.matchAll(blockRegex)];

  if (blocks.length === 0) return null; // No valid patches found

  for (const match of blocks) {
    const searchBlock = match[1].trim();
    const replaceBlock = match[2].trim();

    // Only apply if the exact original code exists in the file
    if (searchBlock && currentContent.includes(searchBlock)) {
      currentContent = currentContent.replace(searchBlock, replaceBlock);
      appliedCount++;
    } else {
      console.warn("[codeTransform] Patch block failed: Could not find exact search string in file.");
    }
  }

  return appliedCount > 0 ? currentContent : null;
}

/**
 * Generate transformation using LLM (Surgical Patching)
 * @param {object} options - Optional flags
 * @param {boolean} options.fromSelfEvolve - If true, adds stricter architectural rules
 */
async function generateTransformation(filePath, content, intent, instructions, options = {}) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).slice(1) || "js";

  // When called from selfEvolve, inject strict architectural rules
  const architectureRules = options.fromSelfEvolve ? `

ARCHITECTURE RULES (MANDATORY — violations will be rejected):
- This project uses ES Modules ONLY (import/export). NEVER use require() or module.exports.
- Do NOT import packages that are not installed. Only use: express, axios, cors, dotenv,
  googleapis, cheerio, compromise, natural, xlsx, rss-parser, multer, file-type, nerdamer, expr-eval.
- Do NOT rename or change the exported function signature.
- Do NOT remove existing functionality unless the instruction explicitly says to.
- Do NOT add CLI interfaces, EventEmitters, or generic boilerplate wrappers.
- Keep changes MINIMAL and SURGICAL — only modify what the instruction asks for.` : "";

  const prompt = `You are a surgical code editor. Your task: ${intent} the following ${ext} file.

File: ${filename}
Path: ${filePath}

Current code:
\`\`\`${ext}
${content}
\`\`\`

User instructions: ${instructions}

RULES FOR SURGICAL EDITING (CRITICAL):
1. DO NOT REWRITE THE ENTIRE FILE! You must use SEARCH and REPLACE blocks.
2. The code in the SEARCH block MUST match the existing code exactly, character for character.
3. Start your response with a 1-sentence summary of the change.${architectureRules}

FORMAT YOUR CHANGES EXACTLY LIKE THIS:
<<<<
exact existing code to remove
====
new code to insert
>>>>

Example of a valid change:
<<<<
const maxRetries = 3;
====
const maxRetries = 5;
>>>>`;

  // ── DYNAMIC VRAM OPTIMIZATION ──
  const isMassiveFile = content.length > 20000;
  const timeoutMs = isMassiveFile ? 600_000 : 300_000;
  const dynamicCtx = isMassiveFile ? 32768 : 8192; // Only expand brain for giant files

  try {
    console.log(`🧠 [codeTransform] Calling LLM (${content.length} chars, timeout: ${timeoutMs / 1000}s, memory: ${dynamicCtx} tokens)`);
    const response = await llm(prompt, {
      timeoutMs,
      options: { num_ctx: dynamicCtx }
    });
    
    const responseText = response?.data?.text || "";

    // 1. Try to apply surgical patches first
    const patchedContent = applyPatchBlocks(content, responseText);
    if (patchedContent) {
      return {
        success: true,
        newContent: patchedContent,
        summary: responseText.split(/<<<</)[0].trim() || "Applied surgical patch successfully.",
        rawResponse: responseText
      };
    }

    // 2. Fallback: If the LLM ignored instructions and just output a full file block
    // We use [\`]{3} instead of typing actual backticks so the chat UI doesn't break
    const codeBlockMatch = responseText.match(/[\`]{3}(?:\w+)?\n([\s\S]*?)[\`]{3}/);
    const newContent = codeBlockMatch ? codeBlockMatch[1].trim() : null;

    if (newContent) {
      // ── TRUNCATION GUARD ──
      if (content.length > 3000 && newContent.length < (content.length * 0.8)) {
        console.warn(`[codeTransform] LLM truncated file from ${content.length} to ${newContent.length} chars.`);
        throw new Error("LLM Safety Guard: The generated code was severely truncated. Patching failed.");
      }
      return {
        success: true,
        newContent,
        summary: responseText.split(/[\`]{3}/)[0].trim() || "Full file rewrite applied.",
        rawResponse: responseText
      };
    }

    return { success: false, error: "LLM did not output valid patches or code blocks." };
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
          changes.push({
            line: i + 1,
            type: "modified",
            old: oldLines[i]?.trim().slice(0, 80),
            new: newLines[i]?.trim().slice(0, 80)
          });
        } else if (i >= oldLines.length) {
          changes.push({
            line: i + 1,
            type: "added",
            content: newLines[i]?.trim().slice(0, 80)
          });
        } else {
          changes.push({
            line: i + 1,
            type: "removed",
            content: oldLines[i]?.trim().slice(0, 80)
          });
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
 * Option C: tool boilerplate with run(input, context) for tools.
 */
async function generateNewCode(description, targetPath, language) {
  const ext = language || path.extname(targetPath).slice(1) || "js";
  const isTool = isToolFilePath(targetPath);

  const boilerplateHint = isTool
    ? `The file is a tool module. It MUST export:

export async function run(input, context) {
  // main tool logic
}

Use this as the main entry point.`
    : `Export appropriate functions or classes as needed.`;

  const prompt = `Generate a complete, production-ready ${ext} file based on this description:

${description}

Target path: ${targetPath}

Requirements:
1. Follow best practices for ${ext}
2. Include proper error handling
3. Add JSDoc/docstring comments
4. ${boilerplateHint}
5. Include any necessary imports

Output ONLY the complete file contents wrapped in \`\`\`${ext} ... \`\`\` code fences.`;

  try {
    const response = await llm(prompt);
    const responseText = response?.data?.text || "";
    // Using the same safe trick to avoid breaking chat parsing
    const codeMatch = responseText.match(/[\`]{3}(?:\w+)?\n([\s\S]*?)[\`]{3}/);
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
  const text =
    typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: {
        message:
          "Please describe the transformation. Example: 'refactor D:/project/server.js to use async/await' or 'add error handling to D:/project/api.js'"
      }
    };
  }

  const intent = context.action || detectIntent(text);
  const targetPathRaw = context.path || extractPath(text);
  const isSelfEvolve = context.source === "selfEvolve";

  // Generate new file requires a target path
  if (intent === "add" && !targetPathRaw) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: {
        message:
          "Please provide a target file path. Example: 'create D:/project/newModule.js that handles authentication'"
      }
    };
  }

  if (!targetPathRaw) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: {
        message: "Please provide a file or folder path. Example: 'refactor D:/project/utils.js'"
      }
    };
  }

  // Option B: if this looks like a bare filename for a tool, default to server/tools
  let targetPath = targetPathRaw;
  if (
    !path.isAbsolute(targetPathRaw) &&
    !targetPathRaw.includes("/") &&
    !targetPathRaw.includes("\\") &&
    targetPathRaw.endsWith(".js")
  ) {
    targetPath = path.join(SERVER_ROOT, "tools", targetPathRaw);
  }

  const normalizedPath = path.resolve(targetPath);

  try {
    let stat;
    try {
      stat = await fs.stat(normalizedPath);
    } catch {
      // ── GUARDRAIL: selfEvolve is NEVER allowed to create new files ──
      if (isSelfEvolve) {
        console.warn(`[codeTransform] BLOCKED: selfEvolve tried to create new file: ${normalizedPath}`);
        return {
          tool: "codeTransform",
          success: false,
          final: true,
          data: {
            message: `Blocked: selfEvolve cannot create new files. File not found: ${normalizedPath}`
          }
        };
      }

      // File doesn't exist — generate new (only for manual/user requests)
      if (intent === "add" || /\b(create|generate|write|new)\b/i.test(text)) {
        const generated = await generateNewCode(text, normalizedPath);
        if (generated.success && generated.content) {
          // Ensure directory exists
          await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
          await fs.writeFile(normalizedPath, generated.content, "utf8");

          // Auto-register new tool if it's under server/tools
          await registerNewTool(normalizedPath, text);

          return {
            tool: "codeTransform",
            success: true,
            final: true,
            data: {
              preformatted: true,
              text: `✅ **Created new file: ${path.basename(
                normalizedPath
              )}**\n\n${generated.content.split("\n").length} lines generated at:\n${normalizedPath}`,
              path: normalizedPath,
              action: "created"
            }
          };
        }
        return {
          tool: "codeTransform",
          success: false,
          final: true,
          data: {
            message: "Failed to generate code: " + (generated.error || "unknown error")
          }
        };
      }
      return {
        tool: "codeTransform",
        success: false,
        final: true,
        data: { message: `File not found: ${normalizedPath}` }
      };
    }

    if (stat.isFile()) {
      // Single file transformation
      const content = await readFileSafe(normalizedPath);
      if (!content) {
        return {
          tool: "codeTransform",
          success: false,
          final: true,
          data: { message: `Could not read: ${normalizedPath}` }
        };
      }

      const transformOpts = { fromSelfEvolve: isSelfEvolve };

      // Preview mode: show what would change without applying
      if (
        context.preview ||
        /\b(preview|dry.?run|what\s+would|show\s+changes)\b/i.test(text)
      ) {
        const transformation = await generateTransformation(
          normalizedPath,
          content,
          intent,
          text,
          transformOpts
        );
        if (transformation.success) {
          const diff = generateDiffSummary(content, transformation.newContent);
          return {
            tool: "codeTransform",
            success: true,
            final: true,
            data: {
              preformatted: true,
              text: `🔍 **Preview: ${intent} ${path.basename(
                normalizedPath
              )}**\n\n${transformation.summary}\n\n📊 Changes: +${
                diff.linesAdded
              } -${diff.linesRemoved} (~${
                diff.linesChanged
              } lines affected)\n\nSample changes:\n${diff.sampleChanges
                .map(c =>
                  c.type === "modified"
                    ? `  Line ${c.line}: "${c.old}" → "${c.new}"`
                    : `  Line ${c.line}: [${c.type}] ${c.content}`
                )
                .join(
                  "\n"
                )}\n\nTo apply these changes, say "apply" or "do it".`,
              preview: true,
              pendingTransform: { path: normalizedPath, newContent: transformation.newContent }
            }
          };
        }
        return {
          tool: "codeTransform",
          success: false,
          final: true,
          data: { message: "Could not generate transformation preview." }
        };
      }

      // Apply transformation
      const transformation = await generateTransformation(
        normalizedPath,
        content,
        intent,
        text,
        transformOpts
      );
      if (!transformation.success || !transformation.newContent) {
        return {
          tool: "codeTransform",
          success: false,
          final: true,
          data: { message: transformation.error || "LLM could not generate transformation." }
        };
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
          text: `✅ **${intent.charAt(0).toUpperCase() + intent.slice(1)}: ${path.basename(
            normalizedPath
          )}**\n\n${transformation.summary}\n\n📊 Changes: +${
            diff.linesAdded
          } -${diff.linesRemoved} (~${diff.linesChanged} lines affected)\n💾 Backup: ${
            backupPath || "none"
          }`,
          path: normalizedPath,
          backupPath,
          diff,
          action: intent
        }
      };
    }

    if (stat.isDirectory()) {
      // Multi-file transformation
      const SKIP_DIRS_LOCAL = new Set([
        "node_modules",
        ".git",
        "dist",
        "build",
        "out",
        "__pycache__",
        ".cache",
        "coverage"
      ]);
      const codeExts = new Set(["js", "jsx", "ts", "tsx", "py", "java", "go", "rs", "rb", "php"]);

      async function findCodeFiles(dir, d = 0) {
        const results = [];
        if (d > 4) return results;
        const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const item of items) {
          if (SKIP_DIRS_LOCAL.has(item.name)) continue;
          const fp = path.join(dir, item.name);
          if (item.isDirectory()) {
            results.push(...(await findCodeFiles(fp, d + 1)));
          } else if (codeExts.has(path.extname(item.name).slice(1).toLowerCase())) {
            results.push(fp);
          }
          if (results.length >= MAX_FILE_SIZE) break;
        }
        return results;
      }

      const files = await findCodeFiles(normalizedPath);
      if (files.length === 0) {
        return {
          tool: "codeTransform",
          success: false,
          final: true,
          data: { message: `No code files found in ${normalizedPath}` }
        };
      }

      // Limit to reasonable number
      const filesToTransform = files.slice(0, 10);
      const results = await transformMultipleFiles(filesToTransform, intent, text);

      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      let summary = `🔄 **${
        intent.charAt(0).toUpperCase() + intent.slice(1)
      } Results: ${normalizedPath}**\n\n`;
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

    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: { message: "Target is neither a file nor a directory." }
    };
  } catch (err) {
    return {
      tool: "codeTransform",
      success: false,
      final: true,
      data: { message: `Error: ${err.message}` }
    };
  }
}
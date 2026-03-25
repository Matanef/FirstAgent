// server/tools/applyPatch.js
// Applies code improvements based on review suggestions and trending patterns
// NOW WITH SELF-HEALING: 3-attempt retry loop with syntax + ESLint validation

import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";
import { llm } from "./llm.js";
import { validateStaged, cleanupStaging } from "../utils/codeValidator.js";

const MAX_HEAL_ATTEMPTS = 3;

/**
 * Resolves a filename to its full path
 */
async function resolveFilePath(filename) {
  if (!filename) return null;

  // Strip extensions and noise
  let clean = filename.replace(/\.(py|txt|md|json)$/i, '');
  clean = clean.replace(/[_\-]/g, ' ');
  const noiseRegex = /\b(review|tool|file|against|them|our|the|my)\b/gi;
  clean = clean.replace(noiseRegex, ' ').replace(/\s+/g, ' ').trim();
  clean = clean.replace(/[_\s-](tool|file|js)$/i, '');

  const target = clean || filename;
  
  // Ensure .js extension
  const targetFile = target.endsWith('.js') ? target : `${target}.js`;
  
  // Search in common directories
  const commonDirs = ["server/tools", "server", "client/src", "utils"];
  
  for (const dir of commonDirs) {
    const fullPath = path.join(PROJECT_ROOT, dir, targetFile);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Extract target filename from request
 */
function extractTargetFile(text) {
  // Match patterns like "email.js", "email tool", "our email tool"
  const fileMatch = text.match(/([a-z]+)\.js|(?:our|the)\s+([a-z]+)\s+tool/i);
  if (fileMatch) {
    const name = fileMatch[1] || fileMatch[2];
    return `${name}.js`;
  }
  
  // Fallback to common tool names
  const tools = ['email', 'file', 'search', 'news', 'weather', 'finance', 'github', 'calculator'];
  for (const tool of tools) {
    if (text.toLowerCase().includes(tool)) {
      return `${tool}.js`;
    }
  }
  
  return null;
}

/**
 * Generate improved code using LLM.
 * @param {Object} opts
 * @param {string|null} opts.previousError - If set, the LLM is in recovery mode
 */
async function generateImprovedCode({ originalCode, reviewSuggestions, trendingPatterns, filename, previousError }) {
  // ── Build recovery context if this is a retry after validation failure ──
  const recoveryBlock = previousError ? `

⚠️ CRITICAL: Your previous attempt FAILED validation with this error:
[ERROR START]
${previousError}
[ERROR END]
You MUST fix this error. Do NOT repeat the same mistake. Analyze the error carefully.` : "";

  const prompt = `You are a code improvement assistant. Your task is to improve the provided code based on review suggestions and trending patterns.

**TARGET FILE:** ${filename}

**ORIGINAL CODE:**
\`\`\`javascript
${originalCode}
\`\`\`

**REVIEW SUGGESTIONS:**
${reviewSuggestions || 'No specific suggestions provided'}

**TRENDING PATTERNS:**
${trendingPatterns || 'No trending patterns provided'}
${recoveryBlock}

**INSTRUCTIONS:**
1. Apply the review suggestions where applicable
2. Incorporate best practices from trending patterns
3. Maintain the original functionality
4. Preserve all imports and exports
5. Keep the code structure similar to avoid breaking changes
6. This project uses ES Modules ONLY (import/export). NEVER use require() or module.exports.

**OUTPUT FORMAT:**
Return ONLY the complete improved code without any markdown formatting, explanations, or preamble. Start directly with the first line of code.

**IMPROVED CODE:**`;

  try {
    const response = await llm(prompt);

    if (!response.success || !response.data?.text) {
      throw new Error("LLM failed to generate improved code");
    }

    let improvedCode = response.data.text.trim();

    // Remove markdown code fences if present
    improvedCode = improvedCode.replace(/^```[a-z]*\n?/gm, '').replace(/\n?```$/gm, '');

    return improvedCode;
  } catch (err) {
    throw new Error(`Code generation failed: ${err.message}`);
  }
}

/**
 * applyPatch Tool
 * Applies code improvements based on review suggestions
 */
export async function applyPatch(request) {
  try {
    console.log("🔧 applyPatch tool called");

    // Extract input
    const text = typeof request === 'string' ? request : request?.text || "";
    const context = typeof request === 'object' ? request.context : {};

    // 1. Determine target file
    let targetFile = context.targetFile || extractTargetFile(text);
    
    if (!targetFile) {
      return {
        tool: "applyPatch",
        success: false,
        final: true,
        error: "Could not determine target file. Please specify which file to patch (e.g., 'email.js')"
      };
    }

    console.log(`📄 Target file: ${targetFile}`);

    // 2. Resolve file path
    const filePath = await resolveFilePath(targetFile);
    
    if (!filePath) {
      return {
        tool: "applyPatch",
        success: false,
        final: true,
        error: `File not found: ${targetFile}. Searched in server/tools, server, client/src, and utils.`
      };
    }

    console.log(`✅ Resolved to: ${filePath}`);

    // 3. Read original code
    let originalCode;
    try {
      originalCode = await fs.readFile(filePath, 'utf8');
      console.log(`📖 Read ${originalCode.length} characters from ${targetFile}`);
    } catch (fileErr) {
      return {
        tool: "applyPatch",
        success: false,
        final: true,
        error: `Failed to read file: ${fileErr.message}`
      };
    }

    // 4. Get review suggestions and trending patterns from context
    const reviewSuggestions = context.reviewSuggestions || context.review || "Apply general best practices";
    const trendingPatterns = context.trendingPatterns || context.patterns || "";

    console.log("🤖 Generating improved code with self-healing loop...");

    // ══════════════════════════════════════════════════════════════
    // 🛡️ SELF-HEALING LOOP: Generate → Validate → Retry up to 3×
    // ══════════════════════════════════════════════════════════════
    let improvedCode = null;
    let lastError = null;
    let healAttempt = 0;

    while (healAttempt < MAX_HEAL_ATTEMPTS) {
      healAttempt++;

      if (lastError) {
        console.log(`[applyPatch] ♻️ Self-healing attempt ${healAttempt}/${MAX_HEAL_ATTEMPTS} — fixing: ${lastError.slice(0, 100)}`);
      }

      // Generate code (with error context on retries)
      try {
        improvedCode = await generateImprovedCode({
          originalCode,
          reviewSuggestions: typeof reviewSuggestions === 'string'
            ? reviewSuggestions
            : JSON.stringify(reviewSuggestions, null, 2),
          trendingPatterns: typeof trendingPatterns === 'string'
            ? trendingPatterns
            : JSON.stringify(trendingPatterns, null, 2),
          filename: targetFile,
          previousError: lastError // Feed validation error back to LLM on retry
        });
      } catch (genErr) {
        lastError = genErr.message;
        console.warn(`[applyPatch] Generation failed on attempt ${healAttempt}: ${lastError}`);
        continue;
      }

      // Validate the generated code (syntax + ESLint)
      const validation = await validateStaged(improvedCode, filePath);

      if (validation.valid) {
        console.log(`[applyPatch] 🟢 Validation passed on attempt ${healAttempt}${validation.warnings?.length ? ` (${validation.warnings.length} warnings)` : ""}`);
        // Clean up staging file — we'll do our own atomic swap below
        await cleanupStaging(filePath);
        break;
      } else {
        lastError = validation.error;
        console.warn(`[applyPatch] 🔴 Validation failed (${validation.stage}): ${lastError?.slice(0, 150)}`);
        improvedCode = null; // Reset so we know if all attempts failed
      }
    }

    if (!improvedCode) {
      return {
        tool: "applyPatch",
        success: false,
        final: true,
        error: `Patch failed after ${MAX_HEAL_ATTEMPTS} self-healing attempts.\nLast error: ${lastError}`
      };
    }

    // 7. Create categorized backup: server/tools/backups/[tool_name]/[tool_name]_[timestamp].js.backup
    const toolName = path.basename(filePath, ".js");
    const backupDir = path.resolve(path.dirname(filePath), "backups", toolName);
    await fs.mkdir(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `${toolName}_${timestamp}.js.backup`);

    try {
      await fs.copyFile(filePath, backupPath);
      console.log(`💾 Backup created: ${backupPath}`);
    } catch (err) {
      console.warn(`⚠️ Could not create backup: ${err.message}`);
    }

    // 8. Write validated code to the live file
    try {
      await fs.writeFile(filePath, improvedCode, "utf8");
      console.log(`✅ Updated ${targetFile} (validated + written)`);
    } catch (writeErr) {
      return {
        tool: "applyPatch",
        success: false,
        final: true,
        error: `Failed to write file: ${writeErr.message}`
      };
    }

    // 9. Generate diff summary
    const originalLines = originalCode.split('\n').length;
    const improvedLines = improvedCode.split('\n').length;
    const lineDiff = improvedLines - originalLines;

    const relativeBackup = path.relative(path.resolve(path.dirname(filePath), ".."), backupPath);
    const html = `
      <div class="apply-patch-tool">
        <h3>✅ Code Patch Applied</h3>
        <div class="patch-summary">
          <div class="patch-info">
            <strong>File:</strong> ${targetFile}<br/>
            <strong>Original:</strong> ${originalLines} lines<br/>
            <strong>Improved:</strong> ${improvedLines} lines<br/>
            <strong>Change:</strong> ${lineDiff > 0 ? '+' : ''}${lineDiff} lines<br/>
            <strong>Backup:</strong> ${relativeBackup}
          </div>
          <div class="patch-actions">
            <p>✅ Syntax + ESLint validated (${healAttempt} attempt${healAttempt > 1 ? "s" : ""})</p>
            <p>💾 Original backed up to backups/${toolName}/</p>
            <p>📦 Ready to commit changes</p>
          </div>
        </div>
      </div>
      <style>
        .apply-patch-tool {
          background: var(--bg-tertiary);
          border: 1px solid var(--success);
          border-radius: 8px;
          padding: 1.5rem;
          margin: 1rem 0;
        }
        .patch-summary {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .patch-info {
          background: var(--bg-hover);
          padding: 1rem;
          border-radius: 4px;
          font-family: monospace;
        }
        .patch-actions p {
          margin: 0.5rem 0;
        }
      </style>
    `;

    return {
      tool: "applyPatch",
      success: true,
      final: true,
      data: {
        targetFile,
        filePath,
        backupPath,
        originalLines,
        improvedLines,
        lineDiff,
        html,
        text: `✅ Applied improvements to ${targetFile}\n\nOriginal: ${originalLines} lines\nImproved: ${improvedLines} lines\nChange: ${lineDiff > 0 ? '+' : ''}${lineDiff} lines\n\nBackup saved to: ${relativeBackup}\n🛡️ Self-healed in ${healAttempt} attempt${healAttempt > 1 ? "s" : ""} (syntax + ESLint) ✅ — Ready to commit!`
      }
    };

  } catch (patchErr) {
    console.error("❌ applyPatch error:", patchErr);
    return {
      tool: "applyPatch",
      success: false,
      final: true,
      error: `Patch application failed: ${patchErr.message}`
    };
  }
}

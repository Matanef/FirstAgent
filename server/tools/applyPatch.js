// server/tools/applyPatch.js
// Applies code improvements based on review suggestions and trending patterns

import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";
import { llm } from "./llm.js";

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
 * Generate improved code using LLM
 */
async function generateImprovedCode({ originalCode, reviewSuggestions, trendingPatterns, filename }) {
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

**INSTRUCTIONS:**
1. Apply the review suggestions where applicable
2. Incorporate best practices from trending patterns
3. Maintain the original functionality
4. Preserve all imports and exports
5. Keep the code structure similar to avoid breaking changes
6. Add comments explaining significant changes

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
    } catch (err) {
      return {
        tool: "applyPatch",
        success: false,
        final: true,
        error: `Failed to read file: ${err.message}`
      };
    }

    // 4. Get review suggestions and trending patterns from context
    const reviewSuggestions = context.reviewSuggestions || context.review || "Apply general best practices";
    const trendingPatterns = context.trendingPatterns || context.patterns || "";

    console.log("🤖 Generating improved code with LLM...");

    // 5. Generate improved code
    const improvedCode = await generateImprovedCode({
      originalCode,
      reviewSuggestions: typeof reviewSuggestions === 'string' 
        ? reviewSuggestions 
        : JSON.stringify(reviewSuggestions, null, 2),
      trendingPatterns: typeof trendingPatterns === 'string'
        ? trendingPatterns
        : JSON.stringify(trendingPatterns, null, 2),
      filename: targetFile
    });

    // 6. Create backup
    const backupPath = `${filePath}.backup`;
    try {
      await fs.copyFile(filePath, backupPath);
      console.log(`💾 Backup created: ${backupPath}`);
    } catch (err) {
      console.warn(`⚠️ Could not create backup: ${err.message}`);
    }

    // 7. Write improved code
    try {
      await fs.writeFile(filePath, improvedCode, 'utf8');
      console.log(`✅ Updated ${targetFile}`);
    } catch (err) {
      return {
        tool: "applyPatch",
        success: false,
        final: true,
        error: `Failed to write file: ${err.message}`
      };
    }

    // 8. Generate diff summary
    const originalLines = originalCode.split('\n').length;
    const improvedLines = improvedCode.split('\n').length;
    const lineDiff = improvedLines - originalLines;

    const html = `
      <div class="apply-patch-tool">
        <h3>✅ Code Patch Applied</h3>
        <div class="patch-summary">
          <div class="patch-info">
            <strong>File:</strong> ${targetFile}<br/>
            <strong>Original:</strong> ${originalLines} lines<br/>
            <strong>Improved:</strong> ${improvedLines} lines<br/>
            <strong>Change:</strong> ${lineDiff > 0 ? '+' : ''}${lineDiff} lines<br/>
            <strong>Backup:</strong> ${path.basename(backupPath)}
          </div>
          <div class="patch-actions">
            <p>✅ File has been updated with improvements</p>
            <p>💾 Original backed up to ${path.basename(backupPath)}</p>
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
        text: `✅ Applied improvements to ${targetFile}\n\nOriginal: ${originalLines} lines\nImproved: ${improvedLines} lines\nChange: ${lineDiff > 0 ? '+' : ''}${lineDiff} lines\n\nBackup saved to: ${path.basename(backupPath)}\nReady to commit!`
      }
    };

  } catch (err) {
    console.error("❌ applyPatch error:", err);
    return {
      tool: "applyPatch",
      success: false,
      final: true,
      error: `Patch application failed: ${err.message}`
    };
  }
}

// server/tools/review.js
// COMPLETE FIX #4, #5: Review tool that actually reads files (no hallucination)

import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";

const SANDBOX_ROOTS = [
  path.resolve("D:/local-llm-ui"),
  path.resolve("E:/testFolder")
];

const MAX_FILE_SIZE = 200 * 1024; // 200KB

function isPathAllowed(resolvedPath) {
  return SANDBOX_ROOTS.some(root => resolvedPath.startsWith(root));
}

// Extract file path from natural language
function extractFilePath(query) {
  const lower = query.toLowerCase();
  
  // Pattern 1: "review news.js in tools folder"
  let match = query.match(/review\s+([a-zA-Z0-9_\-\.]+)\s+in\s+(the\s+)?([a-zA-Z0-9_\-\/\s]+)/i);
  if (match) {
    const filename = match[1];
    let folder = match[3].trim();
    
    // Clean up folder path
    folder = folder.replace(/\s+folder\s*$/i, '').replace(/\s+/g, '/');
    
    return { filename, folder, fullPath: `${folder}/${filename}` };
  }
  
  // Pattern 2: "review server/tools/news.js"
  match = query.match(/review\s+([a-zA-Z0-9_\-\.\/\\]+)/i);
  if (match) {
    const fullPath = match[1].trim();
    return { fullPath };
  }
  
  // Pattern 3: Just a filename
  match = query.match(/review\s+([a-zA-Z0-9_\-\.]+)/i);
  if (match) {
    return { filename: match[1] };
  }
  
  return null;
}

// Resolve file path with sandbox validation
async function resolveFilePath(pathInfo) {
  if (!pathInfo) return null;
  
  const sandboxRoot = SANDBOX_ROOTS[0]; // Default to project root
  
  // Try direct path first
  if (pathInfo.fullPath) {
    let resolved = path.resolve(sandboxRoot, pathInfo.fullPath);
    if (isPathAllowed(resolved)) {
      try {
        await fs.access(resolved);
        return resolved;
      } catch {
        // Try without extension
        resolved = path.resolve(sandboxRoot, pathInfo.fullPath + '.js');
        if (isPathAllowed(resolved)) {
          try {
            await fs.access(resolved);
            return resolved;
          } catch {}
        }
      }
    }
  }
  
  // Try filename + folder
  if (pathInfo.filename && pathInfo.folder) {
    const resolved = path.resolve(sandboxRoot, pathInfo.folder, pathInfo.filename);
    if (isPathAllowed(resolved)) {
      try {
        await fs.access(resolved);
        return resolved;
      } catch {}
    }
  }
  
  // Try just filename (search common locations)
  if (pathInfo.filename) {
    const commonPaths = [
      path.resolve(sandboxRoot, 'server/tools', pathInfo.filename),
      path.resolve(sandboxRoot, 'server', pathInfo.filename),
      path.resolve(sandboxRoot, 'client/src', pathInfo.filename),
      path.resolve(sandboxRoot, pathInfo.filename)
    ];
    
    for (const testPath of commonPaths) {
      if (isPathAllowed(testPath)) {
        try {
          await fs.access(testPath);
          return testPath;
        } catch {}
      }
    }
  }
  
  return null;
}

export async function review(query) {
  try {
    console.log("🔍 Review tool called with:", query);
    
    // Extract file path
    const pathInfo = extractFilePath(query);
    if (!pathInfo) {
      return {
        tool: "review",
        success: false,
        final: true,
        error: "Could not determine which file to review. Please specify a file path like:\n- 'review news.js in tools folder'\n- 'review server/tools/news.js'\n- 'review news.js'"
      };
    }
    
    console.log("📂 Extracted path info:", pathInfo);
    
    // Resolve to actual file path
    const resolvedPath = await resolveFilePath(pathInfo);
    if (!resolvedPath) {
      return {
        tool: "review",
        success: false,
        final: true,
        error: `Could not find file: ${pathInfo.filename || pathInfo.fullPath}\n\nSearched in:\n- server/tools/\n- server/\n- client/src/\n- project root\n\nPlease check the file name and path.`
      };
    }
    
    console.log("✅ Resolved to:", resolvedPath);
    
    // Check file size
    const stat = await fs.stat(resolvedPath);
    if (stat.size > MAX_FILE_SIZE) {
      return {
        tool: "review",
        success: false,
        final: true,
        error: `File too large: ${Math.round(stat.size / 1024)}KB (max 200KB)\n\nPlease review smaller files or request specific sections.`
      };
    }
    
    // Read file content
    const content = await fs.readFile(resolvedPath, "utf8");
    const lines = content.split('\n').length;
    
    console.log(`📄 Read file: ${lines} lines, ${content.length} bytes`);
    
    // Build LLM review prompt
    const filename = path.basename(resolvedPath);
    const relativePath = path.relative("D:/local-llm-ui", resolvedPath);
    
    const prompt = `You are a senior software engineer conducting a code review.

FILE: ${relativePath}
PROJECT CONTEXT: Local LLM UI (Node.js/Express backend + React frontend)
LINES: ${lines}
SIZE: ${Math.round(content.length / 1024)}KB

TASK: Provide a structured, professional code review with:

1. **Summary** (2-3 sentences):
   - What this file does
   - How it fits into the project architecture
   - Its role and responsibilities

2. **Key Observations** (3-5 points):
   - Important design patterns used
   - Critical functionality
   - Notable implementation details

3. **Strengths** (2-3 points):
   - What's done well
   - Good practices observed

4. **Suggestions for Improvement** (3-5 points):
   - Specific, actionable improvements
   - Security considerations
   - Performance optimizations
   - Code quality enhancements

FILE CONTENT:
\`\`\`javascript
${content}
\`\`\`

IMPORTANT: 
- Be specific and reference actual code
- Provide actionable suggestions
- Keep professional tone
- Focus on substance, not style`;

    // Get LLM review
    console.log("🤖 Calling LLM for review...");
    const llmResponse = await llm(prompt);
    
    if (!llmResponse.success) {
      throw new Error("LLM review failed: " + (llmResponse.error || "Unknown error"));
    }
    
    const reviewText = llmResponse.data?.text || "Review could not be generated.";
    
    console.log("✅ Review generated:", reviewText.slice(0, 100) + "...");
    
    // Format response
    const html = `
      <div class="review-panel">
        <div class="review-header">
          <h3>🔍 Code Review: ${filename}</h3>
          <p class="review-path">📂 ${relativePath}</p>
          <p class="review-meta">📏 ${lines} lines • ${Math.round(content.length / 1024)}KB</p>
        </div>
        <div class="review-content">
          ${reviewText.replace(/\n\n/g, '</p><p>').replace(/^/, '<p>').replace(/$/, '</p>')}
        </div>
      </div>
      
      <style>
        .review-panel {
          background: var(--bg-tertiary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 1.5rem;
          margin: 1rem 0;
        }
        .review-header h3 {
          color: var(--accent);
          margin-bottom: 0.5rem;
        }
        .review-path {
          color: var(--text-secondary);
          font-family: monospace;
          font-size: 0.9rem;
          margin: 0.25rem 0;
        }
        .review-meta {
          color: var(--text-muted);
          font-size: 0.85rem;
          margin: 0.25rem 0;
        }
        .review-content {
          margin-top: 1rem;
          color: var(--text-primary);
          line-height: 1.6;
        }
        .review-content p {
          margin: 0.75rem 0;
        }
      </style>
    `;
    
    return {
      tool: "review",
      success: true,
      final: true,
      data: {
        file: filename,
        path: relativePath,
        lines,
        size: content.length,
        reviewText,
        html,
        text: `Code Review: ${filename}\n\n${reviewText}`
      },
      reasoning: `Reviewed ${filename} (${lines} lines)`
    };
    
  } catch (err) {
    console.error("❌ Review tool error:", err);
    return {
      tool: "review",
      success: false,
      final: true,
      error: `Review failed: ${err.message}\n\nPlease check:\n1. File path is correct\n2. File exists and is readable\n3. File is under 200KB`,
      data: {
        errorDetails: err.message
      }
    };
  }
}

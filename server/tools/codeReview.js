// server/tools/codeReview.js
// Deep code analysis tool — quality review, smell detection, architecture analysis
// Uses LLM for intelligent code understanding with structured output

import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";

const MAX_FILE_SIZE = 256 * 1024; // 256 KB
const MAX_FILES_PER_REVIEW = 20;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "build", "out", "__pycache__",
  ".cache", ".next", "coverage", ".vscode", ".idea", "vendor"
]);

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "hpp",
  "cs", "go", "rs", "rb", "php", "swift", "kt", "vue", "svelte"
]);

/**
 * Recursively collect code files
 */
async function collectCodeFiles(dirPath, depth = 0, maxDepth = 5) {
  const files = [];
  if (depth > maxDepth) return files;

  let items;
  try {
    items = await fs.readdir(dirPath, { withFileTypes: true });
  } catch { return files; }

  for (const item of items) {
    if (SKIP_DIRS.has(item.name)) continue;
    if (item.name.startsWith(".") && item.isDirectory()) continue;

    const fullPath = path.join(dirPath, item.name);

    if (item.isDirectory()) {
      const subFiles = await collectCodeFiles(fullPath, depth + 1, maxDepth);
      files.push(...subFiles);
    } else {
      const ext = path.extname(item.name).slice(1).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size <= MAX_FILE_SIZE) {
            files.push({ path: fullPath, name: item.name, ext, size: stat.size });
          }
        } catch { /* skip */ }
      }
    }

    if (files.length >= MAX_FILES_PER_REVIEW * 3) break;
  }

  return files;
}

/**
 * Read file contents safely
 */
async function readFileSafe(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    return null;
  }
}

/**
 * Analyze a single file with LLM
 */
async function analyzeFile(filePath, content, reviewType) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).slice(1);

  const prompts = {
    quality: `Analyze this ${ext} file for code quality. Be concise and actionable.

File: ${filename}
\`\`\`${ext}
${content.slice(0, 8000)}
\`\`\`

Provide a structured review:
1. QUALITY SCORE (1-10)
2. ISSUES (list each with severity: critical/warning/info)
3. IMPROVEMENTS (specific, actionable suggestions with code snippets if helpful)
4. GOOD PRACTICES (what the code does well)

Format as plain text with clear headers. Be specific — reference line numbers or function names.`,

    security: `Analyze this ${ext} file for security vulnerabilities. Be thorough.

File: ${filename}
\`\`\`${ext}
${content.slice(0, 8000)}
\`\`\`

Check for:
1. Injection vulnerabilities (SQL, XSS, command injection)
2. Insecure data handling (hardcoded secrets, unvalidated input)
3. Authentication/authorization flaws
4. Insecure dependencies or patterns
5. Error handling that leaks information

For each finding: describe the vulnerability, its severity (critical/high/medium/low), and suggest a fix.`,

    performance: `Analyze this ${ext} file for performance issues. Be specific.

File: ${filename}
\`\`\`${ext}
${content.slice(0, 8000)}
\`\`\`

Check for:
1. Unnecessary computations in loops
2. Memory leaks (unclosed resources, growing arrays)
3. Blocking operations (sync I/O, heavy computation)
4. Missing caching opportunities
5. Inefficient data structures or algorithms
6. N+1 query patterns

For each issue: explain the impact and suggest an optimization.`,

    architecture: `Analyze this ${ext} file's architecture and design patterns.

File: ${filename}
\`\`\`${ext}
${content.slice(0, 8000)}
\`\`\`

Evaluate:
1. Single Responsibility: Does each function/class do one thing well?
2. Dependencies: Are imports well-organized? Any circular risks?
3. Error Handling: Is it comprehensive and consistent?
4. Naming: Are variables, functions, and modules named clearly?
5. Modularity: Could parts be extracted into separate modules?
6. Testability: Is the code easy to unit test?

Provide specific refactoring suggestions with brief code examples.`,

    full: `Do a comprehensive code review of this ${ext} file.

File: ${filename}
\`\`\`${ext}
${content.slice(0, 8000)}
\`\`\`

Cover ALL of the following:
1. CODE QUALITY (score 1-10, issues, good practices)
2. SECURITY (vulnerabilities, hardcoded secrets)
3. PERFORMANCE (bottlenecks, optimization opportunities)
4. ARCHITECTURE (design patterns, modularity, naming)
5. SUGGESTIONS (top 3 most impactful improvements)

Be concise but thorough. Reference specific functions or line ranges.`
  };

  const prompt = prompts[reviewType] || prompts.full;

  try {
    const response = await llm(prompt);
    return {
      file: filePath,
      filename,
      review: response?.data?.text || "Review generation failed.",
      success: true
    };
  } catch (err) {
    return {
      file: filePath,
      filename,
      review: `Error analyzing file: ${err.message}`,
      success: false
    };
  }
}

/**
 * Analyze project-level architecture
 */
async function analyzeProjectArchitecture(dirPath, files) {
  // Build a dependency map by scanning imports
  const depMap = {};
  for (const f of files.slice(0, 30)) {
    const content = await readFileSafe(f.path);
    if (!content) continue;

    const imports = [];
    const importRegex = /(?:import\s+.*?from\s+['"](.+?)['"]|require\s*\(\s*['"](.+?)['"]\s*\))/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }

    const relativePath = path.relative(dirPath, f.path).replace(/\\/g, "/");
    depMap[relativePath] = imports;
  }

  // Detect patterns
  const fileList = files.map(f => path.relative(dirPath, f.path).replace(/\\/g, "/")).join("\n");

  const prompt = `Analyze this project's architecture based on its file structure and dependency map.

Project root: ${dirPath}

File list:
${fileList}

Import/dependency map:
${JSON.stringify(depMap, null, 2)}

Provide:
1. ARCHITECTURE TYPE (monolith, microservices, modular, MVC, etc.)
2. DEPENDENCY ANALYSIS (any circular dependencies? tightly coupled modules?)
3. PROJECT HEALTH (well-organized? missing patterns?)
4. RECOMMENDATIONS (top 5 architectural improvements)
5. DEAD CODE RISK (files that appear unused or orphaned)

Be specific and reference actual file paths.`;

  try {
    const response = await llm(prompt);
    return response?.data?.text || "Architecture analysis failed.";
  } catch (err) {
    return `Architecture analysis error: ${err.message}`;
  }
}

/**
 * Detect review intent from text
 */
function detectReviewType(text) {
  const lower = text.toLowerCase();
  if (/\bsecur/i.test(lower)) return "security";
  if (/\bperform/i.test(lower)) return "performance";
  if (/\barchitect/i.test(lower)) return "architecture";
  if (/\b(quality|smell|lint|clean)/i.test(lower)) return "quality";
  return "full";
}

/**
 * Extract file or folder path from request
 */
function extractTarget(text) {
  // Explicit path
  const pathMatch = text.match(/([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/);
  if (pathMatch) return pathMatch[1].replace(/\\/g, "/");

  // Quoted
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1];

  return null;
}

/**
 * Main entry point
 */
export async function codeReview(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "codeReview",
      success: false,
      final: true,
      data: { message: "Please specify what to review. Example: 'review D:/my-project' or 'security review server/tools/email.js'" }
    };
  }

  const reviewType = context.reviewType || detectReviewType(text);
  const targetPath = context.path || extractTarget(text);

  if (!targetPath) {
    return {
      tool: "codeReview",
      success: false,
      final: true,
      data: { message: "Please provide a file or folder path to review. Example: 'review D:/local-llm-ui/server'" }
    };
  }

  const normalizedPath = path.resolve(targetPath);

  try {
    const stat = await fs.stat(normalizedPath);

    if (stat.isFile()) {
      // Single file review
      const content = await readFileSafe(normalizedPath);
      if (!content) {
        return { tool: "codeReview", success: false, final: true, data: { message: `Could not read file: ${normalizedPath}` } };
      }

      const result = await analyzeFile(normalizedPath, content, reviewType);

      return {
        tool: "codeReview",
        success: result.success,
        final: true,
        data: {
          preformatted: true,
          text: `🔍 **Code Review: ${result.filename}** (${reviewType})\n\n${result.review}`,
          reviewType,
          files: [result]
        }
      };
    }

    if (stat.isDirectory()) {
      // Project/folder review
      const codeFiles = await collectCodeFiles(normalizedPath);

      if (codeFiles.length === 0) {
        return { tool: "codeReview", success: false, final: true, data: { message: `No code files found in ${normalizedPath}` } };
      }

      // For architecture review, analyze the full project
      if (reviewType === "architecture") {
        const archReview = await analyzeProjectArchitecture(normalizedPath, codeFiles);
        return {
          tool: "codeReview",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: `🏗️ **Architecture Review: ${normalizedPath}**\n(${codeFiles.length} code files analyzed)\n\n${archReview}`,
            reviewType,
            fileCount: codeFiles.length
          }
        };
      }

      // For other reviews, analyze top files
      const filesToReview = codeFiles.slice(0, MAX_FILES_PER_REVIEW);
      const reviews = [];

      for (const f of filesToReview) {
        const content = await readFileSafe(f.path);
        if (!content) continue;
        const result = await analyzeFile(f.path, content, reviewType);
        reviews.push(result);
      }

      let summary = `🔍 **${reviewType.charAt(0).toUpperCase() + reviewType.slice(1)} Review: ${normalizedPath}**\n`;
      summary += `(${reviews.length} of ${codeFiles.length} files reviewed)\n\n`;

      for (const r of reviews) {
        summary += `---\n### 📄 ${r.filename}\n${r.review}\n\n`;
      }

      return {
        tool: "codeReview",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: summary,
          reviewType,
          files: reviews,
          totalFiles: codeFiles.length,
          reviewedFiles: reviews.length
        }
      };
    }

    return { tool: "codeReview", success: false, final: true, data: { message: `${normalizedPath} is neither a file nor a directory.` } };
  } catch (err) {
    return {
      tool: "codeReview",
      success: false,
      final: true,
      data: { message: `Error accessing "${normalizedPath}": ${err.message}` }
    };
  }
}

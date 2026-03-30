// server/tools/codeReview.js
// Deep code analysis tool — quality review, smell detection, architecture analysis
// Uses LLM for intelligent code understanding with structured output

import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";
import { loadReviewCache, saveReviewCache } from "../utils/cacheReview.js"
import { validateCode } from "../utils/codeValidator.js";

const FAST_REVIEW_MODEL = "qwen2.5-coder:7b";   // <— FAST MODEL FOR ALL CODE REVIEWS
const FILE_TIMEOUT = 300_000;            // 60s per file
const ARCH_TIMEOUT = 600_000;            // 90s for architecture review

const MAX_FILE_SIZE = 256 * 1024; // 256 KB
const MAX_FILES_PER_REVIEW = 20;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "build", "out", "__pycache__",
  ".cache", ".next", "coverage", ".vscode", ".idea", "vendor"
]);

// ── SECURITY: Sandbox boundaries for code review ──
const ALLOWED_ROOTS = [
  path.resolve("D:/local-llm-ui"),
  path.resolve("E:/testFolder")
];

function isReviewPathAllowed(resolvedPath) {
  return ALLOWED_ROOTS.some(root => {
    const rel = path.relative(root, resolvedPath);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

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
  } catch {
    return files;
  }

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
  } catch {
    return null;
  }
}

/**
 * Analyze a single file with LLM (FAST MODEL)
 */
async function analyzeFile(filePath, content, reviewType, objectiveFindings = "") {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).slice(1);

  console.log(`[codeReview] Analyzing file with ${FAST_REVIEW_MODEL}: ${filename}`);

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
1. Single Responsibility
2. Dependencies
3. Error Handling
4. Naming
5. Modularity
6. Testability

Provide specific refactoring suggestions with brief code examples.`,

    full: `Do a comprehensive code review of this ${ext} file.

File: ${filename}
\`\`\`${ext}
${content.slice(0, 8000)}
\`\`\`

Cover:
1. CODE QUALITY
2. SECURITY
3. PERFORMANCE
4. ARCHITECTURE
5. TOP 3 IMPROVEMENTS

Be concise but thorough.`
  };

  // Inject objective findings (syntax/ESLint errors) into the prompt so the LLM
  // reviews real issues instead of guessing. Only present for single-file reviews.
  const objectiveSection = objectiveFindings
    ? `\n\n--- AUTOMATED VALIDATION RESULTS (syntax check + ESLint) ---${objectiveFindings}\n--- END VALIDATION RESULTS ---\n\nIMPORTANT: The errors above are REAL and confirmed by automated tooling. Address these FIRST in your review. Do not contradict or ignore them.\n`
    : "";

  const prompt = (prompts[reviewType] || prompts.full) + objectiveSection;

try {
    const response = await llm(prompt, {
      model: FAST_REVIEW_MODEL,
      timeoutMs: FILE_TIMEOUT
    });

    // FIX: Explicitly check if the LLM wrapper reported a failure (like a timeout)
    if (!response || response.success === false) {
      const errorMsg = response?.error || response?.data?.text || "LLM request timed out.";
      console.error(`[codeReview] LLM failed for ${filename}:`, errorMsg);
      return {
        file: filePath,
        filename,
        review: `Review failed: ${errorMsg}`,
        success: false // This halts the chain!
      };
    }

    return {
      file: filePath,
      filename,
      review: response?.data?.text || "Review generation failed.",
      success: true
    };
  } catch (err) {
    console.error(`[codeReview] Error analyzing ${filename}:`, err.message);
    return {
      file: filePath,
      filename,
      review: `Error analyzing file: ${err.message}`,
      success: false
    };
  }
}

/**
 * Analyze project-level architecture (FAST MODEL)
 */
async function analyzeProjectArchitecture(dirPath, files) {
  console.log(`[codeReview] Running architecture review with ${FAST_REVIEW_MODEL}`);

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

  const fileList = files
    .map(f => path.relative(dirPath, f.path).replace(/\\/g, "/"))
    .join("\n");

  const prompt = `Analyze this project's architecture.

Project root: ${dirPath}

File list:
${fileList}

Dependency map:
${JSON.stringify(depMap, null, 2)}

Provide:
1. ARCHITECTURE TYPE
2. DEPENDENCY ANALYSIS
3. PROJECT HEALTH
4. TOP 5 IMPROVEMENTS
5. DEAD CODE RISK`;

  try {
    const response = await llm(prompt, {
      model: FAST_REVIEW_MODEL,
      timeoutMs: ARCH_TIMEOUT
    });

    return response?.data?.text || "Architecture analysis failed.";
  } catch (err) {
    return `Architecture analysis error: ${err.message}`;
  }
}

/**
 * Detect review intent
 */
function detectReviewType(text) {
const lower = text.toLowerCase();
const reviewTypeMap = {
  secur: 'security',
  perform: 'performance',
  architect: 'architecture',
  quality: 'quality',
  smell: 'quality',
  lint: 'quality',
  clean: 'quality'
};
const match = Object.keys(reviewTypeMap).find(key => new RegExp(`\\b${key}\\b`, 'i').test(lower));
return match ? reviewTypeMap[match] : 'full';
}

/**
 * Extract file or folder path from request
 */
function extractTarget(text) {
  const pathMatch = text.match(/([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/);
  if (pathMatch) return pathMatch[1].replace(/\\/g, "/");

  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1];

  return null;
}

/**
 * Main entry point
 */
export async function codeReview(request) {
  const text =
    typeof request === "string"
      ? request
      : request?.text || request?.input || "";

  const context =
    typeof request === "object" ? request?.context || {} : {};

  const signal = context.signal || null;
  const budgetMs = context.budgetMs || null;
  const isSelfEvolve = context.source === "selfEvolve";

  if (!text.trim() && !context.path) {
    return {
      tool: "codeReview",
      success: false,
      final: true,
      data: {
        message:
          "Please specify what to review. Example: 'review D:/my-project' or 'security review server/tools/email.js'"
      }
    };
  }

  const reviewType = context.reviewType || detectReviewType(text);
  const targetPath = context.path || extractTarget(text);

  if (!targetPath) {
    return {
      tool: "codeReview",
      success: false,
      final: true,
      data: {
        message:
          "Please provide a file or folder path to review. Example: 'review D:/local-llm-ui/server'"
      }
    };
  }

  let normalizedPath = path.resolve(targetPath);

  // ── SECURITY: Resolve symlinks and enforce sandbox boundaries ──
  try { normalizedPath = await fs.realpath(normalizedPath); } catch { /* proceed */ }
  if (!isReviewPathAllowed(normalizedPath)) {
    console.warn(`🛡️ [codeReview] BLOCKED path outside sandbox: ${normalizedPath}`);
    return {
      tool: "codeReview", success: false, final: true,
      data: { message: `Access denied: "${targetPath}" is outside allowed project boundaries.` }
    };
  }

  const startTime = Date.now();

  try {
    const stat = await fs.stat(normalizedPath);

    // Single file review
    if (stat.isFile()) {
      const content = await readFileSafe(normalizedPath);
      if (!content) {
        return {
          tool: "codeReview",
          success: false,
          final: true,
          data: { message: `Could not read file: ${normalizedPath}` }
        };
      }

      // ── Objective validation (syntax + ESLint) before LLM review ──
      // Runs the same pipeline as smartEvolution/codeTransform so the
      // LLM review is grounded in real errors, not hallucinated ones.
      let objectiveFindings = "";
      const ext = path.extname(normalizedPath);
      if ([".js", ".mjs", ".jsx", ".ts", ".tsx"].includes(ext)) {
        console.log(`[codeReview] Running objective validation: ${path.basename(normalizedPath)}`);
        const validation = await validateCode(normalizedPath);
        if (!validation.valid) {
          objectiveFindings = `\n\nOBJECTIVE ERRORS DETECTED (${validation.stage}):\n${validation.error}`;
          console.log(`[codeReview] Found objective errors (${validation.stage})`);
        } else if (validation.warnings?.length) {
          objectiveFindings = `\n\nOBJECTIVE WARNINGS:\n${validation.warnings.join("\n")}`;
        }
      }

      const result = await analyzeFile(normalizedPath, content, reviewType, objectiveFindings);

      // For selfEvolve, we can still cache this single file under its folder
      if (isSelfEvolve) {
        const folderPath = path.dirname(normalizedPath);
        const cache = await loadReviewCache(folderPath);
        const reviewedFilesSet = new Set(cache.reviewedFiles);
        const relativeName = path.basename(normalizedPath);
        reviewedFilesSet.add(relativeName);
        await saveReviewCache(cache.cacheFile, Array.from(reviewedFilesSet));
      }

      // Build output with objective findings shown first (if any)
      let reviewOutput = `🔍 **Code Review: ${result.filename}** (${reviewType})\n\n`;
      if (objectiveFindings) {
        reviewOutput += `**🔬 Objective Validation:**${objectiveFindings}\n\n---\n\n`;
      }
      reviewOutput += `**📝 LLM Analysis:**\n${result.review}`;

      return {
        tool: "codeReview",
        success: result.success,
        final: true,
        data: {
          preformatted: true,
          text: reviewOutput,
          reviewType,
          hasObjectiveErrors: !!objectiveFindings,
          files: [result]
        }
      };
    }

    // Directory review
    if (stat.isDirectory()) {
      const codeFiles = await collectCodeFiles(normalizedPath);

      if (codeFiles.length === 0) {
        return {
          tool: "codeReview",
          success: false,
          final: true,
          data: { message: `No code files found in ${normalizedPath}` }
        };
      }

      // Architecture-only review (unchanged)
      if (reviewType === "architecture" && !isSelfEvolve) {
        const archReview = await analyzeProjectArchitecture(
          normalizedPath,
          codeFiles
        );

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

      // === NEW BEHAVIOR FOR selfEvolve: full-folder review with cache + budget ===
      if (isSelfEvolve) {
        const cache = await loadReviewCache(normalizedPath);
        const reviewedFilesSet = new Set(cache.reviewedFiles);
        const reviews = [];
        let newlyReviewedCount = 0;

        for (const f of codeFiles) {
          if (signal?.aborted) {
            console.log("[codeReview] Aborted by signal during selfEvolve review.");
            break;
          }
          if (budgetMs && Date.now() - startTime > budgetMs) {
            console.log("[codeReview] Budget exceeded during selfEvolve review.");
            break;
          }

          const relativeName = path.relative(normalizedPath, f.path).replace(/\\/g, "/");

          // Skip already-reviewed files
          if (reviewedFilesSet.has(relativeName)) continue;

          const content = await readFileSafe(f.path);
          if (!content) continue;

          const result = await analyzeFile(f.path, content, reviewType);
          reviews.push(result);

          reviewedFilesSet.add(relativeName);
          newlyReviewedCount++;

          // Save cache incrementally
          await saveReviewCache(cache.cacheFile, Array.from(reviewedFilesSet));
        }

        let summary = `🔍 **Self-Evolve ${reviewType.charAt(0).toUpperCase() + reviewType.slice(1)} Review: ${normalizedPath}**\n`;
        summary += `New files reviewed this run: ${newlyReviewedCount}\n`;
        summary += `Total cached reviewed files: ${reviewedFilesSet.size} of ${codeFiles.length}\n\n`;

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
            reviewedFiles: reviewedFilesSet.size,
            newlyReviewed: newlyReviewedCount
          }
        };
      }

      // === ORIGINAL BEHAVIOR for normal/manual usage ===
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

    return {
      tool: "codeReview",
      success: false,
      final: true,
      data: { message: `${normalizedPath} is neither a file nor a directory.` }
    };
  } catch (err) {
    return {
      tool: "codeReview",
      success: false,
      final: true,
      data: {
        message: `Error accessing "${normalizedPath}": ${err.message}`
      }
    };
  }
}
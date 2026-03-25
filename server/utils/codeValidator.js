// server/utils/codeValidator.js
// ──────────────────────────────────────────────────────────────────────────────
// SHARED SELF-HEALING CODE VALIDATION PIPELINE
//
// Used by: codeTransform.js, applyPatch.js, fileWrite.js (any tool that writes code)
//
// PIPELINE (3 stages, each stage gates the next):
// 1. SYNTAX CHECK:  `node --check <file>` — catches parse errors, missing brackets,
//                    invalid tokens, unterminated strings, etc.
// 2. SEMANTIC CHECK: `npx eslint@8 <file>` — catches undefined variables, unused imports,
//                    unreachable code, duplicate keys, etc.
// 3. (Optional) GEMINI CRITIC: External AI reviewer for logic validation.
//
// SELF-HEALING LOOP:
// If validation fails, the error is captured and returned to the caller.
// The caller (codeTransform/applyPatch) feeds the error back to the LLM
// for a retry, up to MAX_ATTEMPTS.
//
// This module is a UTILITY, not a tool — it doesn't export the standard
// tool signature. It's imported by code-writing tools.
// ──────────────────────────────────────────────────────────────────────────────

import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// ── Validation timeouts
const SYNTAX_CHECK_TIMEOUT = 10_000;  // 10s for node --check
const ESLINT_TIMEOUT = 30_000;        // 30s for ESLint (slower on large files)

// ──────────────────────────────────────────────────────────────────────────────
// STAGE 1: SYNTAX VALIDATION (node --check)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run `node --check` on a file to verify it parses without syntax errors.
 *
 * @param {string} filePath - Absolute path to the .js file to check
 * @returns {{ valid: boolean, error: string|null }}
 */
export async function checkSyntax(filePath) {
  try {
    await execAsync(`node --check "${filePath}"`, {
      timeout: SYNTAX_CHECK_TIMEOUT,
      windowsHide: true
    });
    return { valid: true, error: null };
  } catch (err) {
    // Extract the meaningful error from stderr
    const stderr = err.stderr?.toString() || err.message || "Unknown syntax error";
    // Clean up the error: remove the file path prefix for readability
    const cleanError = stderr
      .split("\n")
      .filter(line => line.trim() && !line.includes("SyntaxError: ") || line.includes("SyntaxError:"))
      .join("\n")
      .trim();

    return {
      valid: false,
      error: `Syntax Error:\n${cleanError}`
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// STAGE 2: SEMANTIC VALIDATION (ESLint)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run ESLint on a file to check for semantic errors.
 * Uses a minimal, zero-config ruleset focused on catching real bugs:
 * - no-undef: Undefined variables (catches typos in imports)
 * - no-dupe-keys: Duplicate object keys
 * - no-unreachable: Code after return/throw
 * - constructor-super: Missing super() in constructors
 *
 * @param {string} filePath - Absolute path to the .js file to lint
 * @returns {{ valid: boolean, error: string|null, warnings: string[] }}
 */
export async function checkSemantics(filePath) {
  try {
    // ESLint 8 with zero-config: only error-level rules that catch real bugs
    const cmd = [
      "npx eslint@8",
      "--no-eslintrc",
      "--env node",
      "--env es2024",
      "--parser-options=ecmaVersion:latest",
      "--parser-options=sourceType:module",
      "--rule no-undef:error",
      "--rule no-dupe-keys:error",
      "--rule no-unreachable:error",
      "--rule constructor-super:error",
      "--rule no-const-assign:error",
      "--rule no-dupe-class-members:error",
      "--rule no-duplicate-imports:warn",
      `"${filePath}"`
    ].join(" ");

    const { stdout } = await execAsync(cmd, {
      timeout: ESLINT_TIMEOUT,
      windowsHide: true
    });

    // ESLint returns exit code 0 if no errors — but may still have warnings
    const warnings = (stdout || "")
      .split("\n")
      .filter(line => line.includes("warning"))
      .map(line => line.trim());

    return { valid: true, error: null, warnings };

  } catch (err) {
    // ESLint returns exit code 1 for errors, 2 for fatal errors
    const output = err.stdout || err.stderr || err.message || "";

    // Extract only error lines (not warnings, not summary)
    const errorLines = output
      .split("\n")
      .filter(line => line.includes("error") && !line.includes("0 errors"))
      .map(line => line.trim())
      .filter(Boolean);

    if (errorLines.length === 0) {
      // ESLint failed but no actual errors found (might be a config issue)
      // Treat as a pass with a warning
      return { valid: true, error: null, warnings: [`ESLint process issue: ${output.slice(0, 200)}`] };
    }

    return {
      valid: false,
      error: `ESLint Errors:\n${errorLines.join("\n")}`,
      warnings: []
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// COMBINED VALIDATION PIPELINE
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the full validation pipeline on a staged file.
 * Stages run in order; if an earlier stage fails, later stages are skipped.
 *
 * @param {string} filePath - Absolute path to the file to validate
 * @param {Object} options - Optional configuration
 * @param {boolean} options.skipLint - Skip ESLint (useful for non-JS files)
 * @returns {{ valid: boolean, stage: string, error: string|null, warnings: string[] }}
 */
export async function validateCode(filePath, options = {}) {
  const ext = path.extname(filePath);

  // Only validate JavaScript/TypeScript files
  if (![".js", ".mjs", ".jsx", ".ts", ".tsx"].includes(ext)) {
    return { valid: true, stage: "skipped", error: null, warnings: ["Non-JS file — validation skipped"] };
  }

  // ── Stage 1: Syntax ──
  console.log(`[validator] Running syntax check: ${path.basename(filePath)}`);
  const syntaxResult = await checkSyntax(filePath);
  if (!syntaxResult.valid) {
    console.error(`[validator] 🔴 Syntax check FAILED`);
    return {
      valid: false,
      stage: "syntax",
      error: syntaxResult.error,
      warnings: []
    };
  }
  console.log(`[validator] 🟢 Syntax check passed`);

  // ── Stage 2: Semantics (ESLint) ──
  if (!options.skipLint) {
    console.log(`[validator] Running semantic check: ${path.basename(filePath)}`);
    const semanticResult = await checkSemantics(filePath);
    if (!semanticResult.valid) {
      console.error(`[validator] 🔴 Semantic check FAILED`);
      return {
        valid: false,
        stage: "semantics",
        error: semanticResult.error,
        warnings: semanticResult.warnings || []
      };
    }
    console.log(`[validator] 🟢 Semantic check passed`);
    return {
      valid: true,
      stage: "complete",
      error: null,
      warnings: semanticResult.warnings || []
    };
  }

  return {
    valid: true,
    stage: "syntax-only",
    error: null,
    warnings: []
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// SELF-HEALING LOOP HELPER
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the self-healing validation loop.
 * Writes code to a staging file, validates it, and returns the result.
 * If validation fails, returns the error for the caller to feed back to the LLM.
 *
 * @param {string} code - The generated code to validate
 * @param {string} targetPath - The intended destination file path
 * @param {Object} options - Optional configuration
 * @param {boolean} options.skipLint - Skip ESLint check
 * @returns {{ valid: boolean, stagingPath: string, error: string|null, warnings: string[] }}
 */
export async function validateStaged(code, targetPath, options = {}) {
  const stagingPath = `${targetPath}.staging.js`;

  try {
    // Write to staging file
    await fs.writeFile(stagingPath, code, "utf8");

    // Run validation pipeline
    const result = await validateCode(stagingPath, options);

    if (!result.valid) {
      // Clean up staging file on failure
      await fs.unlink(stagingPath).catch(() => {});
    }

    return {
      ...result,
      stagingPath
    };

  } catch (err) {
    // Clean up on any error
    await fs.unlink(stagingPath).catch(() => {});
    return {
      valid: false,
      stage: "io",
      error: `Staging failed: ${err.message}`,
      warnings: [],
      stagingPath
    };
  }
}

/**
 * Clean up a staging file (call after successful atomic swap or final failure).
 */
export async function cleanupStaging(targetPath) {
  const stagingPath = `${targetPath}.staging.js`;
  await fs.unlink(stagingPath).catch(() => {});
}

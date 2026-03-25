// server/tools/codeSandbox.js
// ──────────────────────────────────────────────────────────────────────────────
// DOCKER SANDBOX — Safe code execution in disposable containers
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 🐳 WINDOWS SETUP GUIDE                                                │
// │                                                                        │
// │ 1. Install Docker Desktop for Windows:                                │
// │    https://docs.docker.com/desktop/install/windows-install/            │
// │                                                                        │
// │ 2. Enable WSL 2 backend (recommended):                                │
// │    Settings → General → ✅ Use the WSL 2 based engine                 │
// │                                                                        │
// │ 3. Pull the required base images ONCE:                                │
// │    docker pull node:20-alpine                                         │
// │    docker pull python:3.12-alpine                                     │
// │                                                                        │
// │ 4. Verify Docker is running:                                          │
// │    docker run --rm hello-world                                        │
// │                                                                        │
// │ 5. Optional — Set memory limits in Docker Desktop:                    │
// │    Settings → Resources → Memory: 2 GB (sufficient for scripts)       │
// │                                                                        │
// │ SECURITY NOTES:                                                       │
// │ - All containers run with --rm (auto-removed after exit)              │
// │ - --network none: No network access from sandbox                      │
// │ - --read-only: Filesystem is read-only (except /tmp)                  │
// │ - --memory 128m: Hard memory cap prevents OOM on host                 │
// │ - --cpus 0.5: Limits to half a CPU core                              │
// │ - 10-second timeout: Kills runaway infinite loops                     │
// └─────────────────────────────────────────────────────────────────────────┘
//
// USAGE:
//   "run this JavaScript: console.log('hello')"
//   "execute python: print('hello world')"
//   "test this code in sandbox: function add(a,b) { return a+b; } console.log(add(2,3))"
// ──────────────────────────────────────────────────────────────────────────────

import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { CONFIG } from "../utils/config.js";

const execAsync = promisify(exec);

// ── Container configuration
const TIMEOUT_MS = 10_000;      // 10 seconds — hard kill after this
const MAX_OUTPUT_CHARS = 8000;  // Truncate stdout/stderr to prevent memory overflow
const MEMORY_LIMIT = "128m";    // Container memory cap
const CPU_LIMIT = "0.5";       // Half a CPU core

// ── Supported language → Docker image mapping
const LANGUAGE_CONFIG = {
  javascript: {
    image: "node:20-alpine",
    cmd: (file) => `node ${file}`,
    ext: ".js"
  },
  js: {
    image: "node:20-alpine",
    cmd: (file) => `node ${file}`,
    ext: ".js"
  },
  python: {
    image: "python:3.12-alpine",
    cmd: (file) => `python3 ${file}`,
    ext: ".py"
  },
  py: {
    image: "python:3.12-alpine",
    cmd: (file) => `python3 ${file}`,
    ext: ".py"
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Detect the programming language from the request text or code content.
 * Returns a normalized language key that maps to LANGUAGE_CONFIG.
 */
function detectLanguage(text, code) {
  const lower = (text + " " + code).toLowerCase();

  // Explicit language mention in the request
  if (/\bpython\b|\bpy\b/.test(lower)) return "python";
  if (/\bjavascript\b|\bjs\b|\bnode\b/.test(lower)) return "javascript";

  // Heuristic: Python syntax markers
  if (/\bdef\s+\w+\(/.test(code) || /\bimport\s+\w+/.test(code) && !/\bfrom\s+["']/.test(code)) {
    return "python";
  }
  if (/\bprint\s*\(/.test(code) && !/console\./.test(code)) return "python";

  // Heuristic: JavaScript syntax markers
  if (/\bconst\s+|let\s+|var\s+|=>\s*{|console\.\w+|require\(|import\s+.*from/.test(code)) {
    return "javascript";
  }

  // Default to JavaScript (most common in this project)
  return "javascript";
}

// ──────────────────────────────────────────────────────────────────────────────
// CODE EXTRACTION
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract code from the user's message.
 * Handles: markdown code fences, inline code, or raw code blocks.
 */
function extractCode(text) {
  // 1. Fenced code block: ```js\n...\n```
  const fenced = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // 2. After explicit markers: "run this:", "execute:", "test:", "code:"
  const afterMarker = text.match(/(?:run|execute|test|sandbox|code)\s*(?:this|the)?\s*(?:code)?\s*:\s*([\s\S]+)/i);
  if (afterMarker) {
    let code = afterMarker[1].trim();
    // Strip leading language name if present (e.g., "javascript: console.log('hi')")
    code = code.replace(/^(?:javascript|python|js|py)\s*:\s*/i, "");
    return code;
  }

  // 3. If the entire message looks like code (starts with import/const/function/def/print)
  const trimmed = text.trim();
  if (/^(?:import |const |let |var |function |class |def |print\(|console\.)/.test(trimmed)) {
    return trimmed;
  }

  // 4. Look for code block after "in sandbox" type phrases
  const sandboxCode = text.match(/(?:in\s+(?:a\s+)?sandbox|sandboxed?)\s*:\s*([\s\S]+)/i);
  if (sandboxCode) return sandboxCode[1].trim();

  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// DOCKER EXECUTION
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Check if Docker is available and running.
 */
async function isDockerAvailable() {
  try {
    await execAsync("docker info", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run code in a disposable Docker container.
 *
 * SECURITY LAYERS:
 * 1. --rm: Container auto-deleted after exit
 * 2. --network none: No internet access
 * 3. --read-only: No filesystem writes (except /tmp)
 * 4. --tmpfs /tmp: Writable /tmp in memory only
 * 5. --memory 128m: Hard memory limit
 * 6. --cpus 0.5: CPU throttle
 * 7. Timeout: Process killed after 10s
 *
 * @param {string} code - The code to execute
 * @param {string} language - "javascript" or "python"
 * @returns {{ stdout, stderr, exitCode, timedOut, executionMs }}
 */
async function runInDocker(code, language) {
  const config = LANGUAGE_CONFIG[language];
  if (!config) throw new Error(`Unsupported language: ${language}`);

  // Write code to a temp file (Docker will mount it)
  const tmpDir = os.tmpdir();
  const fileId = crypto.randomBytes(8).toString("hex");
  const tmpFile = path.join(tmpDir, `sandbox_${fileId}${config.ext}`);

  try {
    await fs.writeFile(tmpFile, code, "utf8");

    // Convert Windows path for Docker mount (C:\Users\... → /c/Users/...)
    const dockerPath = tmpFile.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    const containerFile = `/tmp/code${config.ext}`;

    // Build the docker run command
    const dockerCmd = [
      "docker run",
      "--rm",                           // Auto-remove container
      "--network none",                 // No network access
      "--read-only",                    // Read-only filesystem
      "--tmpfs /tmp:rw,noexec,size=64m", // Writable /tmp (limited to 64MB)
      `--memory ${MEMORY_LIMIT}`,       // Memory cap
      `--cpus ${CPU_LIMIT}`,            // CPU throttle
      `--pids-limit 64`,               // Limit processes (prevent fork bombs)
      `-v "${tmpFile}:${containerFile}:ro"`, // Mount code file read-only
      config.image,                     // Base image
      "sh", "-c",                       // Run via shell
      `"${config.cmd(containerFile)}"`  // Execute the code
    ].join(" ");

    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(dockerCmd, {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB buffer
        windowsHide: true
      });

      const executionMs = Date.now() - startTime;

      return {
        stdout: (stdout || "").slice(0, MAX_OUTPUT_CHARS),
        stderr: (stderr || "").slice(0, MAX_OUTPUT_CHARS),
        exitCode: 0,
        timedOut: false,
        executionMs
      };

    } catch (execErr) {
      const executionMs = Date.now() - startTime;
      const timedOut = execErr.killed || execErr.signal === "SIGTERM";

      return {
        stdout: (execErr.stdout || "").slice(0, MAX_OUTPUT_CHARS),
        stderr: (execErr.stderr || execErr.message || "").slice(0, MAX_OUTPUT_CHARS),
        exitCode: execErr.code || 1,
        timedOut,
        executionMs
      };
    }

  } finally {
    // Always clean up the temp file
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TOOL EXPORT
// ──────────────────────────────────────────────────────────────────────────────

/**
 * codeSandbox Tool
 *
 * Input: string or { text, context }
 *   - text: Code to execute (with optional language hint)
 *   - context.language: Override language detection ("javascript" | "python")
 *   - context.code: Direct code input (bypasses extraction)
 *   - context.chainContext.previousOutput: Code from a previous tool
 *
 * Output: Execution results (stdout, stderr, exit code, timing)
 */
export async function codeSandbox(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};

    // ── Step 1: Check Docker availability ──
    const dockerReady = await isDockerAvailable();
    if (!dockerReady) {
      return {
        tool: "codeSandbox",
        success: false,
        final: true,
        error: "Docker is not running or not installed. Please start Docker Desktop and try again.\n\nSetup: https://docs.docker.com/desktop/install/windows-install/"
      };
    }

    // ── Step 2: Extract code ──
    let code = context.code || null;

    // Try chain context (previous tool output)
    if (!code && context.chainContext?.previousOutput) {
      code = context.chainContext.previousOutput;
    }

    // Try extracting from text
    if (!code) {
      code = extractCode(text);
    }

    if (!code || code.trim().length === 0) {
      return {
        tool: "codeSandbox",
        success: false,
        final: true,
        error: "No code found to execute. Provide code in a markdown fence or after 'run this:'\n\nExample: run this: console.log('hello world')"
      };
    }

    // ── Step 3: Detect language ──
    const language = context.language || detectLanguage(text, code);
    const langConfig = LANGUAGE_CONFIG[language];

    if (!langConfig) {
      return {
        tool: "codeSandbox",
        success: false,
        final: true,
        error: `Unsupported language: "${language}". Supported: javascript, python`
      };
    }

    console.log(`[codeSandbox] Executing ${language} code (${code.length} chars) in Docker...`);

    // ── Step 4: Execute in Docker ──
    const result = await runInDocker(code, language);

    // ── Step 5: Format output ──
    const statusIcon = result.exitCode === 0 ? "✅" : (result.timedOut ? "⏰" : "❌");
    const statusText = result.exitCode === 0 ? "Success" : (result.timedOut ? "Timed Out" : `Exit Code ${result.exitCode}`);

    let output = `${statusIcon} **Sandbox Execution: ${statusText}**\n`;
    output += `🐳 Image: \`${langConfig.image}\` | ⏱️ ${result.executionMs}ms\n\n`;

    if (result.stdout) {
      output += `**stdout:**\n\`\`\`\n${result.stdout}\n\`\`\`\n\n`;
    }

    if (result.stderr) {
      output += `**stderr:**\n\`\`\`\n${result.stderr}\n\`\`\`\n\n`;
    }

    if (!result.stdout && !result.stderr) {
      output += "_No output produced._\n";
    }

    if (result.timedOut) {
      output += `\n⚠️ Execution was killed after ${TIMEOUT_MS / 1000}s timeout.\n`;
    }

    return {
      tool: "codeSandbox",
      success: result.exitCode === 0,
      final: true,
      data: {
        text: output.trim(),
        preformatted: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        executionMs: result.executionMs,
        language
      }
    };

  } catch (err) {
    return {
      tool: "codeSandbox",
      success: false,
      final: true,
      error: `Sandbox execution failed: ${err.message}`
    };
  }
}

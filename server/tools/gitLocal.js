import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";

const execAsync = promisify(exec);

/**
 * Executes a git command in the project root
 */
async function runGit(command) {
    try {
        const { stdout, stderr } = await execAsync(`git ${command}`, { cwd: PROJECT_ROOT });
        return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
        return { success: false, error: err.message, stderr: err.stderr };
    }
}

/**
 * Resolves a bare filename to its relative path from PROJECT_ROOT.
 * Searches in server/tools, server, client/src, etc.
 */
async function resolveRelativePath(filename) {
    if (!filename || filename === "." || filename.includes("/") || filename.includes("\\")) {
        return filename;
    }

    // Advanced cleaning (matches review.js logic)
    // 1. Strip hallucinated extensions like .py, .txt
    let clean = filename.replace(/\.(py|txt|md|json)$/i, '');

    // 2. Strip noise words and underscores
    clean = clean.replace(/[_\-]/g, ' ');
    const noiseRegex = /\b(review|tool|file|against|them|our|the|my|against)\b/gi;
    clean = clean.replace(noiseRegex, ' ').replace(/\s+/g, ' ').trim();

    // 3. Strip project-specific tool/file suffixes
    clean = clean.replace(/[_\s-](tool|file|js)$/i, '');

    const target = clean || filename;
    const commonDirs = ["server/tools", "server", "client/src", "utils"];
    for (const dir of commonDirs) {
        const fullPath = path.join(PROJECT_ROOT, dir, target);
        try {
            await fs.access(fullPath);
            return path.join(dir, target).replace(/\\/g, "/");
        } catch {
            // Check for .js extension
            try {
                await fs.access(fullPath + ".js");
                return path.join(dir, target + ".js").replace(/\\/g, "/");
            } catch { }
        }
    }
    return filename; // Fallback to original
}

/**
 * gitLocal Tool
 * Allows the agent to use git locally for self-management
 */
export async function gitLocal(request) {
    try {
        let action, params;

        if (typeof request === 'string') {
            const parts = request.trim().split(/\s+/);
            action = parts[0];
            params = parts.slice(1).join(" ");
        } else {
            // Handle enriched object { text, context }
            const text = request.text || "";
            const parts = text.trim().split(/\s+/);
            action = parts[0];

            // Only use context.raw for commit messages
            const fallbackParams = (action === 'commit') ? (request.context?.raw || "") : "";
            params = parts.slice(1).join(" ") || fallbackParams;
        }

        if (!action) {
            return {
                tool: "gitLocal",
                success: false,
                final: true,
                error: "Action (status, add, commit, etc.) is required"
            };
        }
        let result;
        const lowerAction = (action || "").toLowerCase();
        const fullRequest = `${action} ${params}`.trim().toLowerCase();

        // Robust command detection
        if (lowerAction === "status" || fullRequest.includes("git status")) {
            result = await runGit("status");
        } else if (lowerAction === "add" || fullRequest.includes("git add") || lowerAction === "stage") {
            let target = params || ".";
            // Safety: prevent LLM from using "improvement" or "changes" as a pathspec
            if (["improvement", "improve", "changes", "staged"].includes(target.toLowerCase())) {
                target = ".";
            } else if (target !== ".") {
                target = await resolveRelativePath(target);
            }
            result = await runGit(`add ${target}`);
        } else if (lowerAction === "commit" || fullRequest.includes("git commit")) {
            // Extract commit message from params or fullRequest
            let msg = params;
            const msgMatch = fullRequest.match(/commit\s+(?:-m\s+)?["']?([^"']+)["']?/i);
            if (msgMatch) msg = msgMatch[1];

            if (!msg || msg === "commit") msg = "Agent self-improvement update";
            result = await runGit(`commit -m "${msg.replace(/"/g, '\\"')}"`);
        } else if (lowerAction === "diff" || fullRequest.includes("git diff")) {
            const target = await resolveRelativePath(params);
            result = await runGit(`diff ${target}`);
        } else if (lowerAction === "log" || fullRequest.includes("git log")) {
            result = await runGit(`log --oneline -n 10`);
        } else if (lowerAction === "push" || fullRequest.includes("git push")) {
            result = await runGit(`push ${params || "origin main"}`);
        } else {
            // Fallback for natural language like "stage the changes"
            if (fullRequest.includes("stage") || fullRequest.includes("add everything")) {
                result = await runGit("add .");
            } else if (fullRequest.includes("status")) {
                result = await runGit("status");
            } else {
                return {
                    tool: "gitLocal",
                    success: false,
                    final: true,
                    error: `Unsupported git action or command: ${action}. Please use status, add, commit, or diff.`
                };
            }
        }

        const html = `
      <div class="git-tool">
        <h3>🐙 Git ${action.toUpperCase()}</h3>
        <pre class="git-output">${result.stdout || result.stderr || "No output"}</pre>
      </div>
      <style>
        .git-output {
          background: #1e1e1e;
          color: #d4d4d4;
          padding: 10px;
          border-radius: 4px;
          overflow-x: auto;
          font-family: monospace;
          font-size: 0.85rem;
        }
      </style>
    `;

        return {
            tool: "gitLocal",
            success: result.success,
            final: true,
            data: {
                action,
                output: result.stdout,
                error: result.error || result.stderr,
                html,
                text: result.stdout || result.error
            }
        };

    } catch (err) {
        return {
            tool: "gitLocal",
            success: false,
            final: true,
            error: `Git command failed: ${err.message}`
        };
    }
}

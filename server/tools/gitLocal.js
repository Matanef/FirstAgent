// server/tools/gitLocal.js
import { exec } from "child_process";
import { promisify } from "util";
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
            params = parts.slice(1).join(" ") || request.context?.raw || "";
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
            const target = params || ".";
            result = await runGit(`add ${target}`);
        } else if (lowerAction === "commit" || fullRequest.includes("git commit")) {
            // Extract commit message from params or fullRequest
            let msg = params;
            const msgMatch = fullRequest.match(/commit\s+(?:-m\s+)?["']?([^"']+)["']?/i);
            if (msgMatch) msg = msgMatch[1];

            if (!msg || msg === "commit") msg = "Agent self-improvement update";
            result = await runGit(`commit -m "${msg.replace(/"/g, '\\"')}"`);
        } else if (lowerAction === "diff" || fullRequest.includes("git diff")) {
            result = await runGit(`diff ${params}`);
        } else if (lowerAction === "log" || fullRequest.includes("git log")) {
            result = await runGit(`log --oneline -n 10`);
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

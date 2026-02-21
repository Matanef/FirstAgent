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
            action = request.action;
            params = request.params || "";
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
        switch (action.toLowerCase()) {
            case "status":
                result = await runGit("status");
                break;
            case "add":
                if (!params) return { tool: "gitLocal", success: false, error: "File path(s) required for 'add'" };
                result = await runGit(`add ${params}`);
                break;
            case "commit":
                if (!params) return { tool: "gitLocal", success: false, error: "Commit message required for 'commit'" };
                result = await runGit(`commit -m "${params.replace(/"/g, '\\"')}"`);
                break;
            case "diff":
                result = await runGit(`diff ${params}`);
                break;
            case "log":
                result = await runGit(`log --oneline -n 10`);
                break;
            default:
                return {
                    tool: "gitLocal",
                    success: false,
                    final: true,
                    error: `Unsupported git action: ${action}`
                };
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

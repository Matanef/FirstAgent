// server/tools/gitLocal.js
// CRITICAL FIX: Proper handling of "nothing to commit" scenario

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
        // IMPORTANT: Git can return non-zero exit code for benign cases like "nothing to commit"
        // We need to check the actual error message
        return { 
            success: false, 
            error: err.message, 
            stderr: err.stderr || "",
            stdout: err.stdout || ""
        };
    }
}

/**
 * Check if there are any stagasync function hasS

tagedChanges() {
nc function hasStagedChanges() {
{
    const result = await runGit("diff --cached --name-only");
    // If stdout has content, there are staged files
    return result.stdout && result.stdout.trim().length > 0;
}

/**
 * Resolves a bare filename to its relative path from PROJECT_ROOT.
 */
async function resolveRelativePath(filename) {
    if (!filename || filename === "." || filename.includes("/") || filename.includes("\\")) {
        return filename;
    }

    // Strip hallucinated extensions
    let clean = filename.replace(/\.(py|txt|md|json)$/i, '');

    // Strip noise words
    clean = clean.replace(/[_\-]/g, ' ');
    const noiseRegex = /\b(review|tool|file|against|them|our|the|my)\b/gi;
    clean = clean.replace(noiseRegex, ' ').replace(/\s+/g, ' ').trim();

    // Strip suffixes
    clean = clean.replace(/[_\s-](tool|file|js)$/i, '');

    const target = clean || filename;
    const commonDirs = ["server/tools", "server", "client/src", "utils"];
    
    for (const dir of commonDirs) {
        const fullPath = path.join(PROJECT_ROOT, dir, target);
        try {
            await fs.access(fullPath);
            return path.join(dir, target).replace(/\\/g, "/");
        } catch {
            try {
                await fs.access(fullPath + ".js");
                return path.join(dir, target + ".js").replace(/\\/g, "/");
            } catch { }
        }
    }
    
    return filename;
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
            const text = request.text || "";
            const parts = text.trim().split(/\s+/);
            action = parts[0];

            // Use context.raw for commit messages
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

        // STATUS
        if (lowerAction === "status" || fullRequest.includes("git status")) {
            result = await runGit("status");
        } 
        
        // ADD
        else if (lowerAction === "add" || fullRequest.includes("git add") || lowerAction === "stage") {
            let target = params || ".";
            
            // Safety: prevent LLM hallucinations
            if (["improvement", "improve", "changes", "staged"].includes(target.toLowerCase())) {
                target = ".";
            } else if (target !== ".") {
                target = await resolveRelativePath(target);
            }
            
            result = await runGit(`add ${target}`);
        } 
        
        // COMMIT (CRITICAL FIX)
        else if (lowerAction === "commit" || fullRequest.includes("git commit")) {
            // First, check if there are staged changes
            const hasChanges = await hasStagedChanges();
            
            if (!hasChanges) {
                // Graceful handling: No changes to commit
                return {
                    tool: "gitLocal",
                    success: true, // Mark as success, not failure
                    final: true,
                    data: {
                        action: "commit",
                        output: "No changes to commit. Working tree clean.",
                        warning: "The review was completed, but no actual code changes were made to commit.",
                        html: `
                          <div class="git-tool">
                            <h3>🐙 Git COMMIT</h3>
                            <div class="git-info-box">
                              <p><strong>ℹ️ No Changes to Commit</strong></p>
                              <p>The review and analysis were completed successfully, but no files were modified.</p>
                              <p>To commit changes, you would need to actually modify the code files based on the review suggestions.</p>
                            </div>
                          </div>
                          <style>
                            .git-info-box {
                              background: #fffbea;
                              border: 1px solid #f0ad4e;
                              border-radius: 4px;
                              padding: 1rem;
                              margin: 0.5rem 0;
                            }
                            .git-info-box p {
                              margin: 0.5rem 0;
                            }
                          </style>
                        `,
                        text: "No changes to commit. The review was completed, but no code modifications were made."
                    }
                };
            }

            // Extract commit message
            let msg = params;
            const msgMatch = fullRequest.match(/commit\s+(?:-m\s+)?["']?([^"']+)["']?/i);
            if (msgMatch) msg = msgMatch[1];

            if (!msg || msg === "commit") msg = "Agent self-improvement update";
            
            // Execute commit
            result = await runGit(`commit -m "${msg.replace(/"/g, '\\"')}"`);
            
            // Handle commit errors gracefully
            if (!result.success) {
                // Check if it's just "nothing to commit"
                const errorText = (result.stderr + result.stdout).toLowerCase();
                if (errorText.includes("nothing to commit") || errorText.includes("no changes")) {
                    return {
                        tool: "gitLocal",
                        success: true,
                        final: true,
                        data: {
                            action: "commit",
                            output: "No changes to commit",
                            text: "No changes to commit. Working tree clean."
                        }
                    };
                }
            }
        } 
        
        // DIFF
        else if (lowerAction === "diff" || fullRequest.includes("git diff")) {
            const target = await resolveRelativePath(params);
            result = await runGit(`diff ${target}`);
        } 
        
        // LOG
        else if (lowerAction === "log" || fullRequest.includes("git log")) {
            result = await runGit(`log --oneline -n 10`);
        } 
        
        // PUSH
        else if (lowerAction === "push" || fullRequest.includes("git push")) {
            result = await runGit(`push ${params || "origin main"}`);
        } 
        
        // FALLBACK
        else {
            if (fullRequest.includes("stage") || fullRequest.includes("add everything")) {
                result = await runGit("add .");
            } else if (fullRequest.includes("status")) {
                result = await runGit("status");
            } else {
                return {
                    tool: "gitLocal",
                    success: false,
                    final: true,
                    error: `Unsupported git action: ${action}. Use: status, add, commit, diff, log`
                };
            }
        }

        // Build HTML output
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

// server/tools/packageManager.js
// NPM package management for self-improvement

import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);
const PROJECT_ROOT = path.resolve("D:/local-llm-ui");

/**
 * Execute npm command
 */
async function runNpmCommand(command) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: PROJECT_ROOT,
      timeout: 120000 // 2 minutes timeout
    });

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };

  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout?.trim() || "",
      stderr: err.stderr?.trim() || ""
    };
  }
}

/**
 * Install package
 */
async function installPackage(packageName, flags = "") {
  console.log(`📦 Installing ${packageName}...`);
  
  const command = `npm install ${packageName} ${flags}`.trim();
  const result = await runNpmCommand(command);

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      details: result.stderr
    };
  }

  return {
    success: true,
    package: packageName,
    output: result.stdout
  };
}

/**
 * Uninstall package
 */
async function uninstallPackage(packageName) {
  console.log(`🗑️ Uninstalling ${packageName}...`);
  
  const command = `npm uninstall ${packageName}`;
  const result = await runNpmCommand(command);

  return {
    success: result.success,
    package: packageName,
    output: result.stdout || result.error
  };
}

/**
 * List installed packages
 */
async function listPackages() {
  const command = "npm list --json --depth=0";
  const result = await runNpmCommand(command);

  if (!result.success) {
    return {
      success: false,
      error: result.error
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    const packages = Object.entries(data.dependencies || {}).map(([name, info]) => ({
      name,
      version: typeof info === "string" ? info : info.version
    }));

    return {
      success: true,
      packages,
      count: packages.length
    };

  } catch (err) {
    return {
      success: false,
      error: "Failed to parse package list"
    };
  }
}

/**
 * Main package manager tool
 */
export async function packageManager(request) {
  try {
    let action, packageName, flags = "";

    if (typeof request === "string") {
      // Parse natural language: "install express", "uninstall lodash", "list packages"
      const lower = request.toLowerCase();
      if (/\binstall\b/.test(lower)) action = "install";
      else if (/\buninstall|remove\b/.test(lower)) action = "uninstall";
      else if (/\bupdate\b/.test(lower)) action = "update";
      else action = "list";
      const pkgMatch = request.match(/(?:install|uninstall|remove|update)\s+([@a-z0-9\/-]+)/i);
      if (pkgMatch) packageName = pkgMatch[1];
    } else {
      // Object input from planner context
      const text = request?.text || "";
      action = request?.context?.action || request?.action;
      packageName = request?.context?.package || request?.package;
      flags = request?.context?.flags || request?.flags || "";

      // If no action from context, try parsing the text
      if (!action && text) {
        const lower = text.toLowerCase();
        if (/\binstall\b/.test(lower)) action = "install";
        else if (/\buninstall|remove\b/.test(lower)) action = "uninstall";
        else if (/\bupdate\b/.test(lower)) action = "update";
        else action = "list";
        if (!packageName) {
          const pkgMatch = text.match(/(?:install|uninstall|remove|update)\s+([@a-z0-9\/-]+)/i);
          if (pkgMatch) packageName = pkgMatch[1];
        }
      }
    }

    if (!action) {
      return {
        tool: "packageManager",
        success: false,
        final: true,
        error: "Action is required (install, uninstall, list)"
      };
    }

    let result;

    switch (action) {
      case "install":
        if (!packageName) {
          return {
            tool: "packageManager",
            success: false,
            final: true,
            error: "Package name is required for install"
          };
        }
        result = await installPackage(packageName, flags);
        break;

      case "uninstall":
        if (!packageName) {
          return {
            tool: "packageManager",
            success: false,
            final: true,
            error: "Package name is required for uninstall"
          };
        }
        result = await uninstallPackage(packageName);
        break;

      case "list":
        result = await listPackages();
        break;

      default:
        return {
          tool: "packageManager",
          success: false,
          final: true,
          error: `Unknown action: ${action}. Use: install, uninstall, or list`
        };
    }

    if (!result.success) {
      return {
        tool: "packageManager",
        success: false,
        final: true,
        error: result.error,
        data: result
      };
    }

    return {
      tool: "packageManager",
      success: true,
      final: true,
      data: result,
      reasoning: `Successfully ${action}ed ${packageName || "packages"}`
    };

  } catch (err) {
    return {
      tool: "packageManager",
      success: false,
      final: true,
      error: `Package manager failed: ${err.message}`
    };
  }
}

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
 * Update package(s)
 */
async function updatePackages(packageName = "") {
  const target = packageName || "";
  const command = `npm update ${target}`.trim();
  console.log(`🔄 Updating ${target || "all packages"}...`);
  const result = await runNpmCommand(command);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    message: `Updated ${target || "all packages"}`,
    output: result.stdout || "All packages are up to date"
  };
}

/**
 * Check for outdated packages
 */
async function outdatedPackages() {
  const command = "npm outdated --json";
  console.log("🔍 Checking for outdated packages...");
  const result = await runNpmCommand(command);
  // npm outdated exits with code 1 if there are outdated packages, which is not an error
  const stdout = result.stdout || "{}";
  try {
    const data = JSON.parse(stdout);
    const packages = Object.entries(data).map(([name, info]) => ({
      name,
      current: info.current,
      wanted: info.wanted,
      latest: info.latest
    }));
    return {
      success: true,
      packages,
      count: packages.length,
      message: packages.length > 0 ? `${packages.length} outdated package(s)` : "All packages are up to date"
    };
  } catch {
    return { success: true, packages: [], count: 0, message: "All packages are up to date" };
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
      if (/\binstall\b/.test(lower) && !/\binstalled\b/.test(lower)) action = "install";
      else if (/\buninstall|remove\b/.test(lower)) action = "uninstall";
      else if (/\bupdate\b/.test(lower)) action = "update";
      else if (/\boutdated\b/.test(lower)) action = "outdated";
      else action = "list";
      // Extract package name from action commands
      const pkgMatch = request.match(/(?:install|uninstall|remove|update)\s+([@a-z0-9\/-]+)/i);
      if (pkgMatch) packageName = pkgMatch[1];
      // Extract package name from version/info queries: "what version of express", "is lodash installed"
      if (!packageName) {
        const versionQuery = request.match(/(?:what\s+version\s+(?:of\s+)?|check\s+)([@a-z0-9\/-]+)/i) ||
          request.match(/(?:version\s+of|version\s+is|is)\s+([@a-z0-9\/-]+)(?=\s|$)/i);
        if (versionQuery) packageName = versionQuery[1];
      }
    } else {
      // Object input from planner context
      const text = request?.text || "";
      action = request?.context?.action || request?.action;
      packageName = request?.context?.package || request?.package;
      flags = request?.context?.flags || request?.flags || "";

      // If no action from context, try parsing the text
      if (!action && text) {
        const lower = text.toLowerCase();
        if (/\binstall\b/.test(lower) && !/\binstalled\b/.test(lower)) action = "install";
        else if (/\buninstall|remove\b/.test(lower)) action = "uninstall";
        else if (/\bupdate\b/.test(lower)) action = "update";
        else if (/\boutdated\b/.test(lower)) action = "outdated";
        else action = "list";
        if (!packageName) {
          const pkgMatch = text.match(/(?:install|uninstall|remove|update)\s+([@a-z0-9\/-]+)/i);
          if (pkgMatch) packageName = pkgMatch[1];
        }
        // Extract package name from version/info queries
        if (!packageName) {
          const versionQuery = text.match(/(?:what\s+version\s+(?:of\s+)?|check\s+)([@a-z0-9\/-]+)/i) ||
            text.match(/(?:version\s+of|version\s+is|is)\s+([@a-z0-9\/-]+)(?=\s|$)/i);
          if (versionQuery) packageName = versionQuery[1];
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

      case "update":
        result = await updatePackages(packageName);
        break;

      case "outdated":
        result = await outdatedPackages();
        break;

      case "list":
        result = await listPackages();
        // If a specific package was requested, filter to show only that one
        if (result.success && packageName && result.packages) {
          const lowerPkg = packageName.toLowerCase();
          const filtered = result.packages.filter(p => p.name.toLowerCase() === lowerPkg);
          if (filtered.length > 0) {
            result = { success: true, packages: filtered, count: filtered.length };
          } else {
            result = { success: true, packages: [], count: 0, message: `Package "${packageName}" is not installed.` };
          }
        }
        break;

      default:
        return {
          tool: "packageManager",
          success: false,
          final: true,
          error: `Unknown action: ${action}. Use: install, uninstall, update, outdated, or list`
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

    // Build a human-readable text from the structured result
    let text = "";
    if (result.packages && Array.isArray(result.packages)) {
      // list/outdated: format package table
      if (result.packages.length === 0) {
        text = "📦 No packages found.";
      } else {
        const lines = result.packages.map(p => {
          let line = `• **${p.name}** v${p.version || "?"}`;
          if (p.latest) line += ` → v${p.latest}`;
          return line;
        });
        text = `📦 **Packages** (${result.count || result.packages.length}):\n\n${lines.join("\n")}`;
      }
    } else if (result.message) {
      text = `📦 ${result.message}${result.output ? `\n\n${result.output}` : ""}`;
    } else if (result.output) {
      text = `📦 ${result.output}`;
    } else {
      text = `📦 Package operation "${action}" completed successfully.`;
    }

    return {
      tool: "packageManager",
      success: true,
      final: true,
      data: { text, preformatted: true, ...result },
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

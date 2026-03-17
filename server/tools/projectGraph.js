// server/tools/projectGraph.js
// Project dependency graph builder — import/require analysis, circular dep detection,
// dead code identification, module relationship mapping

import fs from "fs/promises";
import path from "path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__",
  ".cache", ".next", "coverage", ".vscode", ".idea", "vendor"
]);

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs"
]);

/**
 * Recursively collect code files
 */
async function collectFiles(dirPath, depth = 0, maxDepth = 8) {
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
      files.push(...await collectFiles(fullPath, depth + 1, maxDepth));
    } else {
      const ext = path.extname(item.name).slice(1).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

/**
 * Extract imports from a file
 */
async function extractImports(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return { imports: [], exports: [], lineCount: 0 };
  }

  const imports = [];
  const exports = [];

  // ES module imports
  const esImportRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = esImportRegex.exec(content)) !== null) {
    imports.push({ type: "import", source: match[1], raw: match[0].trim() });
  }

  // Dynamic imports
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    imports.push({ type: "dynamic", source: match[1] });
  }

  // CommonJS requires
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push({ type: "require", source: match[1] });
  }

  // Exports
  if (/export\s+default\b/.test(content)) exports.push("default");
  const namedExportRegex = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
  while ((match = namedExportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }
  const reExportRegex = /export\s+\{([^}]+)\}/g;
  while ((match = reExportRegex.exec(content)) !== null) {
    const names = match[1].split(",").map(n => n.trim().split(/\s+as\s+/)[0].trim());
    exports.push(...names);
  }

  return { imports, exports, lineCount: content.split("\n").length };
}

/**
 * Resolve import path to absolute file path
 */
function resolveImport(importSource, fromFile, projectRoot) {
  // Skip external/node modules
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return { type: "external", name: importSource };
  }

  const fromDir = path.dirname(fromFile);
  let resolved = path.resolve(fromDir, importSource);

  // Try with extensions
  const extensions = [".js", ".jsx", ".ts", ".tsx", ".mjs", "/index.js", "/index.ts"];
  for (const ext of extensions) {
    const fullPath = resolved + ext;
    try {
      if (require("fs").existsSync(fullPath)) {
        return { type: "local", path: fullPath };
      }
    } catch { /* continue */ }
  }

  // Try exact path
  try {
    if (require("fs").existsSync(resolved)) {
      return { type: "local", path: resolved };
    }
  } catch { /* continue */ }

  return { type: "unresolved", source: importSource };
}

/**
 * Detect circular dependencies using DFS
 */
function findCircularDeps(graph) {
  const cycles = [];
  const visited = new Set();
  const stack = new Set();
  const path_stack = [];

  function dfs(node) {
    if (stack.has(node)) {
      // Found a cycle
      const cycleStart = path_stack.indexOf(node);
      if (cycleStart !== -1) {
        cycles.push([...path_stack.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path_stack.push(node);

    const deps = graph[node] || [];
    for (const dep of deps) {
      dfs(dep);
    }

    stack.delete(node);
    path_stack.pop();
  }

  for (const node of Object.keys(graph)) {
    dfs(node);
  }

  return cycles;
}

/**
 * Find potentially dead/orphaned files
 */
function findDeadCode(graph, allFiles, projectRoot) {
  const imported = new Set();

  for (const deps of Object.values(graph)) {
    for (const dep of deps) {
      imported.add(dep);
    }
  }

  // Entry points that are expected not to be imported
  const entryPatterns = [
    /index\.(js|ts|jsx|tsx)$/,
    /main\.(js|ts|jsx|tsx)$/,
    /server\.(js|ts)$/,
    /app\.(js|ts|jsx|tsx)$/,
    /\.config\.(js|ts)$/,
    /\.test\.(js|ts|jsx|tsx)$/,
    /\.spec\.(js|ts|jsx|tsx)$/
  ];

  const dead = [];
  for (const file of allFiles) {
    const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
    if (!imported.has(relPath)) {
      const isEntry = entryPatterns.some(p => p.test(file));
      if (!isEntry) {
        dead.push(relPath);
      }
    }
  }

  return dead;
}

/**
 * Calculate module coupling metrics
 */
function calculateMetrics(graph) {
  const metrics = {};

  for (const [file, deps] of Object.entries(graph)) {
    // Fan-out: how many modules this file depends on
    const fanOut = deps.length;

    // Fan-in: how many modules depend on this file
    let fanIn = 0;
    for (const otherDeps of Object.values(graph)) {
      if (otherDeps.includes(file)) fanIn++;
    }

    // Instability: fanOut / (fanIn + fanOut)
    const instability = (fanIn + fanOut) > 0 ? fanOut / (fanIn + fanOut) : 0;

    metrics[file] = {
      fanIn,
      fanOut,
      instability: Math.round(instability * 100) / 100,
      coupling: fanIn + fanOut
    };
  }

  return metrics;
}

/**
 * Extract path from text
 */
function extractPath(text) {
  const pathMatch = text.match(/([A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+)/);
  if (pathMatch) return pathMatch[1].replace(/\\/g, "/");
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1];
  return null;
}

/**
 * Detect intent
 */
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\bcircular\b/.test(lower)) return "circular";
  if (/\bdead\s*code|unused|orphan/.test(lower)) return "dead";
  if (/\bmetric|coupling|instability/.test(lower)) return "metrics";
  if (/\bexternal|dependencies|packages/.test(lower)) return "external";
  return "full";
}

/**
 * Main entry point
 */
export async function projectGraph(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  if (!text.trim()) {
    return {
      tool: "projectGraph",
      success: false,
      final: true,
      data: { message: "Please specify a project path. Example: 'analyze dependencies in D:/local-llm-ui'" }
    };
  }

  const intent = context.action || detectIntent(text);
  const targetPath = context.path || extractPath(text);

  if (!targetPath) {
    return {
      tool: "projectGraph",
      success: false,
      final: true,
      data: { message: "Please provide a project folder path. Example: 'dependency graph for D:/my-project'" }
    };
  }

  const projectRoot = path.resolve(targetPath);

  try {
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) {
      return { tool: "projectGraph", success: false, final: true, data: { message: `${projectRoot} is not a directory.` } };
    }
  } catch (err) {
    return { tool: "projectGraph", success: false, final: true, data: { message: `Cannot access ${projectRoot}: ${err.message}` } };
  }

  try {
    // Collect all code files
    const files = await collectFiles(projectRoot);
    if (files.length === 0) {
      return { tool: "projectGraph", success: false, final: true, data: { message: `No JavaScript/TypeScript files found in ${projectRoot}` } };
    }

    // Build dependency graph
    const graph = {};
    const externalDeps = new Set();
    const fileData = {};

    for (const filePath of files) {
      const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
      const { imports, exports, lineCount } = await extractImports(filePath);

      fileData[relPath] = { exports, lineCount };
      graph[relPath] = [];

      for (const imp of imports) {
        const resolved = resolveImport(imp.source, filePath, projectRoot);
        if (resolved.type === "local") {
          const relDep = path.relative(projectRoot, resolved.path).replace(/\\/g, "/");
          graph[relPath].push(relDep);
        } else if (resolved.type === "external") {
          externalDeps.add(resolved.name);
        }
      }
    }

    // Compute analyses
    const circularDeps = findCircularDeps(graph);
    const deadCode = findDeadCode(graph, files, projectRoot);
    const metrics = calculateMetrics(graph);

    // Build output based on intent
    let output = "";

    if (intent === "full" || intent === "circular") {
      output += `🔄 **Circular Dependencies**\n`;
      if (circularDeps.length === 0) {
        output += "  ✅ No circular dependencies detected!\n\n";
      } else {
        output += `  ⚠️ Found ${circularDeps.length} cycle(s):\n`;
        for (const cycle of circularDeps.slice(0, 10)) {
          output += `  • ${cycle.join(" → ")}\n`;
        }
        output += "\n";
      }
    }

    if (intent === "full" || intent === "dead") {
      output += `🗑️ **Potentially Dead/Orphaned Files**\n`;
      if (deadCode.length === 0) {
        output += "  ✅ No orphaned files detected!\n\n";
      } else {
        output += `  ⚠️ Found ${deadCode.length} file(s) not imported anywhere:\n`;
        for (const f of deadCode.slice(0, 20)) {
          output += `  • ${f}\n`;
        }
        if (deadCode.length > 20) output += `  ... and ${deadCode.length - 20} more\n`;
        output += "\n";
      }
    }

    if (intent === "full" || intent === "metrics") {
      output += `📊 **Module Coupling Metrics**\n`;
      const sortedMetrics = Object.entries(metrics)
        .sort((a, b) => b[1].coupling - a[1].coupling)
        .slice(0, 15);

      output += `  ${"File".padEnd(45)} Fan-In  Fan-Out  Instability\n`;
      output += `  ${"─".repeat(75)}\n`;
      for (const [file, m] of sortedMetrics) {
        const shortFile = file.length > 42 ? "..." + file.slice(-39) : file;
        output += `  ${shortFile.padEnd(45)} ${String(m.fanIn).padEnd(8)} ${String(m.fanOut).padEnd(9)} ${m.instability}\n`;
      }
      output += "\n";
    }

    if (intent === "full" || intent === "external") {
      output += `📦 **External Dependencies** (${externalDeps.size})\n`;
      const sortedDeps = [...externalDeps].sort();
      for (const dep of sortedDeps) {
        output += `  • ${dep}\n`;
      }
      output += "\n";
    }

    // Summary
    output += `📈 **Summary**\n`;
    output += `  • Total files: ${files.length}\n`;
    output += `  • Total lines: ${Object.values(fileData).reduce((sum, f) => sum + (f.lineCount || 0), 0).toLocaleString()}\n`;
    output += `  • Internal dependencies: ${Object.values(graph).reduce((sum, deps) => sum + deps.length, 0)}\n`;
    output += `  • External packages: ${externalDeps.size}\n`;
    output += `  • Circular dependency cycles: ${circularDeps.length}\n`;
    output += `  • Potentially dead files: ${deadCode.length}\n`;

    return {
      tool: "projectGraph",
      success: true,
      final: true,
      data: {
        preformatted: true,
        text: `🗺️ **Dependency Graph: ${projectRoot}**\n\n${output}`,
        graph,
        circularDeps,
        deadCode,
        metrics,
        externalDeps: [...externalDeps],
        fileCount: files.length
      }
    };
  } catch (err) {
    return {
      tool: "projectGraph",
      success: false,
      final: true,
      data: { message: `Error building project graph: ${err.message}` }
    };
  }
}

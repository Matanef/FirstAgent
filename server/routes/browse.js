// server/routes/browse.js
// API endpoint for browsing the filesystem (folder picker)
// Returns directory listings for any drive/path

import { Router } from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";

const router = Router();

const SKIP_DIRS = new Set([
  "node_modules", ".git", "$Recycle.Bin", "System Volume Information",
  "Recovery", "PerfLogs", "Windows.old"
]);

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * List available drives (Windows) or root directories (Unix)
 */
function listDrives() {
  if (os.platform() === "win32") {
    const drives = [];
    // Check common drive letters
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drivePath = `${letter}:\\`;
      try {
        fsSync.accessSync(drivePath, fsSync.constants.R_OK);
        drives.push({
          name: `${letter}:`,
          path: drivePath,
          type: "drive"
        });
      } catch { /* drive doesn't exist */ }
    }
    return drives;
  } else {
    // Unix: list root directories
    try {
      const items = fsSync.readdirSync("/", { withFileTypes: true });
      return items
        .filter(d => d.isDirectory())
        .slice(0, 30)
        .map(d => ({
          name: d.name,
          path: `/${d.name}`,
          type: "directory"
        }));
    } catch {
      return [{ name: "/", path: "/", type: "directory" }];
    }
  }
}

/**
 * POST /api/browse
 * Body: { path: string }
 * Returns: { success, path, items: [{ name, path, type, size? }] }
 */
router.post("/", async (req, res) => {
  const { path: dirPath } = req.body;

  // If no path, list drives/root
  if (!dirPath || dirPath === "") {
    try {
      const drives = listDrives();
      // Also add common user directories
      const homeDir = os.homedir();
      const extras = [];
      for (const name of ["Desktop", "Documents", "Downloads", "Projects"]) {
        const p = path.join(homeDir, name);
        try {
          if (fsSync.existsSync(p) && fsSync.statSync(p).isDirectory()) {
            extras.push({ name: `📌 ${name}`, path: p, type: "directory" });
          }
        } catch { /* skip */ }
      }

      return res.json({ success: true, path: "", items: [...extras, ...drives] });
    } catch (err) {
      return res.json({ success: false, error: err.message });
    }
  }

  // Browse specific directory
  const normalizedPath = path.resolve(dirPath);

  try {
    const stat = await fs.stat(normalizedPath);
    if (!stat.isDirectory()) {
      return res.json({ success: false, error: "Not a directory" });
    }

    const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
    const items = [];

    // Directories first
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(normalizedPath, entry.name);

      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          path: fullPath,
          type: "directory"
        });
      }
    }

    // Then files
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(normalizedPath, entry.name);

      if (entry.isFile()) {
        try {
          const fstat = await fs.stat(fullPath);
          items.push({
            name: entry.name,
            path: fullPath,
            type: "file",
            size: formatSize(fstat.size)
          });
        } catch {
          items.push({ name: entry.name, path: fullPath, type: "file" });
        }
      }
    }

    return res.json({ success: true, path: normalizedPath, items });
  } catch (err) {
    return res.json({ success: false, error: `Cannot browse ${normalizedPath}: ${err.message}` });
  }
});

export default router;

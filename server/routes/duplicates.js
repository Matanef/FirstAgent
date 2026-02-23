// server/routes/duplicates.js
// API routes for duplicate file scanning, file opening, and folder browsing

import express from "express";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { PROJECT_ROOT } from "../utils/config.js";
import { duplicateScanner } from "../tools/duplicateScanner.js";
import { logAudit } from "../utils/auditLog.js";

const router = express.Router();

// Sandbox roots for file access
const ALLOWED_ROOTS = [
    PROJECT_ROOT,
    "E:/testFolder"
].map(p => path.resolve(p));

function isPathAllowed(inputPath) {
    const resolved = path.resolve(inputPath);
    if (inputPath.includes("..")) return false;
    return ALLOWED_ROOTS.some(root => resolved.startsWith(root));
}

// Active scans for cancellation
const activeScans = new Map();

// ============================================================
// POST /api/scan-duplicates — run duplicate scan with SSE progress
// ============================================================
router.post("/scan-duplicates", async (req, res) => {
    const { path: scanPath, name, snippet, type, maxDepth } = req.body;

    // Validate at least one filter or path is provided
    if (!scanPath && !name && !type && !snippet) {
        return res.status(400).json({ error: "At least one filter (path, name, type, or snippet) must be provided" });
    }

    const scanId = Date.now().toString(36);

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Send scan ID
    res.write(`data: ${JSON.stringify({ type: "start", scanId })}\n\n`);

    const abortController = new AbortController();
    activeScans.set(scanId, abortController);

    try {
        const context = {};
        if (scanPath) context.path = scanPath;
        if (name) context.name = name;
        if (type) context.type = type;
        if (snippet) context.snippet = snippet;
        if (maxDepth) context.maxDepth = maxDepth;

        // Send progress update
        res.write(`data: ${JSON.stringify({ type: "progress", phase: "scanning", scanned: 0 })}\n\n`);

        const result = await duplicateScanner({ text: "", context });

        logAudit({
            action: "scan_duplicates",
            ip: req.ip,
            details: { path: scanPath, name, type, groups: result.data?.groups?.length || 0 }
        });

        res.write(`data: ${JSON.stringify({ type: "done", ...result })}\n\n`);
        res.end();
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
        res.end();
    } finally {
        activeScans.delete(scanId);
    }
});

// ============================================================
// POST /api/scan-duplicates/cancel — cancel active scan
// ============================================================
router.post("/scan-duplicates/cancel", (req, res) => {
    const { scanId } = req.body;
    const controller = activeScans.get(scanId);
    if (controller) {
        controller.abort();
        activeScans.delete(scanId);
        res.json({ success: true, message: "Scan cancelled" });
    } else {
        res.json({ success: false, message: "No active scan found" });
    }
});

// ============================================================
// GET /api/open-file?path=... — stream file content safely
// ============================================================
router.get("/open-file", async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: "path query parameter required" });

        if (!isPathAllowed(filePath)) {
            return res.status(403).json({ error: "Access denied: path outside allowed roots" });
        }

        const resolved = path.resolve(filePath);

        try {
            await fs.access(resolved);
        } catch {
            return res.status(404).json({ error: "File not found" });
        }

        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
            return res.status(400).json({ error: "Path is not a file" });
        }

        // Determine content type
        const ext = path.extname(resolved).toLowerCase();
        const mimeMap = {
            ".txt": "text/plain", ".md": "text/plain", ".log": "text/plain",
            ".js": "text/plain", ".jsx": "text/plain", ".ts": "text/plain", ".tsx": "text/plain",
            ".css": "text/plain", ".html": "text/plain", ".json": "application/json",
            ".csv": "text/csv", ".xml": "text/plain", ".yaml": "text/plain", ".yml": "text/plain",
            ".py": "text/plain", ".sh": "text/plain", ".sql": "text/plain",
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
            ".pdf": "application/pdf"
        };

        const contentType = mimeMap[ext] || "text/plain";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `inline; filename="${path.basename(resolved)}"`);

        logAudit({ action: "open_file", ip: req.ip, details: { path: resolved } });

        const stream = createReadStream(resolved);
        stream.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GET /api/open-folder?path=... — list folder contents as JSON
// ============================================================
router.get("/open-folder", async (req, res) => {
    try {
        const folderPath = req.query.path;
        if (!folderPath) return res.status(400).json({ error: "path query parameter required" });

        if (!isPathAllowed(folderPath)) {
            return res.status(403).json({ error: "Access denied: path outside allowed roots" });
        }

        const resolved = path.resolve(folderPath);

        try {
            await fs.access(resolved);
        } catch {
            return res.status(404).json({ error: "Folder not found" });
        }

        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
            return res.status(400).json({ error: "Path is not a directory" });
        }

        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const items = [];

        for (const entry of entries.slice(0, 200)) { // Limit to 200 entries
            try {
                const fullPath = path.join(resolved, entry.name);
                const entryStat = await fs.stat(fullPath);
                items.push({
                    name: entry.name,
                    path: fullPath,
                    isDirectory: entry.isDirectory(),
                    size: entry.isFile() ? entryStat.size : null,
                    mtime: entryStat.mtime.toISOString()
                });
            } catch {
                // Skip unreadable entries
            }
        }

        logAudit({ action: "open_folder", ip: req.ip, details: { path: resolved } });

        res.json({
            path: resolved,
            items,
            total: entries.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

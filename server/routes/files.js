// server/routes/files.js
// File upload, preview, content streaming, compilation, and debug endpoints

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import crypto from "crypto";
import { PROJECT_ROOT } from "../utils/config.js";
import {
    saveJSON,
    getMemory,
    MEMORY_FILE,
    DEFAULT_MEMORY
} from "../memory.js";
import {
    registerFile,
    getFile,
    cleanExpired
} from "../utils/fileRegistry.js";
import { logAudit } from "../utils/auditLog.js";

const router = express.Router();

// ============================================================
// MULTER CONFIGURATION
// ============================================================

const UPLOAD_DIR = path.resolve(PROJECT_ROOT, "uploads");

const ALLOWED_MIMES = [
    // Documents
    "text/plain", "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    // Images
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    // Code / text
    "text/javascript", "application/javascript",
    "text/typescript", "application/typescript",
    "text/jsx", "text/tsx",
    "text/css", "text/html", "text/xml",
    "text/markdown", "text/x-markdown",
    "application/json", "text/json",
    "text/csv",
    "text/yaml", "text/x-yaml", "application/x-yaml",
    "text/x-python", "application/x-python-code",
    "application/x-sh", "text/x-shellscript",
    // Catch-all for code files browsers might not type correctly
    "application/octet-stream"
];

// Extensions we accept even if MIME is octet-stream
const ALLOWED_EXTENSIONS = new Set([
    ".txt", ".md", ".json", ".csv", ".yaml", ".yml", ".xml",
    ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".htm",
    ".py", ".sh", ".bash", ".sql", ".env.example",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".log", ".cfg", ".ini", ".toml", ".conf"
]);

// Blocked executable extensions
const BLOCKED_EXTENSIONS = new Set([
    ".exe", ".bat", ".cmd", ".msi", ".dll", ".so", ".com", ".scr", ".pif"
]);

const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        const id = crypto.randomUUID();
        const ext = path.extname(file.originalname) || "";
        const safeName = file.originalname
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .slice(0, 100);
        cb(null, `${id}-${safeName}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        // Block executables
        if (BLOCKED_EXTENSIONS.has(ext)) {
            return cb(new Error(`Executable file type ${ext} not allowed`));
        }

        // Allow if MIME is in list or extension is allowed
        if (ALLOWED_MIMES.includes(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${file.mimetype} (${ext}) not allowed`));
        }
    }
});

// ============================================================
// TTL CLEANUP — runs on import and every hour
// ============================================================
const TTL_DAYS = parseInt(process.env.UPLOAD_TTL_DAYS || "7", 10);
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

(async () => {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        await cleanExpired(TTL_MS);
    } catch (e) {
        console.warn("TTL cleanup init error:", e.message);
    }
})();

setInterval(() => cleanExpired(TTL_MS).catch(() => {}), 60 * 60 * 1000);

// ============================================================
// MAGIC-BYTE MIME VALIDATION
// ============================================================
async function validateMimeByMagicBytes(filePath, claimedMime) {
    try {
        const { fileTypeFromFile } = await import("file-type");
        const detected = await fileTypeFromFile(filePath);
        // If file-type can detect it (binary files), verify it matches
        if (detected) {
            // Allow if the detected mime is in our allowed list
            if (ALLOWED_MIMES.includes(detected.mime)) return true;
            // Block if detected as something dangerous
            return false;
        }
        // file-type returns undefined for text files — that's fine, trust extension
        return true;
    } catch {
        // If file-type fails, fall back to extension check (already passed multer filter)
        return true;
    }
}

// ============================================================
// DEBUG ROUTES
// ============================================================
router.get("/debug/memory", async (req, res) => {
    const memory = await getMemory();
    res.json({
        memory,
        location: MEMORY_FILE,
        lastUpdated: new Date().toISOString(),
        stats: {
            totalConversations: Object.keys(memory.conversations).length,
            totalMessages: Object.values(memory.conversations).reduce((sum, conv) => sum + conv.length, 0),
            profileKeys: Object.keys(memory.profile).length
        }
    });
});

router.post("/debug/memory/reset", async (req, res) => {
    await saveJSON(MEMORY_FILE, DEFAULT_MEMORY);
    res.json({ success: true, message: "Memory reset", memory: DEFAULT_MEMORY });
});

// ============================================================
// FILE UPLOAD ENDPOINT
// ============================================================
router.post("/upload", upload.array("files", 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        const fileData = [];

        for (const file of req.files) {
            // Validate magic bytes
            const valid = await validateMimeByMagicBytes(file.path, file.mimetype);
            if (!valid) {
                // Remove the invalid file
                try { await fs.unlink(file.path); } catch {}
                continue;
            }

            const id = path.basename(file.filename, path.extname(file.filename)).split("-")[0];
            const entry = await registerFile({
                id: file.filename,
                originalName: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
                filePath: file.path
            });

            fileData.push({
                id: file.filename,
                originalName: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
                previewUrl: `/api/file-preview/${encodeURIComponent(file.filename)}`
            });

            logAudit({ action: "upload", fileId: file.filename, fileName: file.originalname, ip: req.ip });
        }

        res.json({ success: true, files: fileData, count: fileData.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// FILE PREVIEW ENDPOINT — first 200 lines or 8KB
// ============================================================
router.get("/api/file-preview/:id", async (req, res) => {
    try {
        const entry = await getFile(req.params.id);
        if (!entry) return res.status(404).json({ error: "File not found" });

        // Security: verify file is within uploads dir
        const resolved = path.resolve(entry.path);
        if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
            return res.status(403).json({ error: "Access denied" });
        }

        const content = await fs.readFile(entry.path, "utf8");
        const lines = content.split("\n");
        const preview = lines.slice(0, 200).join("\n").slice(0, 8192);

        logAudit({ action: "preview", fileId: req.params.id, fileName: entry.originalName, ip: req.ip });

        res.json({
            id: req.params.id,
            originalName: entry.originalName,
            mimetype: entry.mimetype,
            size: entry.size,
            totalLines: lines.length,
            previewLines: Math.min(lines.length, 200),
            preview,
            truncated: lines.length > 200 || content.length > 8192
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// FILE CONTENT ENDPOINT — streams full file
// ============================================================
router.get("/api/file-content/:id", async (req, res) => {
    try {
        const entry = await getFile(req.params.id);
        if (!entry) return res.status(404).json({ error: "File not found" });

        const resolved = path.resolve(entry.path);
        if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Determine safe content type
        const safeTypes = {
            "text/plain": "text/plain",
            "text/html": "text/plain", // serve HTML as plain text for safety
            "text/css": "text/plain",
            "text/javascript": "text/plain",
            "application/javascript": "text/plain",
            "application/json": "application/json",
            "text/markdown": "text/plain",
            "text/csv": "text/csv",
            "image/png": "image/png",
            "image/jpeg": "image/jpeg",
            "image/gif": "image/gif",
            "image/webp": "image/webp",
            "application/pdf": "application/pdf"
        };

        const contentType = safeTypes[entry.mimetype] || "text/plain";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `inline; filename="${entry.originalName}"`);

        logAudit({ action: "access", fileId: req.params.id, fileName: entry.originalName, ip: req.ip });

        const stream = createReadStream(resolved);
        stream.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// COMPILE FILES ENDPOINT - READS FILE CONTENTS
// ============================================================
router.post("/compile-files", async (req, res) => {
    try {
        const { files } = req.body;
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: "No files provided" });
        }

        let combinedContent = "";
        let successCount = 0;
        let errorCount = 0;

        console.log(`📦 Compiling ${files.length} files...`);

        for (const filename of files) {
            // Resolve path relative to project root
            const filepath = path.resolve(PROJECT_ROOT, filename);

            // Security check
            if (!filepath.startsWith(PROJECT_ROOT)) {
                console.warn(`⚠️ Skipping file outside sandbox: ${filename}`);
                continue;
            }

            try {
                console.log(`  📄 Reading: ${filename}`);
                const content = await fs.readFile(filepath, "utf8");

                // Add file header and content
                combinedContent += `\n\n${"=".repeat(70)}\n`;
                combinedContent += `FILE: ${filename}\n`;
                combinedContent += `${"=".repeat(70)}\n\n`;
                combinedContent += content;
                combinedContent += `\n`;

                successCount++;
                console.log(`  ✅ Read ${content.length} characters`);
            } catch (err) {
                console.error(`  ❌ Failed to read ${filename}:`, err.message);
                combinedContent += `\n\n${"=".repeat(70)}\n`;
                combinedContent += `FILE: ${filename}\n`;
                combinedContent += `ERROR: ${err.message}\n`;
                combinedContent += `${"=".repeat(70)}\n\n`;
                errorCount++;
            }
        }

        // Write to bigFile.txt
        const outputPath = path.resolve(PROJECT_ROOT, "files2/bigFile.txt");
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, combinedContent, "utf8");

        console.log(`✅ Compilation complete: ${successCount} files, ${errorCount} errors`);
        console.log(`📁 Output: ${outputPath} (${combinedContent.length} bytes)`);

        res.json({
            success: true,
            filesCompiled: successCount,
            filesErrored: errorCount,
            outputPath: path.join(PROJECT_ROOT, "files2/bigFile.txt"),
            size: combinedContent.length
        });
    } catch (err) {
        console.error("❌ Compilation error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;

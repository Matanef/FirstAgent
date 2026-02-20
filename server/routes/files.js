// server/routes/files.js
// File upload, compilation, and debug endpoints

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { PROJECT_ROOT } from "../utils/config.js";
import {
    saveJSON,
    getMemory,
    MEMORY_FILE,
    DEFAULT_MEMORY
} from "../memory.js";

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
    dest: path.resolve(PROJECT_ROOT, "uploads"),
    limits: { fileSize: 10 * 1024 * 1024, files: 20 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            "text/plain", "application/pdf", "image/png", "image/jpeg",
            "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ];
        if (allowedMimes.includes(file.mimetype)) cb(null, true);
        else cb(new Error(`File type ${file.mimetype} not allowed`));
    }
});

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
router.post("/upload", upload.array("files", 20), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
        const fileData = req.files.map((file) => ({
            id: file.filename,
            originalName: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            path: file.path
        }));
        res.json({ success: true, files: fileData, count: fileData.length });
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

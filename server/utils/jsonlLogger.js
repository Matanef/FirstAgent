// server/utils/jsonlLogger.js
// Shared JSONL file logging utilities

import fs from "fs/promises";

/**
 * Ensure a directory exists (creates it recursively if not).
 * @param {string} dirPath - Absolute path to directory
 */
export async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (err) {
        console.error(`[jsonlLogger] Failed to create directory ${dirPath}:`, err);
    }
}

/**
 * Append a JSON object as a line to a JSONL file.
 * @param {string} filepath - Absolute path to .jsonl file
 * @param {Object} data - Data to append
 * @param {string} logDir - Directory to ensure exists
 */
export async function appendLog(filepath, data, logDir) {
    try {
        if (logDir) await ensureDir(logDir);
        const line = JSON.stringify(data) + "\n";
        await fs.appendFile(filepath, line, "utf8");
    } catch (err) {
        console.error(`[jsonlLogger] Failed to append to ${filepath}:`, err);
    }
}

/**
 * Read a JSONL file and return the last N parsed entries.
 * @param {string} filepath - Absolute path to .jsonl file
 * @param {number} limit - Max entries to return (from end)
 * @returns {Array<Object>} Parsed entries
 */
export async function readLog(filepath, limit = 100) {
    try {
        const content = await fs.readFile(filepath, "utf8");
        const lines = content.trim().split("\n");
        const entries = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        }).filter(Boolean);

        return entries.slice(-limit);
    } catch (err) {
        if (err.code === "ENOENT") return [];
        console.error(`[jsonlLogger] Failed to read ${filepath}:`, err);
        return [];
    }
}

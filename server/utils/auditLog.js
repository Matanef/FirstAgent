// server/utils/auditLog.js
// Append-only JSON lines audit log for file operations

import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "./config.js";

const AUDIT_FILE = path.resolve(PROJECT_ROOT, "uploads", "audit.jsonl");

export async function logAudit({ action, fileId, fileName, ip, details }) {
    const entry = {
        timestamp: new Date().toISOString(),
        action,
        fileId: fileId || null,
        fileName: fileName || null,
        ip: ip || null,
        details: details || null
    };

    try {
        await fs.mkdir(path.dirname(AUDIT_FILE), { recursive: true });
        await fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
        console.warn("[audit] Failed to write audit log:", err.message);
    }
}

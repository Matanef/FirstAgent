// server/tools/fileReview.js
// Tool: reads uploaded file previews and returns structured data for LLM summarization

import { getFile } from "../utils/fileRegistry.js";
import fs from "fs/promises";

const PREVIEW_SIZE = 4096; // 4KB preview per file

export async function fileReview(input) {
    const text = typeof input === "string" ? input : input?.text || "";
    const context = typeof input === "object" ? input?.context || {} : {};
    const fileIds = context.fileIds || [];

    if (fileIds.length === 0) {
        return {
            tool: "fileReview",
            success: false,
            final: true,
            error: "No files were attached to review.",
            data: {}
        };
    }

    const files = [];
    const errors = [];

    for (const id of fileIds) {
        const entry = await getFile(id);
        if (!entry) {
            errors.push({ id, error: "File not found in registry" });
            continue;
        }

        let preview = "";
        let totalSize = entry.size;
        let truncated = false;

        try {
            const content = await fs.readFile(entry.path, "utf8");
            if (content.length > PREVIEW_SIZE) {
                preview = content.slice(0, PREVIEW_SIZE);
                truncated = true;
            } else {
                preview = content;
            }
        } catch (err) {
            // Might be a binary file
            preview = `[Binary file: ${entry.mimetype}, ${entry.size} bytes]`;
            truncated = false;
        }

        files.push({
            id,
            name: entry.originalName,
            size: entry.size,
            mimetype: entry.mimetype,
            preview,
            truncated
        });
    }

    // Build a combined preview for the LLM summarization step
    let combinedPreview = "";
    for (const f of files) {
        combinedPreview += `\n--- File: ${f.name} (${formatSize(f.size)}) ---\n`;
        combinedPreview += f.preview;
        if (f.truncated) combinedPreview += "\n[... truncated ...]\n";
        combinedPreview += "\n";
    }

    // Build explicit per-file LLM prompt to ensure ALL files are analyzed
    const llmPrompt = files.length > 1
        ? `Analyze EACH of the following ${files.length} files separately. For each file, provide:\n` +
          `1. Brief explanation of what the file does\n` +
          `2. 2-3 specific improvement suggestions\n` +
          `3. If it's a text file, explain the main subject\n\n` +
          `Do NOT skip any files. Analyze ALL ${files.length} files listed below.\n\n` +
          `FILES:\n${combinedPreview}`
        : combinedPreview;

    return {
        tool: "fileReview",
        success: true,
        final: true,
        data: {
            files,
            errors: errors.length > 0 ? errors : undefined,
            userMessage: text,
            combinedPreview,
            text: llmPrompt // used by summarizeWithLLM as tool result text
        }
    };
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// server/tools/fileReview.js
// Tool: reads uploaded file previews and runs a dedicated LLM analysis per file

import { getFile } from "../utils/fileRegistry.js";
import fs from "fs/promises";
import { llm } from "./llm.js"; // <-- We now import the LLM directly

const PREVIEW_SIZE = 4096; // 4KB preview per file

// Quick helper to format file sizes
function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
}

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

    // 1. Read the files from the system
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
        } catch (e) {
            errors.push({ id, error: `Failed to read file: ${e.message}` });
            continue;
        }

        // Safely grab the name no matter what format the registry uses
        const safeName = entry.originalname || entry.filename || entry.fileName || entry.name || `file_${id}.txt`;

        files.push({
            id,
            name: safeName,         // For components expecting 'name'
            fileName: safeName,     // For components expecting 'fileName'
            filename: safeName,     // For components expecting 'filename'
            size: totalSize || entry.size || 0,
            preview,
            truncated
        });
    }

    // 2. Build a combined preview of the code
    let combinedPreview = "";
    for (const f of files) {
        combinedPreview += `\n--- File: ${f.name} (${formatSize(f.size)}) ---\n`;
        combinedPreview += f.preview;
        if (f.truncated) combinedPreview += "\n[... truncated ...]\n";
        combinedPreview += "\n";
    }

    console.log(`🧠 [fileReview] Calling LLM to analyze ${files.length} files...`);

    // 3. The Dedicated LLM Prompt (Forces 2-3 suggestions per file)
    const analysisPrompt = `
You are an expert code reviewer. The user wants you to review the following files:
User request: "${text}"

Analyze EACH of the following ${files.length} files separately. For EACH file, you must provide:
1. A brief explanation of what the file does.
2. 2-3 specific improvement suggestions (code quality, bugs, architecture, or formatting).
3. If it is a regular text file instead of code, explain the main subject.

Do NOT skip any files. Analyze ALL ${files.length} files listed below. Be thorough but concise. Do not cut off your response in the middle.

FILES TO REVIEW:
${combinedPreview}
`;

    // 4. Generate the review and return it immediately
    try {
        const result = await llm(analysisPrompt);
        const reviewText = result?.data?.text || result?.output || "Review completed.";

        console.log("🧠 [fileReview] LLM returned review length:", reviewText.length);

        return {
            tool: "fileReview",
            success: true,
            final: true,
            data: {
                files,
                errors: errors.length > 0 ? errors : undefined,
                userMessage: text,
                text: reviewText, // The final finished text
                message: reviewText,
                preformatted: true // Tells the UI to keep the markdown styling
            }
        };
    } catch (llmErr) {
        console.error("❌ [fileReview] LLM Error:", llmErr);
        return {
            tool: "fileReview",
            success: false,
            final: true,
            error: "LLM failed to analyze files: " + llmErr.message,
            data: { files, errors }
        };
    }
}
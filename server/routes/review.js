// server/routes/review.js
import express from "express";
import path from "path";
import fs from "fs/promises";
import { executeAgent } from "../utils/coordinator.js";
import { PROJECT_ROOT } from "../utils/config.js";

const router = express.Router();
const MAX_FILE_SIZE = 200 * 4096; // 200KB

function isAllowed(resolved) {
  return resolved.startsWith(PROJECT_ROOT);
}

async function walkAndCollect(folderResolved, collector) {
  const entries = await fs.readdir(folderResolved, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(folderResolved, entry.name);
    if (entry.isDirectory()) {
      await walkAndCollect(full, collector);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp'].includes(ext)) {
        collector.push({ path: path.relative(PROJECT_ROOT, full), resolved: full });
      }
    }
  }
}

async function safeReadFile(resolved) {
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("Not a file");
    if (stat.size > MAX_FILE_SIZE) {
      return { truncated: true, size: stat.size, content: null };
    }
    const content = await fs.readFile(resolved, "utf8");
    return { truncated: false, size: stat.size, content };
  } catch (err) {
    throw err;
  }
}

async function callLLMWithRetry(prompt) {
  // First call
  const first = await executeAgent({ tool: "llm", message: { text: prompt }, conversationId: null });
  console.log("[review] LLM RAW RESPONSE:", JSON.stringify(first, null, 2).slice(0, 2000));
  let replyText = (first.reply || "").toString();

  // Try parse
  try {
    const cleaned = replyText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    return { parsed: JSON.parse(cleaned), raw: replyText, meta: first };
  } catch (e) {
    // Retry with a short clarifying instruction to return JSON only
    console.warn("[review] First parse failed, retrying with JSON-only instruction");
    const retryPrompt = `You must return valid JSON only. Parse the previous content and return a JSON object with keys: "summary", "snippets", "suggestions". Do not include any extra text.\n\nPrevious response:\n${replyText}`;
    const second = await executeAgent({ tool: "llm", message: { text: retryPrompt }, conversationId: null });
    console.log("[review] LLM RETRY RAW RESPONSE:", JSON.stringify(second, null, 2).slice(0, 2000));
    const secondText = (second.reply || "").toString();
    try {
      const cleaned2 = secondText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      return { parsed: JSON.parse(cleaned2), raw: secondText, meta: second };
    } catch (e2) {
      // Give up and return raw text
      console.error("[review] JSON parse failed after retry:", e2.message);
      return { parsed: null, raw: secondText || replyText, meta: second || first };
    }
  }
}

router.post("/review", async (req, res) => {
  try {
    const { files = [], folders = [] } = req.body;
    const toReview = [];

    // Resolve and validate file paths
    for (const filePath of files) {
      const resolved = path.resolve(PROJECT_ROOT, filePath);
      if (!isAllowed(resolved)) {
        console.warn("[review] Skipping disallowed path:", filePath, resolved);
        continue;
      }
      toReview.push({ path: filePath, resolved });
    }

    // Expand folders (recursive)
    for (const folderPath of folders) {
      const resolved = path.resolve(PROJECT_ROOT, folderPath);
      if (!isAllowed(resolved)) {
        console.warn("[review] Skipping disallowed folder:", folderPath, resolved);
        continue;
      }
      await walkAndCollect(resolved, toReview);
    }

    console.log("[review] Files to review:", toReview.map(t => t.path));

    // If nothing to review, return a clear message
    if (toReview.length === 0) {
      return res.json({ success: true, reviews: [], reportSuggested: false, message: "No files matched the request or files are outside the allowed project root." });
    }

    // Review each file
    const reviews = [];
    for (const { path: filePath, resolved } of toReview) {
      try {
        const read = await safeReadFile(resolved);
        if (read.truncated) {
          reviews.push({ path: filePath, error: "File too large (max 200KB)", summary: null, snippets: [], suggestions: [] });
          console.warn("[review] File too large:", filePath, "size:", read.size);
          continue;
        }
        if (read.content == null) {
          reviews.push({ path: filePath, error: "Unable to read file", summary: null, snippets: [], suggestions: [] });
          continue;
        }

        // Diagnostic logs
        const preview = read.content.slice(0, 400).replace(/\n/g, "\\n");
        console.log(`[review] Read file: ${filePath} (size=${read.size}) preview: "${preview}"`);
        const prompt = `You are a senior software engineer reviewing code.

FILE: ${filePath}
PROJECT: Local LLM UI (Node.js/Express backend + React frontend)

TASK: Provide a structured review with:
1. Professional summary (2-3 sentences): what this file does, how it fits into the project
2. Important snippets (max 3): key code sections with line numbers
3. Concrete suggestions (max 5): specific improvements for structure, security, performance

FILE CONTENT:
\`\`\`
${read.content}
\`\`\`

RESPOND WITH VALID JSON ONLY:
{
  "summary": "string",
  "snippets": [
    { "lineStart": number, "lineEnd": number, "code": "string", "reason": "string" }
  ],
  "suggestions": ["string"]
}`;

        console.log("[review] Prompt length:", prompt.length);
        const llmResult = await callLLMWithRetry(prompt);

        if (llmResult.parsed) {
          reviews.push({ path: filePath, ...llmResult.parsed });
        } else {
          // If parsing failed, include raw reply for debugging and a short fallback summary
          reviews.push({
            path: filePath,
            summary: `LLM did not return valid JSON. Raw reply included for debugging.`,
            snippets: [],
            suggestions: [],
            llmRaw: llmResult.raw
          });
        }
      } catch (fileErr) {
        console.error("[review] Error processing file:", filePath, fileErr);
        reviews.push({ path: filePath, error: fileErr.message, summary: null, snippets: [], suggestions: [] });
      }
    }

    const reportSuggested = reviews.length > 3;
    res.json({ success: true, reviews, reportSuggested });
  } catch (err) {
    console.error("Review error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
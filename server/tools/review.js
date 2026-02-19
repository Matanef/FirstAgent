// server/tools/review.js
import path from "path";
import fs from "fs/promises";
import { executeAgent } from "../executor.js";

const MAX_FILE_SIZE = 200 * 1024; // 200KB
const PROJECT_ROOT = path.resolve("D:/local-llm-ui");

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

export async function review(input = {}) {
  try {
    const { files = [], folders = [] } = input;
    const toReview = [];

    // Resolve files
    for (const filePath of files) {
      const resolved = path.resolve(PROJECT_ROOT, filePath);
      if (!isAllowed(resolved)) continue;
      toReview.push({ path: filePath, resolved });
    }

    // Expand folders
    for (const folderPath of folders) {
      const resolved = path.resolve(PROJECT_ROOT, folderPath);
      if (!isAllowed(resolved)) continue;
      await walkAndCollect(resolved, toReview);
    }

    const reviews = [];
    for (const item of toReview) {
      const { path: filePath, resolved } = item;
      const stat = await fs.stat(resolved);
      if (stat.size > MAX_FILE_SIZE) {
        reviews.push({ path: filePath, error: "File too large (max 200KB)", summary: null, snippets: [], suggestions: [] });
        continue;
      }
      const content = await fs.readFile(resolved, "utf8");

      const prompt = `You are a senior software engineer reviewing code.

FILE: ${filePath}
PROJECT: Local LLM UI (Node.js/Express backend + React frontend)

TASK: Provide a structured review with:
1. Professional summary (2-3 sentences): what this file does, how it fits into the project
2. Important snippets (max 3): key code sections with line numbers
3. Concrete suggestions (max 5): specific improvements for structure, security, performance

FILE CONTENT:
\`\`\`
${content}
\`\`\`

RESPOND WITH VALID JSON ONLY:
{
  "summary": "string",
  "snippets": [
    { "lineStart": number, "lineEnd": number, "code": "string", "reason": "string" }
  ],
  "suggestions": ["string"]
}`;

      const result = await executeAgent({ tool: "llm", message: { text: prompt }, conversationId: null });

      let parsed;
      try {
        let jsonText = (result.reply || "").replace(/```json\n?/g, '').replace(/```\n?/g, '');
        parsed = JSON.parse(jsonText);
      } catch (e) {
        parsed = { summary: (result.reply || "").slice(0, 300), snippets: [], suggestions: [] };
      }

      reviews.push({ path: filePath, ...parsed });
    }

    return { tool: "review", success: true, data: { reviews, reportSuggested: reviews.length > 3 } };
  } catch (err) {
    return { tool: "review", success: false, error: err.message };
  }
}
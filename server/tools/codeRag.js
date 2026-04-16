// server/tools/codeRag.js
// ──────────────────────────────────────────────────────────────────────────────
// LOCAL CODE RAG (Retrieval-Augmented Generation) FOR CODEBASE
//
// ARCHITECTURE:
// 1. CHUNKING: Parse JS files into semantic chunks (functions, classes, exports)
//    using regex-based AST-lite extraction (no tree-sitter dependency needed).
//    This avoids adding a native binary dependency to the project.
//
// 2. EMBEDDING: Send each chunk to Ollama's `nomic-embed-text` model for
//    384-dimensional vector embeddings. Chunks are stored as JSON on disk.
//
// 3. QUERY: Embed the user's query, compute cosine similarity against all
//    stored chunks, and return the top-K most relevant code fragments.
//
// STORAGE: Simple JSON file at server/data/code_embeddings.json
//   - No external vector DB needed (ChromaDB, Pinecone, etc.)
//   - ~50 tool files × ~10 chunks each = ~500 vectors → fits easily in memory
//
// INDEXING: Run "index the codebase" or "reindex code" to rebuild.
// QUERYING: "find code that handles email sending" → returns relevant chunks.
// ──────────────────────────────────────────────────────────────────────────────

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "../utils/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.resolve(__dirname, "..", "data");
const EMBEDDINGS_FILE = path.join(DATA_DIR, "code_embeddings.json");

// ── Config
const EMBED_MODEL = "nomic-embed-text";  // Small, fast, 384-dim embeddings
const TOP_K = 5;                          // Number of results to return
const MAX_CHUNK_CHARS = 2000;             // Max chars per chunk (keeps embeddings focused)
const MIN_CHUNK_CHARS = 30;               // Skip trivial chunks (single-line exports, etc.)

// ── Directories to index (relative to PROJECT_ROOT)
const INDEX_DIRS = [
  "server",
  "client/local-llm-ui/src/components"
];

// ── Skip patterns
const SKIP_FILES = new Set(["index.js", "node_modules", ".git", "backups"]);
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

// ──────────────────────────────────────────────────────────────────────────────
// CHUNKING: Regex-based semantic code splitting
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Split a JavaScript file into semantic chunks based on function/class boundaries.
 * Each chunk contains: { name, type, code, startLine, endLine }
 *
 * STRATEGY:
 * - Detect function declarations (export async function foo, const foo = async, etc.)
 * - Detect class declarations
 * - Track brace depth to find function/class boundaries
 * - Fall back to fixed-size windowed chunks for files without clear boundaries
 */
function chunkCode(code, filePath) {
  const chunks = [];
  const lines = code.split("\n");
  const relPath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, "/");

  // ── Phase 1: Extract import block as a single chunk (context for understanding)
  const importLines = [];
  let importEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("from ") ||
        (trimmed === "" && importLines.length > 0 && i < 20)) {
      importLines.push(lines[i]);
      importEnd = i;
    } else if (importLines.length > 0) {
      break;
    }
  }
  if (importLines.length > 0) {
    chunks.push({
      name: "imports",
      type: "imports",
      code: importLines.join("\n"),
      file: relPath,
      startLine: 1,
      endLine: importEnd + 1
    });
  }

  // ── Phase 2: Find function and class boundaries via brace-depth tracking
  // Regex patterns for function/class/method declarations
  const declPatterns = [
    // export async function foo(
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    // const foo = async (
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/,
    // const foo = async function(
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
    // class Foo {
    /^(?:export\s+)?class\s+(\w+)/,
    // export default async function
    /^export\s+default\s+(?:async\s+)?function\s*(\w*)/
  ];

  let currentChunk = null;
  let braceDepth = 0;
  let chunkStartLine = 0;

  for (let i = importEnd + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and single-line comments when not inside a chunk
    if (!currentChunk && (trimmed === "" || trimmed.startsWith("//"))) continue;

    // Check if this line starts a new declaration
    if (!currentChunk) {
      for (const pattern of declPatterns) {
        const match = trimmed.match(pattern);
        if (match) {
          currentChunk = {
            name: match[1] || "default",
            type: trimmed.includes("class ") ? "class" : "function",
            lines: [],
            startLine: i + 1
          };
          braceDepth = 0;
          break;
        }
      }
    }

    // If we're inside a chunk, collect lines and track braces
    if (currentChunk) {
      currentChunk.lines.push(line);

      // Count braces (ignore braces inside strings/comments for simplicity)
      const stripped = trimmed.replace(/\/\/.*$/, "").replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "");
      for (const ch of stripped) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }

      // When braces balance back to 0, the declaration is complete
      if (braceDepth <= 0 && currentChunk.lines.length > 1) {
        const chunkCode = currentChunk.lines.join("\n");
        if (chunkCode.length >= MIN_CHUNK_CHARS && chunkCode.length <= MAX_CHUNK_CHARS) {
          chunks.push({
            name: currentChunk.name,
            type: currentChunk.type,
            code: chunkCode,
            file: relPath,
            startLine: currentChunk.startLine,
            endLine: i + 1
          });
        } else if (chunkCode.length > MAX_CHUNK_CHARS) {
          // Split oversized chunks into windows
          const windows = splitIntoWindows(chunkCode, currentChunk.name, relPath, currentChunk.startLine);
          chunks.push(...windows);
        }
        currentChunk = null;
        braceDepth = 0;
      }
    }
  }

  // ── Phase 3: If no semantic chunks found, fall back to windowed splitting
  if (chunks.length <= 1) {
    const bodyCode = lines.slice(importEnd + 1).join("\n");
    if (bodyCode.length > MIN_CHUNK_CHARS) {
      const windows = splitIntoWindows(bodyCode, "body", relPath, importEnd + 2);
      chunks.push(...windows);
    }
  }

  return chunks;
}

/**
 * Split a large code block into overlapping windows of MAX_CHUNK_CHARS.
 * Overlap ensures context isn't lost at boundaries.
 */
function splitIntoWindows(code, baseName, file, startLine) {
  const windows = [];
  const windowSize = MAX_CHUNK_CHARS;
  const overlap = 200;
  let offset = 0;
  let windowIndex = 0;

  while (offset < code.length) {
    const slice = code.slice(offset, offset + windowSize);
    const sliceLines = code.slice(0, offset).split("\n").length;

    windows.push({
      name: `${baseName}_part${windowIndex}`,
      type: "window",
      code: slice,
      file,
      startLine: startLine + sliceLines - 1,
      endLine: startLine + sliceLines + slice.split("\n").length - 2
    });

    offset += windowSize - overlap;
    windowIndex++;
  }

  return windows;
}

// ──────────────────────────────────────────────────────────────────────────────
// EMBEDDING: Call Ollama's nomic-embed-text for vector embeddings
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get embedding vector for a text string.
 * Uses Ollama's /api/embeddings endpoint with nomic-embed-text model.
 * Returns a Float32Array of 384 dimensions.
 */
async function getEmbedding(text) {
  const url = `${CONFIG.LLM_API_URL}api/embeddings`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBED_MODEL,
        prompt: text.slice(0, 4000) // nomic-embed-text has 8192 token limit; ~4000 chars is safe
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding HTTP ${response.status}`);
    }

    const json = await response.json();
    return json.embedding; // number[] of 384 dimensions
  } catch (err) {
    console.error(`[codeRag] Embedding failed: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// VECTOR MATH: Cosine similarity for ranking
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 * Returns a value between -1 (opposite) and 1 (identical).
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ──────────────────────────────────────────────────────────────────────────────
// INDEXING: Walk codebase, chunk, embed, and store
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Recursively find all code files in the index directories.
 */
async function findCodeFiles(baseDir) {
  const files = [];

  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_FILES.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  await walk(baseDir);
  return files;
}

/**
 * Build the full index: chunk all files, embed all chunks, save to disk.
 * This is a potentially slow operation (~2-5 min for 50 files with local Ollama).
 */
async function buildIndex() {
  console.log("[codeRag] 🔨 Building code index...");
  const startTime = Date.now();

  // Find all code files
  const allFiles = [];
  for (const dir of INDEX_DIRS) {
    const dirPath = path.resolve(PROJECT_ROOT, dir);
    const files = await findCodeFiles(dirPath);
    allFiles.push(...files);
  }

  console.log(`[codeRag] Found ${allFiles.length} code files to index`);

  // Chunk all files
  const allChunks = [];
  for (const filePath of allFiles) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content.length > 256 * 1024) continue; // Skip very large files
      const chunks = chunkCode(content, filePath);
      allChunks.push(...chunks);
    } catch {
      // Skip unreadable files
    }
  }

  console.log(`[codeRag] Extracted ${allChunks.length} code chunks`);

  // Embed all chunks (with progress logging)
  const embeddings = [];
  let embedded = 0;
  let failed = 0;

  for (const chunk of allChunks) {
    // Create a search-friendly text representation
    const searchText = `File: ${chunk.file}\nName: ${chunk.name}\nType: ${chunk.type}\n\n${chunk.code}`;
    const vector = await getEmbedding(searchText);

    if (vector) {
      embeddings.push({
        name: chunk.name,
        type: chunk.type,
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        code: chunk.code,
        vector // number[] — will be stored in JSON
      });
      embedded++;
    } else {
      failed++;
    }

    // Progress logging every 50 chunks
    if ((embedded + failed) % 50 === 0) {
      console.log(`[codeRag] Progress: ${embedded + failed}/${allChunks.length} (${failed} failures)`);
    }
  }

  // Save to disk
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(EMBEDDINGS_FILE, JSON.stringify({
    version: 1,
    model: EMBED_MODEL,
    indexedAt: new Date().toISOString(),
    fileCount: allFiles.length,
    chunkCount: embeddings.length,
    embeddings
  }, null, 0), "utf8"); // null, 0 = no pretty-print (saves disk space)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[codeRag] ✅ Index built: ${embeddings.length} chunks from ${allFiles.length} files in ${elapsed}s`);

  return {
    fileCount: allFiles.length,
    chunkCount: embeddings.length,
    failedEmbeddings: failed,
    elapsedSeconds: parseFloat(elapsed)
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// QUERYING: Embed query → cosine similarity → return top-K
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Load the embeddings index from disk.
 */
async function loadIndex() {
  try {
    const raw = await fs.readFile(EMBEDDINGS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Search the codebase for chunks semantically similar to the query.
 * Returns top-K results sorted by relevance.
 */
async function searchCode(query, topK = TOP_K) {
  const index = await loadIndex();
  if (!index || !index.embeddings || index.embeddings.length === 0) {
    return { results: [], error: "No index found. Run 'index the codebase' first." };
  }

  // Embed the query
  const queryVector = await getEmbedding(query);
  if (!queryVector) {
    return { results: [], error: "Failed to embed query. Is Ollama running with nomic-embed-text?" };
  }

  // Rank all chunks by cosine similarity
  const scored = index.embeddings.map(chunk => ({
    ...chunk,
    score: cosineSimilarity(queryVector, chunk.vector)
  }));

  // Sort descending by score, take top K
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, topK);

  // Strip vectors from output (no need to show them to the user)
  return {
    results: topResults.map(r => ({
      name: r.name,
      type: r.type,
      file: r.file,
      startLine: r.startLine,
      endLine: r.endLine,
      score: parseFloat(r.score.toFixed(4)),
      code: r.code
    })),
    indexAge: index.indexedAt,
    totalChunks: index.chunkCount
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// TOOL EXPORT
// ──────────────────────────────────────────────────────────────────────────────

/**
 * codeRag Tool
 *
 * Actions:
 *   "index" / "reindex" / "build index" → Rebuild the embedding index
 *   "search <query>" / "find <query>"   → Semantic search over codebase
 *   "status"                            → Show index stats
 *
 * Input: string or { text, context }
 */
export async function codeRag(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};
    const lower = text.toLowerCase().trim();

    // ── Detect action ──
    let action = "search"; // Default
    if (/\b(index|reindex|rebuild|build\s+index)\b/.test(lower)) action = "index";
    else if (/\b(status|stats|info)\b/.test(lower)) action = "status";

    // Override from context
    if (context.action) action = context.action;

    // ── ACTION: INDEX ──
    if (action === "index") {
      const result = await buildIndex();
      return {
        tool: "codeRag",
        success: true,
        final: true,
        data: {
          text: `✅ **Code index rebuilt**\n\n📁 Files: ${result.fileCount}\n🧩 Chunks: ${result.chunkCount}\n❌ Failed: ${result.failedEmbeddings}\n⏱️ Time: ${result.elapsedSeconds}s\n\nThe codebase is now searchable via semantic queries.`,
          preformatted: true,
          action: "indexed",
          ...result
        }
      };
    }

    // ── ACTION: STATUS ──
    if (action === "status") {
      const index = await loadIndex();
      if (!index) {
        return {
          tool: "codeRag",
          success: true,
          final: true,
          data: {
            text: "❌ No code index found. Run `index the codebase` to build one.",
            preformatted: true
          }
        };
      }
      return {
        tool: "codeRag",
        success: true,
        final: true,
        data: {
          text: `📊 **Code RAG Index Status**\n\n📁 Files: ${index.fileCount}\n🧩 Chunks: ${index.chunkCount}\n🤖 Model: ${index.model}\n📅 Built: ${index.indexedAt}\n🗄️ Storage: ${EMBEDDINGS_FILE}`,
          preformatted: true
        }
      };
    }

    // ── ACTION: SEARCH ──
    // Strip search command words to get the actual query
    const query = text
      .replace(/\b(search|find|look\s+for|query|code\s+rag|rag|codebase)\b/gi, "")
      .replace(/\b(that|which|for|the|in|code|function|where|how)\b/gi, "")
      .trim() || text;

    if (query.length < 3) {
      return {
        tool: "codeRag",
        success: false,
        final: true,
        error: "Search query too short. Try: 'find code that sends emails' or 'search for LLM prompt construction'"
      };
    }

    const topK = context.topK || TOP_K;
    const { results, error, indexAge, totalChunks } = await searchCode(query, topK);

    if (error) {
      return {
        tool: "codeRag",
        success: false,
        final: true,
        error
      };
    }

    if (results.length === 0) {
      return {
        tool: "codeRag",
        success: true,
        final: true,
        data: {
          text: `No relevant code found for: "${query}"\n\nTry a different search term or reindex the codebase.`,
          preformatted: true
        }
      };
    }

// ── Format results ──
    let output = `🔍 **Code Search: "${query}"**\n_Searched ${totalChunks} chunks (index: ${indexAge})_\n\n`;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let displayCode = r.code;
      let displayStartLine = r.startLine;
      let displayEndLine = r.endLine;

      try {
        // ========================================================
        // 1. CONTEXT EXPANSION (Read physical file and grab +/- 15 lines)
        // ========================================================
        const fullFilePath = path.join(PROJECT_ROOT, r.file);
        const fileContent = await fs.readFile(fullFilePath, "utf8");
        const lines = fileContent.split("\n");

        // Convert 1-based line numbers to 0-based array indexes, expand by 15
        const expandedStartIdx = Math.max(0, r.startLine - 1 - 15);
        const expandedEndIdx = Math.min(lines.length, r.endLine + 15);

        let expandedLines = lines.slice(expandedStartIdx, expandedEndIdx);
        displayStartLine = expandedStartIdx + 1; // Back to 1-based

        // ========================================================
        // 2. OUTPUT TRUNCATION (Idiot-Proofing the UI)
        // ========================================================
        const MAX_LINES = 30;
        const MAX_CHARS = 1500;
        let isTruncated = false;

        if (expandedLines.length > MAX_LINES) {
          expandedLines = expandedLines.slice(0, MAX_LINES);
          isTruncated = true;
        }
        
        displayEndLine = displayStartLine + expandedLines.length - 1;
        displayCode = expandedLines.join("\n");

        if (displayCode.length > MAX_CHARS) {
          displayCode = displayCode.substring(0, MAX_CHARS);
          isTruncated = true;
        }

        if (isTruncated) {
          displayCode += "\n// ... rest of the object/code";
        }
      } catch (err) {
        // Fallback to the raw AST chunk if the file read fails
        displayCode = r.code.slice(0, 1500);
      }

      output += `**${i + 1}. ${r.file}** → \`${r.name}\` (${r.type}) — score: ${r.score}\n`;
      output += `Lines ${displayStartLine}–${displayEndLine}\n`;
      output += `\`\`\`javascript\n${displayCode}\n\`\`\`\n\n`;
    }

    return {
      tool: "codeRag",
      success: true,
      final: true,
      data: {
        text: output.trim(),
        preformatted: true,
        results, // Structured data for downstream tools
        query
      }
    };

  } catch (err) {
    return {
      tool: "codeRag",
      success: false,
      final: true,
      error: `Code RAG failed: ${err.message}`
    };
  }
}

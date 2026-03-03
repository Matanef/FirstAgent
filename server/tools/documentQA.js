// server/tools/documentQA.js
// Document Question Answering — load documents, chunk, embed, and answer questions
// Uses vectorStore for retrieval and LLM for answer generation

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { addDocument, search, createCollection, listCollections, getCollectionStats } from "../utils/vectorStore.js";
import { llm } from "./llm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// FILE LOADING
// ============================================================

/**
 * Load and extract text from a file
 * Supports: .txt, .md, .json, .js, .py, .ts, .html, .csv, .log
 */
function loadFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, "utf8");

  switch (ext) {
    case ".json":
      try {
        const obj = JSON.parse(raw);
        return JSON.stringify(obj, null, 2);
      } catch {
        return raw;
      }
    case ".html":
    case ".htm":
      // Strip HTML tags, keep text
      return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    case ".csv":
      // Keep CSV as-is — it's structured text
      return raw;
    default:
      // .txt, .md, .js, .py, .ts, .log, etc. — return as-is
      return raw;
  }
}

// ============================================================
// INTENT DETECTION
// ============================================================

function detectDocQAIntent(query) {
  const lower = (query || "").toLowerCase();

  if (/\b(load|ingest|index|add|import)\s+(a\s+)?(document|file|pdf|text)\b/i.test(lower)) {
    return "ingest";
  }
  if (/\b(list|show)\s+(my\s+)?(documents|collections|indexed)\b/i.test(lower)) {
    return "list";
  }
  if (/\b(delete|remove|clear)\s+(the\s+)?(collection|document|index)\b/i.test(lower)) {
    return "delete";
  }
  // Default: question answering
  return "ask";
}

/**
 * Extract file path from query
 */
function extractFilePath(query) {
  // Absolute paths
  const absMatch = query.match(/([a-zA-Z]:[\\/][^\s,;!?"']+)/);
  if (absMatch) return absMatch[1];

  // Relative paths with extensions
  const relMatch = query.match(/(\.{0,2}\/?[\w][\w.\/-]*\.\w{1,5})\b/);
  if (relMatch) return relMatch[1];

  return null;
}

/**
 * Extract collection name from query
 */
function extractCollectionName(query) {
  const lower = query.toLowerCase();

  // "in collection X", "from collection X", "collection: X"
  const match = query.match(/(?:in|from|collection:?)\s+["']?(\w[\w-]*)["']?/i);
  if (match) return match[1];

  // "about X" — use as topic/collection name
  const aboutMatch = lower.match(/about\s+(\w[\w\s]*?)(?:\s+in\s+|\s+from\s+|$)/);
  if (aboutMatch) return aboutMatch[1].trim().replace(/\s+/g, "_");

  return "default";
}

// ============================================================
// HANDLERS
// ============================================================

/**
 * Ingest a document into the vector store
 */
async function ingestDocument(query) {
  const filePath = extractFilePath(query);
  if (!filePath) {
    return {
      tool: "documentQA",
      success: false,
      error: "Please provide a file path to ingest. Example: 'load document D:/docs/report.txt'",
    };
  }

  try {
    const text = loadFile(filePath);
    const collection = extractCollectionName(query);
    const filename = path.basename(filePath);

    const result = await addDocument(collection, text, {
      filename,
      filePath,
      fileSize: text.length,
      ingestedAt: new Date().toISOString(),
    });

    return {
      tool: "documentQA",
      success: true,
      final: true,
      data: {
        preformatted: true,
        text: `Document ingested successfully!\n\n- **File**: ${filename}\n- **Collection**: ${collection}\n- **Chunks**: ${result.chunks}\n- **Document ID**: ${result.docId}\n\nYou can now ask questions about this document.`,
      },
    };
  } catch (err) {
    return {
      tool: "documentQA",
      success: false,
      error: `Failed to ingest document: ${err.message}`,
    };
  }
}

/**
 * Answer a question using the vector store + LLM
 */
async function answerQuestion(query) {
  const collection = extractCollectionName(query);

  // Search for relevant chunks
  const results = await search(collection, query, 5);

  if (results.length === 0) {
    // Try the default collection
    const defaultResults = await search("default", query, 5);
    if (defaultResults.length === 0) {
      return {
        tool: "documentQA",
        success: false,
        error: "No documents found in the knowledge base. Use 'load document [file path]' to ingest documents first.",
      };
    }
    results.push(...defaultResults);
  }

  // Filter for minimum relevance
  const relevant = results.filter(r => r.score > 0.1);

  if (relevant.length === 0) {
    return {
      tool: "documentQA",
      success: true,
      final: true,
      data: {
        text: "I found some documents but none seem relevant to your question. Try rephrasing or specifying which document to search in.",
      },
    };
  }

  // Build context from retrieved chunks
  const context = relevant.map((r, i) =>
    `[Source ${i + 1} (relevance: ${(r.score * 100).toFixed(0)}%) - ${r.metadata?.filename || "unknown"}]:\n${r.text}`
  ).join("\n\n---\n\n");

  // Generate answer with LLM
  const prompt = `You are a document question-answering assistant. Answer the user's question based ONLY on the provided context. If the context doesn't contain enough information to answer, say so clearly.

RETRIEVED CONTEXT:
${context}

USER QUESTION:
${query}

RULES:
- Answer based ONLY on the provided context
- If the context doesn't answer the question, say "The documents don't contain information about this"
- Cite the source number when referencing information
- Be concise and direct
- Do NOT make up information not present in the context

ANSWER:`;

  try {
    const response = await llm(prompt);
    const answer = response?.data?.text || "I couldn't generate an answer.";

    return {
      tool: "documentQA",
      success: true,
      final: true,
      data: {
        text: answer,
        sources: relevant.map(r => ({
          filename: r.metadata?.filename,
          score: r.score,
          excerpt: r.text.slice(0, 100) + "...",
        })),
      },
    };
  } catch (err) {
    return {
      tool: "documentQA",
      success: false,
      error: `Answer generation failed: ${err.message}`,
    };
  }
}

/**
 * List collections and stats
 */
function listDocuments() {
  const collections = listCollections();

  if (collections.length === 0) {
    return {
      tool: "documentQA",
      success: true,
      final: true,
      data: {
        preformatted: true,
        text: "No document collections found. Use 'load document [file path]' to ingest documents.",
      },
    };
  }

  const lines = ["## Document Collections\n"];
  lines.push("| Collection | Documents | Last Updated |");
  lines.push("|-----------|-----------|-------------|");

  for (const col of collections) {
    const stats = getCollectionStats(col.name);
    lines.push(`| ${col.name} | ${stats?.uniqueDocuments || 0} docs (${stats?.documentCount || 0} chunks) | ${col.lastUpdated ? new Date(col.lastUpdated).toLocaleDateString() : "N/A"} |`);
  }

  return {
    tool: "documentQA",
    success: true,
    final: true,
    data: {
      preformatted: true,
      text: lines.join("\n"),
      collections,
    },
  };
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Document QA tool
 */
export async function documentQA(query) {
  const input = typeof query === "object" ? query.text || query.input || "" : query;
  const intent = detectDocQAIntent(input);

  console.log(`[documentQA] Intent: ${intent}, Query: "${input}"`);

  switch (intent) {
    case "ingest":
      return await ingestDocument(input);
    case "list":
      return listDocuments();
    case "ask":
    default:
      return await answerQuestion(input);
  }
}

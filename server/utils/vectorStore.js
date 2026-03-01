// server/utils/vectorStore.js
// File-based vector store for RAG (Retrieval-Augmented Generation)
// Supports local embeddings via Ollama or basic TF-IDF fallback

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_DIR = path.resolve(__dirname, "..", "data", "vectors");
const INDEX_FILE = path.join(STORE_DIR, "index.json");

// ============================================================
// STORAGE
// ============================================================

function ensureStoreDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return { collections: {}, meta: {} };
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return { collections: {}, meta: {} };
  }
}

function saveIndex(index) {
  ensureStoreDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
}

function loadCollection(name) {
  const file = path.join(STORE_DIR, `${name}.json`);
  try {
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function saveCollection(name, docs) {
  ensureStoreDir();
  const file = path.join(STORE_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(docs), "utf8");
}

// ============================================================
// EMBEDDING
// ============================================================

/**
 * Get embedding from Ollama (nomic-embed-text or similar)
 */
async function getOllamaEmbedding(text) {
  const model = process.env.EMBEDDING_MODEL || "nomic-embed-text";
  const url = `${CONFIG.LLM_API_URL}api/embed`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status}`);
    }

    const data = await res.json();
    // Ollama returns { embeddings: [[...]] } for api/embed
    if (data.embeddings && data.embeddings[0]) {
      return data.embeddings[0];
    }
    // Fallback for older API: { embedding: [...] }
    if (data.embedding) {
      return data.embedding;
    }
    throw new Error("No embedding in response");
  } catch (err) {
    console.warn(`[vectorStore] Ollama embedding failed: ${err.message}, falling back to TF-IDF`);
    return null;
  }
}

/**
 * Simple TF-IDF-like embedding fallback (bag of words with IDF weighting)
 * Returns a sparse representation as a normalized word-frequency vector
 */
function getTfIdfEmbedding(text) {
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);

  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  // Normalize
  const total = words.length || 1;
  const vec = {};
  for (const [w, c] of Object.entries(freq)) {
    vec[w] = c / total;
  }

  return { type: "tfidf", vec };
}

/**
 * Get embedding for text (try Ollama first, fallback to TF-IDF)
 */
async function embed(text) {
  const ollamaVec = await getOllamaEmbedding(text);
  if (ollamaVec) {
    return { type: "dense", vec: ollamaVec };
  }
  return getTfIdfEmbedding(text);
}

// ============================================================
// SIMILARITY
// ============================================================

/**
 * Cosine similarity between two dense vectors
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

/**
 * Similarity between two TF-IDF sparse vectors
 */
function tfidfSimilarity(a, b) {
  if (!a?.vec || !b?.vec) return 0;
  const allWords = new Set([...Object.keys(a.vec), ...Object.keys(b.vec)]);
  let dot = 0, normA = 0, normB = 0;
  for (const w of allWords) {
    const va = a.vec[w] || 0;
    const vb = b.vec[w] || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute similarity between two embeddings (handles both dense and TF-IDF)
 */
function similarity(embA, embB) {
  if (embA.type === "dense" && embB.type === "dense") {
    return cosineSimilarity(embA.vec, embB.vec);
  }
  if (embA.type === "tfidf" && embB.type === "tfidf") {
    return tfidfSimilarity(embA, embB);
  }
  // Mixed types: can't compare meaningfully
  return 0;
}

// ============================================================
// TEXT CHUNKING
// ============================================================

/**
 * Split text into chunks of roughly chunkSize characters with overlap
 */
export function chunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    // Try to break at sentence boundary
    if (end < text.length) {
      const sentenceEnd = text.lastIndexOf(".", end);
      if (sentenceEnd > start + chunkSize * 0.5) {
        end = sentenceEnd + 1;
      }
    }

    chunks.push({
      text: text.slice(start, end).trim(),
      offset: start,
    });

    start = end - overlap;
    if (start < 0) start = 0;
    if (end >= text.length) break;
  }

  return chunks;
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Create or get a collection
 */
export function createCollection(name) {
  const index = loadIndex();
  if (!index.collections[name]) {
    index.collections[name] = {
      created: new Date().toISOString(),
      documentCount: 0,
    };
    saveIndex(index);
    console.log(`[vectorStore] Collection created: "${name}"`);
  }
  return { success: true, collection: name };
}

/**
 * Add a document to a collection (auto-chunks and embeds)
 * @param {string} collection - Collection name
 * @param {string} text - Document text
 * @param {Object} metadata - Optional metadata (filename, source, etc.)
 * @param {number} chunkSize - Characters per chunk
 */
export async function addDocument(collection, text, metadata = {}, chunkSize = 500) {
  createCollection(collection);

  const chunks = chunkText(text, chunkSize);
  const docs = loadCollection(collection);

  const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i].text);
    docs.push({
      id: `${docId}_chunk${i}`,
      docId,
      chunkIndex: i,
      text: chunks[i].text,
      offset: chunks[i].offset,
      embedding,
      metadata: { ...metadata, chunkTotal: chunks.length },
      addedAt: new Date().toISOString(),
    });
  }

  saveCollection(collection, docs);

  // Update index
  const index = loadIndex();
  index.collections[collection].documentCount = docs.length;
  index.collections[collection].lastUpdated = new Date().toISOString();
  saveIndex(index);

  console.log(`[vectorStore] Added document "${metadata.filename || docId}" to "${collection}" (${chunks.length} chunks)`);
  return { success: true, docId, chunks: chunks.length };
}

/**
 * Search for similar chunks in a collection
 * @param {string} collection - Collection name
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Array<{ text, score, metadata }>}
 */
export async function search(collection, query, limit = 5) {
  const docs = loadCollection(collection);
  if (docs.length === 0) {
    return [];
  }

  const queryEmbedding = await embed(query);

  const scored = docs.map(doc => ({
    ...doc,
    score: similarity(queryEmbedding, doc.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(d => ({
    text: d.text,
    score: d.score,
    metadata: d.metadata,
    docId: d.docId,
    chunkIndex: d.chunkIndex,
  }));
}

/**
 * Delete a collection
 */
export function deleteCollection(name) {
  const file = path.join(STORE_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }

  const index = loadIndex();
  delete index.collections[name];
  saveIndex(index);

  return { success: true };
}

/**
 * List all collections
 */
export function listCollections() {
  const index = loadIndex();
  return Object.entries(index.collections).map(([name, info]) => ({
    name,
    ...info,
  }));
}

/**
 * Get collection stats
 */
export function getCollectionStats(name) {
  const docs = loadCollection(name);
  const index = loadIndex();
  const info = index.collections[name];

  if (!info) return null;

  return {
    name,
    documentCount: docs.length,
    uniqueDocuments: new Set(docs.map(d => d.docId)).size,
    ...info,
  };
}

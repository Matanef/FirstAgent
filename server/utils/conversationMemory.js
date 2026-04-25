// server/utils/conversationMemory.js
// Persistent conversation memory — stores summaries of past conversations
// Enables cross-session context: "last time we talked about X"
// Uses existing memory.js infrastructure

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMemory, withMemoryLock, saveJSON, MEMORY_FILE } from "../memory.js";
import { llm } from "../tools/llm.js";
import { addDocument, search as vectorSearch, getCollectionStats } from "./vectorStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Archive file — append-only JSONL, never read at runtime. Safety net for recovery.
const ARCHIVE_FILE = path.resolve(__dirname, "..", "..", "data", "conversation-archive.jsonl");

const MAX_CONVERSATION_SUMMARIES = 50;
const MAX_MESSAGES_BEFORE_SUMMARY = 20;
const SUMMARY_MAX_TOKENS = 200;
const ROLLING_WINDOW_SIZE = 5;

// ============================================================
// ROLLING WINDOW — Fast access to last N turns per conversation
// In-memory cache for quick context access by orchestrator
// ============================================================

const _rollingWindows = new Map(); // conversationId → [{role, content, mode, timestamp}]

/**
 * Get the last N turns for a conversation (from rolling window cache)
 * @param {string} conversationId
 * @param {number} limit - How many turns to return (default 5)
 * @returns {Array} Recent turns [{role, content, mode, timestamp}]
 */
export async function getRecentTurns(conversationId, limit = ROLLING_WINDOW_SIZE) {
  if (!conversationId) return [];

  // Check in-memory cache first
  if (_rollingWindows.has(conversationId)) {
    return _rollingWindows.get(conversationId).slice(-limit);
  }

  // Fallback: load from persistent memory
  try {
    const memory = await getMemory();
    const conversation = memory.conversations?.[conversationId] || [];
    const turns = conversation.slice(-limit).map(m => ({
      role: m.role,
      content: (m.content || "").slice(0, 300),
      mode: m.mode || "task", // default to task for old messages
      timestamp: m.timestamp,
    }));

    _rollingWindows.set(conversationId, turns);
    return turns;
  } catch {
    return [];
  }
}

/**
 * Add a turn to the rolling window
 * @param {string} conversationId
 * @param {Object} turn - {role, content, mode, timestamp, tool?}
 */
export async function addTurn(conversationId, turn) {
  if (!conversationId || !turn) return;

  if (!_rollingWindows.has(conversationId)) {
    _rollingWindows.set(conversationId, []);
  }

  const window = _rollingWindows.get(conversationId);
  window.push({
    role: turn.role,
    content: (turn.content || "").slice(0, 300),
    mode: turn.mode || "task",
    tool: turn.tool || null,
    timestamp: turn.timestamp || new Date().toISOString(),
  });

  // Keep only last N*2 turns (user + assistant pairs)
  if (window.length > ROLLING_WINDOW_SIZE * 2) {
    _rollingWindows.set(conversationId, window.slice(-ROLLING_WINDOW_SIZE * 2));
  }
}

/**
 * Get the current conversation mode (chat/task) based on recent history
 * @param {string} conversationId
 * @returns {string} "chat" or "task"
 */
export function getCurrentMode(conversationId) {
  if (!conversationId || !_rollingWindows.has(conversationId)) return "task";
  const window = _rollingWindows.get(conversationId);
  if (window.length === 0) return "task";
  return window[window.length - 1].mode || "task";
}

/**
 * Summarize a conversation and store it in persistent memory.
 * Called when a conversation reaches a certain length or ends.
 */
export async function summarizeAndStoreConversation(conversationId) {
  const memory = await getMemory();
  const conversation = memory.conversations?.[conversationId] || [];

  if (conversation.length < 4) return null; // Too short to summarize

  // Extract last N messages for summarization
  const messages = conversation.slice(-MAX_MESSAGES_BEFORE_SUMMARY);
  const convoText = messages
    .map(m => `${m.role}: ${m.content?.slice(0, 200) || "(no content)"}`)
    .join("\n");

  // Generate summary with LLM
  const prompt = `Summarize this conversation in 2-3 sentences. Focus on: what the user asked, what was discussed, and any decisions or actions taken. Be concise.

Conversation:
${convoText}

Summary:`;

  let summaryText = "";
  try {
    const result = await llm(prompt);
    summaryText = result?.data?.text || "";
  } catch (err) {
    console.warn("[conversationMemory] Summary generation failed:", err.message);
    // Fallback: extract key topics manually
    const userMessages = messages.filter(m => m.role === "user").map(m => m.content?.slice(0, 50));
    summaryText = `User discussed: ${userMessages.join(", ")}`;
  }

  if (!summaryText) return null;

  // --- NEW: Store in Vector Database ---
  try {
    const topics = extractTopics(messages);
    await addDocument(VEC_COLLECTION, summaryText, {
      conversationId,
      messageCount: conversation.length,
      timestamp: new Date().toISOString(),
      topics: topics.join(", ")
    });
    console.log(`[conversationMemory] Vectorized and stored summary for ${conversationId}`);
  } catch (err) {
    console.warn("[conversationMemory] Failed to vectorize summary:", err.message);
  }

  return summaryText;
}

/**
 * Retrieve relevant past conversation summaries for context.
 */
export async function getRelevantContext(query, limit = 3) {
  if (!query || query.length < 3) return [];

  try {
    // Fetch slightly more hits, then filter by a confidence threshold
    const results = await vectorSearch(VEC_COLLECTION, query, limit * 2);

    // Map vector results to the legacy format the agent expects
    return results
      .filter(r => r.score > 0.25) // Ignore weak semantic matches
      .map(r => ({
        conversationId: r.metadata?.conversationId,
        summary: r.text,
        relevanceScore: r.score,
        timestamp: r.metadata?.timestamp,
        topics: r.metadata?.topics ? r.metadata.topics.split(", ") : []
      }))
      .slice(0, limit);
      
  } catch (err) {
    console.warn("[conversationMemory] Vector RAG search failed:", err.message);
    return [];
  }
}

/**
 * Check if a conversation should be summarized (reached threshold).
 */
export function shouldSummarize(messageCount) {
  return messageCount > 0 && messageCount % MAX_MESSAGES_BEFORE_SUMMARY === 0;
}

/**
 * Extract key topics from messages (simple keyword extraction).
 */
function extractTopics(messages) {
  const topics = new Set();
  const toolNames = new Set();

  for (const m of messages) {
    const text = (m.content || "").toLowerCase();

    // Extract tool references
    if (m.tool) toolNames.add(m.tool);

    // Extract common topic keywords
    const keywords = text.match(/\b(weather|email|sports|finance|stock|news|code|file|search|task|memory|moltbook|calculator)\b/g);
    if (keywords) keywords.forEach(k => topics.add(k));

    // Extract proper nouns (capitalized words)
    const properNouns = (m.content || "").match(/\b[A-Z][a-z]{2,}\b/g);
    if (properNouns) properNouns.slice(0, 3).forEach(n => topics.add(n.toLowerCase()));
  }

  toolNames.forEach(t => topics.add(t));
  return [...topics].slice(0, 10);
}

/**
 * Get total conversation count and last active info.
 */
export async function getConversationStats() {
  const memory = await getMemory();
  const conversations = memory.conversations || {};

  let totalSummarized = 0;
  let lastActive = null;
  
  try {
    const stats = getCollectionStats(VEC_COLLECTION);
    if (stats) {
      totalSummarized = stats.documentCount || 0;
      lastActive = stats.lastUpdated || null;
    }
  } catch (err) {
    // Vector collection might not exist yet
  }

  return {
    totalSummarized,
    activeConversations: Object.keys(conversations).length,
    lastActive,
    recentTopics: [] // Skipped to avoid heavy disk reads on status checks
  };
}

// ============================================================
// CONVERSATION ARCHIVE — Append-only JSONL safety net
// ============================================================

/**
 * Archive a full conversation to the JSONL archive file.
 * This is a safety net — the file is never read at runtime.
 * @param {string} conversationId
 * @param {Array} messages - Full message array
 */
async function archiveConversation(conversationId, messages) {
  try {
    const dir = path.dirname(ARCHIVE_FILE);
    await fs.mkdir(dir, { recursive: true });

    const entry = JSON.stringify({
      id: conversationId,
      archivedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages
    });

    await fs.appendFile(ARCHIVE_FILE, entry + "\n", "utf8");
    return true;
  } catch (err) {
    console.warn("[conversationMemory] Archive write failed:", err.message);
    return false;
  }
}

// ============================================================
// AUTO-PRUNE — Summarize + archive old conversations on startup
// ============================================================

const PRUNE_AGE_DAYS = 30;
const KEEP_RECENT_MESSAGES = 5;

/**
 * Auto-prune conversations older than PRUNE_AGE_DAYS.
 * Call this on server startup (non-blocking).
 */
export async function pruneOldConversations() {
  try {
    const memory = await getMemory();
    const conversations = memory.conversations || {};
    const cutoff = Date.now() - (PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000);
    let pruned = 0;
    let archived = 0;

    for (const [id, messages] of Object.entries(conversations)) {
      if (!Array.isArray(messages) || messages.length < 6) continue;

      const lastMessage = messages[messages.length - 1];
      const lastTimestamp = lastMessage?.timestamp
        ? new Date(lastMessage.timestamp).getTime()
        : 0;

      if (lastTimestamp > cutoff || lastTimestamp === 0) continue;
      if (messages[0]?.role === "__summary__") continue;

      // Step 1: Archive to JSONL
      const archiveOk = await archiveConversation(id, messages);
      if (archiveOk) archived++;

      // Step 2: Summarize (PATCHED)
      let summaryText = "";
      try {
        const convoText = messages
          .slice(0, 30)
          .map(m => `${m.role}: ${(m.content || "").slice(0, 150)}`)
          .join("\n");

        // Force skipLanguageDetection to avoid Gemini overload, and set a timeout
        const result = await llm(
          `Summarize this conversation in 2-3 sentences. Focus on what the user asked and what was accomplished.\n\nConversation:\n${convoText}\n\nSummary:`,
          { skipLanguageDetection: true, timeoutMs: 60000 }
        );
        summaryText = result?.data?.text || "";
        
        // --- NEW: Inject pruned summary into Vector RAG ---
        if (summaryText) {
          try {
             await addDocument(VEC_COLLECTION, summaryText, {
               conversationId: id,
               messageCount: messages.length,
               timestamp: new Date().toISOString(),
               topics: "archived, pruned" // Generic tags for older docs
             });
             console.log(`[conversationMemory] Vectorized pruned summary for ${id}`);
          } catch (vecErr) {
             console.warn(`[conversationMemory] Failed to vectorize pruned summary for ${id}:`, vecErr.message);
          }
        }
        // --------------------------------------------------

      } catch (err) {
        console.warn(`[conversationMemory] Summarization failed for ${id}:`, err.message);
        const userMsgs = messages.filter(m => m.role === "user").map(m => (m.content || "").slice(0, 50));
        summaryText = `User discussed: ${userMsgs.slice(0, 5).join(", ")}`;
      }

      // Step 3: Replace messages
      const recentMessages = messages.slice(-KEEP_RECENT_MESSAGES);
      conversations[id] = [
        {
          role: "__summary__",
          content: summaryText.slice(0, 500),
          timestamp: new Date().toISOString(),
          originalCount: messages.length,
          prunedAt: new Date().toISOString()
        },
        ...recentMessages
      ];
      pruned++;

      // Give the local LLM a 2-second breather before the next conversation
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (pruned > 0) {

        const mem = await getMemory();
        for (const [id, msgs] of Object.entries(conversations)) {
          if (msgs[0]?.role === "__summary__") {
            mem.conversations[id] = msgs;
          }
        }
        await saveJSON(MEMORY_FILE, mem);

      console.log(`🧹 [conversationMemory] Pruned ${pruned} old conversations (${archived} archived to JSONL)`);
    }

    return { pruned, archived };
  } catch (err) {
    console.warn("[conversationMemory] Prune failed:", err.message);
    return { pruned: 0, archived: 0 };
  }
}

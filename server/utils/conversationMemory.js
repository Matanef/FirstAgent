// server/utils/conversationMemory.js
// Persistent conversation memory — stores summaries of past conversations
// Enables cross-session context: "last time we talked about X"
// Uses existing memory.js infrastructure

import { getMemory, withMemoryLock, saveJSON, MEMORY_FILE } from "../memory.js";
import { llm } from "../tools/llm.js";

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

  // Store in memory
  await withMemoryLock(async () => {
    const mem = await getMemory();
    mem.meta = mem.meta || {};
    mem.meta.conversationSummaries = mem.meta.conversationSummaries || [];

    // Add new summary
    mem.meta.conversationSummaries.push({
      conversationId,
      summary: summaryText.slice(0, 500),
      messageCount: conversation.length,
      timestamp: new Date().toISOString(),
      topics: extractTopics(messages)
    });

    // Trim to max
    if (mem.meta.conversationSummaries.length > MAX_CONVERSATION_SUMMARIES) {
      mem.meta.conversationSummaries = mem.meta.conversationSummaries.slice(-MAX_CONVERSATION_SUMMARIES);
    }

    mem.meta.lastUpdated = new Date().toISOString();
    await saveJSON(MEMORY_FILE, mem);
  });

  return summaryText;
}

/**
 * Retrieve relevant past conversation summaries for context.
 */
export async function getRelevantContext(query, limit = 3) {
  const memory = await getMemory();
  const summaries = memory.meta?.conversationSummaries || [];

  if (summaries.length === 0) return [];

  // Simple keyword matching for relevance (vector search would be better but this is MVP)
  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  );

  const scored = summaries.map(s => {
    const summaryWords = s.summary.toLowerCase().split(/\s+/);
    const topicWords = (s.topics || []).map(t => t.toLowerCase());
    let score = 0;

    for (const word of queryWords) {
      if (summaryWords.some(sw => sw.includes(word))) score += 1;
      if (topicWords.some(tw => tw.includes(word))) score += 2;
    }

    return { ...s, relevanceScore: score };
  });

  return scored
    .filter(s => s.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit);
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
  const summaries = memory.meta?.conversationSummaries || [];
  const conversations = memory.conversations || {};

  return {
    totalSummarized: summaries.length,
    activeConversations: Object.keys(conversations).length,
    lastActive: summaries.length > 0 ? summaries[summaries.length - 1].timestamp : null,
    recentTopics: summaries.slice(-5).flatMap(s => s.topics || [])
  };
}

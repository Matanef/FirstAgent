// server/knowledge.js
// Passive knowledge system — facts learned from news, search, and other tools.
// Injected into LLM prompts so the agent has awareness of recent events.

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KNOWLEDGE_FILE = path.resolve(__dirname, "..", "data", "moltbook", "knowledge.json");
const KNOWLEDGE_CAP = 50;
const DEFAULT_EXPIRY_DAYS = 30;

// ──────────────────────────────────────────────────────────
// STORAGE
// ──────────────────────────────────────────────────────────

async function loadKnowledge() {
  try {
    const raw = await fs.readFile(KNOWLEDGE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveKnowledge(facts) {
  const dir = path.dirname(KNOWLEDGE_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(KNOWLEDGE_FILE, JSON.stringify(facts, null, 2), "utf8");
}

// ──────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────

/**
 * Add or reinforce a knowledge fact.
 * If a fact with a similar topic exists, reinforce it (extend expiry, update details).
 * Ongoing events never expire.
 */
export async function addFact({ topic, fact, source, ongoing = false, expiryDays }) {
  const facts = await loadKnowledge();
  const topicLower = (topic || "").toLowerCase();

  // Check for existing fact on same topic
  const existing = facts.find(f =>
    f.topic.toLowerCase() === topicLower ||
    // Fuzzy: if >60% of significant words overlap
    _wordOverlap(f.topic, topic) > 0.6
  );

  const expiry = ongoing ? null : _expiryDate(expiryDays || DEFAULT_EXPIRY_DAYS);

  if (existing) {
    // Reinforce: update fact, extend expiry, bump lastSeen
    existing.fact = fact || existing.fact;
    existing.source = source || existing.source;
    existing.lastSeen = new Date().toISOString().split("T")[0];
    existing.reinforced = (existing.reinforced || 0) + 1;
    if (ongoing) {
      existing.ongoing = true;
      existing.expires = null;
    } else if (existing.expires && !existing.ongoing) {
      // Extend expiry by another period from today
      existing.expires = expiry;
    }
    console.log(`[knowledge] Reinforced: "${existing.topic}" (${existing.reinforced}x)`);
  } else {
    // New fact — evict oldest expired or weakest if at cap
    if (facts.length >= KNOWLEDGE_CAP) {
      _evictOne(facts);
    }
    facts.push({
      id: `fact-${crypto.randomUUID().substring(0, 8)}`,
      topic,
      fact,
      source: source || "unknown",
      learned: new Date().toISOString().split("T")[0],
      lastSeen: new Date().toISOString().split("T")[0],
      expires: expiry,
      ongoing: ongoing || false,
      reinforced: 0,
    });
    console.log(`[knowledge] Learned: "${topic}" (${ongoing ? "ongoing" : `expires ${expiry}`})`);
  }

  await saveKnowledge(facts);
}

/**
 * Remove expired facts. Called before building context.
 */
export async function pruneExpired() {
  const facts = await loadKnowledge();
  const today = new Date().toISOString().split("T")[0];
  const before = facts.length;
  const pruned = facts.filter(f => f.ongoing || !f.expires || f.expires >= today);
  if (pruned.length < before) {
    console.log(`[knowledge] Pruned ${before - pruned.length} expired fact(s)`);
    await saveKnowledge(pruned);
  }
  return pruned;
}

/**
 * Build a compact knowledge context string to inject into LLM prompts.
 */
export async function getKnowledgeContext() {
  const facts = await pruneExpired();
  if (facts.length === 0) return "";

  // Sort by relevance: ongoing first, then by recency
  const sorted = [...facts].sort((a, b) => {
    if (a.ongoing && !b.ongoing) return -1;
    if (!a.ongoing && b.ongoing) return 1;
    return new Date(b.lastSeen) - new Date(a.lastSeen);
  });

  const lines = sorted.slice(0, 20).map(f => {
    const tag = f.ongoing ? "[ONGOING]" : "";
    return `- ${tag} ${f.fact} (source: ${f.source}, ${f.lastSeen})`;
  });

  return `RECENT KNOWLEDGE (facts you've learned from news and search — use these to give informed, up-to-date answers):\n${lines.join("\n")}`;
}

/**
 * Extract facts from news results using a lightweight heuristic.
 * No LLM call — just extracts key info from article summaries.
 */
export async function extractFromNews(articles, topic) {
  if (!articles || articles.length === 0) return;

  // Take top 3 most relevant articles
  const top = articles.slice(0, 3);

  for (const article of top) {
    const title = article.title || "";
    const summary = article.summary || article.description || "";
    if (!title && !summary) continue;

    // Determine if this is an ongoing event
    const ongoingKeywords = /\b(war|conflict|crisis|outbreak|pandemic|siege|invasion|ceasefire|ongoing|escalat|continu|develop)\b/i;
    const ongoing = ongoingKeywords.test(title) || ongoingKeywords.test(summary);

    const factText = summary
      ? `${title}. ${summary.substring(0, 200)}`
      : title;

    await addFact({
      topic: topic || title.substring(0, 60),
      fact: factText.substring(0, 300),
      source: `news${article.source ? `/${article.source}` : ""}`,
      ongoing,
    });
  }
}

/**
 * Extract facts from search results.
 */
export async function extractFromSearch(results, synthesis, query) {
  if (!results || results.length === 0) return;

  // If we have an LLM synthesis, store that as a single comprehensive fact
  if (synthesis && synthesis.length > 20) {
    const ongoingKeywords = /\b(war|conflict|crisis|outbreak|pandemic|siege|invasion|ceasefire|ongoing|escalat|continu|develop)\b/i;
    const ongoing = ongoingKeywords.test(synthesis) || ongoingKeywords.test(query || "");

    await addFact({
      topic: (query || "search result").substring(0, 60),
      fact: synthesis.substring(0, 300),
      source: "search",
      ongoing,
    });
    return;
  }

  // Fallback: store top result
  const top = results[0];
  if (top?.title && top?.snippet) {
    await addFact({
      topic: (query || top.title).substring(0, 60),
      fact: `${top.title}. ${top.snippet}`.substring(0, 300),
      source: `search/${top.source || "web"}`,
    });
  }
}

// ──────────────────────────────────────────────────────────
// INTERNALS
// ──────────────────────────────────────────────────────────

function _expiryDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function _wordOverlap(a, b) {
  const wordsA = new Set((a || "").toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  const wordsB = new Set((b || "").toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

function _evictOne(facts) {
  // First try to evict expired
  const today = new Date().toISOString().split("T")[0];
  const expiredIdx = facts.findIndex(f => !f.ongoing && f.expires && f.expires < today);
  if (expiredIdx >= 0) {
    facts.splice(expiredIdx, 1);
    return;
  }
  // Then evict oldest non-ongoing, least reinforced
  let weakestIdx = -1;
  let weakestScore = Infinity;
  for (let i = 0; i < facts.length; i++) {
    if (facts[i].ongoing) continue;
    const score = (facts[i].reinforced || 0) * 10 + (new Date(facts[i].lastSeen).getTime() / 1e10);
    if (score < weakestScore) {
      weakestScore = score;
      weakestIdx = i;
    }
  }
  if (weakestIdx >= 0) facts.splice(weakestIdx, 1);
}

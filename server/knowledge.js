// server/knowledge.js
// Passive knowledge system — facts learned from news, search, and other tools.
// Injected into LLM prompts so the agent has awareness of recent events.

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Lazy import to avoid circular dependency (knowledge ↔ llm)
let _llm = null;
async function getLLM() {
  if (!_llm) {
    const mod = await import("./tools/llm.js");
    _llm = mod.llm;
  }
  return _llm;
}

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

  let result;
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
    result = { action: "reinforced", topic: existing.topic, count: existing.reinforced };
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
    result = { action: "learned", topic, ongoing };
  }

  await saveKnowledge(facts);
  return result;
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
  if (!articles || articles.length === 0) return [];

  // Reject garbage topics — conversational noise that leaked through
  // Also clean up topic: strip trailing noise like ", get the latest tech news"
  const cleanedTopic = (topic || "")
    .replace(/,?\s*get\s+(?:the\s+)?(?:latest|recent|breaking)?\s*(?:\w+\s+)?(?:news|articles|headlines)\b.*/gi, "")
    .replace(/,?\s*(?:and\s+)?(?:email|send|mail)\b.*/gi, "")
    .replace(/,?\s*(?:summarize|analyze)\b.*/gi, "")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
  const isGarbageTopic = !cleanedTopic || cleanedTopic.length < 3 ||
    /^(lets?|catch|up|on|the|show|me|get|give|summarize|read|search|find|look)\b/i.test(cleanedTopic);

  // Take top 3 most relevant articles
  const top = articles.slice(0, 3);
  const learned = [];

  for (const article of top) {
    const title = article.title || "";
    const summary = article.summary || article.description || "";
    if (!title && !summary) continue;

    // Determine if this is an ongoing event
    const ongoingKeywords = /\b(war|conflict|crisis|outbreak|pandemic|siege|invasion|ceasefire|ongoing|escalat|continu|develop)\b/i;
    const ongoing = ongoingKeywords.test(title) || ongoingKeywords.test(summary);

    // Derive topic from article content, not user's query (avoids "lets catch up on" as topic)
    const articleTopic = isGarbageTopic
      ? title.substring(0, 60).replace(/[:.!?]+$/, "").trim()
      : cleanedTopic;

    const factText = summary
      ? `${title}. ${summary.substring(0, 200)}`
      : title;

    const r = await addFact({
      topic: articleTopic,
      fact: factText.substring(0, 300),
      source: `news${article.source ? `/${article.source}` : ""}`,
      ongoing,
    });
    if (r) learned.push(r);
  }
  return learned;
}

/**
 * Extract facts from search results.
 */
export async function extractFromSearch(results, synthesis, query) {
  if (!results || results.length === 0) return [];

  // If we have an LLM synthesis, store that as a single comprehensive fact
  if (synthesis && synthesis.length > 20) {
    const ongoingKeywords = /\b(war|conflict|crisis|outbreak|pandemic|siege|invasion|ceasefire|ongoing|escalat|continu|develop)\b/i;
    const ongoing = ongoingKeywords.test(synthesis) || ongoingKeywords.test(query || "");

    const r = await addFact({
      topic: (query || "search result").substring(0, 60),
      fact: synthesis.substring(0, 300),
      source: "search",
      ongoing,
    });
    return r ? [r] : [];
  }

  // Fallback: store top result
  const top = results[0];
  if (top?.title && top?.snippet) {
    const r = await addFact({
      topic: (query || top.title).substring(0, 60),
      fact: `${top.title}. ${top.snippet}`.substring(0, 300),
      source: `search/${top.source || "web"}`,
    });
    return r ? [r] : [];
  }
  return [];
}

/**
 * Extract facts from web content (webDownload / webBrowser).
 * For long articles, uses LLM to extract multiple key facts.
 * For short content, falls back to heuristic sentence extraction.
 * Returns array of { action, topic } describing what was learned.
 */
export async function extractFromWebContent(pageTitle, plainText, url) {
  if (!plainText || plainText.length < 50) return [];

  const topic = pageTitle || (url ? new URL(url).pathname.replace(/[_\-\/]/g, " ").trim() : "web article");
  const source = url ? `web/${new URL(url).hostname}` : "web";
  const ongoingKeywords = /\b(war|conflict|crisis|outbreak|pandemic|siege|invasion|ceasefire|ongoing|escalat|continu|develop|massacre|protest|revolt|uprising)\b/i;
  const ongoing = ongoingKeywords.test(topic) || ongoingKeywords.test(plainText.substring(0, 2000));

  // For substantial articles (>500 chars), use LLM to extract multiple facts
  if (plainText.length > 500) {
    try {
      // Trim content to a reasonable size for LLM extraction
      const contentForLLM = plainText.substring(0, 6000);
      const extractPrompt = `Extract 3-5 distinct, important facts from this article. Each fact should be a self-contained statement that someone could understand without reading the article.

Article title: ${topic}
Article content:
${contentForLLM}

Return ONLY valid JSON, no markdown:
{"facts": [{"topic": "short topic label", "fact": "the key fact in 1-2 sentences (max 250 chars)"}]}`;

      const llmFn = await getLLM();
      const result = await llmFn(extractPrompt, { format: "json", skipKnowledge: true, timeoutMs: 30000 });
      if (result.success && result.data?.text) {
        const cleaned = result.data.text.replace(/```json\s*|```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.facts && Array.isArray(parsed.facts) && parsed.facts.length > 0) {
          const learned = [];
          for (const f of parsed.facts.slice(0, 5)) {
            if (!f.topic || !f.fact) continue;
            const r = await addFact({
              topic: f.topic.substring(0, 60),
              fact: f.fact.substring(0, 300),
              source,
              ongoing,
            });
            if (r) learned.push(r);
          }
          console.log(`[knowledge] Extracted ${learned.length} facts from web article: "${topic}"`);
          return learned;
        }
      }
    } catch (e) {
      console.warn(`[knowledge] LLM extraction failed for "${topic}", falling back to heuristic:`, e.message);
    }
  }

  // Fallback: heuristic extraction (first few sentences)
  const sentences = plainText.match(/[A-Z][^.!?]*[.!?]/g);
  let factText = "";
  if (sentences && sentences.length > 0) {
    for (const s of sentences) {
      if (factText.length + s.length > 300) break;
      factText += (factText ? " " : "") + s.trim();
    }
  }
  if (!factText) {
    factText = plainText.substring(0, 300).trim();
  }

  const r = await addFact({
    topic: topic.substring(0, 60),
    fact: factText.substring(0, 300),
    source,
    ongoing,
  });
  return r ? [r] : [];
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

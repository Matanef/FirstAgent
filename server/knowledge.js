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
export async function addFact({ topic, fact, source, ongoing = false, permanent = false, expiryDays }) {
  // Guard: reject garbage topics that are too short, pure stopwords, or conversational noise
  const STOPWORDS = new Set(["what", "is", "are", "was", "were", "the", "a", "an", "this", "that",
    "how", "who", "when", "where", "why", "did", "does", "do", "some", "over", "about",
    "lets", "let", "catch", "up", "on", "get", "show", "me", "search", "find", "look",
    "check", "tell", "give", "read", "result", "results"]);
  const topicWords = (topic || "").toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  const substantiveWords = topicWords.filter(w => !STOPWORDS.has(w));
  if (!topic || topic.trim().length < 3 || substantiveWords.length === 0) {
    console.log(`[knowledge] Rejected garbage topic: "${topic}"`);
    return null;
  }

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
    if (permanent) {
      existing.permanent = true;
      existing.ongoing = true;
      existing.expires = null;
    } else if (ongoing) {
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
      expires: permanent ? null : expiry,
      ongoing: ongoing || permanent || false,
      permanent: permanent || false,
      reinforced: 0,
    });
    console.log(`[knowledge] Learned: "${topic}" (${permanent ? "PERMANENT" : ongoing ? "ongoing" : `expires ${expiry}`})`);
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
  const pruned = facts.filter(f => f.permanent || f.ongoing || !f.expires || f.expires >= today);
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

  // Separate permanent facts from regular ones
  const permanent = sorted.filter(f => f.permanent);
  const regular = sorted.filter(f => !f.permanent);

  const formatFact = (f) => {
    const tags = [];
    if (f.permanent) tags.push("[PERMANENT FACT]");
    else if (f.ongoing) tags.push("[ONGOING]");
    return `- ${tags.join(" ")} ${f.fact} (source: ${f.source}, ${f.lastSeen})`;
  };

  const lines = [...permanent, ...regular].slice(0, 25).map(formatFact);

  return `RECENT KNOWLEDGE (facts you've learned from news, search, and web articles — this is YOUR knowledge, use it confidently when answering questions, forming opinions, and discussing current events):
${lines.join("\n")}
IMPORTANT: When a user asks about any topic covered above, reference this knowledge directly. Do NOT say "I don't know" about topics listed here.`;
}

/**
 * Find knowledge facts relevant to a specific user question.
 * Returns a focused, high-priority context string to inject near the user message.
 * This prevents small LLMs from ignoring knowledge in favor of stale training data.
 */
export async function getRelevantKnowledge(userMessage) {
  if (!userMessage || userMessage.length < 5) return "";
  const facts = await loadKnowledge();
  if (facts.length === 0) return "";

  const msgLower = userMessage.toLowerCase().replace(/[?.!,;:'"]/g, "");
  // Filter out stopwords so "current prime minister" doesn't match everything
  // Use length >= 2 to keep important short tokens like "UK", "US", "AI"
  const msgWords = new Set(msgLower.split(/\s+/).filter(w => w.length >= 2 && !TOPIC_STOPWORDS.has(w)));

  // Score each fact by relevance to the user message
  const scored = facts.map(f => {
    let score = 0;
    const topicLower = (f.topic || "").toLowerCase();
    const factLower = (f.fact || "").toLowerCase();

    // Check if substantive message words appear in topic or fact
    for (const word of msgWords) {
      if (topicLower.includes(word)) score += 3;
      if (factLower.includes(word)) score += 1;
    }

    // Bonus for substantive topic words appearing in the message
    const topicWords = topicLower.split(/\s+/).filter(w => w.length >= 2 && !TOPIC_STOPWORDS.has(w));
    for (const tw of topicWords) {
      if (msgLower.includes(tw)) score += 2;
    }

    return { fact: f, score };
  })
  .filter(s => s.score >= 4) // Minimum relevance threshold
  .sort((a, b) => b.score - a.score)
  .slice(0, 3);

  if (scored.length === 0) return "";

  const lines = scored.map(s => `• ${s.fact.fact}`);
  return `⚠️ KNOWLEDGE OVERRIDE — YOUR LEARNED FACTS ABOUT THIS TOPIC:
${lines.join("\n")}
YOU MUST USE THESE FACTS IN YOUR ANSWER. These are more recent than your training data. Do NOT contradict them with older information.`;
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
 * Derives topic from actual content, not the raw user query, to avoid
 * garbage topics like "what is" polluting the knowledge store.
 */
export async function extractFromSearch(results, synthesis, query) {
  if (!results || results.length === 0) return [];

  // Clean the query: strip question words, search commands, and conversational noise
  const cleanedQuery = (query || "")
    .replace(/^(search\s+for\s+)?(what|who|when|where|why|how|tell\s+me|explain|describe)\s+(is|are|was|were|did|does|do|about|happened\s+in?)?\s*/gi, "")
    .replace(/^(the\s+)?(current|latest|recent)\s+/gi, "")
    .replace(/[?.!]+$/g, "")
    .trim();

  // Determine a good topic: prefer cleaned query if substantive, else use top result title
  const topTitle = results[0]?.title || "";
  const isGarbageQuery = !cleanedQuery || cleanedQuery.length < 4 ||
    /^(the|a|an|some|this|that|it|there)\b$/i.test(cleanedQuery);
  const topic = isGarbageQuery
    ? topTitle.substring(0, 60).replace(/[:.!?]+$/, "").trim()
    : cleanedQuery.substring(0, 60);

  if (!topic || topic.length < 3) return [];

  const ongoingKeywords = /\b(war|conflict|crisis|outbreak|pandemic|siege|invasion|ceasefire|ongoing|escalat|continu|develop|massacre|protest|revolt|uprising)\b/i;

  // If we have an LLM synthesis, store that as a single comprehensive fact
  // But SKIP non-answers — these are failed searches that would pollute knowledge
  if (synthesis && synthesis.length > 20) {
    const isNonAnswer = /\b(not\s+directly\s+mentioned|couldn'?t\s+find|no\s+reliable|not\s+provided|not\s+available|unable\s+to\s+find|no\s+(?:specific|relevant)\s+(?:information|details|results))\b/i.test(synthesis);
    if (isNonAnswer) {
      console.log(`[knowledge] Skipping non-answer synthesis for topic "${topic}"`);
      return [];
    }

    const ongoing = ongoingKeywords.test(synthesis) || ongoingKeywords.test(query || "");

    const r = await addFact({
      topic,
      fact: synthesis.substring(0, 300),
      source: "search",
      ongoing,
    });
    return r ? [r] : [];
  }

  // Fallback: store top result
  const top = results[0];
  if (top?.title && top?.snippet) {
    const ongoing = ongoingKeywords.test(top.title) || ongoingKeywords.test(top.snippet);
    const r = await addFact({
      topic,
      fact: `${top.title}. ${top.snippet}`.substring(0, 300),
      source: `search/${top.source || "web"}`,
      ongoing,
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
export async function extractFromWebContent(pageTitle, plainText, url, { permanent: forcePermament = false } = {}) {
  if (!plainText || plainText.length < 50) return [];

  const topic = pageTitle || (url ? new URL(url).pathname.replace(/[_\-\/]/g, " ").trim() : "web article");
  const source = url ? `web/${new URL(url).hostname}` : "web";
  const ongoingKeywords = /\b(war|conflict|crisis|outbreak|pandemic|siege|invasion|ceasefire|ongoing|escalat|continu|develop|massacre|protest|revolt|uprising)\b/i;
  const ongoing = ongoingKeywords.test(topic) || ongoingKeywords.test(plainText.substring(0, 2000));
  // User-requested reads are permanent — they explicitly asked to learn this
  const permanent = forcePermament || false;

  // For substantial articles (>500 chars), use LLM to extract multiple facts
  if (plainText.length > 500) {
    try {
      // Trim content to a reasonable size for LLM extraction
      const contentForLLM = plainText.substring(0, 6000);
      const extractPrompt = `Extract 3-5 distinct, important facts from this article. Prioritize in this order:
1. CURRENT STATE: Who/what currently holds a position, the latest numbers, the current status (e.g., "The current president is X since Y")
2. RECENT EVENTS: What happened recently, any changes, updates, or breaking developments
3. KEY FACTS: Important permanent facts that help understand the topic

Each fact should be a self-contained statement that someone could understand without reading the article. Include specific names, dates, and numbers — never generic descriptions.

BAD example: {"topic": "Term Length", "fact": "The president serves a four-year term"} — this is generic trivia.
GOOD example: {"topic": "Current US President", "fact": "Donald Trump is the 47th president, inaugurated on January 20, 2025"} — this is specific and current.

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
              permanent,
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
    permanent,
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

// Stopwords to exclude from topic overlap matching — these are common in queries
// but carry no topical meaning ("current prime minister" matches everything)
const TOPIC_STOPWORDS = new Set([
  // Short function words (needed since we allow length >= 2)
  "is", "am", "an", "at", "be", "by", "do", "go", "he", "if", "in", "it", "me", "my",
  "no", "of", "on", "or", "so", "to", "up", "us", "we",
  // Common 3+ char stopwords
  "the", "and", "for", "are", "was", "were", "not", "but", "has", "had", "will", "can", "may",
  "current", "latest", "recent", "today", "new", "last", "first", "next",
  "prime", "minister", "president", "leader", "head", "chief", "king", "queen",
  "what", "who", "when", "where", "which", "how", "does", "that", "this", "with",
  "about", "from", "into", "have", "been", "being", "their", "there", "they",
  "some", "more", "most", "also", "just", "very", "much", "many", "such",
  "search", "find", "look", "show", "tell", "give", "know",
]);

function _wordOverlap(a, b) {
  const wordsA = new Set((a || "").toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !TOPIC_STOPWORDS.has(w)));
  const wordsB = new Set((b || "").toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !TOPIC_STOPWORDS.has(w)));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  // Guard: if either set has only 1 word after filtering, a single shared word
  // (e.g., "israel") would give 100% overlap between unrelated topics.
  // Require at least 2 substantive words in both sets for fuzzy matching.
  if (wordsA.size < 2 || wordsB.size < 2) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

function _evictOne(facts) {
  // First try to evict expired
  const today = new Date().toISOString().split("T")[0];
  const expiredIdx = facts.findIndex(f => !f.ongoing && !f.permanent && f.expires && f.expires < today);
  if (expiredIdx >= 0) {
    facts.splice(expiredIdx, 1);
    return;
  }
  // Then evict oldest non-ongoing, non-permanent, least reinforced
  let weakestIdx = -1;
  let weakestScore = Infinity;
  for (let i = 0; i < facts.length; i++) {
    if (facts[i].ongoing || facts[i].permanent) continue;
    const score = (facts[i].reinforced || 0) * 10 + (new Date(facts[i].lastSeen).getTime() / 1e10);
    if (score < weakestScore) {
      weakestScore = score;
      weakestIdx = i;
    }
  }
  if (weakestIdx >= 0) facts.splice(weakestIdx, 1);
}

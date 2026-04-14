// server/skills/deepResearch/keywordExtractor.js
// Tokenize → drop stopwords → bigrams → optional LLM noun-phrase extraction.
// Returns: { tokens, bigrams, phrases, language }
//
// Pure module (LLM call is optional and gracefully skipped on timeout/parse failure).

import { llm } from "../../tools/llm.js";

// Minimal stopword lists. Hardcoded to avoid pulling in `natural` (banned).
const STOPWORDS_EN = new Set([
  "a","an","the","and","or","but","if","then","else","when","while","of","at","by","for","with","about","against",
  "between","into","through","during","before","after","above","below","to","from","up","down","in","out","on","off",
  "over","under","again","further","once","here","there","why","how","all","any","both","each","few","more","most",
  "other","some","such","no","nor","not","only","own","same","so","than","too","very","s","t","can","will","just",
  "don","should","now","is","am","are","was","were","be","been","being","have","has","had","having","do","does",
  "did","doing","this","that","these","those","i","me","my","myself","we","our","ours","ourselves","you","your",
  "yours","yourself","yourselves","he","him","his","himself","she","her","hers","herself","it","its","itself","they",
  "them","their","theirs","themselves","what","which","who","whom","whose","as","because","until","also"
]);

const STOPWORDS_HE = new Set([
  "של","על","עם","אל","את","אם","כי","גם","לא","הוא","היא","אני","אתה","אתם","אנחנו","אבל","או","כן",
  "זה","זאת","זו","יש","אין","היה","היתה","היו","להיות","היום","אמר","ואמר","היכן","איפה","איך","כמה","כל",
  "מה","מי","מתי","למה","מאוד","רק","עוד","כבר","שוב","פה","שם","ככה","כך","כמו","אצל","ב","ל","ה","ו","ש",
  "מ","ה","אך","ועוד","תוך","בין","כדי","יותר","פחות","רבים","רבות"
]);

const HEBREW_RE = /[\u0590-\u05FF]/;
const ARABIC_RE = /[\u0600-\u06FF]/;

function detectLanguage(text) {
  if (!text) return "en";
  if (HEBREW_RE.test(text)) return "he";
  if (ARABIC_RE.test(text)) return "ar";
  return "en";
}

function tokenize(text) {
  if (!text) return [];
  // Keep Hebrew, Latin letters, digits. Drop punctuation. Lowercase Latin.
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.split(" ") : [];
}

function dropStopwords(tokens, lang) {
  const stop = lang === "he" ? STOPWORDS_HE : STOPWORDS_EN;
  return tokens.filter(t => t.length >= 2 && !stop.has(t));
}

function buildBigrams(tokens) {
  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

/**
 * Optional LLM call to extract 3–6 noun phrases from the topic.
 * Falls back to top-N bigrams on parse failure or timeout.
 */
async function extractPhrasesViaLLM(text, fallbackBigrams) {
  const prompt = `Extract 3–6 distinct noun phrases that capture the core subject of this research request. Return JSON only.

Request: """${text}"""

Output schema:
{ "phrases": ["string", ...] }

Rules:
- Each phrase: 1–4 words, no leading/trailing articles ("the", "a").
- Preserve the original language of the request (do not translate).
- No duplicates. No punctuation.

JSON:`;
  try {
    const res = await llm(prompt, {
      timeoutMs: 15000,
      format: "json",
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.2, num_ctx: 2048 }
    });
    const txt = res?.data?.text || res?.text || "";
    const parsed = safeJsonParse(txt);
    if (parsed && Array.isArray(parsed.phrases)) {
      const cleaned = parsed.phrases
        .filter(p => typeof p === "string")
        .map(p => p.trim())
        .filter(p => p.length > 0 && p.length < 80);
      if (cleaned.length > 0) return cleaned.slice(0, 6);
    }
  } catch {
    // fall through to bigram fallback
  }
  return fallbackBigrams.slice(0, 4);
}

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  // Best-effort brace extraction
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Main entry. Returns extracted keyword bundle.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.usePhraseLLM=true]  set false to skip the LLM noun-phrase pass (faster)
 * @returns {Promise<{tokens:string[], bigrams:string[], phrases:string[], language:string}>}
 */
export async function extract(text, opts = {}) {
  const usePhraseLLM = opts.usePhraseLLM !== false;
  const language = detectLanguage(text);
  const allTokens = tokenize(text);
  const tokens = dropStopwords(allTokens, language);
  const bigrams = buildBigrams(tokens);

  let phrases = bigrams.slice(0, 4);
  if (usePhraseLLM && tokens.length >= 2) {
    phrases = await extractPhrasesViaLLM(text, bigrams);
  }

  return { tokens, bigrams, phrases, language };
}

// Exposed for tests
export const _internals = { tokenize, dropStopwords, buildBigrams, detectLanguage, safeJsonParse };

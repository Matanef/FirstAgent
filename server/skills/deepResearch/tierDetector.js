// server/skills/deepResearch/tierDetector.js
// Robust depth detection: English + Hebrew + intent.
// Returns one of: "article" | "indepth" | "research" | "thesis" | null
//
// Detection priority:
//   1. context.resolvedPending.depth (orchestrator pending-question resume)
//   2. Inline `[depth:tier]` flag (UI depth bar inserts this)
//   3. `--depth=tier` CLI-style flag
//   4. Lexicon match (English + Hebrew) with unicode-aware word boundaries
//   5. null → caller emits a pending question

const VALID = new Set(["article", "indepth", "research", "thesis"]);

const LEXICON = {
  thesis: {
    en: ["thesis", "dissertation", "comprehensive study", "comprehensive analysis"],
    he: ["תזה", "עבודת גמר", "דוקטורט"]
  },
  research: {
    en: ["deep research", "research paper", "research", "study", "literature review"],
    he: ["מחקר", "עבודת מחקר", "סקר ספרות"]
  },
  indepth: {
    en: ["in-depth", "in depth", "indepth", "deep dive", "deepdive", "detailed", "guide"],
    he: ["מדריך", "מעמיק", "מפורט"]
  },
  article: {
    en: ["article", "summary", "brief", "overview"],
    he: ["מאמר", "סקירה", "תקציר"]
  }
};

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Build per-tier regexes once.
const TIER_REGEXES = Object.fromEntries(
  Object.entries(LEXICON).map(([tier, langs]) => {
    const enWords = langs.en.map(escapeRegex).join("|");
    const heWords = langs.he.map(escapeRegex).join("|");
    return [tier, {
      // English: standard \b boundaries work for ASCII
      en: new RegExp(`\\b(?:${enWords})\\b`, "i"),
      // Hebrew: \b doesn't match across non-ASCII; use whitespace/punctuation boundaries
      he: new RegExp(`(?:^|[\\s\\p{P}])(?:${heWords})(?:[\\s\\p{P}]|$)`, "iu")
    }];
  })
);

const INLINE_FLAG_RE = /\[depth:(article|indepth|in-depth|research|thesis)\]/i;
const CLI_FLAG_RE   = /--depth=(article|indepth|in-depth|research|thesis)\b/i;

function normalizeTier(raw) {
  if (!raw) return null;
  const t = String(raw).toLowerCase().trim().replace(/-/g, "");
  if (VALID.has(t)) return t;
  return null;
}

/**
 * Detect the desired tier for a research request.
 *
 * @param {string} text
 * @param {object} [context]   { resolvedPending?: { depth?: string } }
 * @returns {"article"|"indepth"|"research"|"thesis"|null}
 */
export function detect(text, context = {}) {
  // 1. Resumed pending answer wins
  const fromPending = normalizeTier(context?.resolvedPending?.depth);
  if (fromPending) return fromPending;

  if (!text || typeof text !== "string") return null;

  // 2. Inline UI flag
  const inline = text.match(INLINE_FLAG_RE);
  if (inline) return normalizeTier(inline[1]);

  // 3. CLI-style flag
  const cli = text.match(CLI_FLAG_RE);
  if (cli) return normalizeTier(cli[1]);

  // 4. Lexicon match — check thesis first (most specific), then research, indepth, article
  for (const tier of ["thesis", "research", "indepth", "article"]) {
    const { en, he } = TIER_REGEXES[tier];
    if (en.test(text) || he.test(text)) return tier;
  }

  // 5. No signal — caller should fire a pending question
  return null;
}

/**
 * Strip the inline `[depth:...]` flag from a message so downstream NLP isn't polluted.
 */
export function stripDepthFlag(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(INLINE_FLAG_RE, "").replace(CLI_FLAG_RE, "").replace(/\s{2,}/g, " ").trim();
}

export const TIERS = ["article", "indepth", "research", "thesis"];

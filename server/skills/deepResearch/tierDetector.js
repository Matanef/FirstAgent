// server/skills/deepResearch/tierDetector.js
// Robust depth detection: English + Hebrew + intent.
// Returns one of: "article" | "indepth" | "research" | "thesis" | "thesis-deep" | null
//
// Detection priority:
//   1. context.resolvedPending.depth (orchestrator pending-question resume)
//   2. Inline `[depth:tier]` flag (UI depth bar inserts this)
//   3. `--depth=tier` CLI-style flag
//   4. Lexicon match (English + Hebrew) with unicode-aware word boundaries
//   5. null → caller emits a pending question

// Phase 20N — "thesis-deep" super-tier: same as thesis, plus one
// supplementary harvest pass driven by the top 4-5 open questions surfaced
// across the prompt-level conclusions. Adds ~6-8 minutes for substantially
// better Future Directions content.
const VALID = new Set(["article", "indepth", "research", "thesis", "thesis-deep"]);

const LEXICON = {
  "thesis-deep": {
    en: ["thesis-deep", "thesis deep", "deep thesis", "thesis+", "ultra thesis"],
    he: ["תזה מורחבת", "תזה עמוקה"]
  },
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

const INLINE_FLAG_RE = /\[depth:(article|indepth|in-depth|research|thesis-deep|thesis)\]/i;
const CLI_FLAG_RE   = /--depth=(article|indepth|in-depth|research|thesis-deep|thesis)\b/i;
// Phase 15A — client-injected `[MODEL:xxx]` UI directive (App.jsx:182). Routes
// imageGen between local/cloud engines. imageGen consumes it before stripping
// (server/skills/imageGen/imageGen.js:16-23), but when the message routes to
// any other skill the prefix bleeds into topic content and pollutes keyword
// extraction. Stripping it here makes the cleanup global for all skills that
// call stripDepthFlag (currently: deepResearch's parseTopic).
const MODEL_DIRECTIVE_RE = /\[MODEL:[A-Za-z0-9_\-]+\]/gi;

function normalizeTier(raw) {
  if (!raw) return null;
  let t = String(raw).toLowerCase().trim();
  // Phase 20N — preserve the hyphen in "thesis-deep" so it doesn't collapse
  // to "thesisdeep" → unknown tier. We only strip "in-depth" → "indepth".
  if (t === "thesis-deep" || t === "thesis deep" || t === "thesisdeep") return "thesis-deep";
  t = t.replace(/-/g, "");
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

  // 4. Lexicon match — check thesis-deep first (most specific), then thesis, research, indepth, article
  for (const tier of ["thesis-deep", "thesis", "research", "indepth", "article"]) {
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
  return text
    .replace(INLINE_FLAG_RE, "")
    .replace(CLI_FLAG_RE, "")
    .replace(MODEL_DIRECTIVE_RE, "")  // Phase 15A
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const TIERS = ["article", "indepth", "research", "thesis", "thesis-deep"];

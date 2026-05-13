// server/skills/deepResearch/claimVerifier.js
// Phase 23C — numeric-claim verifier.
//
// Scans the final synthesised thesis prose for specific numeric claims
// (percentages, sample sizes, p-values, odds ratios, effect sizes, dose
// in minutes) and verifies each against the per-source fact pool that
// articleAnalyzer.js has already populated. Unverifiable claims are
// either annotated with ` [unverified]` (default) or stripped to the
// sentence level (CLAIM_VERIFY_MODE=strict).
//
// Why this matters: qwen2.5:7b synthesizes paragraphs with very specific
// numbers ("63% risk reduction", "44.55 minutes", "odds ratio of 3.5")
// that look authoritative but often have no source backing — pure LLM
// hallucinations dressed up as findings. The fact pool already has all
// the analyzer-extracted numbers from each article; we just need to
// cross-reference.
//
// Matching strategy: ±5% tolerance (or ±0.5 absolute, whichever is
// larger), fuzzy match against any number in any fact's content + the
// article content slice. False-positive rate is acceptable because the
// alternative (no check) is worse — the user sees fewer made-up stats.

const CLAIM_PATTERNS = [
  { re: /(\d+(?:\.\d+)?)\s*%/g,                                kind: "percent" },
  { re: /\bN\s*=\s*(\d+)/g,                                    kind: "N" },
  { re: /\b(\d+(?:,\d{3})*)\s+participants?\b/gi,              kind: "participants" },
  { re: /\bp\s*[<=≤]\s*0?\.(\d+)/g,                            kind: "pvalue" },
  { re: /\bodds\s+ratio\s+(?:of\s+)?(\d+(?:\.\d+)?)/gi,        kind: "OR" },
  { re: /\bd\s*=\s*(\d+\.\d+)/g,                               kind: "effect-size" },
  { re: /\b(\d+(?:\.\d+)?)\s+minutes?/gi,                      kind: "minutes" },
];

/**
 * Extract numeric claims from synthesised prose.
 * Returns [{ raw, value, kind, start, end }, ...] in document order.
 */
export function extractClaims(text) {
  if (!text) return [];
  const claims = [];
  for (const { re, kind } of CLAIM_PATTERNS) {
    const r = new RegExp(re.source, re.flags);
    let m;
    while ((m = r.exec(text)) !== null) {
      const raw = m[0];
      // Strip thousands separator for numeric parsing
      const value = parseFloat(String(m[1] || "").replace(/,/g, ""));
      if (!Number.isFinite(value)) continue;
      claims.push({ raw, value, kind, start: m.index, end: m.index + raw.length });
    }
  }
  return claims;
}

/**
 * Verify a single claim against a fact pool.
 *
 * @param {object} claim   one entry from extractClaims()
 * @param {Array}  factPool [{ source, content, text }, ...]
 * @returns {{ verified: boolean, evidence: object|null }}
 */
export function verifyClaim(claim, factPool) {
  if (!claim || !Number.isFinite(claim.value)) return { verified: false, evidence: null };
  if (!Array.isArray(factPool) || factPool.length === 0) return { verified: false, evidence: null };
  const tolerance = Math.max(0.5, Math.abs(claim.value) * 0.05);
  for (const fact of factPool) {
    const haystack = String(fact?.content || fact?.text || "");
    if (haystack.length === 0) continue;
    const numbersInFact = haystack.match(/-?\d+(?:\.\d+)?/g) || [];
    for (const n of numbersInFact) {
      const parsed = parseFloat(n);
      if (!Number.isFinite(parsed)) continue;
      if (Math.abs(parsed - claim.value) <= tolerance) {
        return { verified: true, evidence: { source: fact?.source || "?", hint: n } };
      }
    }
  }
  return { verified: false, evidence: null };
}

/**
 * Walk the text, verify each claim, and either annotate or strip the
 * unverified ones depending on `mode`.
 *
 * @param {string} text         synthesised draft
 * @param {Array} factPool      [{ source, content/text }, ...]
 * @param {object} opts
 * @param {"annotate"|"strict"} opts.mode    annotate (default) or sentence-strip
 * @returns {{ text, totalClaims, unverifiedCount, mode }}
 */
export function verifyAndAnnotate(text, factPool, { mode = "annotate" } = {}) {
  if (!text) return { text: "", totalClaims: 0, unverifiedCount: 0, mode };
  const claims = extractClaims(text);
  if (claims.length === 0) return { text, totalClaims: 0, unverifiedCount: 0, mode };
  // Determine which need editing, in original-order
  const flagged = [];
  for (const c of claims) {
    const { verified } = verifyClaim(c, factPool);
    if (!verified) flagged.push(c);
  }
  if (flagged.length === 0) return { text, totalClaims: claims.length, unverifiedCount: 0, mode };
  // Apply edits in reverse (end → start) so earlier offsets stay valid
  let out = text;
  for (const claim of [...flagged].sort((a, b) => b.start - a.start)) {
    if (mode === "strict") {
      // Strip the whole sentence containing the claim. Sentence boundaries
      // are conservative: previous `.`/`!`/`?` (or start-of-text) → next
      // `.`/`!`/`?` (or end-of-text), exclusive of leading whitespace.
      const sentStart = (() => {
        const slice = out.slice(0, claim.start);
        const lastTerm = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
        return lastTerm === -1 ? 0 : lastTerm + 1;
      })();
      const tail = out.slice(claim.end);
      const nextTermRel = (() => {
        const dot = tail.indexOf(".");
        const bang = tail.indexOf("!");
        const q = tail.indexOf("?");
        const candidates = [dot, bang, q].filter(i => i >= 0);
        return candidates.length ? Math.min(...candidates) : -1;
      })();
      const sentEnd = nextTermRel === -1 ? out.length : claim.end + nextTermRel + 1;
      // Preserve a leading space if there was one
      const leading = out.slice(sentStart).match(/^\s*/)?.[0] || "";
      out = out.slice(0, sentStart) + leading + out.slice(sentEnd).trimStart();
    } else {
      // Annotate (default): insert " [unverified]" right after the claim
      out = out.slice(0, claim.end) + " [unverified]" + out.slice(claim.end);
    }
  }
  return { text: out, totalClaims: claims.length, unverifiedCount: flagged.length, mode };
}

export const _internals = { CLAIM_PATTERNS };

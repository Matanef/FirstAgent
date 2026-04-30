// server/skills/deepResearch/citations.js
// Structured-citation utilities for the deepResearch synthesizer.
//
// Three jobs:
//   1. formatAPAEntry(cite)       → "Smith, J., & Jones, A. (2023). *Title*. Journal, 12(3), 45-67. https://doi.org/x"
//   2. shortAPA(cite)             → "(Smith & Jones, 2023)" or "(Smith et al., 2023)"
//   3. buildCitationIndex(notes)  → unified [{ id, inText, apa, ... }] list, ordered alphabetically
//   4. lintStrayCitations(text, index) → flags fake refs ([5], "Source 1", invented authors)
//
// Citation shape (input):
//   {
//     authors: ["Smith, J.", "Jones, A.B."],   // last-name, first-initial(s) — ordered
//     year: 2023,
//     title: "Cognitive behavioral therapy for PTSD: a meta-analysis",
//     venue: "Journal of CBT",
//     volume: 12, issue: 3, pages: "45-67",
//     doi: "10.1234/x.y",
//     url: "https://..."   // fallback if no DOI
//   }

/**
 * Convert a name like "John Smith" or "Smith, John" or "J. Smith" to
 * canonical APA form: "Smith, J." (last name + initials, comma-separated).
 */
// Phase 8E — reject authors whose surname is malformed metadata leakage.
// OpenAlex sometimes returns garbage like "V., A. P." or "L., (. T." when the
// upstream source is broken. These produce broken APA references; better to
// drop the author entirely than print "V., .. A. P." in the bibliography.
function isMalformedAuthor(s) {
  if (!s) return true;
  const t = s.trim();
  if (t.length < 2) return true;
  // Contains parentheses (never valid in a name)
  if (/[()]/.test(t)) return true;
  // Surname (before first comma) is just initials-with-dots or a single letter
  const surname = t.split(",")[0].trim();
  if (surname.length < 2) return true;                                   // "V"
  if (/^[A-Z]\.?$/.test(surname)) return true;                           // "V."
  if (/^[A-Z]\.\s*$/.test(surname)) return true;                         // "V. "
  // Surname starts with a non-letter (e.g. "..A. P.")
  if (!/^[\p{L}]/u.test(surname)) return true;
  // Has obvious metadata-leak markers like ".." or ", ((..."
  if (/\.\./.test(t) || /,\s*\(/.test(t)) return true;
  return false;
}

export function canonicalizeAuthor(name) {
  if (!name || typeof name !== "string") return null;
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  // Phase 8E — reject malformed metadata up-front.
  if (isMalformedAuthor(cleaned)) return null;

  // Already in "Last, F." form? Pass through.
  if (/^[\p{L}'\-]+,\s*[\p{L}.\s'\-]+$/u.test(cleaned)) {
    return cleaned;
  }

  // "First Middle Last" → split, take last as surname, initialize the rest.
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]; // single name — pass through

  const surname = parts[parts.length - 1];
  // Phase 8E — surname itself must look like a real surname (≥2 letters, starts with letter)
  if (surname.length < 2 || !/^[\p{L}]/u.test(surname)) return null;
  const initials = parts.slice(0, -1)
    .map(p => p.charAt(0).toUpperCase() + ".")
    .join(" ");
  return `${surname}, ${initials}`;
}

/**
 * Take the surname out of a canonical "Last, F." author string.
 */
function surnameOf(authorStr) {
  if (!authorStr) return "";
  const comma = authorStr.indexOf(",");
  return comma > 0 ? authorStr.slice(0, comma).trim() : authorStr.trim();
}

/**
 * In-text citation: "(Smith, 2023)" / "(Smith & Jones, 2023)" / "(Smith et al., 2023)".
 * APA 7th rule: 3+ authors → first author + "et al." even on first citation.
 */
export function shortAPA(cite) {
  if (!cite) return "";
  const authors = (cite.authors || []).map(canonicalizeAuthor).filter(Boolean);
  const year = cite.year || "n.d.";
  if (authors.length === 0) return `(${year})`;
  const surnames = authors.map(surnameOf);
  if (surnames.length === 1) return `(${surnames[0]}, ${year})`;
  if (surnames.length === 2) return `(${surnames[0]} & ${surnames[1]}, ${year})`;
  return `(${surnames[0]} et al., ${year})`;
}

/**
 * Full APA 7th-edition reference list entry.
 *
 *   Author, A. A., Author, B. B., & Author, C. C. (Year). Title of article.
 *     Journal Name, vol(issue), pages. https://doi.org/...
 *
 * Title is rendered in *italics* for journal articles by APA convention
 * for the JOURNAL name; the article title itself stays roman. Books reverse
 * this. We emit journal articles by default (most common case).
 */
// Phase 10C — repositories that are NOT journals. When `cite.venue` is one of
// these, render WITHOUT italic-venue formatting (the repository goes in the
// URL line instead). This stops the LLM from emitting "(openalex)" as if it
// were a parenthetical citation.
const REPO_VENUES = new Set([
  "openalex", "figshare", "dryad", "dryad digital repository",
  "harvard dataverse", "dataverse",
  "open science framework", "osf", "osf preprints",
  "zenodo", "data.gov", "datagov",
  "icpsr", "humanitarian data exchange", "hdx",
  "world bank open data", "world bank", "oecd statistics", "oecd",
  "fred", "fred — st. louis fed",
  "who global health observatory", "who", "whogho",
  "academagic"
]);
function isRepositoryVenue(v) {
  return REPO_VENUES.has(String(v || "").trim().toLowerCase());
}

export function formatAPAEntry(cite) {
  if (!cite) return "";
  const authors = (cite.authors || []).map(canonicalizeAuthor).filter(Boolean);
  const year = cite.year ? `(${cite.year})` : "(n.d.)";
  const title = (cite.title || "").trim().replace(/\.$/, "");
  // Phase 10C — drop venue when it's just a repository name. Datasets cited
  // as "*OpenAlex*" got the LLM writing "(openalex)" parentheticals downstream.
  const rawVenue = (cite.venue || "").trim();
  const venue = isRepositoryVenue(rawVenue) ? "" : rawVenue;
  const vol = cite.volume ? String(cite.volume) : "";
  const issue = cite.issue ? `(${cite.issue})` : "";
  const pages = (cite.pages || "").trim();
  const doi = (cite.doi || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").trim();
  const url = doi ? `https://doi.org/${doi}` : (cite.url || "");

  // Authors string. APA 7: up to 20 authors before ellipsis.
  let authorsStr;
  if (authors.length === 0) authorsStr = "";
  else if (authors.length === 1) authorsStr = authors[0];
  else if (authors.length === 2) authorsStr = `${authors[0]}, & ${authors[1]}`;
  else if (authors.length <= 20) authorsStr = `${authors.slice(0, -1).join(", ")}, & ${authors[authors.length - 1]}`;
  else authorsStr = `${authors.slice(0, 19).join(", ")}, ... ${authors[authors.length - 1]}`;

  // Build the parts: "Authors. (Year). Title. *Venue*, vol(issue), pages. URL"
  const parts = [];
  if (authorsStr) {
    // Avoid double period when canonical form already ends in "."
    parts.push(authorsStr.replace(/\.+$/, "") + ".");
  }
  parts.push(`${year}.`);
  if (title) parts.push(`${title}.`);
  if (venue) {
    let venuePart = `*${venue}*`;
    if (vol) venuePart += `, ${vol}${issue}`;
    if (pages) venuePart += (vol ? `, ${pages}` : `, ${pages}`);
    parts.push(venuePart + ".");
  }
  if (url) parts.push(url);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Decode common HTML entities + strip provider branding suffixes that may have
 * leaked through from a fetcher (e.g. Academagic's "&#8211; אקדמג'יק" branding,
 * or `&amp;`/`&#039;` from any HTML scrape). Defensive — applied to every cite
 * entry so the bibliography always renders clean.
 */
function cleanCiteString(s) {
  if (!s || typeof s !== "string") return s;
  let out = s;
  const ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ",
    "&hellip;": "…", "&mdash;": "—", "&ndash;": "–", "&lsquo;": "‘", "&rsquo;": "’",
    "&ldquo;": "“", "&rdquo;": "”", "&laquo;": "«", "&raquo;": "»"
  };
  for (const [ent, repl] of Object.entries(ENTITIES)) out = out.split(ent).join(repl);
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
    const code = parseInt(n, 16);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
  // Strip Academagic's Hebrew branding suffix "אקדמג'יק" (with either apostrophe ' or geresh ׳)
  out = out.replace(/\s*[-–|—]\s*אקדמג['׳]?יק\s*$/u, "");
  // Strip "— Academagic" (English) suffix as well
  out = out.replace(/\s*[-–|—]\s*Academagic\b.*$/i, "");
  return out.replace(/\s+/g, " ").trim();
}

function cleanCite(cite) {
  if (!cite) return cite;
  return {
    ...cite,
    title: cleanCiteString(cite.title),
    venue: cleanCiteString(cite.venue),
    authors: Array.isArray(cite.authors) ? cite.authors.map(cleanCiteString).filter(Boolean) : cite.authors
  };
}

/**
 * Build the citation index from the list of harvested article frontmatters.
 * Input: notes (each may have a `cite` field)
 * Output: unified [{ id, inText, apa, surnameKey, year }] sorted by surname/year.
 */
export function buildCitationIndex(notes) {
  const seen = new Set();
  const entries = [];
  for (const note of notes || []) {
    const rawCite = note?.cite;
    if (!rawCite || !rawCite.authors || rawCite.authors.length === 0 || !rawCite.title) continue;
    const cite = cleanCite(rawCite); // strip HTML entities + provider branding
    // Dedup by DOI or by surname+year+title-prefix
    const dedupKey = (cite.doi || "").toLowerCase() ||
      `${(cite.authors[0] || "").toLowerCase()}_${cite.year || ""}_${(cite.title || "").slice(0, 40).toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const authorsCanon = cite.authors.map(canonicalizeAuthor).filter(Boolean);
    // Phase 8E — drop the entry entirely if all authors got rejected as
    // malformed metadata. Better no entry than a broken "V., .. A. P." entry.
    if (authorsCanon.length === 0) {
      console.log(`[citations] dropped entry — no valid authors after sanitization (raw="${(cite.authors || []).slice(0, 2).join(" / ")}", title="${String(cite.title).slice(0, 60)}")`);
      continue;
    }
    const firstSurname = surnameOf(authorsCanon[0]);
    entries.push({
      id: `cite_${entries.length + 1}`,
      cite: { ...cite, authors: authorsCanon },
      inText: shortAPA({ ...cite, authors: authorsCanon }),
      apa: formatAPAEntry({ ...cite, authors: authorsCanon }),
      surnameKey: firstSurname.toLowerCase(),
      year: cite.year || 0
    });
  }
  // Alphabetical by first-author surname, then by year. APA 7 ordering.
  entries.sort((a, b) => {
    if (a.surnameKey !== b.surnameKey) return a.surnameKey.localeCompare(b.surnameKey);
    return (a.year || 0) - (b.year || 0);
  });
  // Re-number ids after sort so numeric refs (if used) match sort order.
  entries.forEach((e, i) => { e.id = `cite_${i + 1}`; });
  return entries;
}

/**
 * Render the References section as a plain markdown numbered list.
 */
export function renderReferencesSection(index) {
  if (!index || index.length === 0) return "";
  const lines = ["## References", ""];
  index.forEach((entry, i) => {
    lines.push(`${i + 1}. ${entry.apa}`);
  });
  return lines.join("\n") + "\n";
}

/**
 * Render the citations index as a compact bulleted list for injection into LLM prompts.
 * The LLM uses this to ground inline citations.
 */
export function renderCitationsForPrompt(index, max = 30) {
  if (!index || index.length === 0) return "(no structured citations available)";
  return index.slice(0, max).map(e => `- ${e.inText} — "${(e.cite.title || "").slice(0, 100)}"`).join("\n");
}

/**
 * Lint a draft for stray invented citation patterns. Returns:
 *   { issues: [{ pattern, match, lineNumber }], cleanText: string }
 *
 * Stray patterns we detect:
 *   - Numeric refs: [5], [12]              (we use APA, never numeric)
 *   - "Source N" / "source N"              (LLM placeholder)
 *   - "Source 1." / "Reference 1"          (similar)
 *   - "(Author, Year)" / "(author, year)"  (literal placeholder)
 *   - Inline "(X et al., YYYY)" not in index — likely invented author
 *
 * `cleanText` has the obvious strays removed (numeric refs become bare claims,
 * "Source N" is dropped). Invented author refs are flagged but not auto-fixed
 * — those need an LLM rewrite pass.
 */
export function lintStrayCitations(text, index) {
  if (!text) return { issues: [], cleanText: "" };
  const issues = [];
  const knownInText = new Set((index || []).map(e => e.inText.toLowerCase()));

  let clean = text;

  // 1. Numeric refs → strip
  clean = clean.replace(/\[(\d+)\](?!\()/g, (m) => {
    issues.push({ pattern: "numeric-ref", match: m });
    return "";
  });

  // 2. "Source N" / "Reference N" → strip
  clean = clean.replace(/\b(Source|Reference)\s+(\d+)\b/gi, (m) => {
    issues.push({ pattern: "source-placeholder", match: m });
    return "";
  });

  // 3. "(Author, Year)" literal placeholder
  clean = clean.replace(/\((Author|author),\s*(Year|year)\)/g, (m) => {
    issues.push({ pattern: "author-year-placeholder", match: m });
    return "";
  });

  // 3b. "[insert X]" / "[topic]" / "[YOUR TOPIC]" / "[X HERE]" template placeholders.
  //     The LLM occasionally leaves these unfilled when the prompt template
  //     has bracketed placeholders. Detect bracketed words that look like
  //     directive placeholders rather than citations or wikilinks.
  clean = clean.replace(/\[(insert|enter|add|fill[\s\-]?in|your|placeholder|topic|category|name)\b[^\]]{0,40}\]/gi, (m) => {
    issues.push({ pattern: "template-placeholder", match: m });
    return "";
  });
  // "[X HERE]" / "[X TBD]" / "[X TO BE FILLED]"
  clean = clean.replace(/\[[\w\s]{1,30}(here|tbd|to\s+be\s+filled|to\s+be\s+added|to\s+do)\]/gi, (m) => {
    issues.push({ pattern: "template-placeholder", match: m });
    return "";
  });

  // 4. Invented author refs — match (X, YYYY) or (X et al., YYYY) and check against index
  const inTextRe = /\(([A-Z][\p{L}'-]+(?:\s+(?:&|and)\s+[A-Z][\p{L}'-]+)?(?:\s+et al\.?)?),?\s*(\d{4})\)/gu;
  clean = clean.replace(inTextRe, (m) => {
    const normalized = m.toLowerCase().replace(/\s+et al\.?,/, " et al.,");
    if (knownInText.has(normalized) || knownInText.has(m.toLowerCase())) {
      return m; // recognized
    }
    // Not in index — likely invented. Flag, drop the parenthetical.
    issues.push({ pattern: "invented-author-ref", match: m });
    return "";
  });

  // Tidy up resulting double spaces / leading punctuation.
  //
  // CRITICAL: use `[ \t]` (horizontal whitespace) NOT `\s` (which matches \n too).
  // The previous `\s{2,}` was collapsing every \n\n paragraph break into a single
  // space — destroying the entire markdown structure (61 ¶ breaks → 2). That's
  // the root cause of the persistent "wall of text" rendering bug.
  clean = clean
    .replace(/[ \t]+,/g, ",")           // " ," → ","
    .replace(/[ \t]+\./g, ".")          // " ." → "."
    .replace(/[ \t]{2,}/g, " ")         // collapse spaces ONLY (preserves newlines)
    .replace(/\([ \t]*\)/g, "")         // empty () → drop
    .replace(/[ \t]+([.,;:])/g, "$1")   // " ;" → ";"
    .replace(/ +\n/g, "\n")             // trailing space before newline → drop
    .replace(/\n{4,}/g, "\n\n\n");      // cap excessive blank-line runs

  return { issues, cleanText: clean };
}

/** Parse a Crossref-style year from various input formats. */
export function parseYear(input) {
  if (!input) return null;
  if (typeof input === "number") return input >= 1700 && input <= 2100 ? input : null;
  const m = String(input).match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 1700 && y <= 2100 ? y : null;
}

// Exposed for tests
export const _internals = { canonicalizeAuthor, surnameOf };

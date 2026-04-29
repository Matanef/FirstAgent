#!/usr/bin/env node
// Quick verification of the prompt-leak lint patterns from thesisSynthesizer.js
// Tests against the actual leaked text the user reported.

const sample = `Cognitive Behavioral Therapy is widely used.

To reach the floor length requirement, you must expand on these points by quoting specific numbers/effect sizes/sample sizes.

**Retrieved source material:**

[]
Recent studies indicate that CBT is effective.

**Adding more specific examples/numbers from cited sources:**

- For insomnia, optimal dose is 250 minutes.

**Probing implications:**

- Scalability matters.

Rewritten Passage:
"Authors have critiqued..."

DO NOT pad with filler. You MUST write at least 412 words.

**Technical Bullet Points:**
1. Discrepancies among studies
2. Lack of long-term follow-up

**Obsidian Wikilinks:**
1. [[Gravitational Lensing]]
2. [[Unified Protocol]]`;

const PROMPT_LEAK_PATTERNS = [
  /^[\s>]*To reach the floor length requirement,[^\n]+\n+/gim,
  /^[\s>]*To reach the (?:required )?length(?: of at least \d+ words)?,[^\n]+\n+/gim,
  /^[\s>]*\*\*(?:Adding more specific examples\/numbers from cited sources|Probing implications|Expanding analysis depth|Comparisons between different types|Retrieved source material)[^*\n]*\*\*\s*:?\s*\n+/gim,
  /^[\s>]*\[\]\s*$/gm,
  /^[\s>]*"?(?:Rewritten Passage|Original Passage|Output Section|Section to rewrite)"?\s*:?\s*\n+/gim,
  /\n+[ \t]*\*{1,2}(?:Technical Bullet Points?|Obsidian Wikilinks?|Wikilinks?|Bullet Points?)[\s\S]{0,5}?\n[\s\S]*?(?=\n[ \t]*##[ \t])/gi,
  /\n+[ \t]*\*{1,2}(?:Technical Bullet Points?|Obsidian Wikilinks?|Wikilinks?|Bullet Points?)[\s\S]{0,5}?\n[\s\S]*$/gi,
  /\bDO NOT (?:pad with filler|copy any example terms|use Obsidian callout)[^.\n]*\.?/g,
  /\bYou MUST (?:write|wrap|include|expand)[^.\n]*\.?/g,
];

let out = sample;
let n = 0;
for (const re of PROMPT_LEAK_PATTERNS) {
  out = out.replace(re, () => { n++; return ""; });
}
out = out.replace(/\n{3,}/g, "\n\n").trim();

console.log("=== AFTER LINT ===");
console.log(out);
console.log("\n=== STATS ===");
console.log("prompt leaks stripped:", n);

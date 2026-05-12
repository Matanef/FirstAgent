#!/usr/bin/env node
// Phase 18 smoke test — synthesizer quality fixes + orphan-ngrok cleanup
// + bridge UX. Pure-helper assertions; no live LLM or Ollama needed.

import { readFileSync } from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== Phase 18 Smoke (synth quality, orphan ngrok, bridge UX) ===\n");

// ── 18A: SYNTH_HEAVY_MODEL guidance updated ──────────────────────────────
console.log("Test 18A: thesisSynthesizer SYNTH_HEAVY_MODEL guidance");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("default falls back to SYNTH_MODEL (qwen2.5:7b) when env unset",
    /SYNTH_HEAVY_MODEL\s*=\s*process\.env\.SYNTH_HEAVY_MODEL\s*\|\|\s*SYNTH_MODEL/.test(src));
  check("comment warns against deepseek-r1 / qwq for section composition",
    /AVOID reasoning models/i.test(src) && /deepseek-r1/.test(src));
}

// ── 18B: content-loss preservation guards ────────────────────────────────
console.log("\nTest 18B: content preservation guards");
{
  const src = readFileSync(new URL("../skills/deepResearch/thesisSynthesizer.js", import.meta.url), "utf8");
  check("adjustSectionLength widens window to 1.8 (was 1.5)",
    /ratio\s*>=\s*0\.6\s*&&\s*ratio\s*<=\s*1\.8/.test(src));
  check("adjustSectionLength removes the .slice(0, 6000) char cap",
    !/text\.slice\(0,\s*6000\)/.test(src));
  check("adjustSectionLength rejects trim that drops below floor",
    /rewrite dropped to.*floor.*keeping original/.test(src));
  check("adjustSectionLength rejects expand that shrinks content",
    /rewrite shrank from.*to.*keeping original/.test(src));
  check("enforceMethodologySubheadings rejects rewrite that loses >25%",
    /rewrite shrank from.*lost >25%.*keeping original/.test(src));
}

// ── 18C: MyST fence stripping ────────────────────────────────────────────
console.log("\nTest 18C: stripMarkdownFences handles MyST + unmatched openers");
{
  // Inline replica of stripMarkdownFences's MyST + unmatched-fence branch.
  function stripFences(text) {
    let out = String(text);
    // Strip MyST/Jupyter-Book directive blocks
    out = out.replace(
      /^[\s>]*```\{(?:figure|bibliography|math|admonition|note|warning|tip|important|caution|toctree|csv-table|list-table|tabbed|panels|grid)\}[^\n]*\n[\s\S]*?(?:^[\s>]*```\s*$|(?=^##\s)|(?=^---\s*$)|$)/gm,
      ""
    );
    // Strip orphan ``` lines
    out = out.replace(/^[\s>]*```\s*$/gm, "");
    out = out.replace(/^[\s>]*```\s+(?=\S)/gm, "");
    // Unmatched-opener safety net
    const fenceCount = (out.match(/^```/gm) || []).length;
    if (fenceCount % 2 === 1) {
      const lines = out.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^```/.test(lines[i])) { lines.splice(i, 1); break; }
      }
      out = lines.join("\n");
    }
    out = out.replace(/\n{3,}/g, "\n\n");
    return out;
  }

  const mystFigure = "## Discussion\n\n```{figure} charts/foo.svg\n\n---\n\n### **1. Subhead**\nbody body body\n\n## Conclusion\nMore text.";
  const stripped1 = stripFences(mystFigure);
  check("MyST {figure} block removed",
    !/```\{figure\}/.test(stripped1));
  check("Conclusion content preserved after MyST strip",
    /## Conclusion/.test(stripped1) && /More text\./.test(stripped1));

  const mystBib = "Body text.\n\n```{bibliography} references.bib This bibliography covers...\n\n## Conclusion\nFinal words.";
  const stripped2 = stripFences(mystBib);
  check("MyST {bibliography} block removed",
    !/```\{bibliography\}/.test(stripped2));
  check("Body before MyST preserved",
    /Body text\./.test(stripped2));

  const unmatched = "## Discussion\n\n```\nsome text without close\n\nmore text";
  const stripped3 = stripFences(unmatched);
  check("unmatched ``` opener stripped (odd fence count balanced)",
    ((stripped3.match(/^```/gm) || []).length % 2) === 0);

  // Sanity: code-body prose survives even though the orphan-fence pass
  // strips the bare ``` close (which is the existing pre-Phase-18 behavior).
  // What we care about is the content not being swallowed.
  const goodCode = "Inline:\n\n```js\nconst x = 1;\n```\n\nMore prose.";
  const stripped4 = stripFences(goodCode);
  check("code-block body text preserved (`const x = 1`)",
    /const x = 1/.test(stripped4));
  check("prose after code block preserved",
    /More prose\./.test(stripped4));
}

// ── 18D: numbered list blank-line splitting ──────────────────────────────
console.log("\nTest 18D: numbered list blank-line repair");
{
  function fixList(out) {
    out = out.replace(/^(\d+)\.\s*\n\s*\n(\*\*)/gm, (_, n, b) => `${n}. ${b}`);
    out = out.replace(/^(\d+)\.\s*\n\s*\n([A-Z][a-z])/gm, (_, n, w) => `${n}. ${w}`);
    return out;
  }
  const broken = "1.\n\n**Eating Disorders:** content here\n\n2.\n\n**Trauma:** more content";
  const fixed = fixList(broken);
  check("`1.\\n\\n**Bold:**` becomes `1. **Bold:**`",
    /^1\. \*\*Eating Disorders:\*\*/m.test(fixed));
  check("second item also joined",
    /^2\. \*\*Trauma:\*\*/m.test(fixed));

  const capWord = "3.\n\nAnxiety Disorders here";
  const fixedCap = fixList(capWord);
  check("`3.\\n\\nAnxiety` becomes `3. Anxiety`",
    /^3\. Anxiety Disorders/m.test(fixedCap));

  // Don't mangle correctly-formatted lists
  const good = "1. Item one\n2. Item two";
  check("correctly-formatted list unchanged",
    fixList(good) === good);
}

// ── 18E: Roman numeral H3 series normalization ──────────────────────────
console.log("\nTest 18E: normalizeRomanH3Series");
{
  function normalizeRomanH3Series(text) {
    if (!text) return text;
    const lines = String(text).split("\n");
    const h3Indices = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^###\s+\S/.test(lines[i])) h3Indices.push(i);
    }
    if (h3Indices.length < 2) return text;
    const ROMAN_RE = /^###\s+(I{2,3}|IV|VI{0,3}|IX|X)\.\s+/;
    const hasIIPlus = h3Indices.some(i => ROMAN_RE.test(lines[i]));
    if (!hasIIPlus) return text;
    const hasI = h3Indices.some(i => /^###\s+I\.\s+/.test(lines[i]));
    if (hasI) return text;
    const firstRomanIdx = h3Indices.find(i => ROMAN_RE.test(lines[i]));
    let prependTarget = -1;
    for (const i of h3Indices) {
      if (i >= firstRomanIdx) break;
      if (/^###\s+(\d+\.|[IVX]+\.)/.test(lines[i])) continue;
      prependTarget = i;
      break;
    }
    if (prependTarget === -1) return text;
    lines[prependTarget] = lines[prependTarget].replace(/^###\s+/, "### I. ");
    return lines.join("\n");
  }

  const missingI = "### Overall Efficacy\n### II. Key Areas\n### III. Limitations\n### IV. Future";
  const fixed = normalizeRomanH3Series(missingI);
  check("first non-Roman H3 gets `I.` prepended",
    /^### I\. Overall Efficacy$/m.test(fixed));
  check("subsequent II./III./IV. unchanged",
    /^### II\. Key Areas$/m.test(fixed) && /^### III\. Limitations$/m.test(fixed));

  const alreadyFine = "### I. First\n### II. Second";
  check("already-correct series unchanged",
    normalizeRomanH3Series(alreadyFine) === alreadyFine);

  const noRomans = "### Plain\n### Another\n### Third";
  check("non-Roman series untouched",
    normalizeRomanH3Series(noRomans) === noRomans);

  const onlyOneH3 = "### Solo heading\nbody";
  check("single H3 untouched",
    normalizeRomanH3Series(onlyOneH3) === onlyOneH3);
}

// ── 18F: looksTruncated detects partial-year + unclosed-paren ──────────
console.log("\nTest 18F: extended truncation detection");
{
  function looksTruncated(text) {
    if (!text || text.length < 80) return false;
    const tail = String(text).replace(/[\s>]+$/, "").slice(-160);
    if (!tail) return false;
    if (/[.!?)\]"'»’”]$/.test(tail)) return false;
    if (/\]\]$/.test(tail)) return false;
    if (/\*$|_$/.test(tail)) return false;
    if (/[a-z,]$/.test(tail)) return true;
    if (/\b(and|or|the|a|an|in|of|with|that|to|from|by|for|as|on|at|is|are|was|were|but|while|when|which|where|but|though)$/i.test(tail)) return true;
    if (/\(\s*[NnPpKk]?\s*=?\s*\d*$/.test(tail)) return true;
    if (/&$|\+$|-$/.test(tail)) return true;
    if (/,\s*\d{1,3}$/.test(tail)) return true;
    if (/\b\d{1,3}$/.test(tail) && !/\d{4}$/.test(tail)) return true;
    const opens = (tail.match(/\(/g) || []).length;
    const closes = (tail.match(/\)/g) || []).length;
    if (opens > closes) return true;
    return false;
  }

  // The CBT Abstract truncation
  const abstract = "Long abstract content that exceeds 80 characters easily because it has substantive prose. (Cognitive-Behavioral Treatment for Depression in Adolescents, 20";
  check("partial citation year `, 20` detected as truncated",
    looksTruncated(abstract) === true);

  // Unclosed paren
  const openParen = "Long body of text exceeding 80 characters with technical detail. The treatment was effective (per the recent meta-analysis";
  check("unclosed paren at end-of-tail detected",
    looksTruncated(openParen) === true);

  // Healthy ending should NOT trip
  const healthy = "This is a complete sentence that ends with proper punctuation and is plenty long enough to clear the 80-char threshold.";
  check("healthy ending NOT flagged as truncated",
    looksTruncated(healthy) === false);

  // Year alone (full 4-digit) is fine
  const fullYear = "Long body of text that exceeds the eighty character minimum so the function actually evaluates content. Published in 2024.";
  check("complete sentence ending with full year is fine",
    looksTruncated(fullYear) === false);
}

// ── 18G: orphan ngrok cleanup at boot ────────────────────────────────────
console.log("\nTest 18G: orphan ngrok startup self-check");
{
  const src = readFileSync(new URL("../tools/webhookTunnel.js", import.meta.url), "utf8");
  check("webhookTunnel.js defines killOrphanNgrokAtBoot()",
    /function killOrphanNgrokAtBoot\s*\(/.test(src));
  check("orphan check runs at module load (not lazily)",
    /killOrphanNgrokAtBoot\(\);\s*\n/.test(src));
  check("orphan check uses tasklist on Windows",
    /tasklist[^\n]*ngrok\.exe/i.test(src));
  check("orphan check uses taskkill /F /T to kill the tree",
    /taskkill\s+\/F\s+\/T\s+\/PID/.test(src));
  check("orphan check has POSIX fallback (pkill)",
    /pkill[^\n]*ngrok/.test(src));
}

// ── 18H: bridge offer failure categorization ────────────────────────────
console.log("\nTest 18H: bridge offer failure categorization");
{
  // Inline replica of categorizeFetchError
  function categorize(rawError, usedLibgen) {
    if (!rawError && usedLibgen) return { label: "libgen ad-page (real PDF needed)", hint: "free-PDF mirror returned a tracker page" };
    if (!rawError) return { label: "thin content", hint: "fetched but content too short to use" };
    const e = String(rawError).toLowerCase();
    if (/status code 403|http 403|forbidden/.test(e)) return { label: "HTTP 403 paywall", hint: "publisher login likely required" };
    if (/status code 401/.test(e)) return { label: "HTTP 401 auth required", hint: "credentialed access needed" };
    if (/status code 404|http 404|not found/.test(e)) return { label: "HTTP 404 not found", hint: "URL has moved or been removed" };
    if (/status code 429/.test(e)) return { label: "HTTP 429 rate-limited", hint: "try again later from a different IP" };
    if (/maximum number of redirects/.test(e)) return { label: "redirect loop", hint: "publisher anti-scraping; open in browser instead" };
    if (/timeout|econnaborted|etimedout/.test(e)) return { label: "timeout", hint: "host unresponsive; try a mirror or alternative URL" };
    if (/econnreset|enotfound|econnrefused/.test(e)) return { label: "network unreachable", hint: "host down or DNS failure" };
    if (/status code 5\d\d|http 5\d\d/.test(e)) return { label: "server error", hint: "publisher-side issue; retry later" };
    return { label: rawError.slice(0, 60), hint: "" };
  }

  check("403 → paywall label",
    /paywall/i.test(categorize("Request failed with status code 403", false).label));
  check("404 → not found label",
    /not found/i.test(categorize("Request failed with status code 404", false).label));
  check("redirect loop detected",
    /redirect loop/i.test(categorize("Maximum number of redirects exceeded", false).label));
  check("timeout detected",
    /timeout/i.test(categorize("timeout of 18000ms exceeded", false).label));
  check("libgen ad-page label when no error but flagged libgen",
    /libgen/i.test(categorize(null, true).label));
  check("429 rate-limited detected",
    /rate-limited/i.test(categorize("Request failed with status code 429", false).label));

  // Verify wiring in collectBlockedSources / renderBridgeMessage
  const bridgeSrc = readFileSync(new URL("../skills/deepResearch/manualBridge.js", import.meta.url), "utf8");
  check("collectBlockedSources surfaces fetchError on blocked records",
    /fetchError:\s*a\.article\?\._fetch_error/.test(bridgeSrc));
  check("collectBlockedSources surfaces usedLibgen flag",
    /usedLibgen:\s*a\.article\?\._used_libgen_fallback\s*===\s*true/.test(bridgeSrc));
  check("renderBridgeMessage prints `Why blocked: <category>`",
    /Why blocked: \$\{cat\.label\}/.test(bridgeSrc));

  // Verify harvester records _fetch_error
  const harvSrc = readFileSync(new URL("../skills/deepResearch/articleHarvester.js", import.meta.url), "utf8");
  check("articleHarvester exports getLastFetchError()",
    /export function getLastFetchError\s*\(/.test(harvSrc));
  check("articleHarvester sets _fetch_error after _fetch_failed",
    /item\._fetch_error\s*=\s*getLastFetchError\(\)/.test(harvSrc));
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

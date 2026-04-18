// server/skills/deepResearch/index.js
// Top-level orchestrator for the refactored deepResearch skill.
//
// Pipeline (matches the approved plan):
//   1. parse(text) → { rawTopic, explicitDepth }
//   2. tier = tierDetector.detect(text, context); if null → setPendingQuestion + return
//   3. extracted = keywordExtractor.extract(rawTopic)
//   4. matches = subjectMatcher.rank(...); if 0 → subjectBootstrapper.bootstrap() + re-rank ONCE
//   5. prompts = promptPlanner.build(...)
//   6. for each prompt: harvest → analyze → conclusionWriter.write
//   7. promptRollup.rewritePrompt() per prompt → promptRollup.writeMaster()
//   8. (vector collections built inside conclusionWriter / thesisSynthesizer)
//   9. thesisSynthesizer.synthesize() — outline → section-by-section → bibliography → lint
//  10. return short chat reply

import path from "path";
import { llm } from "../../tools/llm.js";
import { getVaultPath, writeNote, buildFrontmatter, createFolder, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";
import { loadAgentConstraints } from "../../utils/writingRules.js";
import { setPendingQuestion } from "../../utils/pendingQuestion.js";

import * as tierDetector from "./tierDetector.js";
import * as keywordExtractor from "./keywordExtractor.js";
import * as sourceDirectory from "./sourceDirectory.js";
import * as subjectMatcher from "./subjectMatcher.js";
import * as subjectBootstrapper from "./subjectBootstrapper.js";
import * as promptPlanner from "./promptPlanner.js";
import * as articleHarvester from "./articleHarvester.js";
import * as articleAnalyzer from "./articleAnalyzer.js";
import * as conclusionWriter from "./conclusionWriter.js";
import * as promptRollup from "./promptRollup.js";
import * as thesisSynthesizer from "./thesisSynthesizer.js";
import { seedIfNeeded } from "./academicJournalSeeder.js";
import { createLogger } from "../../utils/logger.js";

const TOOL_NAME = "deepResearch";
const log = createLogger("deepResearch");

// ── One-time academic journal RSS seed (runs asynchronously, non-blocking) ──
// Adds 38 FT50 journal feeds to research-sources.json on first startup.
// Subsequent calls are no-ops (flag stored in _meta.academicJournalsSeeded).
seedIfNeeded().catch(err => log(`Academic seed error (non-blocking): ${err.message}`, "warn"));

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ── Source dedup helpers (Phase 1B) ─────────────────────────────────────────
/** Token-set Jaccard similarity on normalized title strings. */
function jaccardSim(normA, normB) {
  if (!normA || !normB) return 0;
  const sa = new Set(normA.split(" ")), sb = new Set(normB.split(" "));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Collapse analyses whose normalized titles have Jaccard > 0.85.
 * When two analyses are near-duplicates, keep the one with higher relevance score.
 */
function dedupAnalysesByTitle(analyses) {
  const kept = [];
  for (const cand of analyses) {
    const normTitle = articleHarvester.normalizeTitleForDedup(cand.frontmatter?.title || "");
    let dupIdx = -1;
    for (let k = 0; k < kept.length; k++) {
      const kt = articleHarvester.normalizeTitleForDedup(kept[k].frontmatter?.title || "");
      if (jaccardSim(normTitle, kt) > 0.85) { dupIdx = k; break; }
    }
    if (dupIdx === -1) {
      kept.push(cand);
    } else {
      // Replace with the higher-relevance one
      const candRel = cand.analysis?.relevance ?? 0;
      const keptRel = kept[dupIdx].analysis?.relevance ?? 0;
      if (candRel > keptRel) kept[dupIdx] = cand;
    }
  }
  return kept;
}

function titleCaseFallback(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map(w => w.length >= 2 ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : w)
    .join(" ");
}

/**
 * Derive a clean academic title and a sane slug from the raw research topic.
 * Single short LLM call + deterministic fallbacks. slugify() re-applied to the
 * LLM output so pathological responses can't produce unsafe paths.
 */
async function deriveTitleAndSlug(rawTopic, tier) {
  const prompt = `You are naming a ${tier}-level academic research write-up.

Raw topic from the user: """${rawTopic}"""

Produce:
- title: a clean, readable academic title (<= 80 characters). Correct obvious typos (e.g. "mater" -> "matter"). Preserve the original language. No trailing punctuation.
- slug: a url-safe lowercase-kebab-case slug (<= 50 characters). Letters and digits only, separated by single dashes. Strip articles ("the","a","an","and"). No trailing dashes.

Return JSON only:
{ "title": "string", "slug": "string" }`;

  let parsed = null;
  try {
    const res = await llm(prompt, {
      timeoutMs: 15000,
      format: "json",
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.2, num_ctx: 1024 }
    });
    parsed = safeJsonParse(res?.data?.text || "");
  } catch (err) {
    log(`deriveTitleAndSlug LLM call failed: ${err.message}`, "warn");
  }

  let title = String(parsed?.title || "").trim();
  let slug  = String(parsed?.slug  || "").trim();

  if (!title || title.length > 120) title = titleCaseFallback(rawTopic).slice(0, 80);
  if (!slug) slug = sourceDirectory.slugify(rawTopic);
  // Always run the LLM slug through our canonical slugify() so the 50-char hash
  // rule and the Hebrew-preserving character class are enforced.
  slug = sourceDirectory.slugify(slug);

  return { title, slug };
}

/**
 * Strip noise tokens to recover the bare research topic.
 */
function parseTopic(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  let topic = tierDetector.stripDepthFlag(rawText);
  topic = topic
    // strip framing verbs / nouns
    .replace(/\b(deep\s+)?research\b/gi, "")
    .replace(/\b(write\s+(me\s+)?a?|generate|produce|build|create|make)\b/gi, "")
    .replace(/\b(thesis|dissertation|article|summary|brief|overview|in[\s-]?depth|deep[\s-]?dive|detailed|guide|comprehensive|paper|report|analysis|study)\b/gi, "")
    .replace(/\b(about|on|regarding|of|for)\b/gi, "")
    .replace(/^\s*(a|an|the)\s+/i, "")
    .replace(/[^\p{L}\p{N}\s'\u0590-\u05FF-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (topic.length < 3) topic = rawText.replace(/\b(deep\s+)?research\b/gi, "").trim();
  return topic;
}

export async function deepResearch(request) {
  const text = typeof request === "string" ? request : (request?.text || "");
  const context = (typeof request === "object" ? request?.context : null) || {};
  const conversationId = context.conversationId || context.convId || null;

  // Vault is required for everything below; bail early with a useful message.
  const vault = getVaultPath();
  if (!vault) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: "Action failed: OBSIDIAN_VAULT_PATH is not configured. Set it in .env to enable Research notes."
    };
  }

  const rawTopic = parseTopic(text);
  if (!rawTopic) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: "Action failed: could not extract a research topic. Please specify what to research."
    };
  }

  // ── Step 2: tier detection (with pending-question pause) ─────────────────
  const tier = tierDetector.detect(text, context);
  if (!tier) {
    if (conversationId) {
      const question = `How deep should the research go for "${rawTopic}"?\n\n` +
        `1. **Article** — ~1500 words, 3 prompts\n` +
        `2. **In-Depth** — ~2200 words, 4 prompts\n` +
        `3. **Research** — ~3500 words, 4 prompts (academic structure)\n` +
        `4. **Thesis** — ~5500 words, 8 prompts (full academic format)\n\n` +
        `Reply with 1/2/3/4, the tier name, or use the depth bar.`;
      try {
        await setPendingQuestion(conversationId, {
          skill: TOOL_NAME,
          question,
          expects: "depth",
          originalRequest: { text, context: { ...context, _pendingResume: true } }
        });
      } catch (err) {
        log(`setPendingQuestion failed: ${err.message}`, "warn");
      }
      return {
        tool: TOOL_NAME,
        success: true,
        final: false,
        awaitingUser: true,
        data: { text: question, preformatted: true }
      };
    }
    // No conversationId — degrade gracefully to article tier.
    log("no tier and no conversationId — defaulting to article", "warn");
  }
  const effectiveTier = tier || "article";

  try {
    // ── Step 3: keyword extraction ─────────────────────────────────────────
    log(`step=keywordExtract topic="${rawTopic}"`, "info");
    const extracted = await keywordExtractor.extract(rawTopic);
    log(`step=keywordExtract done tokens=${extracted.tokens?.length} phrases=${extracted.phrases?.length} bigrams=${extracted.bigrams?.length}`, "info");

    // ── Step 4: subject matching with bounded bootstrap ────────────────────
    log("step=subjectMatch", "info");
    let directory = await sourceDirectory.load();
    let matches = subjectMatcher.rank(extracted, directory.subjects, { limit: 6, maxCandidates: 12 });
    let bootstrap = null;
    if (matches.length === 0) {
      log("step=subjectBootstrap (no match — bootstrapping new subject)", "info");
      bootstrap = await subjectBootstrapper.bootstrap(rawTopic, extracted, directory.subjects);
      directory = await sourceDirectory.load();
      matches = subjectMatcher.rank(extracted, directory.subjects, { limit: 6, maxCandidates: 12 });
    }
    log(`step=subjectMatch done matches=${matches.length} topScore=${matches[0]?.score ?? "n/a"}`, "info");

    // The "active" subject for this run: nearest match if topic similarity is high,
    // otherwise the bootstrapped slug, otherwise a freshly derived clean slug.
    // LLM-derived title + slug pair gives readable folder names AND clean thesis titles.
    const derived = await deriveTitleAndSlug(rawTopic, effectiveTier);
    const activeSlug = bootstrap?.slug
      || (matches[0] && matches[0].score >= 4 ? matches[0].slug : null)
      || derived.slug;
    const cleanTitle = derived.title;
    log(`derived title="${cleanTitle}" slug="${activeSlug}" tier=${effectiveTier}`, "info");

    // Ensure subject entry exists (no-op merge if it does).
    // Phase 1E — prefer multi-word phrases over single tokens so the keyword
    // index maps "dark matter" and "gravitational lensing" not just "dark"/"matter".
    const richKeywords = [
      ...(extracted.phrases || []),
      ...(extracted.bigrams  || []).slice(0, 8),
      ...(extracted.tokens   || []).slice(0, 15)
    ].filter((k, i, a) => k && a.indexOf(k) === i).slice(0, 35); // dedupe + cap
    await sourceDirectory.upsertSubject(activeSlug, {
      topic: rawTopic,
      keywords: richKeywords,
      depth: effectiveTier,
      lastResearched: new Date().toISOString()
    });
    const subject = await sourceDirectory.getSubject(activeSlug);

    // ── Step 5: prompts ────────────────────────────────────────────────────
    const prompts = await promptPlanner.build({
      topic: rawTopic,
      extracted,
      relatedMatches: matches,
      tier: effectiveTier
    });

    // ── Step 6: per-prompt write-as-you-go pipeline ────────────────────────
    const constraints = await loadAgentConstraints();
    const seenUrls   = new Set();
    const seenTitles = new Set(); // cross-prompt normalized-title dedup
    const promptResults = [];
    const maxPerPrompt = constraints.research.maxArticlesPerPrompt || 7;
    const tierLimits = { article: 3, indepth: 4, research: 6, thesis: 7 };
    const articlesPerPrompt = Math.min(maxPerPrompt, tierLimits[effectiveTier] || 4);

    // Pre-create the topic folder.
    try { await createFolder(`${VAULT_JOURNAL_ROOT}/Research/${activeSlug}`); } catch {}

    for (const promptSpec of prompts) {
      const promptIndex = parseInt(promptSpec.id.replace(/\D/g, ""), 10) || (promptResults.length + 1);

      // Write the initial prompt.md (will be rewritten later by promptRollup).
      try {
        const fm = buildFrontmatter({
          title: `"Prompt ${promptIndex}: ${promptSpec.query}"`,
          type: "research-prompt",
          parent: `[[${activeSlug}]]`,
          prompt: promptIndex,
          angle: promptSpec.angle || "",
          status: "in-progress",
          tags: ["research-prompt", activeSlug]
        });
        await writeNote(`${VAULT_JOURNAL_ROOT}/Research/${activeSlug}/${promptIndex}/prompt.md`,
          fm + `# Prompt ${promptIndex}: ${promptSpec.query}\n\n_Harvesting articles…_\n`);
      } catch (err) {
        log(`initial prompt.md write failed: ${err.message}`, "warn");
      }

      // Harvest
      log(`step=harvest prompt=${promptIndex} query="${promptSpec.query.slice(0, 80)}"`, "info");
      let articles = [];
      try {
        articles = await articleHarvester.harvest(promptSpec.query, {
          topic: rawTopic,
          limit: articlesPerPrompt,
          perProvider: Math.max(2, Math.ceil(articlesPerPrompt / 2)),
          prioritySources: subject?.priority_sources?.length ? subject.priority_sources : null,
          skipDomains: constraints.research.skipDomains || [],
          preferDomains: constraints.research.preferDomains || [],
          seenUrls,
          seenTitles
        });
      } catch (err) {
        log(`step=harvest prompt=${promptIndex} error="${err.message}"`, "warn");
      }
      log(`step=harvest prompt=${promptIndex} done articles=${articles.length}`, "info");

      // Local library scan for the first prompt only (cheap supplement).
      if (promptIndex === 1) {
        try {
          const local = await articleHarvester.scanLocalLibrary(rawTopic, { maxResults: 3 });
          for (const l of local) {
            if (!seenUrls.has(l.url)) { seenUrls.add(l.url); articles.push(l); }
          }
        } catch {}
      }

      // Per-article LLM analysis (sequential to respect 7B model limits)
      const analyses = [];
      for (let i = 0; i < articles.length; i++) {
        const artUrl = articles[i]?.url || "(unknown)";
        log(`step=analyze prompt=${promptIndex} article=${i + 1}/${articles.length} url="${artUrl.slice(0, 100)}"`, "info");
        try {
          const r = await articleAnalyzer.analyze({
            article: articles[i],
            topic: rawTopic,
            topicSlug: activeSlug,
            promptIndex,
            articleIndex: i + 1,
            constraints
          });
          analyses.push(r);
          log(`step=analyze prompt=${promptIndex} article=${i + 1} done relevance=${r.analysis?.relevance?.toFixed(2)} facts=${r.analysis?.facts?.length}`, "info");
        } catch (err) {
          log(`step=analyze prompt=${promptIndex} article=${i + 1} url="${artUrl}" error="${err.message}"`, "warn");
        }
      }

      // ── Phase 1B: Jaccard title dedup + self-review retry ─────────────────
      let dedupedAnalyses = dedupAnalysesByTitle(analyses);
      const minSurvivors = Math.ceil(articlesPerPrompt * 0.7);
      log(`prompt ${promptIndex}: ${analyses.length} raw → ${dedupedAnalyses.length} after title-dedup (min=${minSurvivors})`, "info");

      if (dedupedAnalyses.length < minSurvivors) {
        log(`prompt ${promptIndex}: self-review retry (only ${dedupedAnalyses.length}/${minSurvivors} survived dedup)`, "warn");
        try {
          const retryArticles = await articleHarvester.harvest(promptSpec.query, {
            topic: rawTopic,
            limit: articlesPerPrompt,
            perProvider: Math.max(2, Math.ceil(articlesPerPrompt / 2)),
            prioritySources: subject?.priority_sources?.length ? subject.priority_sources : null,
            skipDomains: constraints.research.skipDomains || [],
            preferDomains: constraints.research.preferDomains || [],
            seenUrls,
            seenTitles
          });
          for (let ri = 0; ri < retryArticles.length; ri++) {
            try {
              const r = await articleAnalyzer.analyze({
                article: retryArticles[ri],
                topic: rawTopic,
                topicSlug: activeSlug,
                promptIndex,
                articleIndex: analyses.length + ri + 1,
                constraints
              });
              analyses.push(r);
            } catch (err) {
              log(`retry analyze failed ${retryArticles[ri]?.url}: ${err.message}`, "warn");
            }
          }
          dedupedAnalyses = dedupAnalysesByTitle(analyses);
          log(`prompt ${promptIndex}: after retry → ${dedupedAnalyses.length} analyses`, "info");
        } catch (err) {
          log(`prompt ${promptIndex}: retry harvest failed: ${err.message}`, "warn");
        }
      }

      // Conclusion + vector collection
      log(`step=conclusionWriter prompt=${promptIndex} analyses=${dedupedAnalyses.length}`, "info");
      let conclusionResult = { conclusion: null, collectionName: conclusionWriter.articlesCollectionName(activeSlug, promptIndex), relativePath: null };
      try {
        conclusionResult = await conclusionWriter.write({
          topic: rawTopic,
          topicSlug: activeSlug,
          promptIndex,
          promptSpec,
          analyses: dedupedAnalyses,
          constraints
        });
        log(`step=conclusionWriter prompt=${promptIndex} done path="${conclusionResult.relativePath}"`, "info");
      } catch (err) {
        log(`step=conclusionWriter prompt=${promptIndex} error="${err.message}" stack="${err.stack}"`, "warn");
      }

      promptResults.push({
        promptIndex,
        promptSpec,
        analyses: dedupedAnalyses,   // deduplicated list used by rollup + thesis
        conclusion: conclusionResult.conclusion,
        collectionName: conclusionResult.collectionName,
        conclusionPath: conclusionResult.relativePath
      });
    }

    // ── Step 7: rewrite per-prompt prompt.md + master rollup ──────────────
    for (const pr of promptResults) {
      try {
        await promptRollup.rewritePrompt({
          topicSlug: activeSlug,
          promptSpec: pr.promptSpec,
          promptIndex: pr.promptIndex,
          conclusion: pr.conclusion,
          analyses: pr.analyses,
          collectionName: pr.collectionName
        });
      } catch (err) {
        log(`rewritePrompt failed for ${pr.promptIndex}: ${err.message}`, "warn");
      }
    }
    log(`step=writeMaster prompts=${promptResults.length}`, "info");
    let masterInfo = null;
    try {
      masterInfo = await promptRollup.writeMaster({
        topic: rawTopic,
        topicSlug: activeSlug,
        cleanTitle,
        tier: effectiveTier,
        promptResults,
        relatedMatches: matches
      });
      log(`step=writeMaster done path="${masterInfo?.relativePath}"`, "info");
    } catch (err) {
      log(`step=writeMaster error="${err.message}" stack="${err.stack}"`, "error");
    }

    // ── Step 8.5: Info sufficiency check ──────────────────────────────────
    // If total harvested articles fall below the tier minimum, do one extra
    // CORE-targeted pass before writing. This avoids thin research on hard topics.
    const MIN_SOURCES = { article: 4, indepth: 7, research: 10, thesis: 14 };
    const totalAnalyses = promptResults.reduce((s, p) => s + p.analyses.length, 0);
    const minRequired = MIN_SOURCES[effectiveTier] || 6;
    if (totalAnalyses < minRequired) {
      console.log(`[deepResearch] ℹ️ Info sufficiency: ${totalAnalyses}/${minRequired} sources for "${effectiveTier}" tier — running supplemental CORE harvest`);
      try {
        const supplemental = await articleHarvester.harvest(rawTopic, {
          topic: rawTopic,
          limit: Math.min(minRequired - totalAnalyses + 2, 5),
          perProvider: 3,
          prioritySources: ["core", "semanticscholar", "doaj"],
          skipDomains: constraints.research.skipDomains || [],
          seenUrls,
          seenTitles
        });
        if (supplemental.length > 0) {
          console.log(`[deepResearch] Supplemental harvest added ${supplemental.length} articles`);
          // Attach to the last prompt's results
          const lastPr = promptResults[promptResults.length - 1];
          for (const art of supplemental) {
            try {
              const r = await articleAnalyzer.analyze({
                article: art,
                topic: rawTopic,
                topicSlug: activeSlug,
                promptIndex: lastPr.promptIndex,
                articleIndex: lastPr.analyses.length + 1,
                constraints
              });
              lastPr.analyses.push(r);
            } catch {}
          }
        }
      } catch (suppErr) {
        log(`supplemental harvest failed (non-blocking): ${suppErr.message}`, "warn");
      }
    } else {
      log(`step=infoCheck ok total=${totalAnalyses} min=${minRequired}`, "info");
    }

    // ── Step 9: chunked thesis synthesis ───────────────────────────────────
    log(`step=thesisSynthesizer tier=${effectiveTier} sections=pending`, "info");
    let thesisInfo = null;
    try {
      thesisInfo = await thesisSynthesizer.synthesize({
        topic: rawTopic,
        topicSlug: activeSlug,
        cleanTitle,
        tier: effectiveTier,
        promptResults,
        constraints
      });
      const stubCount = thesisInfo?.createdStubs?.length ?? 0;
      log(`step=thesisSynthesizer done words=${thesisInfo?.wordCount} stubs=${stubCount}`, "info");
      console.log(`[deepResearch] Thesis complete: ${thesisInfo?.wordCount ?? 0} words, ${stubCount} stubs created`);
    } catch (err) {
      log(`step=thesisSynthesizer error="${err.message}" stack="${err.stack}"`, "error");
    }

    // Persist source-count update
    const totalSources = promptResults.reduce((s, p) => s + p.analyses.length, 0);
    await sourceDirectory.upsertSubject(activeSlug, {
      sourceCount: totalSources,
      depth: effectiveTier,
      lastResearched: new Date().toISOString()
    });

    // ── Step 10: chat reply ────────────────────────────────────────────────
    const finalPath = thesisInfo?.relativePath || masterInfo?.relativePath || `${VAULT_JOURNAL_ROOT}/Research/${activeSlug}/`;
    const reply = `✅ ${effectiveTier.charAt(0).toUpperCase() + effectiveTier.slice(1)} on **"${rawTopic}"** saved.\n\n` +
      `- Final write-up: \`${finalPath}\`\n` +
      `- Master rollup: \`${masterInfo?.relativePath || "(skipped)"}\`\n` +
      `- Prompts executed: ${promptResults.length}\n` +
      `- Sources harvested: ${totalSources}\n` +
      (thesisInfo?.lintReport?.warnings?.length
        ? `- ⚠️ Lint warnings: ${thesisInfo.lintReport.warnings.length} (see \`${masterInfo?.relativePath || "_master.md"}\`)\n`
        : "");

    return {
      tool: TOOL_NAME,
      success: true,
      final: true,
      data: {
        text: reply,
        preformatted: true,
        topic: rawTopic,
        slug: activeSlug,
        tier: effectiveTier,
        promptCount: promptResults.length,
        sourceCount: totalSources,
        finalPath,
        masterPath: masterInfo?.relativePath,
        wordCount: thesisInfo?.wordCount || 0
      }
    };
  } catch (err) {
    log(`pipeline failed: ${err.stack || err.message}`, "error");
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Action failed: ${err.message}`
    };
  }
}

export default deepResearch;

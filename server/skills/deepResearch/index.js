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

const TOOL_NAME = "deepResearch";

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
        console.warn("[deepResearch] setPendingQuestion failed:", err.message);
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
    console.warn("[deepResearch] no tier and no conversationId — defaulting to article");
  }
  const effectiveTier = tier || "article";

  try {
    // ── Step 3: keyword extraction ─────────────────────────────────────────
    const extracted = await keywordExtractor.extract(rawTopic);

    // ── Step 4: subject matching with bounded bootstrap ────────────────────
    let directory = await sourceDirectory.load();
    let matches = subjectMatcher.rank(extracted, directory.subjects, { limit: 6, maxCandidates: 12 });
    let bootstrap = null;
    if (matches.length === 0) {
      bootstrap = await subjectBootstrapper.bootstrap(rawTopic, extracted, directory.subjects);
      directory = await sourceDirectory.load();
      matches = subjectMatcher.rank(extracted, directory.subjects, { limit: 6, maxCandidates: 12 });
    }

    // The "active" subject for this run: nearest match if topic similarity is high,
    // otherwise the bootstrapped slug, otherwise a freshly slugified topic.
    const activeSlug = bootstrap?.slug
      || (matches[0] && matches[0].score >= 4 ? matches[0].slug : null)
      || sourceDirectory.slugify(rawTopic);

    // Ensure subject entry exists (no-op merge if it does).
    await sourceDirectory.upsertSubject(activeSlug, {
      topic: rawTopic,
      keywords: extracted.tokens.slice(0, 30),
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
    const seenUrls = new Set();
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
        console.warn(`[deepResearch] initial prompt.md write failed: ${err.message}`);
      }

      // Harvest
      let articles = [];
      try {
        articles = await articleHarvester.harvest(promptSpec.query, {
          topic: rawTopic,
          limit: articlesPerPrompt,
          perProvider: Math.max(2, Math.ceil(articlesPerPrompt / 2)),
          prioritySources: subject?.priority_sources?.length ? subject.priority_sources : null,
          skipDomains: constraints.research.skipDomains || [],
          preferDomains: constraints.research.preferDomains || [],
          seenUrls
        });
      } catch (err) {
        console.warn(`[deepResearch] harvest failed for prompt ${promptIndex}: ${err.message}`);
      }

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
        } catch (err) {
          console.warn(`[deepResearch] analyze failed for ${articles[i]?.url}: ${err.message}`);
        }
      }

      // Conclusion + vector collection
      let conclusionResult = { conclusion: null, collectionName: conclusionWriter.articlesCollectionName(activeSlug, promptIndex), relativePath: null };
      try {
        conclusionResult = await conclusionWriter.write({
          topic: rawTopic,
          topicSlug: activeSlug,
          promptIndex,
          promptSpec,
          analyses,
          constraints
        });
      } catch (err) {
        console.warn(`[deepResearch] conclusionWriter failed: ${err.message}`);
      }

      promptResults.push({
        promptIndex,
        promptSpec,
        analyses,
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
        console.warn(`[deepResearch] rewritePrompt failed for ${pr.promptIndex}: ${err.message}`);
      }
    }
    let masterInfo = null;
    try {
      masterInfo = await promptRollup.writeMaster({
        topic: rawTopic,
        topicSlug: activeSlug,
        tier: effectiveTier,
        promptResults,
        relatedMatches: matches
      });
    } catch (err) {
      console.warn(`[deepResearch] writeMaster failed: ${err.message}`);
    }

    // ── Step 9: chunked thesis synthesis ───────────────────────────────────
    let thesisInfo = null;
    try {
      thesisInfo = await thesisSynthesizer.synthesize({
        topic: rawTopic,
        topicSlug: activeSlug,
        tier: effectiveTier,
        promptResults,
        constraints
      });
    } catch (err) {
      console.warn(`[deepResearch] thesisSynthesizer failed: ${err.message}`);
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
    console.error("[deepResearch] pipeline failed:", err);
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Action failed: ${err.message}`
    };
  }
}

export default deepResearch;

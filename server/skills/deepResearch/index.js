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
import * as datasetHarvester from "./datasetHarvester.js";
import * as tableAnalyst from "./tableAnalyst.js";
import * as chartComposer from "./chartComposer.js";
import * as manualBridge from "./manualBridge.js";
import * as conclusionWriter from "./conclusionWriter.js";
import * as promptRollup from "./promptRollup.js";
import * as thesisSynthesizer from "./thesisSynthesizer.js";
import { seedIfNeeded } from "./academicJournalSeeder.js";
import { addFact } from "../../knowledge.js";
import { createLogger } from "../../utils/logger.js";

const TOOL_NAME = "deepResearch";
const log = createLogger("deepResearch");

// Phase 16F — pin a non-persona model for the title/slug derivation. Same
// env var that thesisSynthesizer uses; default qwen2.5:7b. Without this,
// llm() falls through to the chat default (dolphin-llama3) which timed out
// in the latest CBT run as the first failure of the pipeline.
const TITLE_SLUG_MODEL = process.env.SYNTHESIZER_MODEL || "qwen2.5:7b";

// ── Phase 14G — research-in-progress flag ──────────────────────────────────
// The CBT thesis run logs showed three scheduled tasks (X trends, news,
// weather) firing during the 48-min pipeline. The news task took 194s of
// CPU/GPU and forced an Ollama model swap (qwen ↔ dolphin), polluting logs
// and slowing the run. Export a simple module-level flag that the scheduler
// can consult to defer tasks until research finishes.
let _inProgress = false;
export const isDeepResearchInProgress = () => _inProgress;
export const _markDeepResearchInProgress = (v) => { _inProgress = !!v; };

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
    // Phase 16F — explicit model:. Without it, llm() falls through to the
    // chat default (dolphin-llama3:latest), which is the persona model —
    // slow, prompt-leaky, not aligned for structured JSON. The user's run
    // timed out on this very call as the first failure.
    const res = await llm(prompt, {
      timeoutMs: 15000,
      format: "json",
      model: TITLE_SLUG_MODEL,
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
    // Format / meta-nouns describing the deliverable, NOT the topic.
    // "research a piece about X" → topic should be "X", not "piece X".
    // Without this, "piece" leaks into every downstream query, vector collection,
    // and article body.
    .replace(/\b(thesis|dissertation|article|summary|brief|overview|in[\s-]?depth|deep[\s-]?dive|detailed|guide|comprehensive|paper|report|analysis|study|piece|post|essay|blog|write[\s-]?up|story|draft|review|memo|entry|item|content|topic|subject|note|text)\b/gi, "")
    .replace(/\b(about|on|regarding|of|for)\b/gi, "")
    .replace(/^\s*(a|an|the)\s+/i, "")
    .replace(/[^\p{L}\p{N}\s'\u0590-\u05FF-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (topic.length < 3) topic = rawText.replace(/\b(deep\s+)?research\b/gi, "").trim();
  return topic;
}

// Phase 14G — public wrapper that flips the in-progress flag for the
// duration of the pipeline. Scheduled tasks check this flag and defer until
// research completes, eliminating mid-run model swaps and log contamination.
export async function deepResearch(request) {
  _markDeepResearchInProgress(true);
  try {
    return await _deepResearchImpl(request);
  } catch (err) {
    // Phase 16E — turn the PIPELINE_ABORTED throw into a clean response.
    // Other errors bubble (the existing top-level catch in chatAgent handles them).
    if (err && err.code === "PIPELINE_ABORTED") {
      return {
        tool: TOOL_NAME,
        success: false,
        final: true,
        aborted: true,
        error: err.message,
        data: { text: "Research aborted by user." }
      };
    }
    throw err;
  } finally {
    _markDeepResearchInProgress(false);
  }
}

async function _deepResearchImpl(request) {
  const text = typeof request === "string" ? request : (request?.text || "");
  const context = (typeof request === "object" ? request?.context : null) || {};
  const conversationId = context.conversationId || context.convId || null;
  // Phase 16E — abort signal from chat.js → executor → skill. When the user
  // clicks cancel, this signal flips. We check it between major pipeline
  // steps so the pipeline bails out rather than keeping its 2-hour march.
  const signal = context.signal || null;
  const checkAborted = () => {
    if (signal && signal.aborted) {
      const e = new Error("Pipeline aborted by user");
      e.code = "PIPELINE_ABORTED";
      throw e;
    }
  };

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

  // Phase 6C — progress emitter. Falls back to no-op when onStep is absent
  // (e.g. CLI/test runs). Emits as a "thought" event with phase "PROGRESS"
  // so the existing client-side thought renderer picks it up unchanged.
  const onStep = typeof context._onStep === "function" ? context._onStep : null;
  const emitProgress = (content, extra = {}) => {
    if (!onStep) return;
    try {
      onStep({
        type: "thought",
        phase: "PROGRESS",
        content,
        data: extra,
        timestamp: new Date().toISOString()
      });
    } catch {}
  };

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

  // Phase 17C — pre-flight Ollama probe.
  // Before launching a 30+ minute harvest+synthesis pipeline, fire one tiny
  // call to verify Ollama is alive AND responds within budget. With a slow
  // GPU-spilled model the analyzer chunks would all timeout at 30s anyway;
  // surfacing that here aborts in 60s with an actionable message instead of
  // burning 2 hours on the cascade. Tiny prompt + num_predict=5 + maxRetries=0
  // keeps the probe cheap.
  emitProgress(`🔍 Pre-flight: probing Ollama (${TITLE_SLUG_MODEL})…`);
  checkAborted();
  const probe = await llm("Reply with the single word OK.", {
    timeoutMs: 60000,
    model: TITLE_SLUG_MODEL,
    maxRetries: 0,
    skipKnowledge: true,
    skipLanguageDetection: true,
    options: { temperature: 0, num_ctx: 512, num_predict: 5 }
  });
  if (!probe?.success) {
    const cat = probe?.errorCategory || "unknown";
    // Surface the underlying Ollama error message verbatim — it often contains
    // the exact diagnostic the user needs (e.g. "model requires more system
    // memory (4.1 GiB) than is available (2.4 GiB)" tells them VRAM is full,
    // not that Ollama is down).
    const ollamaMsg = probe?.error || "(no underlying error message)";
    log(`pre-flight probe FAILED — category=${cat}, model=${TITLE_SLUG_MODEL}, error=${ollamaMsg}`, "error");
    const userText = [
      `🛑 **Research aborted before harvest** — Ollama pre-flight probe failed.`,
      ``,
      `**Category:** \`${cat}\`  •  **Model:** \`${TITLE_SLUG_MODEL}\``,
      `**Underlying error:** ${ollamaMsg}`,
      ``,
      `**What to try:**`,
      `1. Run \`ollama ps\` — if other models are loaded, run \`ollama stop <name>\` to free VRAM.`,
      `2. Reduce GPU layer count: set \`OLLAMA_NUM_GPU=30\` (or lower) in your .env, then \`pm2 restart Lanou --update-env\`. Forces partial CPU offload — slower but works on tight VRAM.`,
      `3. If VRAM is exhausted by other apps (ComfyUI, browser, games), close them and retry.`,
      `4. As a last resort, switch to a smaller synthesizer: set \`SYNTHESIZER_MODEL=qwen2.5:3b\` (≈2 GB instead of 4.7 GB).`,
      ``,
      `_The pipeline aborted in <60 s instead of running 2 hours of cascading timeouts._`
    ].join("\n");
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      aborted: true,                       // signal: terminal, do not synthesize fallback
      error: `Ollama pre-flight probe failed (${cat}): ${ollamaMsg}`,
      data: {
        text: userText,
        preformatted: true                 // honoured by chatAgent's bypass (Phase 17J)
      }
    };
  }
  log(`pre-flight probe OK — proceeding with research`, "info");

  // Phase 17F/G — reset per-run network state (dead-domain set, S2 cooldown).
  // These are module-scoped helpers; resetting at run start prevents stale
  // state from a previous run leaking into this one.
  try { articleHarvester.resetDeadDomains?.(); } catch {}
  try { articleHarvester.resetS2Cooldown?.(); } catch {}
  // Phase 20F — clear per-run alt-source host cooldown state
  try {
    const altMod = await import("./altSourceFinder.js");
    altMod.resetAltSourceState?.();
  } catch {}

  // Phase 9D — bridge resume detection. When the user replies "continue"/"skip"
  // to a manual-bridge offer, the orchestrator passes the action through
  // resolvedPending.
  const isBridgeResume = context.resolvedPending?.manual_bridge_continue !== undefined;

  // Phase 11B — short-circuit harvest+analysis on resume. Load saved
  // promptResults from the bridge state file and skip the entire 5-10min
  // harvest+LLM-analyze pipeline. JSON round-trip is byte-for-byte lossless;
  // an integrity check against the live disk state guards against vector-
  // collection eviction or vault relocation.
  let restoredFromState = null;
  if (isBridgeResume && context.resolvedPending?._bridgeSlug) {
    const bridgeSlug = context.resolvedPending._bridgeSlug;
    log(`bridge resume detected — attempting state-restore short-circuit for slug="${bridgeSlug}"`, "info");
    try {
      const state = await manualBridge.loadBridgeState(bridgeSlug);
      if (state?.promptResults?.length) {
        const integrity = await manualBridge.verifyBridgeState(state);
        if (integrity.ok) {
          restoredFromState = state;
          log(`bridge resume: state-restore OK (${state.promptResults.length} prompts, ${state.promptResults.reduce((s, p) => s + (p.analyses?.length || 0), 0)} analyses) — SKIPPING harvest`, "info");
          if (integrity.missingCollections?.length) {
            log(`bridge resume: ${integrity.missingCollections.length} vector collection(s) missing on disk; will rebuild on demand`, "warn");
          }
          emitProgress(`📥 State restored — skipping harvest (${state.promptResults.length} prompts cached)`);
        } else {
          log(`bridge resume: integrity check failed (${integrity.issues.join("; ")}) — falling through to full pipeline`, "warn");
        }
      } else {
        log(`bridge resume: no saved state for slug="${bridgeSlug}" — running full pipeline`, "warn");
      }
    } catch (err) {
      log(`bridge resume: state-restore error (${err.message}) — falling through`, "warn");
    }
  }

  try {
    // Phase 11B — variables shared between full-pipeline and resume paths.
    // On normal runs these are populated by steps 3-8. On bridge resume they
    // come pre-populated from the saved state file.
    let activeSlug, cleanTitle, subject, prompts, promptResults, masterInfo;
    let constraints = null;

    if (restoredFromState) {
      // Skip harvest+analyze entirely — restore from bridge state.
      activeSlug    = restoredFromState.slug;
      cleanTitle    = restoredFromState.cleanTitle;
      prompts       = restoredFromState.prompts || [];
      promptResults = restoredFromState.promptResults || [];
      masterInfo    = restoredFromState.masterInfo || null;
      constraints   = restoredFromState.constraintsSnapshot || await loadAgentConstraints();
      // subject not strictly needed past this point — leave undefined.
      subject       = null;
      log(`bridge resume: restored ${promptResults.length} prompts with ${promptResults.reduce((s, p) => s + (p.analyses?.length || 0), 0)} total analyses`, "info");
    } else {
    // ── Step 3: keyword extraction ─────────────────────────────────────────
    log(`step=keywordExtract topic="${rawTopic}"`, "info");
    emitProgress(`🔍 Extracting keywords for "${rawTopic.slice(0, 60)}"…`);
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
    activeSlug = bootstrap?.slug
      || (matches[0] && matches[0].score >= 4 ? matches[0].slug : null)
      || derived.slug;
    cleanTitle = derived.title;
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
    subject = await sourceDirectory.getSubject(activeSlug);

    // ── Step 5: prompts ────────────────────────────────────────────────────
    emitProgress(`🧭 Planning sub-questions (tier=${effectiveTier})…`);
    prompts = await promptPlanner.build({
      topic: rawTopic,
      extracted,
      relatedMatches: matches,
      tier: effectiveTier
    });
    emitProgress(`📋 Generated ${prompts.length} sub-questions`, { count: prompts.length });

    // ── Step 6: per-prompt write-as-you-go pipeline ────────────────────────
    constraints = await loadAgentConstraints();
    const seenUrls    = new Set();
    const seenTitles  = new Set(); // cross-prompt normalized-title dedup
    const seenDatasetIds = new Set(); // Phase 7: cross-prompt dataset dedup
    promptResults = [];
    const maxPerPrompt = constraints.research.maxArticlesPerPrompt || 7;
    // Phase 20N — "thesis-deep" maps to the same main-pipeline limits as
    // "thesis"; the extra recursion is what makes it deeper, not a higher
    // per-prompt article count. Missing this entry collapsed runs to the
    // article-tier fallback (3 articles/prompt) — which is exactly the bug
    // the user hit: the main pipeline appeared not to run.
    const tierLimits = { article: 3, indepth: 4, research: 6, thesis: 7, "thesis-deep": 7 };
    const articlesPerPrompt = Math.min(maxPerPrompt, tierLimits[effectiveTier] || 4);

    // Pre-create the topic folder.
    try { await createFolder(`${VAULT_JOURNAL_ROOT}/Research/${activeSlug}`); } catch {}

    for (const promptSpec of prompts) {
      // Phase 16E — bail between prompts if the user has aborted.
      checkAborted();
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

      // Harvest — Phase 7: articles + datasets in parallel.
      emitProgress(`📡 Harvesting ${promptIndex}/${prompts.length}: "${promptSpec.query.slice(0, 60)}"`,
        { current: promptIndex, total: prompts.length });
      log(`step=harvest prompt=${promptIndex} query="${promptSpec.query.slice(0, 80)}"`, "info");
      const tierDatasetLimit = ({ article: 2, indepth: 3, research: 4, thesis: 5, "thesis-deep": 5 })[effectiveTier] || 3;
      const [articlesSettled, datasetsSettled] = await Promise.allSettled([
        articleHarvester.harvest(promptSpec.query, {
          topic: rawTopic,
          tier: effectiveTier,
          limit: articlesPerPrompt,
          perProvider: Math.max(2, Math.ceil(articlesPerPrompt / 2)),
          prioritySources: subject?.priority_sources?.length ? subject.priority_sources : null,
          skipDomains: constraints.research.skipDomains || [],
          preferDomains: constraints.research.preferDomains || [],
          seenUrls,
          seenTitles
        }),
        datasetHarvester.harvest(promptSpec.query, {
          topic: rawTopic,
          limit: tierDatasetLimit,
          perProvider: 3,
          seenIds: seenDatasetIds
        })
      ]);
      let articles = articlesSettled.status === "fulfilled" ? (articlesSettled.value || []) : [];
      let datasets = datasetsSettled.status === "fulfilled" ? (datasetsSettled.value || []) : [];
      if (articlesSettled.status === "rejected") log(`step=harvest prompt=${promptIndex} articles error="${articlesSettled.reason?.message}"`, "warn");
      if (datasetsSettled.status === "rejected") log(`step=harvest prompt=${promptIndex} datasets error="${datasetsSettled.reason?.message}"`, "warn");
      log(`step=harvest prompt=${promptIndex} done articles=${articles.length} datasets=${datasets.length}`, "info");

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
      emitProgress(`🔬 Analyzing ${articles.length} articles for prompt ${promptIndex}/${prompts.length}`,
        { current: promptIndex, total: prompts.length, articles: articles.length });
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
          // Phase 9D — attach the original article so manualBridge can detect
          // thin/blocked sources (content < 1500 chars on a relevant article).
          analyses.push({ ...r, article: articles[i] });
          log(`step=analyze prompt=${promptIndex} article=${i + 1} done relevance=${r.analysis?.relevance?.toFixed(2)} facts=${r.analysis?.facts?.length} contentLen=${(articles[i]?.content || "").length}`, "info");
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
              analyses.push({ ...r, article: retryArticles[ri] });
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

      // ── Phase 7B/7C: table analysis + chart composition ─────────────────
      // For each harvested dataset: download a usable file → schema-sniff →
      // LLM assessment (suggests charts) → deterministic aggregation + SVG.
      // Failures are non-fatal; the article path still produces a thesis.
      const quantitativeFindings = [];
      const datasetCitations = [];
      if (datasets.length > 0) {
        emitProgress(`📊 Analyzing ${datasets.length} dataset(s) for prompt ${promptIndex}/${prompts.length}`,
          { current: promptIndex, total: prompts.length, datasets: datasets.length });
        const chartsDir = `${VAULT_JOURNAL_ROOT}/Research/${activeSlug}/charts`;
        // Vault-relative path needs to be absolute on disk — resolve via vault root.
        const absChartsDir = path.join(vault, chartsDir);
        for (let di = 0; di < datasets.length; di++) {
          const ds = datasets[di];
          datasetCitations.push(ds);            // always cite, even metadata-only
          let parsed = null;
          if (!ds.metadataOnly && ds.files?.length) {
            const usable = ds.files.find(f => f.format === "csv" || f.format === "tsv" || f.format === "json")
                          || ds.files.find(f => f.format === "xlsx" || f.format === "xls");
            if (usable) {
              try {
                parsed = await datasetHarvester.downloadAndParse(usable);
                if (parsed) log(`prompt ${promptIndex} dataset ${di + 1}/${datasets.length}: parsed ${parsed.rows.length} rows (${parsed.sampling}) from ${ds.repository}/${usable.name}`, "info");
              } catch (err) {
                log(`download fail ${ds.id}: ${err.message}`, "warn");
              }
            }
            // Phase 9D — if the dataset has files but parsing produced nothing,
            // mark it as bridge-eligible so the user can drop the file manually.
            if (!parsed) ds._bridge_eligible = true;
          }
          let assessment = null;
          try {
            assessment = await tableAnalyst.assess({ topic: rawTopic, dataset: ds, parsed });
          } catch (err) {
            log(`tableAnalyst fail ${ds.id}: ${err.message}`, "warn");
          }
          if (!assessment) continue;
          if (assessment.metadataOnly) {
            quantitativeFindings.push({
              datasetId: ds.id,
              datasetTitle: ds.title,
              repository: ds.repository,
              metadataOnly: true,
              hypothesis: "",
              limitations: assessment.limitations,
              honestyLabels: assessment.honesty_labels,
              charts: []
            });
            continue;
          }
          const charts = [];
          for (let ci = 0; ci < (assessment.suggested_charts || []).length; ci++) {
            const spec = assessment.suggested_charts[ci];
            const fileBase = `${ds.id.replace(/[^a-z0-9]+/gi, "-")}-c${ci + 1}`;
            try {
              const result = await chartComposer.compose({
                spec,
                parsed,
                dataset: ds,
                honestyLabels: assessment.honesty_labels,
                outDir: absChartsDir,
                fileBase
              });
              if (result?.ok) {
                charts.push(result);
                log(`chart composed: ${result.chartPath}`, "info");
              } else {
                log(`chart skipped: ${result?.reason}`, "warn");
              }
            } catch (err) {
              log(`chart compose fail ${ds.id} #${ci + 1}: ${err.message}`, "warn");
            }
          }
          quantitativeFindings.push({
            datasetId: ds.id,
            datasetTitle: ds.title,
            repository: ds.repository,
            N: assessment.N,
            sampling: assessment.sampling,
            keyVariables: assessment.key_variables,
            hypothesis: assessment.hypothesis_to_test,
            limitations: assessment.limitations,
            honestyLabels: assessment.honesty_labels,
            charts
          });
        }
        emitProgress(`📊 Prompt ${promptIndex}: ${quantitativeFindings.length} dataset finding(s), ${quantitativeFindings.reduce((s, q) => s + (q.charts?.length || 0), 0)} chart(s) generated`);
      }

      // Conclusion + vector collection
      emitProgress(`📝 Writing conclusion for prompt ${promptIndex}/${prompts.length} (${dedupedAnalyses.length} sources)`,
        { current: promptIndex, total: prompts.length });
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
        conclusionPath: conclusionResult.relativePath,
        // Phase 7: empirical-methodology outputs piped to the synthesizer.
        quantitativeFindings,
        datasetCitations
      });
    }

    // ── Phase 7F: write _data.md index for empirical-methodology outputs ──
    // Phase 11B — local-scoped names to avoid shadowing the outer
    // declarations after the else-block closes.
    const _localQuant = promptResults.flatMap(p => p.quantitativeFindings || []);
    const _localDatasetCites = promptResults.flatMap(p => p.datasetCitations || []);
    if (_localDatasetCites.length > 0) {
      try {
        const dataLines = [
          buildFrontmatter({
            title: `"${cleanTitle} — Datasets & Quantitative Findings"`,
            type: "research-data-index",
            parent: `[[${activeSlug}]]`,
            dataset_count: _localDatasetCites.length,
            chart_count: _localQuant.reduce((s, q) => s + (q.charts?.length || 0), 0),
            tags: ["research-data-index", activeSlug]
          }),
          `# Datasets & Quantitative Findings — ${cleanTitle}`,
          ``,
          `${_localDatasetCites.length} dataset(s) harvested across ${promptResults.length} prompt(s). ${_localQuant.filter(q => !q.metadataOnly).length} analyzed; ${_localQuant.filter(q => q.metadataOnly).length} metadata-only.`,
          ``
        ];
        for (const ds of _localDatasetCites) {
          dataLines.push(`## ${ds.title}`);
          dataLines.push(`- Repository: **${ds.repository}**`);
          if (ds.doi) dataLines.push(`- DOI: [${ds.doi}](https://doi.org/${ds.doi})`);
          if (ds.url) dataLines.push(`- URL: <${ds.url}>`);
          if (ds.year) dataLines.push(`- Year: ${ds.year}`);
          if (ds.metadataOnly) dataLines.push(`- _Metadata-only — rows not retrieved (cited for methodological rigor)._`);
          else if (ds.files?.length) dataLines.push(`- Files: ${ds.files.map(f => `\`${f.name}\` (${f.format}, ${(f.sizeBytes / 1024).toFixed(0)}KB)`).join(", ")}`);
          const matchingQF = _localQuant.find(q => q.datasetId === ds.id);
          if (matchingQF && !matchingQF.metadataOnly) {
            dataLines.push(`- N=${matchingQF.N}, sampling=${matchingQF.sampling}`);
            if (matchingQF.honestyLabels?.length) dataLines.push(`- Honesty: ${matchingQF.honestyLabels.join("; ")}`);
            if (matchingQF.hypothesis) dataLines.push(`- Hypothesis tested: ${matchingQF.hypothesis}`);
            for (const c of matchingQF.charts || []) {
              dataLines.push(``);
              dataLines.push(`![[${c.chartPath}]]`);
              dataLines.push(``);
              dataLines.push(`*${c.caption}*`);
              dataLines.push(``);
              dataLines.push(c.interpretation);
            }
          }
          dataLines.push(``);
        }
        await writeNote(`${VAULT_JOURNAL_ROOT}/Research/${activeSlug}/_data.md`, dataLines.join("\n"));
        log(`step=writeDataIndex done datasets=${_localDatasetCites.length}`, "info");
      } catch (err) {
        log(`writeDataIndex error="${err.message}"`, "warn");
      }
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
    masterInfo = null;
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
    const MIN_SOURCES = { article: 4, indepth: 7, research: 10, thesis: 14, "thesis-deep": 14 };
    const totalAnalyses = promptResults.reduce((s, p) => s + p.analyses.length, 0);
    const minRequired = MIN_SOURCES[effectiveTier] || 6;
    if (totalAnalyses < minRequired) {
      console.log(`[deepResearch] ℹ️ Info sufficiency: ${totalAnalyses}/${minRequired} sources for "${effectiveTier}" tier — running supplemental CORE harvest`);
      try {
        const supplemental = await articleHarvester.harvest(rawTopic, {
          topic: rawTopic,
          tier: effectiveTier,
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
    } // ─── end of full-pipeline else-block (Phase 11B); resume path skips here ──

    // Phase 11B — recompute these for downstream code (synthesis + reply +
    // bridge gate). The matching consts inside the else-block are block-scoped
    // and not visible here. Cheap flatMaps.
    const allDatasetCites = promptResults.flatMap(p => p.datasetCitations || []);
    const allQuant        = promptResults.flatMap(p => p.quantitativeFindings || []);

    // ── Phase 9D: manual PDF/CSV bridge ───────────────────────────────────
    // For research/thesis tiers, if multiple high-relevance articles arrived
    // thin (paywalls, JS challenges, redirect loops) OR datasets had files we
    // couldn't parse, pause here and let the user download them manually.
    // Skip the gate if this is already a resume from a prior bridge invocation.
    if (!isBridgeResume) {
      const blocked = manualBridge.collectBlockedSources(promptResults);
      const bridgeOverride = process.env.MANUAL_BRIDGE === "always" ? true
                          : process.env.MANUAL_BRIDGE === "never" ? false : null;
      // Phase 13J — always log the gate evaluation so we can debug why bridge
      // doesn't fire on runs with obvious fetch failures.
      const willOffer = manualBridge.shouldOfferBridge(blocked, effectiveTier, bridgeOverride);
      // Phase 20N — surface the actual eligible-tiers list and threshold so
      // future tier-naming bugs are obvious from the log.
      const bridgeEligibleTiers = [...manualBridge._internals.BRIDGE_ELIGIBLE_TIERS];
      const tierEligible = bridgeEligibleTiers.includes(effectiveTier);
      const bridgeReason = willOffer
        ? `OFFER (blocked=${blocked.length}, tier=${effectiveTier}, override=${bridgeOverride})`
        : `SKIP (blocked=${blocked.length}, tier=${effectiveTier}, tierEligible=${tierEligible}, eligibleTiers=[${bridgeEligibleTiers.join(",")}], threshold=2, override=${bridgeOverride})`;
      console.log(`[manualBridge] gate evaluated: ${bridgeReason}`);
      if (blocked.length > 0 && !willOffer) {
        // Diagnostic: show first blocked source so the user can see what was detected
        console.log(`[manualBridge] would-block sample: kind=${blocked[0].kind}, url=${(blocked[0].url || "").slice(0, 80)}`);
      }
      // Phase 14F — loud surfacing when willOffer fires but conversationId is
      // missing. Without a conversationId, setPendingQuestion() can't pause
      // the pipeline, so the bridge silently skips. The CBT run had 33 blocked
      // sources and the user had no idea the bridge was even attempted.
      let bridgeSkippedDespiteOffer = false;
      if (willOffer && !conversationId) {
        console.warn(`[manualBridge] ⚠️ OFFER triggered but conversationId is missing — pipeline will continue without pause. ${blocked.length} sources will go unfilled. Fix: ensure orchestrator/taskAgent passes conversationId to deepResearch.`);
        bridgeSkippedDespiteOffer = true;
        // Stash on context so the markdown writer can prepend a TODO callout
        context._bridgeSkippedDespiteOffer = { count: blocked.length, blocked: blocked.slice(0, 12) };
      }
      if (willOffer && conversationId) {
        const vaultRel = `${VAULT_JOURNAL_ROOT}/Research/${activeSlug}`;
        try {
          // Phase 11B — save FULL promptResults so resume can short-circuit
          // the entire harvest+analysis pipeline. saveBridgeState strips
          // article.content blobs before serialization (those are already
          // saved as note files). State file is ~30KB even for thesis tier.
          await manualBridge.saveBridgeState(activeSlug, {
            topic: rawTopic, slug: activeSlug, tier: effectiveTier,
            cleanTitle, blocked,
            // Restore-critical state for short-circuit resume:
            promptResults,                        // full graph (content stripped)
            prompts,                              // promptSpec list
            masterInfo,                           // _master.md path info
            constraintsSnapshot: constraints      // writingRules + skip/prefer domains
          });
          const bridgeText = manualBridge.renderBridgeMessage(blocked, activeSlug, vaultRel);
          await setPendingQuestion(conversationId, {
            skill: TOOL_NAME,
            question: bridgeText,
            expects: "manual_bridge_continue",
            ttlMs: 0,                                 // Phase 21 — never expire; user may need hours to grab 30+ PDFs by hand
            originalRequest: { text, context: { ...context, _bridgeSlug: activeSlug } }
          });
          emitProgress(`🔒 Paused: ${blocked.length} blocked source(s) — see chat for download instructions`);
          log(`step=manualBridge offering ${blocked.length} blocked sources, awaiting user`, "info");
          return {
            tool: TOOL_NAME,
            success: true,
            final: false,
            awaitingUser: true,
            data: { text: bridgeText, preformatted: true }
          };
        } catch (err) {
          log(`manualBridge save failed: ${err.message} — proceeding without bridge`, "warn");
        }
      } else if (blocked.length > 0) {
        log(`step=manualBridge ${blocked.length} blocked source(s) — bridge not offered (tier=${effectiveTier}, override=${bridgeOverride})`, "info");
      }
    } else {
      // Bridge resume — load state, scan _pending/, attach files, re-analyze
      const bridgeAction = context.resolvedPending.manual_bridge_continue;
      log(`step=manualBridge resume action="${bridgeAction}"`, "info");
      emitProgress(`📥 Resuming from manual bridge (${bridgeAction})…`);
      if (bridgeAction === "continue") {
        try {
          const attached = await manualBridge.scanAndAttach(activeSlug, manualBridge.collectBlockedSources(promptResults));
          let attachedCount = 0;
          // Phase 22 — per-file progress emission. The bridge resume can run
          // 17+ articles × 3-5 analyzer chunks each (~50-85 LLM calls).
          // Without these markers the user sees one long silent gap.
          const bridgeTotal = attached.filter(x => x.exists).length;
          let bridgeIdx = 0;
          for (const a of attached) {
            if (!a.exists) continue;
            const e = a.entry;
            bridgeIdx++;
            const bridgeTitleSlice = String(e.title || "").slice(0, 60);
            emitProgress(`📥 bridge re-analyzing ${bridgeIdx}/${bridgeTotal}: "${bridgeTitleSlice}"`);
            try {
              if (e.kind === "article") {
                const targetPrompt = promptResults.find(p => p.promptIndex === e.promptIndex);
                if (!targetPrompt) continue;
                const slot = targetPrompt.analyses[e.articleIndex - 1];
                if (!slot) continue;
                // Phase 20B + 20C — when bridge attached a PDF but text
                // extraction returned empty (scanned/image PDF), don't silently
                // skip — surface it on the article note so the user knows the
                // upload was received but the PDF needs OCR. The old code
                // checked truthiness of attachedContent which evaluated false
                // on empty string and left the note showing the pre-bridge
                // "PDF text extraction returned empty" message indefinitely.
                if (!a.attachedContent || a.attachedContent.length < 200) {
                  // Empty-or-thin extraction: tag the article as scanned-PDF
                  // and re-write the note with that note so it stops looking
                  // like the bridge never happened. We do NOT re-run the
                  // analyzer (no content to analyze).
                  slot.article = {
                    ...slot.article,
                    _fetch_error: a.attachedContent
                      ? "thin-extraction-from-pdf"
                      : "scanned-or-image-pdf-needs-ocr",
                    _bridge_resolved_but_empty: true,
                    content: slot.article?.content || ""
                  };
                  log(`bridge attached p=${e.promptIndex} i=${e.articleIndex} but extraction returned ${a.attachedContent?.length || 0}c — flagged as scanned/thin`, "warn");
                  continue;
                }
                // Rebuild article record with new full-text content; re-run analyzer
                const newArticle = {
                  ...slot.article,
                  content: a.attachedContent,
                  _bridge_resolved: true,
                  _content_provenance: "manual-bridge"
                };
                // Clear stale fetch-error flags so the bridge-resolved article
                // is no longer treated as blocked downstream.
                delete newArticle._fetch_failed;
                delete newArticle._fetch_error;
                delete newArticle._used_libgen_fallback;
                const r = await articleAnalyzer.analyze({
                  article: newArticle,
                  topic: rawTopic,
                  topicSlug: activeSlug,
                  promptIndex: e.promptIndex,
                  articleIndex: e.articleIndex,
                  constraints
                });
                targetPrompt.analyses[e.articleIndex - 1] = { ...r, article: newArticle };
                attachedCount++;
                log(`bridge re-analyzed article p=${e.promptIndex} i=${e.articleIndex} content=${a.attachedContent.length}c facts=${r.analysis?.facts?.length}`, "info");
              } else if (e.kind === "dataset" && (a.attachedContent || a.attachedBuffer)) {
                // The user-dropped CSV/JSON content goes through tableAnalyst directly
                const targetPrompt = promptResults.find(p => p.promptIndex === e.promptIndex);
                if (!targetPrompt) continue;
                const ds = targetPrompt.datasetCitations[e.datasetIndex - 1];
                if (!ds) continue;
                // Parse using datasetHarvester's format dispatcher (re-export indirect via parsing the file)
                // For v1 we only support CSV/TSV/JSON manually-dropped (xlsx requires the lazy-load).
                let parsed = null;
                if (e.expectedFormat === "csv" || e.expectedFormat === "tsv") {
                  parsed = datasetHarvester._internals?.parseCsv?.(a.attachedContent, e.expectedFormat === "tsv" ? "\t" : ",");
                } else if (e.expectedFormat === "json") {
                  parsed = datasetHarvester._internals?.parseJsonRows?.(a.attachedContent);
                }
                if (parsed) {
                  parsed.sampling = "manual"; parsed.totalBytes = (a.attachedContent || a.attachedBuffer || "").length;
                  const assessment = await tableAnalyst.assess({ topic: rawTopic, dataset: ds, parsed });
                  if (assessment) {
                    delete ds._bridge_eligible;
                    // Append a synthetic quantitativeFinding entry so synthesis sees it
                    targetPrompt.quantitativeFindings = targetPrompt.quantitativeFindings || [];
                    targetPrompt.quantitativeFindings.push({
                      datasetId: ds.id, datasetTitle: ds.title, repository: ds.repository,
                      N: assessment.N, sampling: "manual",
                      keyVariables: assessment.key_variables,
                      hypothesis: assessment.hypothesis_to_test,
                      limitations: assessment.limitations,
                      honestyLabels: assessment.honesty_labels,
                      charts: []   // chart composition skipped on manual bridge for v1
                    });
                    attachedCount++;
                    log(`bridge re-analyzed dataset p=${e.promptIndex} i=${e.datasetIndex} N=${assessment.N}`, "info");
                  }
                }
              }
            } catch (err) {
              log(`bridge attach error for ${e.kind} p=${e.promptIndex}: ${err.message}`, "warn");
            }
          }
          await manualBridge.clearBridgeState(activeSlug);
          emitProgress(`📥 Bridge resume: ${attachedCount} source(s) re-analyzed with manual downloads`);
        } catch (err) {
          log(`manualBridge resume error: ${err.message}`, "warn");
        }
      } else if (bridgeAction === "skip") {
        await manualBridge.clearBridgeState(activeSlug);
        emitProgress(`⏭️ Skipping manual bridge — proceeding to synthesis with original sources`);
      }
    }

    // ── Step 8.5: Phase 20N — thesis-deep open-questions recursion ─────────
    // For [depth:thesis-deep] only. Picks top 4-5 questions across all prompt
    // conclusions, generates one follow-up search query, harvests +6-8
    // articles targeting those questions. Adds ~5-8 minutes to runtime.
    // Results are stashed on context for the synthesizer to fold into a new
    // "Future Directions" subsection.
    let deepFollowup = null;
    if (effectiveTier === "thesis-deep") {
      checkAborted();
      try {
        const openQuestionRecursion = await import("./openQuestionRecursion.js");
        emitProgress(`🔁 thesis-deep: running open-questions follow-up harvest…`);
        deepFollowup = await openQuestionRecursion.runDeepFollowup({
          promptResults,
          articleHarvester,
          articleAnalyzer,
          topic: rawTopic,
          topicSlug: activeSlug,
          constraints,
          emitProgress,
          signal,
        });
        if (deepFollowup) {
          log(`step=deepFollowup followupQuery="${deepFollowup.followupQuery}" articles=${deepFollowup.analyses?.length || 0}`, "info");
        }
      } catch (err) {
        log(`deepFollowup error: ${err.message}`, "warn");
      }
    }

    // ── Step 9: chunked thesis synthesis ───────────────────────────────────
    // Phase 16E — bail before the most expensive step (thesis synthesis).
    checkAborted();
    log(`step=thesisSynthesizer tier=${effectiveTier} sections=pending`, "info");
    emitProgress(`🧵 Synthesizing thesis from ${promptResults.length} prompts…`);
    let thesisInfo = null;
    try {
      thesisInfo = await thesisSynthesizer.synthesize({
        topic: rawTopic,
        topicSlug: activeSlug,
        cleanTitle,
        tier: effectiveTier,
        promptResults,
        constraints,
        onStep: emitProgress,
        // Phase 14F — pass through any "bridge skipped despite offer" notice
        // so the saved markdown gets a visible warning callout.
        bridgeSkipNotice: context._bridgeSkippedDespiteOffer || null,
        topicVaultRel: `${VAULT_JOURNAL_ROOT}/Research/${activeSlug}`,
        // Phase 16E — pass abort signal so per-section composition can bail.
        signal,
        // Phase 20N — thesis-deep recursive follow-up artifacts (null for
        // other tiers). When present, synthesizer adds a "Future Directions"
        // subsection grounded in these extra harvested articles.
        deepFollowup,
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

    // ── Step 9.5: Feed completed research back into the knowledge store ──
    // Every internal deepResearch LLM call passes skipKnowledge:true to avoid
    // polluting the knowledge graph with scaffolding calls. But the FINAL
    // synthesis IS worth remembering — the agent should know it researched
    // this topic and carry forward a one-line summary of what it learned.
    //
    // Aggregates top-level findings from each prompt's conclusion summary into
    // a single compact fact, stored with a 1-year expiry. Best-effort — never
    // blocks the pipeline.
    try {
      const topConclusions = promptResults
        .map(p => (p.conclusion?.summary || "").trim())
        .filter(Boolean)
        .slice(0, 3);
      if (topConclusions.length > 0) {
        const factBlob = topConclusions
          .map(s => s.length > 320 ? s.slice(0, 317) + "..." : s)
          .join(" | ");
        await addFact({
          topic: rawTopic,
          fact: `Researched ${effectiveTier} (${totalSources} sources): ${factBlob}`,
          source: `deepResearch:${activeSlug}`,
          ongoing: false,
          expiryDays: 365
        });
        console.log(`[deepResearch] 📚 Knowledge: stored finding for "${rawTopic.slice(0, 60)}" (${totalSources} sources, expires in 365d)`);
      } else {
        console.log(`[deepResearch] 📚 Knowledge: no usable conclusions to store — skipping addFact`);
      }
    } catch (err) {
      console.log(`[deepResearch] 📚 Knowledge: addFact failed (non-blocking): ${err.message}`);
      log(`knowledge addFact failed: ${err.message}`, "warn");
    }

    // ── Step 10: chat reply ────────────────────────────────────────────────
    emitProgress(`✅ Research saved (${thesisInfo?.wordCount || 0} words, ${totalSources} sources)`,
      { wordCount: thesisInfo?.wordCount || 0, sourceCount: totalSources });
    const finalPath = thesisInfo?.relativePath || masterInfo?.relativePath || `${VAULT_JOURNAL_ROOT}/Research/${activeSlug}/`;
    const totalDatasets = allDatasetCites.length;
    const totalCharts = allQuant.reduce((s, q) => s + (q.charts?.length || 0), 0);
    const reply = `✅ ${effectiveTier.charAt(0).toUpperCase() + effectiveTier.slice(1)} on **"${rawTopic}"** saved.\n\n` +
      `- Final write-up: \`${finalPath}\`\n` +
      `- Master rollup: \`${masterInfo?.relativePath || "(skipped)"}\`\n` +
      `- Prompts executed: ${promptResults.length}\n` +
      `- Sources harvested: ${totalSources}\n` +
      (totalDatasets > 0
        ? `- Datasets analyzed: ${totalDatasets} (${totalCharts} chart(s) generated, see \`_data.md\`)\n`
        : "") +
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

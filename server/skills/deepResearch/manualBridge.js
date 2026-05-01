// server/skills/deepResearch/manualBridge.js
// Phase 9D — Manual PDF/CSV bridge for blocked sources.
//
// When article PDFs or dataset CSVs can't be auto-fetched (paywall, JS challenge,
// 403, redirect loop, etc.), this module lets the deepResearch pipeline pause,
// surface the URL list to the user with deterministic save-as filenames, then
// resume after the user drops files into a per-research _pending/ folder.
//
// Usage from index.js (sketch):
//
//   const blocked = collectBlockedSources(promptResults);
//   if (shouldOfferBridge(blocked, tier)) {
//     await saveBridgeState(slug, { promptResults, ... });
//     const text = renderBridgeMessage(blocked, slug);
//     await setPendingQuestion(conversationId, { ... ttlMs: 60*60*1000 });
//     return { awaitingUser: true, ... };
//   }
//
// On resume, deepResearch detects the resolvedPending flag and calls:
//   const { state, attached } = await scanAndAttach(slug);
//   // attached has new content for the originally-blocked entries
//
// Files live in vault path:
//   <Vault>/Journal/Research/<slug>/_pending/
// Naming convention:
//   p<promptIndex>-article-<articleIndex>.pdf
//   p<promptIndex>-dataset-<datasetIndex>.<csv|json|tsv|xlsx>
//
// State persistence: <Vault>/Journal/Research/<slug>/.bridge-state.json
// (dot-prefixed so Obsidian hides it).

import fs from "fs/promises";
import path from "path";
import { getVaultPath, VAULT_JOURNAL_ROOT, extractPdfText, stripHtmlToText } from "../../utils/obsidianUtils.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("manualBridge", { consoleLevel: "warn" });

const BRIDGE_STATE_FILE  = ".bridge-state.json";
const PENDING_DIR_NAME   = "_pending";
const MIN_THIN_CONTENT   = 1500;     // chars — below this we suspect we got abstract-only
const MIN_BLOCKED_TO_OFFER = 2;      // don't interrupt for one isolated 403
const BRIDGE_ELIGIBLE_TIERS = new Set(["research", "thesis"]);

// ── eligibility scoring ────────────────────────────────────────────────────
/**
 * Decide whether an article counts as "blocked".
 *
 * Phase 10E — primary signal is now `_fetch_failed` (set by articleHarvester
 * when fetchPage threw or returned thin). Length-heuristic kept as a backup
 * for cases where the failure flag wasn't propagated.
 *
 * Eligibility (any path → eligible):
 *   (a) `_fetch_failed: true` AND relevance >= 0.5
 *   (b) content < 1500 chars AND relevance >= 0.6 AND URL paper-like
 * Then the article must NOT be a libgen/scihub already-tried URL.
 */
function isArticleBlocked(article, analysis) {
  const url = String(article?.url || "");
  if (!url) return false;
  if (/libgen|sci-?hub|google\.com\/scholar/i.test(url)) return false;
  const relevance = analysis?.analysis?.relevance ?? 0;
  // Path (a) — explicit fetch failure (preferred signal)
  if (article?._fetch_failed === true && relevance >= 0.5) return true;
  // Path (b) — fallback length heuristic
  const content = String(article?.content || "");
  if (content.length < MIN_THIN_CONTENT && relevance >= 0.6) return true;
  return false;
}

/**
 * A dataset is "blocked" if it has files we know about but every file failed
 * to download/parse during the run. The harvester records this in the analysis
 * record's `_bridge_eligible` flag (set by index.js when downloadAndParse
 * returns null on every file of a real dataset).
 */
function isDatasetBlocked(dsRecord) {
  if (!dsRecord) return false;
  if (dsRecord.metadataOnly) return false;
  if (!Array.isArray(dsRecord.files) || dsRecord.files.length === 0) return false;
  return dsRecord._bridge_eligible === true;
}

// ── failure collection ─────────────────────────────────────────────────────
/**
 * Walk promptResults and produce a flat list of blocked sources with
 * deterministic save-as filenames + suggested URLs.
 *
 * Returns: [{ kind, promptIndex, articleIndex|datasetId, title, url, savePath, expectedFormat }]
 */
export function collectBlockedSources(promptResults) {
  const blocked = [];
  for (const p of (promptResults || [])) {
    const promptIndex = p.promptIndex;
    // Articles
    for (let i = 0; i < (p.analyses || []).length; i++) {
      const a = p.analyses[i];
      if (!a?.article) continue;
      if (isArticleBlocked(a.article, a)) {
        blocked.push({
          kind: "article",
          promptIndex,
          articleIndex: i + 1,
          title: a.frontmatter?.title || a.article?.title || "(untitled)",
          url: a.article.url,
          savePath: `${PENDING_DIR_NAME}/p${promptIndex}-article-${i + 1}.pdf`,
          expectedFormat: "pdf"
        });
      }
    }
    // Datasets — index.js stamps `_bridge_eligible:true` on records where
    // every file failed downloadAndParse.
    for (let i = 0; i < (p.datasetCitations || []).length; i++) {
      const ds = p.datasetCitations[i];
      if (isDatasetBlocked(ds)) {
        const file = ds.files[0];
        const ext  = (file?.format || "csv").toLowerCase();
        blocked.push({
          kind: "dataset",
          promptIndex,
          datasetIndex: i + 1,
          datasetId: ds.id,
          title: ds.title,
          url: file?.downloadUrl || ds.url,
          savePath: `${PENDING_DIR_NAME}/p${promptIndex}-dataset-${i + 1}.${ext}`,
          expectedFormat: ext
        });
      }
    }
  }
  return blocked;
}

export function shouldOfferBridge(blocked, tier, override = null) {
  if (override === true) return blocked.length > 0;
  if (override === false) return false;
  if (!BRIDGE_ELIGIBLE_TIERS.has(tier)) return false;
  return blocked.length >= MIN_BLOCKED_TO_OFFER;
}

// ── presentation ───────────────────────────────────────────────────────────
/**
 * Render the user-facing message listing blocked sources with save-as paths.
 * The message is shown in chat after the harvest phase completes.
 */
export function renderBridgeMessage(blocked, slug, vaultRelativePath) {
  const groups = { article: [], dataset: [] };
  for (const b of blocked) groups[b.kind].push(b);

  const lines = [];
  lines.push(`🔒 ${blocked.length} source(s) couldn't be auto-fetched. The thesis will benefit from these — please download them manually.\n`);
  lines.push(`Drop files into: \`${vaultRelativePath}/${PENDING_DIR_NAME}/\``);
  lines.push("");

  if (groups.article.length) {
    lines.push(`**Articles (${groups.article.length}):**`);
    for (const b of groups.article) {
      const titleShort = b.title.length > 80 ? b.title.slice(0, 77) + "…" : b.title;
      lines.push(`- Prompt ${b.promptIndex}, Article ${b.articleIndex}: *${titleShort}*`);
      lines.push(`  URL: <${b.url}>`);
      lines.push(`  Save as: \`${b.savePath}\``);
    }
    lines.push("");
  }

  if (groups.dataset.length) {
    lines.push(`**Datasets (${groups.dataset.length}):**`);
    for (const b of groups.dataset) {
      const titleShort = b.title.length > 80 ? b.title.slice(0, 77) + "…" : b.title;
      lines.push(`- Prompt ${b.promptIndex}, Dataset ${b.datasetIndex}: *${titleShort}*`);
      lines.push(`  URL: <${b.url}>`);
      lines.push(`  Save as: \`${b.savePath}\` (format: ${b.expectedFormat})`);
    }
    lines.push("");
  }

  lines.push(`Reply **"continue"** when ready (60-min window), or **"skip"** to proceed without these.`);
  return lines.join("\n");
}

// ── state persistence ──────────────────────────────────────────────────────
function bridgeStatePath(slug) {
  const vault = getVaultPath();
  if (!vault) throw new Error("manualBridge: vault path not configured");
  return path.join(vault, VAULT_JOURNAL_ROOT, "Research", slug, BRIDGE_STATE_FILE);
}

function pendingDirPath(slug) {
  const vault = getVaultPath();
  if (!vault) throw new Error("manualBridge: vault path not configured");
  return path.join(vault, VAULT_JOURNAL_ROOT, "Research", slug, PENDING_DIR_NAME);
}

/**
 * Phase 11B — Strip `article.content` from analyses before serialization.
 * Article content is large (1-8KB per record), already saved as note files in
 * vault, and not needed for resume — synthesis reads from analysis.facts +
 * conclusions vector store. Round-trip lossless for the synthesizer.
 */
function stripContentForSerialization(promptResults) {
  if (!Array.isArray(promptResults)) return [];
  return promptResults.map(p => ({
    ...p,
    analyses: (p.analyses || []).map(a => {
      if (!a) return a;
      // Strip article.content but preserve url, _fetch_failed, etc.
      const article = a.article ? { ...a.article } : null;
      if (article) delete article.content;
      return { ...a, article };
    })
  }));
}

export async function saveBridgeState(slug, state) {
  const p = bridgeStatePath(slug);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Phase 11B — slim promptResults if present (strip article.content blobs)
  const slim = state.promptResults ? stripContentForSerialization(state.promptResults) : null;
  const payload = { ...state, savedAt: new Date().toISOString() };
  if (slim) payload.promptResults = slim;
  await fs.writeFile(p, JSON.stringify(payload, null, 2), "utf8");
  // Also pre-create the _pending/ folder + a README so the user knows where to drop files.
  const pendingDir = pendingDirPath(slug);
  await fs.mkdir(pendingDir, { recursive: true });
  const readmePath = path.join(pendingDir, "README.md");
  const readme = `# Manual download drop folder

The deepResearch run for "${slug}" couldn't fetch some sources automatically.
Save the files here with the exact filenames listed in the chat message,
then reply "continue" in the chat to resume.

Files in this folder are matched by name, e.g.:
- \`p1-article-5.pdf\` → re-analyzed for prompt 1, article slot 5
- \`p3-dataset-2.csv\` → re-analyzed for prompt 3, dataset slot 2

After resume, this folder is automatically cleaned up.
`;
  try { await fs.writeFile(readmePath, readme, "utf8"); } catch { /* best effort */ }
  log(`saved bridge state for "${slug}"`, "info");
  return p;
}

/**
 * Phase 11B — Integrity check before short-circuiting harvest.
 *
 * The state file is a snapshot but the WORLD on disk may have changed:
 *   - vector collections may have been cleared by a maintenance task
 *   - vault folder may have been moved
 *   - article note files may have been deleted manually
 *
 * Returns `{ ok: bool, issues: string[] }`. If any vector collection went
 * missing, the caller can re-run conclusionWriter just for affected prompts
 * (cheap — ~30s) instead of falling back to full pipeline re-run.
 */
export async function verifyBridgeState(state) {
  const issues = [];
  if (!state || !state.slug) {
    return { ok: false, issues: ["state missing slug"] };
  }
  if (!Array.isArray(state.promptResults) || state.promptResults.length === 0) {
    return { ok: false, issues: ["state missing promptResults"] };
  }

  // 1. Vault folder still exists at expected path
  try {
    const vault = getVaultPath();
    if (!vault) issues.push("vault path not configured");
    else {
      const folder = path.join(vault, VAULT_JOURNAL_ROOT, "Research", state.slug);
      const stat = await fs.stat(folder).catch(() => null);
      if (!stat || !stat.isDirectory()) issues.push(`research folder missing: ${folder}`);
    }
  } catch (err) {
    issues.push(`vault check: ${err.message}`);
  }

  // 2. Vector collections — ping each prompt's conclusionsCollection.
  // Lazy-import vectorStore to avoid circular deps + because it's optional.
  const missingCollections = [];
  try {
    const { vectorSearch } = await import("../../utils/vectorStore.js");
    for (const p of state.promptResults) {
      const cn = p.collectionName;
      if (!cn) continue;
      try {
        const r = await vectorSearch(cn, "ping", 1);
        if (!Array.isArray(r) || r.length === 0) missingCollections.push(cn);
      } catch {
        missingCollections.push(cn);
      }
    }
  } catch (err) {
    // vectorStore unavailable — non-fatal, mark for full pipeline if synthesis depends on RAG
    issues.push(`vectorStore check skipped: ${err.message}`);
  }

  // Vector misses are RECOVERABLE (caller can rebuild) — flag separately
  return {
    ok: issues.length === 0,
    issues,
    missingCollections,
    canRecoverFromCollectionLoss: missingCollections.length > 0 && issues.length === 0
  };
}

export async function loadBridgeState(slug) {
  try {
    const p = bridgeStatePath(slug);
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") log(`loadBridgeState failed: ${err.message}`, "warn");
    return null;
  }
}

export async function clearBridgeState(slug) {
  try {
    await fs.unlink(bridgeStatePath(slug));
  } catch { /* ignore */ }
  // Also clean the _pending/ folder contents (keep folder + README)
  try {
    const dir = pendingDirPath(slug);
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (f === "README.md") continue;
      try { await fs.unlink(path.join(dir, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── file attach (post-resume) ──────────────────────────────────────────────
/**
 * Scan the _pending/ folder. For each blocked entry whose savePath exists,
 * read the file content and return it keyed by the entry. Caller is
 * responsible for re-running articleAnalyzer / tableAnalyst on the new content.
 *
 * @returns Promise<Array<{ entry, attachedContent, attachedBuffer, attachedFormat, exists }>>
 */
export async function scanAndAttach(slug, blocked) {
  const dir = pendingDirPath(slug);
  let dirEntries = [];
  try {
    dirEntries = await fs.readdir(dir);
  } catch (err) {
    log(`scanAndAttach: _pending/ dir missing (${err.message})`, "warn");
    return blocked.map(entry => ({ entry, exists: false }));
  }
  const dirSet = new Set(dirEntries.map(f => f.toLowerCase()));

  const out = [];
  for (const entry of blocked) {
    const fileName = path.basename(entry.savePath);
    if (!dirSet.has(fileName.toLowerCase())) {
      out.push({ entry, exists: false });
      continue;
    }
    const fullPath = path.join(dir, fileName);
    try {
      if (entry.expectedFormat === "pdf") {
        // Use the existing PDF text extractor
        const text = await extractPdfText(fullPath);
        out.push({
          entry,
          exists: true,
          attachedContent: text,
          attachedBuffer: null,
          attachedFormat: "pdf"
        });
      } else {
        // CSV/TSV/JSON/XLSX — read as buffer, let datasetHarvester.parseByFormat handle it
        const buffer = await fs.readFile(fullPath);
        const text = (entry.expectedFormat === "xlsx" || entry.expectedFormat === "xls")
          ? null
          : buffer.toString("utf8");
        out.push({
          entry,
          exists: true,
          attachedContent: text,
          attachedBuffer: buffer,
          attachedFormat: entry.expectedFormat
        });
      }
      log(`attached ${fileName} → prompt=${entry.promptIndex} ${entry.kind}=${entry.articleIndex || entry.datasetIndex}`, "info");
    } catch (err) {
      log(`scanAndAttach: ${fileName} read failed: ${err.message}`, "warn");
      out.push({ entry, exists: false, error: err.message });
    }
  }
  return out;
}

export const _internals = {
  isArticleBlocked,
  isDatasetBlocked,
  MIN_THIN_CONTENT,
  MIN_BLOCKED_TO_OFFER,
  BRIDGE_ELIGIBLE_TIERS,
  PENDING_DIR_NAME
};

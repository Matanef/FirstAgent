// server/skills/gitPulse.js
// Git analysis skill — commit history, diff analysis, impact reports, Mermaid diagrams
// Part of the Obsidian Knowledge OS

import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";
import { llm } from "../tools/llm.js";
import { getVaultPath, writeNote, buildFrontmatter } from "../utils/obsidianUtils.js";

const execAsync = promisify(exec);
const TOOL_NAME = "gitPulse";
const MAX_COMMITS = 20;
const MAX_DIFF_CHARS_PER_FILE = 3000;

/**
 * Git Pulse skill — analyzes git history and generates impact reports.
 *
 * @param {string|Object} request - User input or {text, context}
 * @returns {Object} Standard tool response
 */
export async function gitPulse(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};

    // Determine repo path
    const repoPath = context.repoPath || PROJECT_ROOT;

    // Parse timeframe from text
    const since = parseTimeframe(text);

    // Step 1: Fetch git log
    const commits = await fetchGitLog(repoPath, since);
    if (commits.length === 0) {
      return {
        tool: TOOL_NAME,
        success: true,
        final: true,
        data: {
          text: `No commits found since ${since}. The repo has been quiet! 🤫`,
          preformatted: true,
        },
      };
    }

    // Step 2: Fetch diffs for each commit (capped)
    const diffs = await fetchDiffs(repoPath, commits.slice(0, MAX_COMMITS));

    // Step 3: LLM impact analysis
    const analysis = await analyzeImpact(commits, diffs);

    // Step 4: Generate Mermaid diagrams
    const mermaid = generateMermaidDiagrams(commits, diffs);

    // Step 5: Build report
    const report = buildReport(commits, diffs, analysis, mermaid, since);

    // Step 6: Write to vault if configured
    let vaultPath = null;
    const vault = getVaultPath();
    if (vault) {
      const dateStr = new Date().toISOString().slice(0, 10);
      const notePath = `Engineering/Git-Pulse-${dateStr}.md`;
      const frontmatter = buildFrontmatter({
        title: `"Git Pulse — ${dateStr}"`,
        type: "git-pulse",
        created: new Date().toISOString(),
        since,
        commits: commits.length,
        tags: ["engineering", "git-pulse"],
      });
      await writeNote(notePath, frontmatter + report);
      vaultPath = notePath;
    }

    return {
      tool: TOOL_NAME,
      success: true,
      final: true,
      data: {
        text: report,
        preformatted: true,
        commitCount: commits.length,
        vaultPath,
      },
    };
  } catch (err) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Action failed: ${err.message}`,
    };
  }
}

// ============================================================
// TIMEFRAME PARSING
// ============================================================

function parseTimeframe(text) {
  const lower = text.toLowerCase();

  // "last N days/hours/weeks"
  const lastMatch = lower.match(/last\s+(\d+)\s+(day|hour|week|month)s?/);
  if (lastMatch) {
    const n = parseInt(lastMatch[1]);
    const unit = lastMatch[2];
    const multipliers = { hour: 3600, day: 86400, week: 604800, month: 2592000 };
    const seconds = n * (multipliers[unit] || 86400);
    const date = new Date(Date.now() - seconds * 1000);
    return date.toISOString().slice(0, 10);
  }

  // "today"
  if (/\btoday\b/.test(lower)) {
    return new Date().toISOString().slice(0, 10);
  }

  // "yesterday"
  if (/\byesterday\b/.test(lower)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // "this week"
  if (/\bthis\s+week\b/.test(lower)) {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
  }

  // "this month"
  if (/\bthis\s+month\b/.test(lower)) {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  }

  // Default: last 7 days
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// GIT DATA FETCHING
// ============================================================

async function fetchGitLog(repoPath, since) {
  try {
    const { stdout } = await execAsync(
      `git log --since="${since}" --pretty=format:"%H|%an|%ad|%s" --date=short`,
      { cwd: repoPath, maxBuffer: 5 * 1024 * 1024 }
    );

    if (!stdout.trim()) return [];

    return stdout.trim().split("\n").map(line => {
      const [hash, author, date, ...msgParts] = line.split("|");
      return { hash, author, date, message: msgParts.join("|") };
    });
  } catch (err) {
    throw new Error(`Git log failed: ${err.message}`);
  }
}

async function fetchDiffs(repoPath, commits) {
  const diffs = [];

  for (const commit of commits) {
    try {
      // Get file list for this commit
      const { stdout: files } = await execAsync(
        `git diff-tree --no-commit-id --name-status -r ${commit.hash}`,
        { cwd: repoPath, maxBuffer: 2 * 1024 * 1024 }
      );

      // Get actual diff (capped)
      const { stdout: diff } = await execAsync(
        `git diff ${commit.hash}~1..${commit.hash} --stat`,
        { cwd: repoPath, maxBuffer: 2 * 1024 * 1024 }
      ).catch(() => ({ stdout: "(initial commit or merge)" }));

      // Get detailed diff for changed files (capped per file)
      let detailedDiff = "";
      try {
        const { stdout: fullDiff } = await execAsync(
          `git diff ${commit.hash}~1..${commit.hash}`,
          { cwd: repoPath, maxBuffer: 5 * 1024 * 1024 }
        );
        // Cap total diff size
        detailedDiff = fullDiff.slice(0, MAX_DIFF_CHARS_PER_FILE * 5);
      } catch {
        detailedDiff = "(diff unavailable)";
      }

      const changedFiles = files.trim().split("\n").filter(Boolean).map(line => {
        const [status, ...pathParts] = line.split("\t");
        return { status: status.trim(), file: pathParts.join("\t").trim() };
      });

      diffs.push({
        hash: commit.hash,
        stat: diff.trim(),
        changedFiles,
        detailedDiff,
      });
    } catch {
      diffs.push({ hash: commit.hash, stat: "(unavailable)", changedFiles: [], detailedDiff: "" });
    }
  }

  return diffs;
}

// ============================================================
// LLM IMPACT ANALYSIS
// ============================================================

async function analyzeImpact(commits, diffs) {
  // Build a compact summary of changes for LLM
  const changesSummary = commits.slice(0, 10).map((c, i) => {
    const d = diffs[i];
    const files = d?.changedFiles?.map(f => `${f.status} ${f.file}`).join(", ") || "unknown";
    return `• ${c.message} (${c.author}, ${c.date}) — Files: ${files}`;
  }).join("\n");

  // Cap diff content for LLM context
  const diffExcerpt = diffs.slice(0, 5).map(d => d.detailedDiff).join("\n").slice(0, 4000);

  try {
    const result = await llm(
      `Analyze these git changes and provide:
1. **Summary** (2-3 sentences of what happened overall)
2. **Architecture Impact** for each major change (none/low/medium/high)
3. **Risk Assessment** — any changes that could cause issues
4. **Notable Patterns** — refactors, new features, bug fixes, etc.

Recent commits:
${changesSummary}

Diff excerpt:
${diffExcerpt}

Provide your analysis:`,
      { skipLanguageDetection: true, timeoutMs: 60000 }
    );

    return result?.data?.text || "Analysis unavailable.";
  } catch {
    return "LLM analysis skipped (model unavailable or timed out).";
  }
}

// ============================================================
// MERMAID DIAGRAM GENERATION
// ============================================================

function generateMermaidDiagrams(commits, diffs) {
  const diagrams = [];

  // 1. Git graph — simplified commit history
  if (commits.length > 0) {
    const gitGraph = ["```mermaid", "gitGraph"];
    const seen = new Set();

    for (const commit of commits.slice(0, 15).reverse()) {
      const shortMsg = commit.message.slice(0, 40).replace(/"/g, "'");
      if (!seen.has(shortMsg)) {
        gitGraph.push(`  commit id: "${shortMsg}"`);
        seen.add(shortMsg);
      }
    }
    gitGraph.push("```");
    diagrams.push(gitGraph.join("\n"));
  }

  // 2. File change heatmap as pie chart
  const fileCounts = {};
  for (const d of diffs) {
    for (const f of d.changedFiles || []) {
      // Get top-level folder
      const folder = f.file.includes("/") ? f.file.split("/")[0] : "(root)";
      fileCounts[folder] = (fileCounts[folder] || 0) + 1;
    }
  }

  if (Object.keys(fileCounts).length > 1) {
    const pie = ["```mermaid", 'pie title "Changes by Directory"'];
    const sorted = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [folder, count] of sorted) {
      pie.push(`  "${folder}" : ${count}`);
    }
    pie.push("```");
    diagrams.push(pie.join("\n"));
  }

  return diagrams.join("\n\n");
}

// ============================================================
// REPORT BUILDER
// ============================================================

function buildReport(commits, diffs, analysis, mermaid, since) {
  const sections = [];

  sections.push(`# 🔬 Git Pulse Report`);
  sections.push(`> Period: since ${since} | ${commits.length} commits\n`);

  // Summary section
  sections.push(`## 📊 Overview`);
  sections.push(analysis);

  // Commits list
  sections.push(`\n## 📝 Commits`);
  for (const commit of commits.slice(0, MAX_COMMITS)) {
    const shortHash = commit.hash.slice(0, 7);
    sections.push(`- \`${shortHash}\` **${commit.message}** — ${commit.author} (${commit.date})`);
  }
  if (commits.length > MAX_COMMITS) {
    sections.push(`\n_...and ${commits.length - MAX_COMMITS} more commits_`);
  }

  // Changed files summary
  sections.push(`\n## 📁 Files Changed`);
  const allFiles = new Map();
  for (const d of diffs) {
    for (const f of d.changedFiles || []) {
      const key = f.file;
      if (!allFiles.has(key)) allFiles.set(key, []);
      allFiles.get(key).push(f.status);
    }
  }

  const statusEmoji = { A: "🆕", M: "✏️", D: "🗑️", R: "🔄" };
  for (const [file, statuses] of [...allFiles.entries()].slice(0, 30)) {
    const emoji = statusEmoji[statuses[0]] || "📄";
    const count = statuses.length > 1 ? ` (${statuses.length}x)` : "";
    sections.push(`- ${emoji} \`${file}\`${count}`);
  }

  // Diagrams
  if (mermaid) {
    sections.push(`\n## 📈 Diagrams`);
    sections.push(mermaid);
  }

  // Doc sync warnings (placeholder for vault integration)
  const vault = getVaultPath();
  if (vault) {
    sections.push(`\n## 🔗 Documentation Sync`);
    sections.push(`> [!tip] Run "populate stubs" to auto-fill any new concept stubs created by this report.`);
  }

  return sections.join("\n");
}

// Self-registered routing rule — picked up by loadSkills() in executor.js
export const ROUTING = {
  tool: "gitPulse",
  priority: 74,
  match: (lower) =>
    /\b(git\s*pulse|code\s+report|engineering\s+review)\b/i.test(lower) ||
    (/\b(what\s+changed|what'?s\s+changed|what\s+happened)\b/i.test(lower) && /\b(code|repo|commit|git|today|this\s+week|yesterday|last\s+\d+\s+days?)\b/i.test(lower)),
  guard: (lower) =>
    /\b(git\s+(add|commit|push|pull|checkout|branch|merge|stash|rebase|reset|status|log|diff|clone|init|fetch|tag|remote))\b/i.test(lower) &&
    !/\b(report|review|analysis|pulse|summary|overview)\b/i.test(lower),
  description: "Git Pulse — commit analysis, impact reports, Mermaid diagrams"
};

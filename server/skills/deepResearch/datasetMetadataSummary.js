// server/skills/deepResearch/datasetMetadataSummary.js
// Phase 20J — dataset metadata-only summary extraction.
//
// When the deepResearch run retrieves N datasets but ALL are metadata-only
// (no parseable rows or files), we previously prepended a "no charts" note
// and moved on. The user pointed out that even metadata-only catalog records
// have value: study counts, sample sizes, intervention types, year ranges.
// This module extracts that structured info and renders a callout that
// REPLACES the no-charts note, surfacing what the datasets actually contributed.
//
// Allowed dependencies: node built-ins only.

/**
 * Inspect a flat list of dataset citation records (the shape produced by
 * datasetHarvester) and return a structured summary or null if there's
 * nothing useful to report.
 *
 * Input record shape (datasetHarvester output):
 *   {
 *     id, title, repository, year, url,
 *     metadataOnly: boolean,
 *     authors?: string[], doi?: string,
 *     description?: string,
 *     // (for parseable datasets, additional fields exist but we ignore them here)
 *   }
 *
 * Returns:
 *   { totalCount, byRepository: {repo: N}, yearRange: {min, max} | null,
 *     topInterventions: string[], topConditions: string[], totalN: number | null,
 *     studyTypes: string[] }
 */
export function buildDatasetMetadataSummary(datasetCitations) {
  if (!Array.isArray(datasetCitations) || datasetCitations.length === 0) {
    return null;
  }

  const totalCount = datasetCitations.length;
  const byRepository = {};
  const years = [];
  const titles = [];
  const descriptions = [];
  let totalN = 0;
  let nWithSampleSize = 0;

  for (const ds of datasetCitations) {
    const repo = String(ds.repository || ds.provider || "unknown").toLowerCase();
    byRepository[repo] = (byRepository[repo] || 0) + 1;
    if (Number.isFinite(Number(ds.year))) years.push(Number(ds.year));
    if (ds.title) titles.push(String(ds.title));
    if (ds.description) descriptions.push(String(ds.description));
    // Look for a sample-size mention in the title / description: "N=240", "n=12", "1,234 participants"
    const blob = `${ds.title || ""} ${ds.description || ""}`;
    const nMatch = blob.match(/\bN\s*=\s*(\d{1,6})\b/i) ||
                   blob.match(/\b(\d{1,3}(?:,\d{3})+|\d{2,6})\s+(?:participants|patients|subjects|adults|adolescents|children|individuals)\b/i);
    if (nMatch) {
      const n = parseInt(String(nMatch[1]).replace(/,/g, ""), 10);
      if (Number.isFinite(n) && n > 0 && n < 1_000_000) {
        totalN += n;
        nWithSampleSize++;
      }
    }
  }

  const yearRange = years.length > 0
    ? { min: Math.min(...years), max: Math.max(...years) }
    : null;

  // Intervention/condition keyword counts across all titles + descriptions.
  // Curated lists — cheap heuristic, no LLM, no NER.
  const blob = (titles.join(" ") + " " + descriptions.join(" ")).toLowerCase();
  const INTERVENTION_TERMS = [
    "cbt", "cbt-i", "cbt-e", "tf-cbt", "mbct", "act", "dbt",
    "exposure therapy", "cognitive restructuring", "mindfulness",
    "behavioral activation", "psychoeducation", "ssri", "fluoxetine",
    "internet-delivered cbt", "digital cbt", "online cbt",
    "trauma-focused cbt", "prolonged exposure", "emdr",
  ];
  const CONDITION_TERMS = [
    "depression", "anxiety", "ptsd", "ocd", "insomnia", "eating disorder",
    "anorexia", "bulimia", "binge-eating", "social anxiety", "panic",
    "substance use", "addiction", "phobia", "stress", "burnout",
    "adhd", "autism", "psychosis", "bipolar", "schizophrenia",
    "chronic pain", "migraine", "tinnitus",
  ];
  const STUDY_TYPE_TERMS = [
    "randomized controlled trial", "rct", "systematic review", "meta-analysis",
    "cohort study", "case-control", "pilot study", "feasibility", "protocol",
    "qualitative", "longitudinal",
  ];

  const countOccurrences = (terms) => {
    const out = [];
    for (const term of terms) {
      const re = new RegExp(`\\b${term.replace(/[-]/g, "[\\s\\-]")}\\b`, "gi");
      const m = blob.match(re);
      if (m && m.length > 0) out.push({ term, count: m.length });
    }
    return out.sort((a, b) => b.count - a.count);
  };

  const topInterventions = countOccurrences(INTERVENTION_TERMS).slice(0, 5).map(x => x.term);
  const topConditions = countOccurrences(CONDITION_TERMS).slice(0, 5).map(x => x.term);
  const studyTypes = countOccurrences(STUDY_TYPE_TERMS).slice(0, 3).map(x => x.term);

  return {
    totalCount,
    byRepository,
    yearRange,
    topInterventions,
    topConditions,
    studyTypes,
    totalN: nWithSampleSize > 0 ? totalN : null,
    nWithSampleSize,
  };
}

/**
 * Render the summary as a Markdown callout (Obsidian note-style). This
 * REPLACES the "no charts in this run" message when datasets exist but
 * none are chartable.
 *
 * Returns: a string with trailing newlines, ready to prepend to the draft.
 *          Or empty string if summary is empty / not useful.
 */
export function renderDatasetMetadataSummary(summary, { topicSlug = "" } = {}) {
  if (!summary || summary.totalCount === 0) return "";

  const lines = [];
  lines.push(`> [!info] Datasets contributed (metadata-only — no charts this run)`);
  lines.push(`> ${summary.totalCount} dataset(s) were retrieved across the run. Their files were not parseable (Dryad files require auth, OpenAlex returns catalog records only, etc.) so no charts were generated — but the metadata below was extracted from titles and descriptions to give a high-level view of what the dataset corpus covered.`);
  lines.push(`>`);

  // Repository breakdown
  const repoEntries = Object.entries(summary.byRepository)
    .sort((a, b) => b[1] - a[1])
    .map(([repo, n]) => `**${repo}** (${n})`);
  if (repoEntries.length > 0) {
    lines.push(`> **Repositories:** ${repoEntries.join(", ")}`);
  }

  // Year range
  if (summary.yearRange) {
    lines.push(`> **Year range:** ${summary.yearRange.min}–${summary.yearRange.max}`);
  }

  // Sample sizes
  if (summary.totalN !== null && summary.nWithSampleSize > 0) {
    lines.push(`> **Aggregate sample size:** ${summary.totalN.toLocaleString()} participants across ${summary.nWithSampleSize} dataset(s) reporting N`);
  }

  // Study types
  if (summary.studyTypes.length > 0) {
    lines.push(`> **Study types:** ${summary.studyTypes.join(", ")}`);
  }

  // Interventions / conditions
  if (summary.topInterventions.length > 0) {
    lines.push(`> **Top interventions mentioned:** ${summary.topInterventions.join(", ")}`);
  }
  if (summary.topConditions.length > 0) {
    lines.push(`> **Top conditions covered:** ${summary.topConditions.join(", ")}`);
  }

  lines.push(`>`);
  lines.push(`> For full per-dataset records, see \`_data.md\` in the research folder.`);
  lines.push(``);
  lines.push(``);

  return lines.join("\n");
}

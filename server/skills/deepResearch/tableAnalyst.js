// server/skills/deepResearch/tableAnalyst.js
// Phase 7B — Schema sniff + LLM-assisted analytical assessment.
//
// Architecture:
//   downloadAndParse(file) → { rows, headers, sampling }     (datasetHarvester)
//                          ↓
//   sniffSchema(rows, headers) → { columns, summary, sampleRows }
//                          ↓
//   askLLMForAssessment() → { relevant, suggested_charts, hypothesis_to_test, limitations }
//                          ↓
//   applyHonestyRails() → forces "underpowered N=…" / "no causal claim" / "high missingness" labels
//                          ↓
//   assess() returns the merged analytical record for chartComposer + synthesizer.
//
// The LLM never computes statistics — only interprets them and suggests which
// columns to chart. All numbers come from deterministic JS over the full row data.

import { llm } from "../../tools/llm.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tableAnalyst", { consoleLevel: "warn" });
const SYNTH_MODEL = process.env.SYNTHESIZER_MODEL || "qwen2.5:7b";

// Honesty thresholds — applied AFTER the LLM, so the LLM cannot suppress them.
const HONESTY = {
  UNDERPOWERED_N: 30,
  HIGH_MISSING_PCT: 0.20,
  CONTROL_KEYWORDS: /\b(control|placebo|comparison|untreated|baseline)\b/i
};

// ── schema sniff ────────────────────────────────────────────────────────────
function isNumeric(v) {
  if (v === null || v === undefined || v === "") return false;
  const s = typeof v === "string" ? v.replace(/,/g, "").trim() : v;
  if (s === "" || s === null) return false;
  return !Number.isNaN(Number(s));
}
function asNumber(v) {
  if (typeof v === "number") return v;
  return Number(String(v).replace(/,/g, "").trim());
}
function isDateLike(v) {
  if (!v) return false;
  const s = String(v).trim();
  if (s.length < 4 || s.length > 30) return false;
  // Match YYYY, YYYY-MM, YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY etc.
  return /^(\d{4}(-\d{1,2}(-\d{1,2})?)?|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})$/.test(s) ||
    !Number.isNaN(Date.parse(s));
}

function classifyColumn(values) {
  // Drop empty cells for type detection
  const nonEmpty = values.filter(v => v !== null && v !== undefined && v !== "");
  if (nonEmpty.length === 0) return { type: "empty", missing_pct: 1 };
  const missing_pct = 1 - nonEmpty.length / values.length;

  const numCount = nonEmpty.filter(isNumeric).length;
  const dateCount = nonEmpty.filter(isDateLike).length;
  const numRatio = numCount / nonEmpty.length;
  const dateRatio = dateCount / nonEmpty.length;

  if (dateRatio > 0.85) return { type: "date", missing_pct };
  if (numRatio > 0.85) return { type: "numeric", missing_pct };

  // Categorical if low cardinality, else free text.
  const unique = new Set(nonEmpty.map(v => String(v).trim()));
  if (unique.size <= Math.max(20, Math.floor(nonEmpty.length * 0.05))) {
    return { type: "categorical", missing_pct, cardinality: unique.size };
  }
  return { type: "text", missing_pct, cardinality: unique.size };
}

function summarizeNumeric(values) {
  const nums = values.filter(isNumeric).map(asNumber).filter(n => Number.isFinite(n));
  const n = nums.length;
  if (n === 0) return { n: 0 };
  nums.sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? nums[(n - 1) / 2] : (nums[n / 2 - 1] + nums[n / 2]) / 2;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1);
  const sd = Math.sqrt(variance);
  return {
    n,
    mean: round(mean),
    median: round(median),
    sd: round(sd),
    min: round(nums[0]),
    max: round(nums[n - 1])
  };
}

function summarizeCategorical(values, top = 10) {
  const counts = new Map();
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    const k = String(v).trim();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    n_unique: counts.size,
    top: sorted.slice(0, top).map(([value, count]) => ({ value, count }))
  };
}

function round(n) { return Math.round(n * 1000) / 1000; }

/**
 * Compute schema + summary stats for every column in a parsed dataset.
 * Pure JS, no LLM. Operates on the full row set (or stratified-sampled rows).
 */
export function sniffSchema(parsed) {
  if (!parsed || !Array.isArray(parsed.rows) || !Array.isArray(parsed.headers)) return null;
  const { rows, headers } = parsed;
  const N = rows.length;
  const columns = [];
  for (const h of headers) {
    const values = rows.map(r => r[h]);
    const cls = classifyColumn(values);
    const col = { name: h, type: cls.type, missing_pct: round(cls.missing_pct) };
    if (cls.cardinality !== undefined) col.cardinality = cls.cardinality;
    if (cls.type === "numeric") Object.assign(col, summarizeNumeric(values));
    else if (cls.type === "categorical") Object.assign(col, summarizeCategorical(values));
    columns.push(col);
  }
  // 5 representative sample rows for the LLM (first, 25%, 50%, 75%, last).
  const sampleIdx = N <= 5
    ? rows.map((_, i) => i)
    : [0, Math.floor(N / 4), Math.floor(N / 2), Math.floor((3 * N) / 4), N - 1];
  const sampleRows = sampleIdx.map(i => rows[i]);
  return { N, columns, sampleRows };
}

// ── LLM assessment pass ─────────────────────────────────────────────────────
function buildPrompt(topic, dataset, schema) {
  const colSummary = schema.columns.map(c => {
    if (c.type === "numeric") {
      return `  - ${c.name} (numeric): n=${c.n}, mean=${c.mean}, median=${c.median}, sd=${c.sd}, range=[${c.min}, ${c.max}], missing=${(c.missing_pct * 100).toFixed(1)}%`;
    }
    if (c.type === "categorical") {
      const top = (c.top || []).slice(0, 5).map(t => `${t.value}(${t.count})`).join(", ");
      return `  - ${c.name} (categorical, ${c.n_unique} unique): top=[${top}], missing=${(c.missing_pct * 100).toFixed(1)}%`;
    }
    if (c.type === "date") return `  - ${c.name} (date): missing=${(c.missing_pct * 100).toFixed(1)}%`;
    return `  - ${c.name} (${c.type})`;
  }).join("\n");

  const sampleRowsText = schema.sampleRows.slice(0, 5).map((r, i) => {
    const flat = Object.entries(r).slice(0, 12).map(([k, v]) => `${k}="${String(v).slice(0, 40)}"`).join(", ");
    return `  Row ${i + 1}: ${flat}`;
  }).join("\n");

  return `You are an empirical research analyst. A dataset has been retrieved that may relate to the research topic. Your job: read the schema (computed deterministically over all rows) and decide whether and how to analyze it.

RESEARCH TOPIC: "${topic}"

DATASET: "${dataset.title}"
REPOSITORY: ${dataset.repository}
DESCRIPTION: ${(dataset.description || "(no description)").slice(0, 400)}
TOTAL ROWS: ${schema.N}

COLUMN SCHEMA + SUMMARY STATISTICS (computed over all rows):
${colSummary}

5 SAMPLE ROWS (so you can see what values look like — do NOT compute stats from these):
${sampleRowsText}

Decide:
1. Is this dataset RELEVANT to the research topic? (relevance_score 0-1)
2. If yes, which 1-3 charts would surface the most analytically interesting finding?
   - Choose chart type: "bar" | "line" | "pie" | "scatter" | "area"
   - x_col: column for the X axis (must be a column NAME from the schema above)
   - y_col: column for the Y axis (numeric column NAME)
   - group_by_col: optional categorical column to group/color by
   - agg: aggregation method — "mean" | "sum" | "count" | "freq"
   - why: 1 sentence on what the chart would reveal
3. State a specific HYPOTHESIS this dataset could test, in the agent's own words.
4. List statistical/methodological LIMITATIONS you notice (sample size, no control, missingness, etc.).

OUTPUT JSON ONLY (no markdown, no commentary):
{
  "relevant": true|false,
  "relevance_score": 0.0-1.0,
  "key_variables": ["col1", "col2"],
  "suggested_charts": [
    { "type": "bar", "x_col": "...", "y_col": "...", "group_by_col": "...optional...", "agg": "mean", "why": "..." }
  ],
  "hypothesis_to_test": "...",
  "limitations": "..."
}`;
}

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function askLLMForAssessment(topic, dataset, schema) {
  const prompt = buildPrompt(topic, dataset, schema);
  try {
    const res = await llm(prompt, {
      timeoutMs: 90000,
      format: "json",
      model: SYNTH_MODEL,
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.25, num_ctx: 6144, num_predict: 800 }
    });
    const parsed = safeJsonParse(res?.data?.text || "");
    return parsed;
  } catch (err) {
    log(`LLM assessment failed for ${dataset.id}: ${err.message}`, "warn");
    return null;
  }
}

// ── honesty rails ───────────────────────────────────────────────────────────
function buildHonestyLabels(schema, datasetMeta) {
  const labels = [];
  if (schema.N < HONESTY.UNDERPOWERED_N) {
    labels.push(`exploratory only, underpowered (N=${schema.N})`);
  }

  // Detect missing control / comparison group
  const hasControl = schema.columns.some(c =>
    c.type === "categorical" && (c.top || []).some(t => HONESTY.CONTROL_KEYWORDS.test(t.value))
  );
  if (!hasControl) {
    labels.push("descriptive, no causal claim — no control group identified");
  }

  // Flag any numeric/categorical column with high missingness
  const highMissing = schema.columns
    .filter(c => c.missing_pct > HONESTY.HIGH_MISSING_PCT)
    .map(c => `${c.name} (${(c.missing_pct * 100).toFixed(0)}% missing)`);
  if (highMissing.length) {
    labels.push(`high missingness: ${highMissing.slice(0, 3).join(", ")}`);
  }

  // Metadata-only sources
  if (datasetMeta?.metadataOnly) {
    labels.push("metadata-only — rows not retrieved (cited for methodological rigor)");
  }
  return labels;
}

// ── public entry ────────────────────────────────────────────────────────────
/**
 * Run the full assessment pipeline on a parsed dataset.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {Dataset} args.dataset       record from datasetHarvester.harvest()
 * @param {object} args.parsed         { headers, rows, sampling, totalBytes } from datasetHarvester.downloadAndParse()
 * @returns {Promise<{
 *   relevant: boolean,
 *   relevance_score: number,
 *   schema: object,
 *   key_variables: string[],
 *   suggested_charts: object[],
 *   hypothesis_to_test: string,
 *   limitations: string,
 *   honesty_labels: string[],
 *   sampling: string,
 *   N: number
 * } | null>}
 */
export async function assess({ topic, dataset, parsed }) {
  // Metadata-only datasets skip schema sniffing — we still produce a record so
  // the synthesizer can cite them, but with empty stats.
  if (!parsed || dataset.metadataOnly) {
    const honesty = buildHonestyLabels({ N: 0, columns: [] }, dataset);
    return {
      relevant: true,                 // assume metadata-only sources are relevant if harvester returned them
      relevance_score: 0.5,           // mid-tier — they're cited but not analyzed
      schema: null,
      key_variables: [],
      suggested_charts: [],
      hypothesis_to_test: "",
      limitations: "Rows not retrieved for this dataset; only methodology metadata is cited.",
      honesty_labels: honesty,
      sampling: "none",
      N: 0,
      metadataOnly: true
    };
  }

  const schema = sniffSchema(parsed);
  if (!schema) {
    log(`schema sniff failed for ${dataset.id}`, "warn");
    return null;
  }
  console.log(`[tableAnalyst] ${dataset.id}: schema sniffed — N=${schema.N}, cols=${schema.columns.length}, sampling=${parsed.sampling}`);

  const llmResult = await askLLMForAssessment(topic, dataset, schema);
  if (!llmResult) {
    log(`${dataset.id}: LLM returned null — recording as descriptive-only`, "warn");
    return {
      relevant: true,
      relevance_score: 0.4,
      schema,
      key_variables: schema.columns.filter(c => c.type === "numeric").map(c => c.name).slice(0, 3),
      suggested_charts: [],
      hypothesis_to_test: "",
      limitations: "LLM assessment unavailable; descriptive statistics only.",
      honesty_labels: buildHonestyLabels(schema, dataset),
      sampling: parsed.sampling,
      N: schema.N
    };
  }

  if (llmResult.relevant === false || (llmResult.relevance_score || 0) < 0.3) {
    console.log(`[tableAnalyst] ${dataset.id}: LLM judged not relevant (score=${llmResult.relevance_score}) — dropping`);
    return null;
  }

  // Validate suggested_charts: every column referenced must exist in the schema.
  const colNames = new Set(schema.columns.map(c => c.name));
  const validCharts = (llmResult.suggested_charts || []).filter(c => {
    if (!c.x_col || !c.y_col) return false;
    if (!colNames.has(c.x_col) || !colNames.has(c.y_col)) {
      log(`${dataset.id}: dropping chart — invalid col reference x=${c.x_col} y=${c.y_col}`, "warn");
      return false;
    }
    if (c.group_by_col && !colNames.has(c.group_by_col)) {
      log(`${dataset.id}: dropping group_by — invalid col ${c.group_by_col}`, "warn");
      delete c.group_by_col;
    }
    if (!["bar", "line", "pie", "scatter", "area"].includes(c.type)) c.type = "bar";
    if (!["mean", "sum", "count", "freq"].includes(c.agg)) c.agg = "mean";
    return true;
  });

  return {
    relevant: true,
    relevance_score: llmResult.relevance_score || 0.7,
    schema,
    key_variables: llmResult.key_variables || [],
    suggested_charts: validCharts.slice(0, 3),
    hypothesis_to_test: llmResult.hypothesis_to_test || "",
    limitations: llmResult.limitations || "",
    honesty_labels: buildHonestyLabels(schema, dataset),
    sampling: parsed.sampling,
    N: schema.N
  };
}

// ── exports for tests ───────────────────────────────────────────────────────
export const _internals = {
  classifyColumn,
  summarizeNumeric,
  summarizeCategorical,
  buildHonestyLabels,
  isNumeric,
  asNumber
};

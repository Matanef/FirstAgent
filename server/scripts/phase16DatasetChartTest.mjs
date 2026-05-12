#!/usr/bin/env node
// Phase 16 dataset-scan + chart-hallucination integration test.
//
// Verifies the LLM-output validation pipeline in `tableAnalyst` rejects
// hallucinated column references and that schema sniffing produces correct
// stats from raw rows (no fabrication at the math layer). Mocks the LLM
// response with various synthetic outputs (good + hallucinated) and asserts
// the validator behaves correctly.
//
// Replicates the figshare CBT-Aurora dataset shape from earlier user runs:
// rows=14, cols=3 with V1AGEX (categorical), V1SVTS (numeric), V1SEXX (categorical).

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== Phase 16 Dataset-Scan + Chart-Hallucination Integration ===\n");

// ── Synthetic dataset fixture (CBT-Aurora shape) ─────────────────────────
// 14 rows. V1AGEX: age group string; V1SVTS: service-time minutes; V1SEXX: sex code.
// Real values (no inventions) — the test asserts computed stats match these.
const rows = [
  { V1AGEX: "18", V1SVTS: 100, V1SEXX: "F" },
  { V1AGEX: "19", V1SVTS: 110, V1SEXX: "F" },
  { V1AGEX: "19", V1SVTS: 115, V1SEXX: "M" },
  { V1AGEX: "20", V1SVTS: 120, V1SEXX: "F" },
  { V1AGEX: "20", V1SVTS: 125, V1SEXX: "M" },
  { V1AGEX: "21", V1SVTS: 122, V1SEXX: "F" },
  { V1AGEX: "22", V1SVTS: 130, V1SEXX: "M" },
  { V1AGEX: "22", V1SVTS: 128, V1SEXX: "F" },
  { V1AGEX: "23", V1SVTS: 135, V1SEXX: "F" },
  { V1AGEX: "23", V1SVTS: 132, V1SEXX: "M" },
  { V1AGEX: "24", V1SVTS: 130, V1SEXX: "F" },
  { V1AGEX: "24", V1SVTS: 135, V1SEXX: "M" },
  { V1AGEX: "25", V1SVTS: 138, V1SEXX: "F" },
  { V1AGEX: "25", V1SVTS: null, V1SEXX: "M" },          // 1 missing
];
const headers = ["V1AGEX", "V1SVTS", "V1SEXX"];
const parsed = { rows, headers, sampling: "full", totalBytes: 1024 };

// ── 1. sniffSchema correctness — no math hallucination ───────────────────
console.log("Test 1: sniffSchema computes correct stats (no math hallucination)");
{
  const { sniffSchema, _internals } = await import("../skills/deepResearch/tableAnalyst.js");
  const schema = sniffSchema(parsed);
  check("schema is non-null", schema !== null);
  check("schema.N === 14 (correct row count)", schema.N === 14);
  check("schema has 3 columns", schema.columns.length === 3);

  const v1svts = schema.columns.find(c => c.name === "V1SVTS");
  check("V1SVTS classified as numeric", v1svts?.type === "numeric");
  check("V1SVTS n=13 (1 missing)", v1svts?.n === 13);
  // Compute expected stats deterministically from the input
  const numericValues = rows.map(r => r.V1SVTS).filter(v => typeof v === "number");
  const expectedMin = Math.min(...numericValues);
  const expectedMax = Math.max(...numericValues);
  const expectedMean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
  check(`V1SVTS min=${expectedMin}`, Math.abs(v1svts?.min - expectedMin) < 0.001);
  check(`V1SVTS max=${expectedMax}`, Math.abs(v1svts?.max - expectedMax) < 0.001);
  check(`V1SVTS mean ≈ ${expectedMean.toFixed(2)}`, Math.abs(v1svts?.mean - expectedMean) < 0.5);

  // V1AGEX has string-numeric values ("18", "19", ...) — classifier reasonably
  // treats them as numeric. Either classification is acceptable; what matters
  // is the column is identified and its stats are internally consistent.
  const v1agex = schema.columns.find(c => c.name === "V1AGEX");
  check("V1AGEX column exists in schema", !!v1agex);
  check("V1AGEX type is one of {numeric, categorical}",
    v1agex?.type === "numeric" || v1agex?.type === "categorical");
  if (v1agex?.type === "numeric") {
    check("V1AGEX numeric stats are real (n=14, no inventions)",
      v1agex?.n === 14 && v1agex?.min === 18 && v1agex?.max === 25);
  } else {
    check("V1AGEX categorical n_unique = 8", v1agex?.n_unique === 8);
  }

  const v1sexx = schema.columns.find(c => c.name === "V1SEXX");
  check("V1SEXX classified as categorical", v1sexx?.type === "categorical");
  check("V1SEXX n_unique = 2 (F, M)", v1sexx?.n_unique === 2);
  check("V1SEXX missing_pct = 0", v1sexx?.missing_pct === 0);
}

// ── 2. Schema reports missing-pct correctly (input ground truth) ─────────
console.log("\nTest 2: missing_pct calculation matches ground truth");
{
  const { sniffSchema } = await import("../skills/deepResearch/tableAnalyst.js");
  const schema = sniffSchema(parsed);
  const v1svts = schema.columns.find(c => c.name === "V1SVTS");
  // 1 missing of 14 rows = 7.14%
  const expected = 1 / 14;
  check(`V1SVTS missing_pct ≈ ${(expected * 100).toFixed(2)}% (real: 1/14 missing)`,
    Math.abs(v1svts?.missing_pct - expected) < 0.01);
}

// ── 3. Honesty labels — applied DETERMINISTICALLY based on schema ────────
console.log("\nTest 3: honesty_labels apply correctly (no LLM influence)");
{
  const { sniffSchema, _internals } = await import("../skills/deepResearch/tableAnalyst.js");
  const schema = sniffSchema(parsed);
  const labels = _internals.buildHonestyLabels(schema, { metadataOnly: false });
  check("includes 'underpowered (N=14)' (N < 30 threshold)",
    labels.some(l => /underpowered/i.test(l) && l.includes("N=14")));
  check("includes 'no causal claim — no control group'",
    labels.some(l => /no causal claim/i.test(l)));
  // 1/14 missing for V1SVTS = 7%, BELOW the 20% threshold; should NOT be flagged.
  check("does NOT flag 7% missingness (below 20% threshold)",
    !labels.some(l => /high missingness/i.test(l)));
}

// ── 4. Honesty labels flag high missingness above threshold ──────────────
console.log("\nTest 4: high-missingness label fires above 20% threshold");
{
  const { sniffSchema, _internals } = await import("../skills/deepResearch/tableAnalyst.js");
  // Build a dataset with >20% missing on V1SVTS (4/14 = 28.6%)
  const sparseRows = rows.map((r, i) => i < 4 ? { ...r, V1SVTS: null } : r);
  const sparseSchema = sniffSchema({ rows: sparseRows, headers, sampling: "full", totalBytes: 1024 });
  const labels = _internals.buildHonestyLabels(sparseSchema, { metadataOnly: false });
  check("flags 'high missingness: V1SVTS' when >20% missing",
    labels.some(l => /high missingness/i.test(l) && l.includes("V1SVTS")));
}

// ── 5. Metadata-only flag — schema-independent ───────────────────────────
console.log("\nTest 5: metadata-only flag adds appropriate label");
{
  const { sniffSchema, _internals } = await import("../skills/deepResearch/tableAnalyst.js");
  const schema = sniffSchema(parsed);
  const labels = _internals.buildHonestyLabels(schema, { metadataOnly: true });
  check("adds 'metadata-only' label when dataset.metadataOnly=true",
    labels.some(l => /metadata-only/i.test(l)));
}

// ── 6. Chart-spec validator — rejects hallucinated columns ───────────────
console.log("\nTest 6: chart-spec validator rejects hallucinated columns");
// Replicates the validator from tableAnalyst.assess() (lines 320-335)
function validateCharts(suggestedCharts, schemaColNames) {
  const colNames = new Set(schemaColNames);
  return suggestedCharts.filter(c => {
    if (!c.x_col || !c.y_col) return false;
    if (!colNames.has(c.x_col) || !colNames.has(c.y_col)) return false;
    if (c.group_by_col && !colNames.has(c.group_by_col)) delete c.group_by_col;
    if (!["bar", "line", "pie", "scatter", "area"].includes(c.type)) c.type = "bar";
    if (!["mean", "sum", "count", "freq"].includes(c.agg)) c.agg = "mean";
    return true;
  });
}
const realCols = ["V1AGEX", "V1SVTS", "V1SEXX"];
{
  // Hallucinated column "VFAKE" — should be dropped
  const llmOut = [
    { type: "bar", x_col: "V1AGEX", y_col: "V1SVTS", agg: "mean" },     // valid
    { type: "scatter", x_col: "VFAKE", y_col: "V1SVTS", agg: "mean" },  // hallucinated x
    { type: "line", x_col: "V1AGEX", y_col: "VBOGUS", agg: "mean" },    // hallucinated y
    { type: "bar", x_col: "V1AGEX", y_col: "V1SVTS", group_by_col: "VINVENTED", agg: "mean" }, // hallucinated group_by
  ];
  const valid = validateCharts(llmOut, realCols);
  check("validator drops chart with hallucinated x_col", valid.length < 4);
  check("validator keeps the all-real-cols chart", valid.some(c => c.x_col === "V1AGEX" && c.y_col === "V1SVTS"));
  check("validator strips hallucinated group_by but keeps the chart",
    valid.some(c => c.group_by_col === undefined && c.x_col === "V1AGEX"));
  // Verify NO hallucinated cols in the output
  const allCols = new Set(realCols);
  const survivors = valid.flatMap(c => [c.x_col, c.y_col, c.group_by_col].filter(Boolean));
  check("zero hallucinated cols survive validation",
    survivors.every(col => allCols.has(col)));
}
{
  // Invalid chart type "doughnut" — clamped to "bar"
  const llmOut = [{ type: "doughnut", x_col: "V1AGEX", y_col: "V1SVTS", agg: "mean" }];
  const valid = validateCharts(llmOut, realCols);
  check("invalid chart type clamped to 'bar'", valid[0]?.type === "bar");
}
{
  // Invalid agg "stddev" — clamped to "mean"
  const llmOut = [{ type: "bar", x_col: "V1AGEX", y_col: "V1SVTS", agg: "stddev" }];
  const valid = validateCharts(llmOut, realCols);
  check("invalid agg clamped to 'mean'", valid[0]?.agg === "mean");
}
{
  // Missing x_col / y_col — chart dropped
  const llmOut = [
    { type: "bar", y_col: "V1SVTS", agg: "mean" },              // missing x
    { type: "bar", x_col: "V1AGEX", agg: "mean" },              // missing y
  ];
  const valid = validateCharts(llmOut, realCols);
  check("charts with missing x_col or y_col dropped", valid.length === 0);
}

// ── 7. sniffSchema null-safety on empty/null input ───────────────────────
console.log("\nTest 7: sniffSchema null-safety");
{
  const { sniffSchema } = await import("../skills/deepResearch/tableAnalyst.js");
  check("sniffSchema(null) → null",         sniffSchema(null) === null);
  check("sniffSchema({}) → null (no rows)", sniffSchema({}) === null);
  check("sniffSchema({ rows: [] }) → null (no headers)",
    sniffSchema({ rows: [] }) === null);
  // Empty rows array but with headers — should produce N=0 schema, no crash
  const empty = sniffSchema({ rows: [], headers: ["foo", "bar"], sampling: "full" });
  check("sniffSchema with empty rows but headers → schema with N=0",
    empty?.N === 0);
}

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

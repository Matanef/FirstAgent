#!/usr/bin/env node
// Phase 7 smoke test — verifies the deterministic pieces (CSV parse, schema
// sniff, aggregation, SVG render) without hitting the network or LLM.

import { _internals as DH } from "../skills/deepResearch/datasetHarvester.js";
import { sniffSchema, _internals as TA } from "../skills/deepResearch/tableAnalyst.js";
import { compose, _internals as CC } from "../skills/deepResearch/chartComposer.js";
import path from "path";
import os from "os";
import fs from "fs/promises";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log("\n=== CSV parser ===");
const csv = `treatment,score,age
control,42,30
treatment,55,28
control,38,35
treatment,60,32
treatment,58,29
control,40,33`;
const parsed = DH.parseCsv(csv, ",");
check("headers count", parsed.headers.length === 3);
check("rows count",    parsed.rows.length === 6);
check("row data",      parsed.rows[1].score === "55");

console.log("\n=== Quoted CSV with embedded commas ===");
const csv2 = `name,quote\n"Smith, J.","He said ""hi"""\n"Jones, K.","Plain"`;
const parsed2 = DH.parseCsv(csv2, ",");
check("quoted rows",  parsed2.rows.length === 2);
check("embedded comma", parsed2.rows[0].name === "Smith, J.");
check("escaped quote", parsed2.rows[0].quote === 'He said "hi"');

console.log("\n=== Schema sniff ===");
const schema = sniffSchema(parsed);
const treatCol = schema.columns.find(c => c.name === "treatment");
const scoreCol = schema.columns.find(c => c.name === "score");
check("N", schema.N === 6);
check("treatment is categorical", treatCol.type === "categorical");
check("score is numeric", scoreCol.type === "numeric");
check("score mean computed", typeof scoreCol.mean === "number" && scoreCol.mean > 40 && scoreCol.mean < 60);
check("score sd computed", scoreCol.sd > 0);

console.log("\n=== Topic classifier ===");
check("finance topic", DH.classifyTopic("inflation 2020-2024 monetary policy").includes("finance"));
check("psych topic",   DH.classifyTopic("cognitive behavioral therapy").includes("psych"));
check("engineering topic", DH.classifyTopic("additive manufacturing fatigue testing").includes("engineering"));

console.log("\n=== Provider ordering ===");
const psychProviders = DH.pickProviders("cognitive behavioral therapy", 6);
check("psych: figshare always-on first", psychProviders[0] === "figshare");
check("psych: includes osf", psychProviders.includes("osf"));
const finProviders = DH.pickProviders("inflation monetary policy", 6);
check("finance: includes fred", finProviders.includes("fred"));
check("finance: includes worldbank", finProviders.includes("worldbank"));

console.log("\n=== Honesty rails ===");
const labels = TA.buildHonestyLabels({ N: 12, columns: [{ type: "categorical", top: [{ value: "treatment" }, { value: "treatment2" }], missing_pct: 0 }] }, {});
check("underpowered flagged",     labels.some(l => l.includes("underpowered")));
check("no-control flagged",       labels.some(l => l.includes("no causal claim")));

console.log("\n=== Aggregation ===");
const agg = CC.aggregate(parsed.rows, { x_col: "treatment", y_col: "score", agg: "mean" });
const ctrl = agg.find(d => d.x === "control");
const treat = agg.find(d => d.x === "treatment");
check("control mean",  Math.abs(ctrl.value - 40) < 0.01);
check("treatment mean", Math.abs(treat.value - 57.666) < 0.5);
check("counts",        ctrl.n === 3 && treat.n === 3);
check("sds computed",  ctrl.sd > 0 && treat.sd > 0);

console.log("\n=== SVG render → file ===");
const tmpDir = path.join(os.tmpdir(), `phase7-smoke-${Date.now()}`);
const result = await compose({
  spec: { type: "bar", x_col: "treatment", y_col: "score", agg: "mean" },
  parsed,
  dataset: { id: "test:1", title: "Smoke Test Data", repository: "test", year: 2026 },
  honestyLabels: ["test label"],
  outDir: tmpDir,
  fileBase: "smoke-test"
});
check("compose returned ok", result.ok === true, result.reason || "");
check("svg starts with <svg>", result.svg?.startsWith("<svg"));
check("interpretation has effect size", /Cohen|Effect size/.test(result.interpretation));
check("caption has honesty label", result.caption.includes("test label"));
const stat = await fs.stat(result.fullPath).catch(() => null);
check("svg file written", stat !== null && stat.size > 200);
await fs.rm(tmpDir, { recursive: true, force: true });

console.log("\n=== Time-series line chart ===");
const tsCsv = `year,gdp\n2020,21.06\n2021,23.32\n2022,25.46\n2023,27.36`;
const tsParsed = DH.parseCsv(tsCsv, ",");
const tsAgg = CC.aggregate(tsParsed.rows, { x_col: "year", y_col: "gdp", agg: "mean" });
check("ts agg has 4 points", tsAgg.length === 4);

console.log("\n=== JSON rows finder ===");
const jsonBody = JSON.stringify({ meta: { count: 3 }, hits: { hits: [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }] } });
const jParsed = DH.parseJsonRows(jsonBody);
check("json rows recovered", jParsed.rows.length === 3);
check("json headers", jParsed.headers.includes("a") && jParsed.headers.includes("b"));

console.log(`\n=== ${pass}/${pass + fail} passed ${fail ? `(${fail} FAILED)` : "✓"} ===`);
process.exit(fail ? 1 : 0);

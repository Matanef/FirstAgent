// server/skills/deepResearch/chartComposer.js
// Phase 7C — Deterministic chart aggregation + inline-SVG rendering.
//
// Given an LLM chart spec ({ type, x_col, y_col, group_by_col, agg }) and the
// parsed dataset rows, this module:
//   1. Computes the aggregation in JS — never trusts the LLM with numbers.
//   2. Renders a self-contained SVG to the vault charts/ folder.
//   3. Returns a caption + interpretation paragraph carrying the agent's own
//      analysis, with mandatory honesty labels prepended.
//
// Why SVG (not PNG): Obsidian renders inline SVG natively. No image library
// dependency, no banned npm package, no headless browser. Lighter, embeddable,
// theme-aware (uses currentColor where possible).
//
// The output of compose() is appended to a prompt's `quantitativeFindings[]`
// array, which the synthesizer pulls into Methodology + Results + Discussion.

import fs from "fs/promises";
import path from "path";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("chartComposer", { consoleLevel: "warn" });

const SVG_W = 720;
const SVG_H = 420;
const PAD_L = 80;   // y-axis labels
const PAD_R = 30;
const PAD_T = 60;   // title
const PAD_B = 90;   // x-axis labels + caption

const PALETTE = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

// ── helpers (mirror of tableAnalyst's, kept local to avoid cross-import) ────
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
function safe(s) {
  return String(s ?? "").replace(/[<>&"']/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 10)   return n.toFixed(1);
  if (Math.abs(n) >= 1)    return n.toFixed(2);
  return n.toFixed(3);
}
function slugifyForFile(s) {
  return String(s || "chart")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chart";
}

// ── deterministic aggregation ───────────────────────────────────────────────
/**
 * Group rows by x_col (and optionally group_by_col) and compute the requested
 * aggregation over y_col.
 *
 * @returns Array of { x, group?, value, n }
 *   For "freq" agg, value is a count and y_col is ignored.
 */
function aggregate(rows, spec) {
  const { x_col, y_col, group_by_col, agg } = spec;
  const buckets = new Map(); // key → { x, group, values: number[], count: number }
  for (const r of rows) {
    const xv = r[x_col];
    if (xv === null || xv === undefined || xv === "") continue;
    const x = String(xv).trim();
    const group = group_by_col ? String(r[group_by_col] ?? "").trim() : "";
    const key = `${x}${group}`;
    if (!buckets.has(key)) buckets.set(key, { x, group, values: [], count: 0 });
    const b = buckets.get(key);
    b.count += 1;
    if (agg !== "count" && agg !== "freq") {
      const yv = r[y_col];
      if (isNumeric(yv)) b.values.push(asNumber(yv));
    }
  }
  const out = [];
  for (const b of buckets.values()) {
    let value;
    if (agg === "count" || agg === "freq") {
      value = b.count;
    } else if (agg === "sum") {
      value = b.values.reduce((a, n) => a + n, 0);
    } else { // mean (default)
      if (b.values.length === 0) continue;
      value = b.values.reduce((a, n) => a + n, 0) / b.values.length;
    }
    const sd = b.values.length > 1
      ? Math.sqrt(b.values.reduce((a, n) => a + (n - value) ** 2, 0) / (b.values.length - 1))
      : 0;
    out.push({ x: b.x, group: b.group, value, n: b.count, sd });
  }
  return out;
}

// ── SVG renderers ───────────────────────────────────────────────────────────
function renderBar(agg, spec, title) {
  const W = SVG_W, H = SVG_H;
  const groups = [...new Set(agg.map(d => d.group))];
  const hasGroups = groups.length > 1 || (groups.length === 1 && groups[0] !== "");
  const xs = [...new Set(agg.map(d => d.x))];
  const yMax = Math.max(...agg.map(d => d.value), 0);
  const yMin = Math.min(...agg.map(d => d.value), 0);
  const yRange = yMax - yMin || 1;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const groupW = plotW / Math.max(xs.length, 1);
  const barW = hasGroups ? Math.max(6, (groupW * 0.8) / groups.length) : Math.max(8, groupW * 0.7);

  const yToPx = v => PAD_T + plotH - ((v - yMin) / yRange) * plotH;

  const bars = [];
  agg.forEach(d => {
    const xi = xs.indexOf(d.x);
    const gi = hasGroups ? groups.indexOf(d.group) : 0;
    const xCenter = PAD_L + xi * groupW + groupW / 2;
    const xPos = hasGroups
      ? xCenter - (groups.length * barW) / 2 + gi * barW
      : xCenter - barW / 2;
    const yTop = yToPx(d.value);
    const yBase = yToPx(0);
    const color = PALETTE[gi % PALETTE.length];
    bars.push(`<rect x="${xPos.toFixed(1)}" y="${Math.min(yTop, yBase).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.abs(yBase - yTop).toFixed(1)}" fill="${color}" opacity="0.85"/>`);
    // Value label above bar
    bars.push(`<text x="${(xPos + barW / 2).toFixed(1)}" y="${(yTop - 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="#444">${safe(fmtNum(d.value))}</text>`);
  });

  const xLabels = xs.map((x, i) => {
    const cx = PAD_L + i * groupW + groupW / 2;
    return `<text x="${cx.toFixed(1)}" y="${(H - PAD_B + 16).toFixed(1)}" font-size="11" text-anchor="middle" fill="#333" transform="rotate(-25 ${cx.toFixed(1)} ${(H - PAD_B + 16).toFixed(1)})">${safe(x.length > 18 ? x.slice(0, 17) + "…" : x)}</text>`;
  }).join("");

  const yTicks = makeAxisTicks(yMin, yMax, 5).map(t =>
    `<g><line x1="${PAD_L}" y1="${yToPx(t).toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${yToPx(t).toFixed(1)}" stroke="#e5e7eb" stroke-dasharray="2,2"/>` +
    `<text x="${PAD_L - 8}" y="${(yToPx(t) + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#555">${safe(fmtNum(t))}</text></g>`
  ).join("");

  const legend = hasGroups ? renderLegend(groups) : "";

  return wrapSVG(W, H, title, spec, bars.join(""), xLabels, yTicks, legend);
}

function renderLine(agg, spec, title) {
  const W = SVG_W, H = SVG_H;
  const groups = [...new Set(agg.map(d => d.group))];
  const xs = [...new Set(agg.map(d => d.x))].sort((a, b) => {
    const na = Date.parse(a) || Number(a);
    const nb = Date.parse(b) || Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
  const yMax = Math.max(...agg.map(d => d.value), 0);
  const yMin = Math.min(...agg.map(d => d.value), 0);
  const yRange = yMax - yMin || 1;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const xToPx = i => PAD_L + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
  const yToPx = v => PAD_T + plotH - ((v - yMin) / yRange) * plotH;

  const paths = [];
  groups.forEach((g, gi) => {
    const points = xs
      .map((x, i) => {
        const d = agg.find(a => a.x === x && a.group === g);
        return d ? { x: xToPx(i), y: yToPx(d.value), v: d.value } : null;
      })
      .filter(Boolean);
    if (points.length === 0) return;
    const color = PALETTE[gi % PALETTE.length];
    const dPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    paths.push(`<path d="${dPath}" fill="none" stroke="${color}" stroke-width="2"/>`);
    points.forEach(p => paths.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}"/>`));
  });

  const xLabels = xs.map((x, i) =>
    `<text x="${xToPx(i).toFixed(1)}" y="${(H - PAD_B + 16).toFixed(1)}" font-size="11" text-anchor="middle" fill="#333" transform="rotate(-25 ${xToPx(i).toFixed(1)} ${(H - PAD_B + 16).toFixed(1)})">${safe(x.length > 18 ? x.slice(0, 17) + "…" : x)}</text>`
  ).join("");

  const yTicks = makeAxisTicks(yMin, yMax, 5).map(t =>
    `<g><line x1="${PAD_L}" y1="${yToPx(t).toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${yToPx(t).toFixed(1)}" stroke="#e5e7eb" stroke-dasharray="2,2"/>` +
    `<text x="${PAD_L - 8}" y="${(yToPx(t) + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#555">${safe(fmtNum(t))}</text></g>`
  ).join("");

  const legend = groups.length > 1 ? renderLegend(groups) : "";

  return wrapSVG(W, H, title, spec, paths.join(""), xLabels, yTicks, legend);
}

function renderArea(agg, spec, title) {
  // Reuse line scaffolding then fill to baseline
  const lineSvg = renderLine(agg, spec, title);
  return lineSvg.replace(/<path d="([^"]+)" fill="none" stroke="([^"]+)"/g,
    (_m, d, c) => `<path d="${d} L ${SVG_W - PAD_R},${SVG_H - PAD_B} L ${PAD_L},${SVG_H - PAD_B} Z" fill="${c}" fill-opacity="0.18" stroke="${c}"`);
}

function renderPie(agg, spec, title) {
  const W = SVG_W, H = SVG_H;
  const total = agg.reduce((s, d) => s + d.value, 0) || 1;
  const cx = W / 2;
  const cy = PAD_T + (H - PAD_T - PAD_B) / 2;
  const r = Math.min((H - PAD_T - PAD_B) / 2 - 10, W / 4);
  let angle = -Math.PI / 2;
  const slices = [];
  agg.forEach((d, i) => {
    const slice = (d.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += slice;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;
    const color = PALETTE[i % PALETTE.length];
    slices.push(`<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" opacity="0.85" stroke="white" stroke-width="2"/>`);
    // Slice label
    const labelAngle = angle - slice / 2;
    const labelR = r * 1.15;
    const lx = cx + labelR * Math.cos(labelAngle);
    const ly = cy + labelR * Math.sin(labelAngle);
    const pct = ((d.value / total) * 100).toFixed(1);
    if (slice > 0.08) {
      slices.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="10" text-anchor="middle" fill="#333">${safe(d.x)} (${pct}%)</text>`);
    }
  });
  return wrapSVG(W, H, title, spec, slices.join(""), "", "", "");
}

function renderScatter(agg, spec, title) {
  // Treat x as numeric if possible; reuse line frame minus connecting lines.
  const W = SVG_W, H = SVG_H;
  const groups = [...new Set(agg.map(d => d.group))];
  const numericX = agg.every(d => isNumeric(d.x));
  const xs = numericX
    ? agg.map(d => asNumber(d.x))
    : [...new Set(agg.map(d => d.x))];
  const xMin = numericX ? Math.min(...xs) : 0;
  const xMax = numericX ? Math.max(...xs) : Math.max(xs.length - 1, 1);
  const xRange = xMax - xMin || 1;
  const yMax = Math.max(...agg.map(d => d.value), 0);
  const yMin = Math.min(...agg.map(d => d.value), 0);
  const yRange = yMax - yMin || 1;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const xToPx = v => PAD_L + ((v - xMin) / xRange) * plotW;
  const yToPx = v => PAD_T + plotH - ((v - yMin) / yRange) * plotH;

  const dots = agg.map((d, i) => {
    const xVal = numericX ? asNumber(d.x) : xs.indexOf(d.x);
    const cx = xToPx(xVal);
    const cy = yToPx(d.value);
    const gi = groups.indexOf(d.group);
    const color = PALETTE[(gi >= 0 ? gi : 0) % PALETTE.length];
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${color}" opacity="0.7"/>`;
  }).join("");

  const yTicks = makeAxisTicks(yMin, yMax, 5).map(t =>
    `<g><line x1="${PAD_L}" y1="${yToPx(t).toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${yToPx(t).toFixed(1)}" stroke="#e5e7eb" stroke-dasharray="2,2"/>` +
    `<text x="${PAD_L - 8}" y="${(yToPx(t) + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#555">${safe(fmtNum(t))}</text></g>`
  ).join("");

  const xTickValues = numericX
    ? makeAxisTicks(xMin, xMax, 6)
    : xs.slice(0, 8);
  const xLabels = xTickValues.map(t => {
    const xv = numericX ? t : xs.indexOf(t);
    return `<text x="${xToPx(xv).toFixed(1)}" y="${(H - PAD_B + 16).toFixed(1)}" font-size="10" text-anchor="middle" fill="#333">${safe(numericX ? fmtNum(t) : String(t).slice(0, 12))}</text>`;
  }).join("");

  const legend = groups.length > 1 ? renderLegend(groups) : "";
  return wrapSVG(W, H, title, spec, dots, xLabels, yTicks, legend);
}

function renderLegend(groups) {
  const items = groups.map((g, i) => {
    const color = PALETTE[i % PALETTE.length];
    const xPos = PAD_L + i * 110;
    return `<g><rect x="${xPos}" y="${(SVG_H - 22).toFixed(0)}" width="10" height="10" fill="${color}"/>` +
           `<text x="${xPos + 14}" y="${(SVG_H - 13).toFixed(0)}" font-size="10" fill="#333">${safe(g.length > 14 ? g.slice(0, 13) + "…" : g)}</text></g>`;
  });
  return items.join("");
}

function makeAxisTicks(min, max, count) {
  const step = (max - min) / count;
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(min + step * i);
  return ticks;
}

function wrapSVG(W, H, title, spec, body, xLabels, yTicks, legend) {
  const xLabel = spec.x_col;
  const yLabel = spec.agg === "count" || spec.agg === "freq"
    ? "Count"
    : `${spec.agg} of ${spec.y_col}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif" role="img">
  <rect width="${W}" height="${H}" fill="white"/>
  <text x="${(W / 2).toFixed(0)}" y="28" font-size="14" font-weight="600" text-anchor="middle" fill="#111">${safe(title.length > 86 ? title.slice(0, 84) + "…" : title)}</text>
  ${yTicks}
  <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${(H - PAD_B).toFixed(0)}" stroke="#999"/>
  <line x1="${PAD_L}" y1="${(H - PAD_B).toFixed(0)}" x2="${(W - PAD_R).toFixed(0)}" y2="${(H - PAD_B).toFixed(0)}" stroke="#999"/>
  ${body}
  ${xLabels}
  <text x="${(W / 2).toFixed(0)}" y="${(H - PAD_B + 60).toFixed(0)}" font-size="11" text-anchor="middle" fill="#444">${safe(xLabel)}</text>
  <text x="20" y="${(PAD_T + (H - PAD_T - PAD_B) / 2).toFixed(0)}" font-size="11" text-anchor="middle" fill="#444" transform="rotate(-90 20 ${(PAD_T + (H - PAD_T - PAD_B) / 2).toFixed(0)})">${safe(yLabel)}</text>
  ${legend}
</svg>`;
}

// ── interpretation paragraph ────────────────────────────────────────────────
function buildInterpretation(agg, spec, dataset, datasetMeta) {
  if (agg.length === 0) return "No data points to interpret.";
  const sorted = [...agg].sort((a, b) => b.value - a.value);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];

  let text;
  if (sorted.length === 1) {
    text = `For ${safeWord(spec.x_col)} = ${safeWord(top.x)}, the ${spec.agg} ${safeWord(spec.y_col)} was ${fmtNum(top.value)} (N=${top.n}).`;
  } else {
    const ratio = bottom.value !== 0 ? Math.abs(top.value / bottom.value) : Infinity;
    const ratioText = Number.isFinite(ratio) && ratio !== 1
      ? ` — a ${ratio.toFixed(2)}× ratio between the highest and lowest groups`
      : "";
    text = `Highest ${spec.agg} of ${safeWord(spec.y_col)} was observed for ${safeWord(spec.x_col)} = "${safeWord(top.x)}" (M=${fmtNum(top.value)}, N=${top.n}); the lowest was for "${safeWord(bottom.x)}" (M=${fmtNum(bottom.value)}, N=${bottom.n})${ratioText}.`;
  }

  // Effect size (Cohen's d) when there are exactly two groups and we have SDs
  if (sorted.length === 2 && top.sd && bottom.sd) {
    const pooledSd = Math.sqrt(((top.n - 1) * top.sd ** 2 + (bottom.n - 1) * bottom.sd ** 2) / Math.max(top.n + bottom.n - 2, 1));
    if (pooledSd > 0) {
      const d = (top.value - bottom.value) / pooledSd;
      const magnitude = Math.abs(d) >= 0.8 ? "large" : Math.abs(d) >= 0.5 ? "medium" : Math.abs(d) >= 0.2 ? "small" : "negligible";
      text += ` Effect size (Cohen's d) ≈ ${d.toFixed(2)} — ${magnitude}.`;
    }
  }
  return text;
}

function safeWord(s) {
  return String(s ?? "").slice(0, 60);
}

// ── public entry ────────────────────────────────────────────────────────────
/**
 * Compose a chart from a parsed dataset + LLM chart spec.
 *
 * @param {object} args
 * @param {object} args.spec           one entry from tableAnalyst.assess() suggested_charts
 * @param {object} args.parsed         { rows, headers } from datasetHarvester.downloadAndParse()
 * @param {object} args.dataset        the Dataset record (for title + cite)
 * @param {string[]} args.honestyLabels mandatory caption prefixes from tableAnalyst
 * @param {string} args.outDir         absolute path to vault charts/ folder
 * @param {string} args.fileBase       slug to use as filename base
 * @returns {Promise<{
 *   chartPath: string,        // relative path (Obsidian-friendly)
 *   svg: string,              // inline SVG
 *   caption: string,          // figure caption with honesty labels prefixed
 *   interpretation: string,   // 2-3 sentence paragraph
 *   spec: object,
 *   aggResult: array,
 *   ok: boolean
 * }>}
 */
export async function compose({ spec, parsed, dataset, honestyLabels = [], outDir, fileBase }) {
  if (!spec || !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    return { ok: false, reason: "missing inputs" };
  }
  // Aggregate
  let agg;
  try {
    agg = aggregate(parsed.rows, spec);
  } catch (err) {
    log(`aggregate failed for ${dataset.id}: ${err.message}`, "warn");
    return { ok: false, reason: `aggregate: ${err.message}` };
  }
  if (!agg || agg.length === 0) {
    return { ok: false, reason: "no data points after aggregation" };
  }
  // Cap the number of x-categories for readability
  if (agg.length > 25) {
    agg = [...agg].sort((a, b) => b.value - a.value).slice(0, 25);
  }

  // Build chart title
  const yLabel = spec.agg === "count" || spec.agg === "freq" ? "Count" : `${spec.agg} of ${spec.y_col}`;
  const titleText = `${yLabel} by ${spec.x_col}${spec.group_by_col ? `, grouped by ${spec.group_by_col}` : ""}`;

  // Render
  let svg;
  try {
    if (spec.type === "line")    svg = renderLine(agg, spec, titleText);
    else if (spec.type === "pie")    svg = renderPie(agg, spec, titleText);
    else if (spec.type === "area")   svg = renderArea(agg, spec, titleText);
    else if (spec.type === "scatter") svg = renderScatter(agg, spec, titleText);
    else                             svg = renderBar(agg, spec, titleText);
  } catch (err) {
    log(`render fail for ${dataset.id}: ${err.message}`, "warn");
    return { ok: false, reason: `render: ${err.message}` };
  }

  // Persist
  const fileName = `${fileBase}.svg`;
  const fullPath = path.join(outDir, fileName);
  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(fullPath, svg, "utf8");
  } catch (err) {
    log(`write ${fullPath}: ${err.message}`, "warn");
    return { ok: false, reason: `write: ${err.message}` };
  }

  // Build caption + interpretation
  const honestyPrefix = honestyLabels.length
    ? `[${honestyLabels.join("; ")}] `
    : "";
  const caption = `${honestyPrefix}Figure: ${titleText}. Source: ${dataset.title} (${dataset.repository}, ${dataset.year || "n.d."}).`;
  const interpretation = buildInterpretation(agg, spec, dataset, dataset);

  return {
    ok: true,
    chartPath: path.join("charts", fileName).replace(/\\/g, "/"),
    fullPath,
    svg,
    caption,
    interpretation,
    spec,
    aggResult: agg
  };
}

export const _internals = { aggregate, renderBar, renderLine, renderPie, makeAxisTicks };

// server/skills/deepResearch.js
// Thin re-export shim. All implementation lives in server/skills/deepResearch/.
// Kept here so the MANIFEST.json allowlist entry ("deepResearch.js") stays valid.

export { deepResearch } from "./deepResearch/index.js";

// Self-registered routing rule — picked up by loadSkills() in executor.js
export const ROUTING = {
  tool: "deepResearch",
  priority: 72,
  match: (lower) =>
    /\[depth:(article|indepth|in-depth|research|thesis)\]/i.test(lower) ||
    /\b(deep\s+research|thesis|research\s+report|research\s+paper)\b/i.test(lower) ||
    (/\b(comprehensive|thorough|exhaustive|in-?depth)\b/i.test(lower) && /\b(research|analysis|study|investigation|breakdown)\b/i.test(lower)) ||
    /^(?:please\s+|can\s+you\s+)?research\b/i.test(lower) ||
    /(?:^|\s)(תזה|דוקטורט|עבודת\s+גמר|מחקר\s+מעמיק)(\s|$)/.test(lower),
  guard: (lower) =>
    (lower.split(/\s+and\s+|\s+then\s+/i).length > 1 && !/\b(research|thesis)\b/i.test(lower) && !/\[depth:/i.test(lower)) ||
    (/\b(where|how)\s+(do\s+(i|we)|can\s+(i|we)|to)\s+(set|configure|change|update|find|modify|edit|adjust|tweak|override)\b/i.test(lower) &&
     /\b(skill|tool|module|agent|pipeline|planner|executor|tier|prompt|config|setting|variable|function|class|route|router|manifest|budget|threshold|timeout|param(?:eter)?|synthesizer|harvester|analyzer|writer|bootstrapper|matcher|extractor|detector)\b/i.test(lower)),
  description: "Deep Research — recursive research engine with query expansion"
};

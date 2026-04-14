// server/skills/deepResearch/promptRollup.js
// After all per-prompt conclusions are written, this module:
//   1. Rewrites {VAULT_JOURNAL_ROOT}/Research/{topicSlug}/{N}/prompt.md with a rollup block
//   2. Writes {VAULT_JOURNAL_ROOT}/Research/{topicSlug}/_master.md aggregating all per-prompt conclusions
//   3. Pushes connectivity/relatedness updates into research-sources.json

import { writeNote, buildFrontmatter, VAULT_JOURNAL_ROOT } from "../../utils/obsidianUtils.js";
import { updateGraph } from "./sourceDirectory.js";

/**
 * Per-prompt rewrite: replace the original prompt.md with one that includes the rollup.
 *
 * @param {object} args
 * @param {string} args.topicSlug
 * @param {object} args.promptSpec     { id, query, angle }
 * @param {number} args.promptIndex
 * @param {object} args.conclusion     conclusionWriter.write() return.conclusion
 * @param {Array}  args.analyses       articleAnalyzer outputs
 * @param {string} args.collectionName research-{slug}-pN-articles
 */
export async function rewritePrompt({ topicSlug, promptSpec, promptIndex, conclusion, analyses, collectionName }) {
  const fm = buildFrontmatter({
    title: `"Prompt ${promptIndex}: ${promptSpec.query}"`,
    type: "research-prompt",
    parent: `[[${topicSlug}]]`,
    prompt: promptIndex,
    angle: promptSpec.angle || "",
    article_count: analyses.length,
    avg_relevance: avg(analyses.map(a => a.analysis.relevance)),
    vector_collection: collectionName,
    tags: ["research-prompt", topicSlug]
  });

  const articleLinks = analyses
    .map((a, i) => `${i + 1}. [[${a.relativePath.replace(/\.md$/, "")}|${(a.frontmatter?.title || `Article ${i + 1}`).replace(/^"|"$/g, "")}]] — relevance ${(a.analysis.relevance * 100).toFixed(0)}%`)
    .join("\n");

  const body = `# Prompt ${promptIndex}: ${promptSpec.query}

> [!info] Prompt metadata
> - **Angle:** ${promptSpec.angle || "general"}
> - **Articles harvested:** ${analyses.length}
> - **Vector collection:** \`${collectionName}\`

## Rollup
${conclusion?.summary || "_(synthesis pending)_"}

### Top commonalities
${listOrNone((conclusion?.commonalities || []).slice(0, 4))}

### Notable contradictions
${listOrNone((conclusion?.contradictions || []).slice(0, 4))}

## Articles
${articleLinks || "_(no articles)_"}

## Conclusion
[[${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${promptIndex}/conclusion|Read the full conclusion →]]
`;

  const relativePath = `${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${promptIndex}/prompt.md`;
  await writeNote(relativePath, fm + body);
  return relativePath;
}

/**
 * Master rollup across all prompts. Also pushes connectivity/relatedness updates
 * into research-sources.json.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.topicSlug
 * @param {string} args.tier
 * @param {Array}  args.promptResults    [{promptSpec, promptIndex, analyses, conclusion, collectionName, relativePath:promptPath}]
 * @param {Array<{slug,score}>} args.relatedMatches   matches found at start of run
 */
export async function writeMaster({ topic, topicSlug, tier, promptResults, relatedMatches = [] }) {
  // Aggregate metrics.
  const totalArticles = promptResults.reduce((s, p) => s + p.analyses.length, 0);
  const allRelevances = promptResults.flatMap(p => p.analyses.map(a => a.analysis.relevance));
  const avgRel = avg(allRelevances);
  const allDomains = uniqCount(promptResults.flatMap(p => p.analyses.map(a => a.frontmatter?.domain).filter(Boolean)));

  // Connectivity = number of distinct related subjects whose proximity is non-trivial.
  const relatedness = {};
  for (const m of relatedMatches) {
    if (m.slug && m.score > 0) relatedness[m.slug] = Math.min(1, m.score / 5);
  }
  const connectivity = Object.values(relatedness).filter(v => v >= 0.2).length;

  // Persist to sources file.
  try { await updateGraph(topicSlug, { connectivity, relatedness }); }
  catch (err) { console.warn("[promptRollup] updateGraph failed:", err.message); }

  // Build _master.md
  const fm = buildFrontmatter({
    title: `"${topic} — Research Master"`,
    type: "research-master",
    tier,
    prompt_count: promptResults.length,
    article_count: totalArticles,
    avg_relevance: avgRel,
    connectivity,
    related_subjects: Object.keys(relatedness),
    created: new Date().toISOString(),
    tags: ["research-master", topicSlug, tier]
  });

  const promptBlocks = promptResults.map(pr => {
    const c = pr.conclusion || {};
    return `### Prompt ${pr.promptIndex}: ${pr.promptSpec.query}
- **Angle:** ${pr.promptSpec.angle || "general"}
- **Sources:** ${pr.analyses.length} (avg relevance ${(avg(pr.analyses.map(a => a.analysis.relevance)) * 100).toFixed(0)}%)
- **Conclusion:** ${c.summary || "_(none)_"}
- [[${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${pr.promptIndex}/conclusion|Open conclusion →]]`;
  }).join("\n\n");

  const domainsBlock = allDomains
    .slice(0, 12)
    .map(([host, hits]) => `- \`${host}\` × ${hits}`)
    .join("\n") || "_(none)_";

  const relatedBlock = Object.entries(relatedness)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, prox]) => `- [[${slug}]] (proximity ${(prox * 100).toFixed(0)}%)`)
    .join("\n") || "_(none — this is a new subject island)_";

  const body = `# ${topic} — Research Master

> [!summary] Run overview
> - **Tier:** ${tier}
> - **Prompts executed:** ${promptResults.length}
> - **Articles harvested:** ${totalArticles}
> - **Average relevance:** ${(avgRel * 100).toFixed(0)}%
> - **Subject connectivity:** ${connectivity} related subjects ≥ 20%

## Per-prompt rollups
${promptBlocks || "_(no prompt rollups available)_"}

## Source domains
${domainsBlock}

## Related subjects in the knowledge base
${relatedBlock}

## Final synthesis
The thesis-level write-up is at [[${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/${topicSlug}|${topic}]].
`;

  const relativePath = `${VAULT_JOURNAL_ROOT}/Research/${topicSlug}/_master.md`;
  await writeNote(relativePath, fm + body);
  return { relativePath, totalArticles, avgRelevance: avgRel, connectivity };
}

function avg(xs) { if (!xs.length) return 0; return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)); }
function listOrNone(xs) { return (xs && xs.length) ? xs.map(x => `- ${x}`).join("\n") : "_(none)_"; }
function uniqCount(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

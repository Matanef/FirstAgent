export function detectContradictions(stateGraph, newOutput) {
  if (!newOutput) return [];

  const newStr =
    typeof newOutput === "string"
      ? newOutput
      : JSON.stringify(newOutput);

  const last = stateGraph[stateGraph.length - 1];

  if (!last) return [];

  const prevStr =
    typeof last.output === "string"
      ? last.output
      : JSON.stringify(last.output);

  if (prevStr === newStr) return [];

  if (prevStr && newStr && prevStr !== newStr) {
    return ["Potential contradiction detected"];
  }

  return [];
}

export function calculateConfidence(stateGraph) {
  let score = 0.5;

  const usedFinance = stateGraph.some(s => s.tool === "finance");
  const usedSearch = stateGraph.some(s => s.tool === "search");
  const contradictions = stateGraph.flatMap(s => s.contradictions || []);
  const citationMiss = stateGraph.flatMap(s => s.citationMiss || []);

  if (usedFinance) score += 0.25;
  if (usedSearch) score += 0.15;
  if (contradictions.length > 0) score -= 0.2;
  if (citationMiss.length > 0) score -= 0.2;

  return Math.min(Math.max(score, 0.1), 0.95);
}

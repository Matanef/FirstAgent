export const MAX_TOOL_CALLS = { search: 3, llm: 2, calculator: 1 };

export function detectContradictions(stateGraph, newOutput) {
  const previousOutputs = stateGraph.map(s => s.output).filter(Boolean);
  const newStr = typeof newOutput === "string" ? newOutput : JSON.stringify(newOutput);

  const contradictions = previousOutputs.filter(out => {
    const outStr = typeof out === "string" ? out : JSON.stringify(out);
    return outStr !== newStr && outStr.toLowerCase() !== newStr.toLowerCase();
  });

  return contradictions.length > 0 ? ["Potential contradiction detected"] : [];
}

export function calculateConfidence(stateGraph) {
  let score = 0.4;

  const usedSearch = stateGraph.some(s => s.tool === "search" || s.tool === "llm-fallback");
  const reused = stateGraph.some(s => s.cached);
  const contradictions = stateGraph.flatMap(s => s.contradictions || []);
  const citationMisses = stateGraph.flatMap(s => s.citationMiss || []);

  if (usedSearch) score += 0.2;
  if (stateGraph.filter(s => s.tool === "search").length > 1) score += 0.1;
  if (reused) score += 0.1;
  if (contradictions.length > 0) score -= 0.2;
  if (citationMisses.length > 0) score -= 0.2;

  const lastReply = stateGraph[stateGraph.length - 1]?.output;
  if (lastReply && lastReply.length > 0) score += 0.1;

  return Math.min(Math.max(score, 0.1), 0.95);
}

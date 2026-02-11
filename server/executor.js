import { plan } from "./planner.js";
import { calculator, searchWeb } from "./tools.js";
import { detectContradictions } from "./audit.js";

export async function executeStep(message, step, stateGraph, memory, toolUsage, convo) {
  const decision = plan(message);
  console.log(`🤖 STEP ${step} PLAN:`, decision);

  if (!toolUsage[decision]) toolUsage[decision] = 0;

  if (toolUsage[decision] >= (decision === "search" ? 3 : 2)) {
    console.log(`⚠️ Tool budget exceeded for ${decision}`);
    return { reply: "(tool budget exceeded)" };
  }

  toolUsage[decision]++;

  let reply = "";
  let contradictions = [];

  if (decision === "calculator") {
    const result = calculator(message);
    reply = result.error ?? `Result: ${result.result}`;
    stateGraph.push({ step, tool: "calculator", input: message, output: reply });
    return { reply };
  }

  if (decision === "search") {
    const search = await searchWeb(message);
    const observations = search.results;
    const citationMiss = observations.length === 0 ? ["No sources found"] : [];
    contradictions = detectContradictions(stateGraph, observations);

    stateGraph.push({ step, tool: "search", input: message, output: observations.length > 0 ? observations : "(no search results)", cached: search.cached, contradictions, citationMiss });

    if (observations.length > 0) {
      const context = observations.map(r => `${r.title}: ${r.snippet}`).join("\n");
      // call LLM
      const ollamaRes = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mat-llm",
          prompt: `Use ONLY the following sources to answer factually:\n${context}\nQuestion: ${message}`,
          stream: false
        })
      });
      const data = await ollamaRes.json();
      reply = data.response ?? "(no response)";
      contradictions = detectContradictions(stateGraph, reply);
      stateGraph.push({ step: step + 0.5, tool: "llm", input: message, output: reply, contradictions });
    } else {
      reply = "(no search results)";
    }

    return { reply };
  }

  // fallback LLM
  const prompt = convo.map(m => `${m.role}: ${m.content}`).join("\n");
  const ollamaRes = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mat-llm", prompt, stream: false })
  });
  const data = await ollamaRes.json();
  reply = data.response ?? "(no response)";
  contradictions = detectContradictions(stateGraph, reply);
  stateGraph.push({ step, tool: "llm", input: message, output: reply, contradictions });
  return { reply };
}

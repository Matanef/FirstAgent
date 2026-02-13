// server/planner.js

import fetch from "node-fetch";

/**
 * Deterministic Power Planner (Path A)
 *
 * This planner:
 * - Sees message
 * - Sees stateGraph
 * - Sees conversation history
 * - Asks LLM to choose tool STRICTLY via JSON
 * - Remains controlled (we validate tool name)
 */

const ALLOWED_TOOLS = ["calculator", "finance", "file", "search", "llm", "done"];

export async function plan({ message, stateGraph, conversationHistory }) {
  const lastNode = stateGraph[stateGraph.length - 1];

  // If last step already marked final → stop
  if (lastNode?.final) {
    return { tool: "done", reason: "Final step reached" };
  }

  const recentHistory = conversationHistory
    .slice(-5)
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = `
You are a deterministic tool selection engine.

Choose ONE tool:
calculator
finance
file
search
llm
done

Rules:
- Pure math → calculator
- Stocks / sector / market → finance
- Local files → file
- Internet info → search
- General reasoning → llm
- If fully answered → done

Return STRICT JSON:
{
  "tool": "tool_name",
  "reason": "short explanation"
}

Conversation:
${recentHistory}

StateGraph:
${JSON.stringify(stateGraph)}

User:
${message}
`;

  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mat-llm:latest",
        prompt,
        stream: false,
        options: { temperature: 0 }
      })
    });

    const data = await res.json();
    const text = data.response?.trim();

    const parsed = JSON.parse(text);

    if (!ALLOWED_TOOLS.includes(parsed.tool)) {
      return { tool: "llm", reason: "Invalid tool fallback" };
    }

    return parsed;

  } catch {
    return { tool: "llm", reason: "Planner fallback" };
  }
}

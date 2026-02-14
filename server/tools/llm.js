// server/tools/llm.js

import fetch from "node-fetch";

export async function llm(input) {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mat-llm:latest",
        prompt: input,
        stream: false
      })
    });

    const data = await res.json();

    const text = data.response?.trim();

    if (!text) {
      return {
        success: false,
        error: "LLM returned empty response",
        final: true
      };
    }

    return {
      success: true,
      data: { text },
      final: true,
      output: text
    };

  } catch (err) {
    return {
      success: false,
      error: "LLM execution failed",
      final: true
    };
  }
}

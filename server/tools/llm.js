// server/tools/llm.js

import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

export async function llm(prompt) {
  try {
    const body = {
      model: CONFIG.LLM_MODEL,
      prompt,
      stream: false
    };

    const url = CONFIG.LLM_API_URL + "api/generate";

    const response = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const text =
      response?.response ||
      response?.message ||
      response?.text ||
      null;

    if (!text) {
      return {
        tool: "llm",
        success: false,
        final: true,
        data: { text: "The language model returned an empty response." }
      };
    }

    return {
      tool: "llm",
      success: true,
      final: true,
      data: { text }
    };

  } catch (err) {
    return {
      tool: "llm",
      success: false,
      final: true,
      data: { text: `The language model encountered an error: ${err.message}` }
    };
  }
}
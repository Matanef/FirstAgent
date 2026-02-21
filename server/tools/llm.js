import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import fetch from "node-fetch";

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

/**
 * llmStream
 * Real-time streaming for Ollama/LLM generate API
 */
export async function llmStream(prompt, onChunk) {
  try {
    const body = {
      model: CONFIG.LLM_MODEL,
      prompt,
      stream: true
    };

    const url = CONFIG.LLM_API_URL + "api/generate";

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Node-fetch 3.x response.body is a Node.js Readable stream
    for await (const chunk of response.body) {
      const line = chunk.toString();
      try {
        const json = JSON.parse(line);
        const text = json.response || json.message?.content || "";
        if (text) onChunk(text);
        if (json.done) break;
      } catch (e) {
        // Handle potential partial JSON in chunks
        const lines = line.split('\n').filter(Boolean);
        for (const l of lines) {
          try {
            const j = JSON.parse(l);
            const t = j.response || j.message?.content || "";
            if (t) onChunk(t);
            if (j.done) break;
          } catch (inner) { }
        }
      }
    }

    return { success: true };
  } catch (err) {
    console.error("LLM Stream error:", err);
    return { success: false, error: err.message };
  }
}
// server/tools/llm.js
// Safe, timeout-protected LLM wrapper for Ollama

import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";

/**
 * Internal helper: perform a POST to Ollama with timeout + abort
 */
async function fetchWithTimeout(url, body, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}`);
    }

    const json = await res.json();
    return json;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Non-streaming LLM call
 */
export async function llm(prompt, configOptions = {}) {
  const {
    timeoutMs = 120_000,
    model = CONFIG.LLM_MODEL,
    format, // <--- NEW: Capture the format command
    options = {} 
  } = configOptions;

  const url = CONFIG.LLM_API_URL + "api/generate";

  try {
    const body = {
      model,
      prompt,
      stream: false,
      ...(format ? { format } : {}), // <--- NEW: Send format to Ollama
      ...(Object.keys(options).length > 0 ? { options } : {})
    };
    
    // ... rest of the function stays exactly the same

    const response = await fetchWithTimeout(url, body, timeoutMs);

    const text =
      response?.response ||
      response?.content ||
      response?.message?.content ||
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
 * Streaming LLM call with chunk guard + timeout
 * Robust against multiple JSON objects per chunk and partial lines.
 */
export async function llmStream(prompt, onChunk, options = {}) {
  const {
    timeoutMs = 120_000,
    maxChunks = 200,
    model = CONFIG.LLM_MODEL
  } = options;

  const url = CONFIG.LLM_API_URL + "api/generate";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      prompt,
      stream: true
    };

    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let chunks = 0;
    let buffer = "";
    let doneFlag = false;

    for await (const chunk of response.body) {
      chunks += 1;
      if (chunks > maxChunks) {
        throw new Error(`LLM exceeded maxChunks=${maxChunks}`);
      }

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;

        try {
          const json = JSON.parse(line);
          const text =
            json.response ||
            json.content ||
            json.message?.content ||
            "";

          if (text) {
            onChunk(text);
          }

          if (json.done) {
            doneFlag = true;
            break;
          }
        } catch {
          // Ignore malformed lines; next chunks may complete them
        }
      }

      if (doneFlag) break;
    }

    return { success: true };

  } catch (err) {
    if (err.name === "AbortError") {
      return { success: false, error: `LLM stream timed out after ${timeoutMs}ms` };
    }
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}
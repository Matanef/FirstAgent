// server/tools/llm.js
// Safe, timeout-protected LLM wrapper for Ollama

import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";
import { getKnowledgeContext } from "../knowledge.js";
import { getPersonalityContext } from "../personality.js";

/**
 * Internal helper: perform a POST to Ollama with timeout + abort
 */
async function fetchWithTimeout(url, body, timeoutMs = 1200_000) {
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
  // Use the passed timeout, or default to 10 minutes (600,000ms) for safety
  const timeoutMs = configOptions.timeoutMs || 600_000;
  
  const {
    model = CONFIG.LLM_MODEL,
    format, 
    options = {} 
  } = configOptions;

  const url = CONFIG.LLM_API_URL + "api/generate";

  try {
    // Inject personality + knowledge for user-facing prompts (not internal JSON tool calls)
    let finalPrompt = prompt;
    if (!configOptions.skipKnowledge && !configOptions.format) {
      try {
        const [personalityCtx, knowledgeCtx] = await Promise.all([
          getPersonalityContext("chat").catch(() => ""),
          getKnowledgeContext().catch(() => "")
        ]);
        const prefix = [personalityCtx, knowledgeCtx].filter(Boolean).join("\n\n---\n\n");
        if (prefix) {
          finalPrompt = `${prefix}\n\n---\n\n${prompt}`;
        }
      } catch (e) {
        console.warn("[llm] Context injection failed:", e.message);
      }
    }

    const body = {
      model,
      prompt: finalPrompt,
      stream: false,
      ...(format ? { format } : {}),
      options: {
        num_ctx: 8192, // <--- Hard cap to prevent VRAM overflow on 8GB cards
        ...options
      }
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
export async function llmStream(prompt, onChunk, configOptions = {}) {
  // Pull these out so they can be overridden, with much safer defaults
  const timeoutMs = configOptions.timeoutMs || 300_000; // 5 minutes
  const maxChunks = configOptions.maxChunks || 10000;   // <--- HUGE increase from 200!
  
  const {
    model = CONFIG.LLM_MODEL,
    options = {} // Allow passing Ollama specific options like num_ctx
  } = configOptions;

  const url = CONFIG.LLM_API_URL + "api/generate";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
const body = {
      model,
      prompt,
      stream: true,
      options: {
        num_ctx: 8192, // <--- Keep normal chat streams fast!
        ...options
      }
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
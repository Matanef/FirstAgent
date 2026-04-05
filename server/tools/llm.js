import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";


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

export async function llm(prompt, configOptions = {}) {
  const timeoutMs = configOptions.timeoutMs || 600_000;
  
  const { model = CONFIG.LLM_MODEL, format, options = {} } = configOptions;

  const url = CONFIG.LLM_API_URL + "api/generate";

  try {
    let finalPrompt = prompt;
    if (!configOptions.skipKnowledge && !configOptions.format) {
      try {
        // LAZY LOAD: Only fetch these files when the LLM actually runs!
        const { getPersonalityContext } = await import("../personality.js");
        const { getKnowledgeContext } = await import("../knowledge.js");
        
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
        num_ctx: 8192, // Hard cap to prevent VRAM overflow on 8GB cards
        ...options
      }
    };
    
    const llmStartTime = performance.now();
    console.log(`🧠 [LLM] Sending prompt to ${model}...`);

    const response = await fetchWithTimeout(url, body, timeoutMs);

    const llmEndTime = performance.now();
    console.log(`⏱️ [LLM] Response received in ${((llmEndTime - llmStartTime) / 1000).toFixed(2)}s`);

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
    console.error("[llm] Error:", err);
    return {
      tool: "llm",
      success: false,
      final: true,
      data: { text: `The language model encountered an error: ${err.message}` }
    };
  }
}

export async function llmStream(prompt, onChunk, configOptions = {}) {
  const timeoutMs = configOptions.timeoutMs || 300_000;
  const maxChunks = configOptions.maxChunks || 10000;
  
  const { model = CONFIG.LLM_MODEL, options = {} } = configOptions;

  const url = CONFIG.LLM_API_URL + "api/generate";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      prompt,
      stream: true,
      options: {
        num_ctx: 8192, // Keep normal chat streams fast!
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
    console.error("[llmStream] Error:", err);
    if (err.name === "AbortError") {
      return { success: false, error: `LLM stream timed out after ${timeoutMs}ms` };
    }
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}
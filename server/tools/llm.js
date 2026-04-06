import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";

// ── GEMINI API BACKEND ──
// Used for Hebrew/Arabic/multilingual prose where local models fail.
// Falls back gracefully to local Ollama if API key is missing.
let _genai = null;
async function getGenAI() {
  if (_genai) return _genai;
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const { GoogleGenAI } = await import("@google/genai");
    _genai = new GoogleGenAI({});
    return _genai;
  } catch {
    console.warn("[llm] @google/genai not available, Gemini disabled");
    return null;
  }
}

/**
 * Call Gemini API directly. Returns the same response shape as llm().
 */
async function callGemini(prompt, timeoutMs = 120_000) {
  const ai = await getGenAI();
  if (!ai) throw new Error("Gemini API not configured (missing GEMINI_API_KEY)");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startTime = performance.now();
    console.log(`🧠 [LLM] Sending prompt to gemini-2.5-flash (${prompt.length} chars)...`);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    const text = response.text || "";
    console.log(`⏱️ [LLM] Gemini response received in ${elapsed}s (${text.length} chars)`);

    if (!text) {
      return { tool: "llm", success: false, final: true, data: { text: "Gemini returned an empty response." } };
    }

    return { tool: "llm", success: true, final: true, data: { text } };
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Expose for direct use by tools that want Gemini specifically
export { callGemini };

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
 * Smart model selector — picks the best available model for the content.
 * Returns "gemini" for Hebrew/Arabic (outsourced to Gemini API for quality).
 * Falls back to "llama3.1:8b" if Gemini API key is missing.
 * Returns undefined for Latin/English content (uses default Ollama model).
 * @param {string} text - The content to analyze
 * @returns {string|undefined} Model name override, or undefined for default
 */
export function pickModelForContent(text) {
  if (!text) return undefined;
  const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  // If non-Latin scripts dominate, outsource to Gemini for quality
  if (hebrew > 20 || arabic > 20 || (hebrew + arabic) > latin) {
    return process.env.GEMINI_API_KEY ? "gemini" : "llama3.1:8b";
  }
  return undefined; // Use default model from CONFIG
}

export async function llm(prompt, configOptions = {}) {
  const timeoutMs = configOptions.timeoutMs || 600_000;

  const { model = CONFIG.LLM_MODEL, format, options = {} } = configOptions;

  // ── GEMINI ROUTE: If model is "gemini", use the Gemini API instead of Ollama ──
  if (model === "gemini") {
    try {
      return await callGemini(prompt, timeoutMs);
    } catch (err) {
      console.warn(`[llm] Gemini failed (${err.message}), falling back to local Ollama`);
      // Fall through to Ollama below
    }
  }

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
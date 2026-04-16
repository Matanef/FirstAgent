import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

// Silent logger: lifecycle info goes to logs/llm/ only, never to PM2 stdout
const log = createLogger("llm", { silent: false, consoleLevel: "warn" });

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
    log("[llm] @google/genai not available, Gemini disabled", "warn");
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
    // Configurable via .env: GEMINI_MODEL=gemini-3-flash-preview (default: gemini-2.5-flash)
    const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const startTime = performance.now();
    log(`Sending prompt to ${geminiModel} (${prompt.length} chars)`, "info");

    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: prompt,
    });

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    const text = response.text || "";
    log(`Gemini response in ${elapsed}s (${text.length} chars)`, "info");

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

// ── GEMINI CIRCUIT BREAKER ──
// When Gemini returns 429 (quota) or 503 (overloaded), stop hammering it.
// All subsequent calls skip the API and fall back to Ollama immediately.
let _geminiCooldownUntil = 0; // Unix timestamp (ms) — 0 = no cooldown

/**
 * Check if Gemini API is currently in cooldown (circuit breaker tripped).
 * @returns {{ coolingDown: boolean, remainingSec: number }}
 */
export function geminiStatus() {
  const now = Date.now();
  if (_geminiCooldownUntil > now) {
    return { coolingDown: true, remainingSec: Math.ceil((_geminiCooldownUntil - now) / 1000) };
  }
  return { coolingDown: false, remainingSec: 0 };
}

/**
 * Trip the circuit breaker — Gemini is unavailable for `seconds`.
 */
function tripGeminiBreaker(seconds) {
  _geminiCooldownUntil = Date.now() + seconds * 1000;
  log(`Gemini circuit breaker tripped — skipping API calls for ${seconds}s`, "warn");
}

// Expose for direct use by tools that want Gemini specifically
export { callGemini };

// Replace your existing fetchWithTimeout with this:
async function fetchWithTimeout(url, body, timeoutMs = 1200_000, externalSignal = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // If the user clicks stop, trigger our internal abort controller
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener("abort", () => controller.abort());
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal, // This now listens to both the timeout AND the user!
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (res.body && typeof res.body.on === 'function') res.body.on('error', () => {});

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`LLM request aborted or timed out`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Best local model for Hebrew/Arabic prose (Cohere's Aya Expanse, trained on 23 languages)
const LOCAL_HEBREW_MODEL = process.env.LOCAL_HEBREW_MODEL || "aya-expanse:8b";

/**
 * Smart model selector — picks the best available model for the content.
 * Returns "gemini" for Hebrew/Arabic (outsourced to Gemini API for quality).
 * Falls back to aya-expanse:8b if Gemini API key is missing or circuit breaker is active.
 * Returns undefined for Latin/English content (uses default Ollama model).
 * @param {string} text - The content to analyze
 * @returns {string|undefined} Model name override, or undefined for default
 */
export function pickModelForContent(text) {
  if (!text) return undefined;
  // Strip the (System: ...) persona wrapper — it's injected metadata, not user content.
  // Without this, the English wrapper's Latin chars overwhelm short Hebrew messages.
  const userText = text.replace(/^\(System:[^)]*\)\s*/i, "");
  const hebrew = (userText.match(/[\u0590-\u05FF]/g) || []).length;
  const arabic = (userText.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (userText.match(/[a-zA-Z]/g) || []).length;
  // If non-Latin scripts dominate (or enough Hebrew/Arabic present), use a multilingual model
  if (hebrew > 3 || arabic > 3 || (hebrew + arabic) > latin) {
    // If Gemini API is available and not rate-limited, use it for best quality
    if (process.env.GEMINI_API_KEY && !geminiStatus().coolingDown) {
      return "gemini";
    }
    // Otherwise use the best local multilingual model
    return LOCAL_HEBREW_MODEL;
  }
  return undefined; // Use default model from CONFIG
}

export async function llm(prompt, configOptions = {}) {
  const timeoutMs = configOptions.timeoutMs || 600_000;
  const externalSignal = configOptions.signal;
  let { model, format, options = {}, skipLanguageDetection = false } = configOptions;

  // Auto-detect Hebrew/Arabic ONLY if we aren't explicitly skipping it
  if (!model && !skipLanguageDetection) {
    const detectedModel = pickModelForContent(typeof prompt === "string" ? prompt : "");
    model = detectedModel || CONFIG.LLM_MODEL;
  } else if (!model) {
    model = CONFIG.LLM_MODEL;
  }

  // ── GEMINI ROUTE: If model is "gemini", use the Gemini API instead of Ollama ──
  if (model === "gemini") {
    const status = geminiStatus();
    if (status.coolingDown) {
      // Circuit breaker is active — skip API entirely, go straight to Ollama
      log(`Gemini circuit breaker active (${status.remainingSec}s left) — using local Ollama`, "warn");
    } else {
      try {
        return await callGemini(prompt, timeoutMs);
      } catch (err) {
        const errMsg = err.message || "";
        const is429 = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota");
        const is503 = errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("high demand");

        if (is429) {
          // Quota exhausted — long cooldown. Free tier is 20 RPD, no point retrying for minutes.
          // 5 minutes minimum, or the Google-suggested retryDelay if longer
          const retryMatch = errMsg.match(/retryDelay.*?(\d+)s/i) || errMsg.match(/retry\s+in\s+([\d.]+)s/i);
          const googleSuggestedSec = retryMatch ? Number(retryMatch[1]) : 0;
          const cooldownSec = Math.max(300, googleSuggestedSec); // At least 5 minutes
          tripGeminiBreaker(cooldownSec);
          log(`Gemini 429 (quota) — falling back to local Ollama for ${cooldownSec}s`, "warn");
        } else if (is503) {
          // Server overloaded — moderate cooldown, it might recover
          tripGeminiBreaker(120);
          log(`Gemini 503 (overloaded) — falling back to local Ollama for 120s`, "warn");
        } else {
          log(`Gemini failed (${errMsg}), falling back to local Ollama`, "warn");
        }
        // Fall through to Ollama
      }
    }
  }

  // Use the actual Ollama model name (never "gemini" — that's an API-only route)
  // When Gemini falls back, use the local Hebrew model (aya-expanse) since the content was non-Latin
  const ollamaModel = model === "gemini" ? LOCAL_HEBREW_MODEL : model;
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
        log(`Context injection failed: ${e.message}`, "warn");
      }
    }

    const body = {
      model: ollamaModel,
      prompt: finalPrompt,
      stream: false,
      ...(format ? { format } : {}),
      options: {
        num_ctx: 8192, // Hard cap to prevent VRAM overflow on 8GB cards
        ...options
      }
    };

    const llmStartTime = performance.now();
    log(`Sending prompt to ${ollamaModel} (${finalPrompt.length} chars)`, "info");

    const response = await fetchWithTimeout(url, body, timeoutMs, externalSignal);

    const llmEndTime = performance.now();
    log(`Response received in ${((llmEndTime - llmStartTime) / 1000).toFixed(2)}s`, "info");

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
    if (err.name === 'AbortError') {
        log("Request aborted safely", "info");
        return { success: false, error: "Aborted" };
      }
    log(`Error: ${err.message}`, "error");
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
  const externalSignal = configOptions.signal;
  
  const { model = CONFIG.LLM_MODEL, options = {} } = configOptions;

  const url = CONFIG.LLM_API_URL + "api/generate";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener("abort", () => controller.abort());
  }

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

    // 👉 ADD THIS LINE HERE TO PROTECT THE STREAM!
    if (response.body && typeof response.body.on === 'function') response.body.on('error', () => {});

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
    if (err.name === 'AbortError') {
        log("Stream aborted safely", "info");
        return { success: false, error: "Aborted" };
      }
    log(`llmStream error: ${err.message}`, "error");
    if (err.name === "AbortError") {
      return { success: false, error: `LLM stream timed out after ${timeoutMs}ms` };
    }
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}
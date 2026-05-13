import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { getLLMPriority } from "../utils/llmContext.js";

// Silent logger: lifecycle info goes to logs/llm/ only, never to PM2 stdout
const log = createLogger("llm", { silent: false, consoleLevel: "warn" });

// ──────────────────────────────────────────────────────────
// Phase 23B — Ollama health-recovery wait
// ──────────────────────────────────────────────────────────
// When an LLM call hits category="timeout", retrying after 2s usually
// just produces another timeout because the Ollama server is stalled
// (GPU exhaustion, KV-cache thrash, model swap). The retry attempt is
// wasted. Instead, ping /api/tags every 5s up to 5 min; if Ollama comes
// back online, retry the original call. If it doesn't recover within
// the window, propagate the timeout as a genuine outage so the user
// sees one clean error instead of compounded waits.
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_HEALTH_TIMEOUT_MS = 3000;
const OLLAMA_HEALTH_POLL_MS = 5000;
const OLLAMA_HEALTH_MAX_WAIT_MS = 5 * 60 * 1000;

async function pingOllama() {
  // Use AbortController-based fetch (native; node-fetch v3 supports it).
  // /api/tags is cheap (<100ms when healthy) and exists on every Ollama version.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForOllamaHealthy({ maxWaitMs = OLLAMA_HEALTH_MAX_WAIT_MS, pollMs = OLLAMA_HEALTH_POLL_MS } = {}) {
  const started = Date.now();
  if (await pingOllama()) return true;
  log(`Ollama unresponsive — waiting up to ${Math.round(maxWaitMs / 1000)}s for it to come back…`, "warn");
  while (Date.now() - started < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollMs));
    if (await pingOllama()) {
      log(`Ollama healthy again after ${Math.round((Date.now() - started) / 1000)}s`, "info");
      return true;
    }
    log(`Ollama still unresponsive (${Math.round((Date.now() - started) / 1000)}s elapsed)`, "warn");
  }
  log(`Ollama did not recover within ${Math.round(maxWaitMs / 1000)}s — giving up`, "error");
  return false;
}

// ──────────────────────────────────────────────────────────
// LLM CONCURRENCY SEMAPHORE (single-GPU Ollama gate)
// ──────────────────────────────────────────────────────────
// Ollama on a single GPU is effectively serial — running two generations at
// once just queues them server-side behind each other, with no visibility.
// This semaphore makes the queueing explicit, enforces concurrency=1, and
// gives user-initiated calls priority over background work (scheduler,
// selfEvolve, heartbeats). It does NOT reject on overflow — per-caller
// `timeoutMs` provides the natural drain.
//
// Priority lanes:
//   - "user"        : live user turn (orchestrator, chatAgent, synthesis)
//   - "background"  : scheduler, selfEvolve, codeReview, heartbeats (default)
// When the active holder releases, the user queue is drained before the
// background queue. A user call that arrives during a background run still
// waits for that run to finish (no hard preempt), but jumps ahead of any
// queued background work.

const _llmQueue = { user: [], background: [] };
let _llmActive = null; // { priority, startedAt } when a call holds the gate

function _llmPickNext() {
  const next = _llmQueue.user.shift() || _llmQueue.background.shift();
  if (next) {
    _llmActive = { priority: next.priority, startedAt: Date.now() };
    next.resolve();
  } else {
    _llmActive = null;
  }
}

/**
 * Acquire the single-GPU gate. Resolves when it's this caller's turn.
 * If `externalSignal` aborts while waiting in the queue, the wait is
 * cancelled and the returned promise rejects.
 */
function _llmAcquire({ priority = "background", externalSignal = null } = {}) {
  if (!_llmActive) {
    _llmActive = { priority, startedAt: Date.now() };
    return Promise.resolve();
  }

  const userWaiting = _llmQueue.user.length;
  const bgWaiting = _llmQueue.background.length;
  const holderPriority = _llmActive.priority;
  const holderAgeSec = Math.round((Date.now() - _llmActive.startedAt) / 1000);

  if (priority === "user" && holderPriority === "background") {
    log(`[gate] user call queued behind a background run (${holderAgeSec}s elapsed) — will jump ahead of ${bgWaiting} background waiter(s)`, "warn");
  } else if (bgWaiting + userWaiting > 0) {
    log(`[gate] ${priority} call queued (ahead: ${userWaiting} user + ${bgWaiting} bg, holder=${holderPriority} ${holderAgeSec}s)`, "info");
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, priority };
    _llmQueue[priority].push(waiter);

    if (externalSignal) {
      const onAbort = () => {
        const lane = _llmQueue[priority];
        const idx = lane.indexOf(waiter);
        if (idx >= 0) {
          lane.splice(idx, 1);
          reject(new Error("LLM request aborted while waiting in queue"));
        }
      };
      if (externalSignal.aborted) {
        onAbort();
      } else {
        externalSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

function _llmRelease() {
  _llmPickNext();
}

/**
 * Observability: current gate state (active holder + queue depths).
 * Useful for debug endpoints or adaptive back-off in background callers.
 */
export function llmGateStatus() {
  return {
    active: _llmActive ? { ...(_llmActive), elapsedMs: Date.now() - _llmActive.startedAt } : null,
    queued: { user: _llmQueue.user.length, background: _llmQueue.background.length }
  };
}

/**
 * Resolve the effective priority for a call: explicit > AsyncLocalStorage > default("background").
 */
function _resolvePriority(explicit) {
  if (explicit === "user" || explicit === "background") return explicit;
  const ctx = getLLMPriority();
  if (ctx === "user" || ctx === "background") return ctx;
  return "background";
}

// ── ACTIVE GENERATION TRACKER ──
// Only one Ollama streaming generation should be active at a time.
// When a new llmStream starts, it aborts any previous controller so Ollama
// doesn't queue new requests behind a stale generation the user already cancelled.
// This is safe for single-user local deployments; multi-user setups would need
// a per-user tracker.
let _activeStreamController = null;

/**
 * Abort any currently-running Ollama stream.
 * Called automatically at the start of each new llmStream.
 * Can also be called directly from chat.js when the user clicks Stop.
 */
export function abortActiveStream() {
  if (_activeStreamController && !_activeStreamController.signal.aborted) {
    log("Aborting previous Ollama generation before starting new one", "info");
    _activeStreamController.abort();
  }
  _activeStreamController = null;
}

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
// Phase 16C — categorize errors so callers (and logs) can distinguish:
//   user_abort       — external signal aborted (user cancelled)
//   timeout          — internal setTimeout fired (request took longer than timeoutMs)
//   network          — fetch threw ECONNREFUSED/ECONNRESET/ENOTFOUND (Ollama unreachable)
//   http_error       — non-2xx HTTP response (Ollama returned an error code)
//   context_overflow — HTTP 400 with body matching context-length pattern
//   unknown          — fallback for unrecognized failures
async function fetchWithTimeout(url, body, timeoutMs = 180_000, externalSignal = null) {
  const controller = new AbortController();
  // Phase 16C — track WHICH source aborted (timeout setTimeout vs externalSignal).
  // Without this flag both paths look identical in the catch block.
  let abortReason = null;
  const timeoutId = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, timeoutMs);

  // Watchdog: if the Ollama connection goes silent the user sees nothing for
  // minutes. Emit a progress log every 30s so it's obvious the server is still
  // stuck on the upstream, not crashed.
  const startedAt = Date.now();
  const watchdogId = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    log(`still waiting for LLM response (${elapsedSec}s elapsed, timeout at ${Math.round(timeoutMs / 1000)}s)`, "warn");
  }, 30_000);

  // If the user clicks stop, trigger our internal abort controller
  if (externalSignal) {
    if (externalSignal.aborted) { abortReason = "user_abort"; controller.abort(); }
    externalSignal.addEventListener("abort", () => {
      abortReason = abortReason || "user_abort";
      controller.abort();
    });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal, // This now listens to both the timeout AND the user!
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (res.body && typeof res.body.on === 'function') res.body.on('error', () => {});

    if (!res.ok) {
      // Phase 16C — distinguish context_overflow from generic http_error
      const bodyText = await res.text().catch(() => "");
      const isContextOverflow = (res.status === 400 || res.status === 422)
        && /context|num_ctx|too\s+(?:long|large)|exceed/i.test(bodyText);
      const e = new Error(`LLM HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      e.category = isContextOverflow ? "context_overflow" : "http_error";
      e.httpStatus = res.status;
      e.duration = Date.now() - startedAt;
      throw e;
    }
    return await res.json();
  } catch (err) {
    const duration = Date.now() - startedAt;
    if (err.category) throw err;          // already categorized (e.g. http_error above)
    if (err.name === "AbortError") {
      const cat = abortReason || "unknown_abort";
      const e = new Error(`LLM request ${cat} after ${duration}ms`);
      e.category = cat;
      e.duration = duration;
      throw e;
    }
    if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "ENOTFOUND" || err.code === "EHOSTUNREACH") {
      const e = new Error(`LLM network error (${err.code}) after ${duration}ms`);
      e.category = "network";
      e.duration = duration;
      e.networkCode = err.code;
      throw e;
    }
    err.duration = duration;
    err.category = err.category || "unknown";
    throw err;
  } finally {
    clearTimeout(timeoutId);
    clearInterval(watchdogId);
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

// Phase 16D — single retry with exponential backoff for transient timeouts
// and network errors. The retry fires AFTER the full timeoutMs has elapsed
// (the user noted that long writes are normal — slow ≠ stuck), not mid-call.
// User-aborts and context-overflows are NEVER retried.
const RETRYABLE_CATEGORIES = new Set(["timeout", "network", "http_error"]);
const NON_RETRYABLE_CATEGORIES = new Set(["user_abort", "context_overflow"]);

export async function llm(prompt, configOptions = {}) {
  const maxRetries = configOptions.maxRetries ?? 1;
  let lastResult = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await _llmCore(prompt, configOptions);
    if (result?.success) return result;
    lastResult = result;
    const cat = result?.errorCategory || "unknown";
    if (NON_RETRYABLE_CATEGORIES.has(cat)) {
      log(`[retry] not retrying — category=${cat} is non-retryable`, "info");
      break;
    }
    if (attempt < maxRetries && RETRYABLE_CATEGORIES.has(cat)) {
      // Phase 23B — on `timeout` category, the Ollama server is likely
      // stalled (GPU exhaustion, model swap, etc.). Burning the retry on
      // a still-stalled server just produces another timeout. Instead,
      // ping Ollama's /api/tags until it responds (or 5 min max), THEN
      // retry the actual call.
      if (cat === "timeout") {
        const healthy = await waitForOllamaHealthy();
        if (!healthy) {
          log(`[retry] Ollama did not recover — propagating timeout`, "error");
          break;
        }
        log(`[retry] attempt ${attempt + 1}/${maxRetries} after Ollama recovered (category=${cat}, model=${configOptions.model || "default"})`, "warn");
        continue;
      }
      const delay = Math.min(2000 * Math.pow(2, attempt), 15000);  // 2s, 4s, 8s, capped 15s
      log(`[retry] attempt ${attempt + 1}/${maxRetries} after ${delay}ms (category=${cat}, model=${configOptions.model || "default"})`, "warn");
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    break;
  }
  return lastResult;
}

async function _llmCore(prompt, configOptions = {}) {
  const timeoutMs = configOptions.timeoutMs || 600_000;
  const externalSignal = configOptions.signal;
  const priority = _resolvePriority(configOptions.priority);
  let { model, format, options = {}, skipLanguageDetection = false, system } = configOptions;

  // Auto-detect Hebrew/Arabic ONLY if we aren't explicitly skipping it
  if (!model && !skipLanguageDetection) {
    const detectedModel = pickModelForContent(typeof prompt === "string" ? prompt : "");
    model = detectedModel || CONFIG.LLM_MODEL;
  } else if (!model) {
    model = CONFIG.LLM_MODEL;
  }

  // ── Acquire the single-GPU gate before doing any work ──
  // We acquire BEFORE building the prompt context so the expensive
  // context-injection / token work doesn't happen while we're about to wait.
  // Gemini route also goes through the gate: even though it hits a different
  // backend, treating both routes as one queue keeps behavior predictable
  // (and the Gemini fallback path lands on Ollama anyway).
  try {
    await _llmAcquire({ priority, externalSignal });
  } catch (err) {
    // Aborted while waiting in queue — propagate as a standard LLM failure.
    // Phase 16D — tag with errorCategory so the retry wrapper can decide
    // whether to retry (queue-aborts are typically user_abort → no retry).
    return {
      tool: "llm", success: false, final: true,
      error: err.message,
      errorCategory: externalSignal?.aborted ? "user_abort" : "queue_aborted",
      data: { text: `The language model encountered an error: ${err.message}` }
    };
  }

  // Everything past this point holds the gate — guarantee release in finally.
  try {
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
    // Only inject persona/knowledge for active user chats, NEVER for background admin tools (selfEvolve, etc.)
    if (!configOptions.skipKnowledge && !configOptions.format && priority !== "background") {
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

// LOUD DEBUGGING LOGS:
    console.log(`\n🔥 [LLM TOOL DEBUG] -----------------------------------------`);
    console.log(`🔥 MODEL BEING USED: ${ollamaModel}`);
    console.log(`🔥 IS SYSTEM PROMPT INJECTED? ${!!system}`);
    if (finalPrompt.includes("cynical, foul-mouthed veteran hacker")) {
      console.log(`🔥 PERSONALITY CHECK: Hacker Persona DETECTED in prompt!`);
    } else {
      console.log(`🔥 PERSONALITY CHECK: Hacker Persona MISSING from prompt!`);
    }
    console.log(`------------------------------------------------------------\n`);

    // Phase 17A — KV-cache + GPU-layer hygiene for 8GB VRAM cards.
    // num_ctx=4096 keeps qwen2.5:7b's KV cache ≈ 1GB, leaving the model itself
    // (~4.7GB) comfortably resident in VRAM. Synthesis callers that need more
    // context pass num_ctx via options and override via the spread below.
    // num_gpu=999 instructs Ollama to load ALL layers to GPU; if it can't, it
    // errors immediately as HTTP 400 instead of silently spilling layers to
    // CPU RAM (which causes 30-100x slower inference and the timeout cascade
    // observed in earlier runs). Override via OLLAMA_NUM_GPU env var to force
    // partial offload (e.g. OLLAMA_NUM_GPU=35) when a larger model is needed.
    const numGpu = process.env.OLLAMA_NUM_GPU
      ? parseInt(process.env.OLLAMA_NUM_GPU, 10)
      : 999;
    const body = {
      model: ollamaModel,
      prompt: finalPrompt,
      ...(system ? { system } : {}),
      stream: false,
      ...(format ? { format } : {}),
      options: {
        num_ctx: 4096,           // was 8192 — KV cache fits in 8GB
        num_gpu: numGpu,         // 999 = all-GPU; fail loudly if doesn't fit
        ...options               // caller overrides win via spread
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
    // Phase 16C — surface error category + duration + model + prompt-length
    // for diagnosis. The previous catch collapsed all failures to a generic
    // "Error: ..." line; the new line lets us tell at a glance whether the
    // user cancelled, Ollama crashed, the request timed out, or the input
    // exceeded the model's context window.
    const category = err.category || (err.name === "AbortError" ? "unknown_abort" : "unknown");
    const duration = err.duration || null;
    const promptLen = (typeof prompt === "string" ? prompt.length : 0);
    if (err.name === 'AbortError' && category === "user_abort") {
      log(`Request aborted by user (model=${model}, duration=${duration}ms, promptLen=${promptLen}c)`, "info");
      return { success: false, error: "Aborted", errorCategory: "user_abort" };
    }
    log(`[ERROR] category=${category} model=${model} duration=${duration}ms promptLen=${promptLen}c — ${err.message}`, "error");
    return {
      tool: "llm",
      success: false,
      final: true,
      error: err.message,
      errorCategory: category,
      data: { text: `The language model encountered an error: ${err.message}` }
    };
  }
  } finally {
    _llmRelease();
  }
}

export async function llmStream(prompt, onChunk, configOptions = {}) {
  const timeoutMs = configOptions.timeoutMs || 300_000;
  const maxChunks = configOptions.maxChunks || 10000;
  const externalSignal = configOptions.signal;

  // ── Language-aware model selection (parity with llm()) ──
  // Previously llmStream defaulted straight to CONFIG.LLM_MODEL, which meant Hebrew/Arabic
  // chat replies (the primary user-facing path) always used the English default model and
  // returned broken prose. Now we run pickModelForContent like the non-streaming path does.
  let { model, options = {}, skipLanguageDetection = false, system } = configOptions;
  if (!model && !skipLanguageDetection) {
    const detected = pickModelForContent(typeof prompt === "string" ? prompt : "");
    // If Gemini is the recommendation, fall back to the local Hebrew model for streaming
    // (Gemini is not wired into this Ollama streaming path).
    if (detected === "gemini") model = LOCAL_HEBREW_MODEL;
    else if (detected) model = detected;
  }
  if (!model) model = CONFIG.LLM_MODEL;

  const url = CONFIG.LLM_API_URL + "api/generate";

  // Abort any previously active Ollama stream. This ensures that when the user
  // clicks Stop and then sends a new message, the old generation is explicitly
  // killed before the new fetch is issued — so Ollama doesn't queue the new
  // request behind a stale one.
  abortActiveStream();

  // Streaming calls are always user-initiated chat — give them user priority
  // unless the caller explicitly overrides. They jump ahead of any queued
  // background work (scheduler, selfEvolve, heartbeats).
  const streamPriority = _resolvePriority(configOptions.priority || "user");
  try {
    await _llmAcquire({ priority: streamPriority, externalSignal });
  } catch (err) {
    log(`Stream aborted while waiting in queue: ${err.message}`, "info");
    return { success: false, error: err.message };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Register this controller as the globally active one
  _activeStreamController = controller;

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener("abort", () => controller.abort());
  }

  try {
    const body = {
      model,
      prompt,
      ...(system ? { system } : {}),
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
    // Clear the global tracker if this is still the active controller
    if (_activeStreamController === controller) {
      _activeStreamController = null;
    }
    // Release the semaphore so the next waiter (user or background) can go.
    _llmRelease();
  }
}
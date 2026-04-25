// server/utils/llmContext.js
// AsyncLocalStorage for propagating LLM call priority through async chains.
//
// The orchestrator wraps every user-initiated turn in `runWithLLMPriority("user", ...)`.
// Any `llm()` or `llmStream()` call made inside that turn — however deeply nested —
// inherits `priority: "user"` automatically, without threading a parameter through
// every function signature.
//
// Scheduler / selfEvolve / heartbeat callers run OUTSIDE this scope, so their
// `getLLMPriority()` returns `null` and `llm.js` defaults them to "background".

import { AsyncLocalStorage } from "node:async_hooks";

const _als = new AsyncLocalStorage();

/**
 * Run `fn` with the given LLM priority active for all nested async work.
 * @param {"user" | "background"} priority
 * @param {() => Promise<any>} fn
 */
export function runWithLLMPriority(priority, fn) {
  return _als.run({ priority }, fn);
}

/**
 * Read the currently-active LLM priority, or `null` if not inside a scope.
 * @returns {"user" | "background" | null}
 */
export function getLLMPriority() {
  return _als.getStore()?.priority || null;
}

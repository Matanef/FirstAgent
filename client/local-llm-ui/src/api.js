// client/local-llm-ui/src/api.js
// Centralized API helper — provides authenticated fetch and XHR for all components

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

const API_KEY = import.meta.env.VITE_AGENT_API_KEY || "";

/**
 * Returns headers object with auth key included (if configured).
 * Merge with any additional headers your call needs.
 */
export function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (API_KEY) {
    headers["X-Api-Key"] = API_KEY;
  }
  return headers;
}

/**
 * Authenticated fetch wrapper — automatically injects X-Api-Key.
 * Accepts the same arguments as native fetch().
 */
export function apiFetch(url, options = {}) {
  const fullUrl = url.startsWith("http") ? url : `${API_URL}${url}`;
  const merged = {
    ...options,
    headers: authHeaders(options.headers || {}),
  };
  return fetch(fullUrl, merged);
}

/**
 * Configures an existing XMLHttpRequest with the auth header.
 * Call this AFTER xhr.open() but BEFORE xhr.send().
 */
export function applyAuthToXHR(xhr) {
  if (API_KEY) {
    xhr.setRequestHeader("X-Api-Key", API_KEY);
  }
}

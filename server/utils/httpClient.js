// server/utils/httpClient.js
// HTTP client with cookie jar, CSRF extraction, rate limiting, and retry logic
// Wraps axios with sessionManager integration

import axios from "axios";
import * as cheerio from "cheerio";
import { getSession, saveSession } from "./sessionManager.js";

// ============================================================
// USER-AGENT ROTATION
// ============================================================
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

let uaIndex = 0;
function getNextUserAgent() {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

// ============================================================
// RATE LIMITING (per-domain)
// ============================================================
const _lastRequestTime = new Map(); // domain -> timestamp

async function enforceRateLimit(url, delayMs) {
  const domain = new URL(url).hostname;
  const now = Date.now();
  const last = _lastRequestTime.get(domain) || 0;
  const elapsed = now - last;

  if (elapsed < delayMs) {
    const wait = delayMs - elapsed;
    await new Promise(resolve => setTimeout(resolve, wait));
  }

  _lastRequestTime.set(domain, Date.now());
}

// ============================================================
// CSRF EXTRACTION
// ============================================================
const CSRF_SELECTORS = [
  'meta[name="csrf-token"]',
  'meta[name="_csrf"]',
  'meta[name="csrf_token"]',
  'input[name="_token"]',
  'input[name="csrf_token"]',
  'input[name="_csrf"]',
  'input[name="csrfmiddlewaretoken"]',
  'input[name="authenticity_token"]',
];

function extractCsrfToken(html) {
  try {
    const $ = cheerio.load(html);

    for (const selector of CSRF_SELECTORS) {
      const el = $(selector).first();
      if (el.length) {
        // Meta tags use content attr, inputs use value attr
        return el.attr("content") || el.attr("value") || null;
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

// ============================================================
// LOG SANITIZATION
// ============================================================
const SENSITIVE_FIELDS = new Set([
  "password", "passwd", "pass", "secret", "token",
  "api_key", "apikey", "credit_card", "ssn"
]);

function sanitizeForLog(data) {
  if (!data || typeof data !== "object") return data;
  const sanitized = { ...data };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      sanitized[key] = "***REDACTED***";
    }
  }
  return sanitized;
}

// ============================================================
// MAIN: createHttpClient
// ============================================================

/**
 * Create an HTTP client bound to a named session with cookie persistence.
 *
 * @param {string} sessionName - Session name (e.g. "moltbook")
 * @param {object} options
 * @param {number} options.rateLimit - Delay between requests in ms (default 1000)
 * @param {number} options.maxRetries - Max retry attempts (default 3)
 * @param {string} options.userAgent - Custom UA (default: rotated)
 * @param {number} options.timeout - Request timeout ms (default 30000)
 */
export function createHttpClient(sessionName, options = {}) {
  const {
    rateLimit = 1000,
    maxRetries = 3,
    userAgent = null,
    timeout = 30000
  } = options;

  // ---- Internal helpers ----

  async function buildHeaders(url, extraHeaders = {}) {
    const session = await getSession(sessionName);
    const headers = {
      "User-Agent": userAgent || getNextUserAgent(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...extraHeaders
    };

    // Inject cookies from jar
    try {
      const cookieString = await session.jar.getCookieString(url);
      if (cookieString) {
        headers["Cookie"] = cookieString;
      }
    } catch (err) {
      console.warn(`[httpClient] Cookie read error:`, err.message);
    }

    // Inject CSRF token for non-GET requests
    if (session.metadata.csrfToken) {
      headers["X-CSRF-TOKEN"] = session.metadata.csrfToken;
      headers["X-Requested-With"] = "XMLHttpRequest";
    }

    return headers;
  }

  async function storeCookies(url, response) {
    const session = await getSession(sessionName);
    const setCookies = response.headers["set-cookie"];

    if (setCookies) {
      const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
      for (const cookie of cookies) {
        try {
          await session.jar.setCookie(cookie, url);
        } catch (err) {
          console.warn(`[httpClient] Cookie set error:`, err.message);
        }
      }
      await saveSession(sessionName);
    }
  }

  async function updateCsrf(html) {
    const token = extractCsrfToken(html);
    if (token) {
      const session = await getSession(sessionName);
      session.metadata.csrfToken = token;
      await saveSession(sessionName);
    }
    return token;
  }

  async function requestWithRetry(method, url, data, extraHeaders = {}, attempt = 0) {
    await enforceRateLimit(url, rateLimit);

    const headers = await buildHeaders(url, extraHeaders);

    const config = {
      method,
      url,
      headers,
      timeout,
      maxRedirects: 10,
      validateStatus: () => true, // Don't throw on any status
    };

    if (data && (method === "post" || method === "put" || method === "patch")) {
      if (typeof data === "string" || data instanceof URLSearchParams) {
        config.data = data;
        if (data instanceof URLSearchParams) {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
      } else {
        config.data = data;
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    console.log(`[httpClient] ${method.toUpperCase()} ${url} (session: ${sessionName}, attempt: ${attempt + 1})`);
    if (data && typeof data === "object") {
      console.log(`[httpClient] Body:`, sanitizeForLog(data));
    }

    try {
      const response = await axios(config);

      // Store response cookies
      await storeCookies(url, response);

      // Extract CSRF from HTML responses
      const contentType = response.headers["content-type"] || "";
      if (contentType.includes("text/html") && typeof response.data === "string") {
        await updateCsrf(response.data);
      }

      console.log(`[httpClient] Response: ${response.status} (${contentType.split(";")[0]})`);

      // Retry on 429 or 5xx
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = parseInt(response.headers["retry-after"]) || 0;
        const backoff = retryAfter * 1000 || Math.pow(2, attempt) * 1000;
        console.log(`[httpClient] Retrying in ${backoff}ms (status ${response.status})...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return requestWithRetry(method, url, data, extraHeaders, attempt + 1);
      }

      return {
        status: response.status,
        headers: response.headers,
        data: response.data,
        url: response.request?.res?.responseUrl || url,
        ok: response.status >= 200 && response.status < 400
      };
    } catch (err) {
      if (attempt < maxRetries && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT")) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.log(`[httpClient] Network error, retrying in ${backoff}ms: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return requestWithRetry(method, url, data, extraHeaders, attempt + 1);
      }

      console.error(`[httpClient] Request failed:`, err.message);
      return {
        status: 0,
        headers: {},
        data: null,
        url,
        ok: false,
        error: err.message
      };
    }
  }

  // ---- Public API ----

  return {
    /**
     * GET a URL.
     */
    async get(url, opts = {}) {
      return requestWithRetry("get", url, null, opts.headers || {});
    },

    /**
     * POST data to a URL.
     */
    async post(url, data = {}, opts = {}) {
      return requestWithRetry("post", url, data, opts.headers || {});
    },

    /**
     * Submit a form (URL-encoded POST) with automatic CSRF injection.
     */
    async submitForm(url, formData = {}, opts = {}) {
      const session = await getSession(sessionName);

      // Auto-inject CSRF token into form data
      const data = { ...formData };
      if (session.metadata.csrfToken) {
        // Try common CSRF field names
        if (!data._token && !data.csrf_token && !data._csrf && !data.csrfmiddlewaretoken) {
          data._token = session.metadata.csrfToken;
        }
      }

      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) {
        params.append(key, value);
      }

      return requestWithRetry("post", url, params, {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(opts.headers || {})
      });
    },

    /**
     * Get cookies for a domain from the session jar.
     */
    async getCookies(domain) {
      const session = await getSession(sessionName);
      try {
        const url = domain.startsWith("http") ? domain : `https://${domain}`;
        return await session.jar.getCookies(url);
      } catch {
        return [];
      }
    },

    /**
     * Get the current session object (jar + metadata).
     */
    async getSession() {
      return getSession(sessionName);
    },

    /**
     * Manually set a CSRF token (useful when extracted from JS-rendered pages).
     */
    async setCsrfToken(token) {
      const session = await getSession(sessionName);
      session.metadata.csrfToken = token;
      await saveSession(sessionName);
    },

    /**
     * Extract CSRF token from the last HTML response, or GET a page first.
     */
    async fetchCsrfToken(url) {
      const response = await requestWithRetry("get", url, null, {});
      if (response.ok && typeof response.data === "string") {
        return extractCsrfToken(response.data);
      }
      return null;
    }
  };
}

/**
 * Convenience: extract CSRF from raw HTML string.
 */
export { extractCsrfToken };

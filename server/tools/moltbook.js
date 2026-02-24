// server/tools/moltbook.js
// Domain-specific tool for interacting with moltbook.com
// Wraps httpClient + webBrowser with moltbook-specific knowledge

import { createHttpClient } from "../utils/httpClient.js";
import { storeCredential, getCredential } from "../utils/credentialStore.js";
import { findVerificationEmail, clickVerificationLink } from "../utils/emailVerification.js";
import * as cheerio from "cheerio";
import { CONFIG } from "../utils/config.js";

const SESSION_NAME = "moltbook";
const BASE_URL = () => CONFIG.MOLTBOOK_BASE_URL || "https://moltbook.com";

// Common paths (will be discovered/updated as we learn the site structure)
const PATHS = {
  home: "/",
  login: "/login",
  register: "/register",
  logout: "/logout",
  profile: "/profile",
  settings: "/settings",
  search: "/search",
  dashboard: "/dashboard",
};

function fullUrl(pathOrUrl) {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  return BASE_URL() + (pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl);
}

function getClient() {
  return createHttpClient(SESSION_NAME, {
    rateLimit: 1200,
    maxRetries: 3,
    timeout: 30000
  });
}

/**
 * Parse page content with cheerio.
 */
function parsePage(html, url) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const title = $("title").text().trim() || $("h1").first().text().trim() || "";
  const mainContent = $("main, article, .content, #content, [role='main']").first();
  const textContent = (mainContent.length ? mainContent.text() : $("body").text())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);

  // Links
  const links = [];
  $("a[href]").each((_, el) => {
    if (links.length >= 30) return false;
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && text && !href.startsWith("#") && !href.startsWith("javascript:")) {
      try {
        links.push({ text: text.slice(0, 100), url: new URL(href, url).href });
      } catch { /* skip */ }
    }
  });

  // Forms
  const forms = [];
  $("form").each((_, formEl) => {
    const action = $(formEl).attr("action") || "";
    const method = ($(formEl).attr("method") || "GET").toUpperCase();
    const fields = [];

    $(formEl).find("input, textarea, select").each((__, fieldEl) => {
      const name = $(fieldEl).attr("name");
      const type = $(fieldEl).attr("type") || $(fieldEl).prop("tagName").toLowerCase();
      const value = $(fieldEl).attr("value") || "";
      const placeholder = $(fieldEl).attr("placeholder") || "";
      const required = $(fieldEl).attr("required") !== undefined;
      if (name) fields.push({ name, type, value, placeholder, required });
    });

    if (fields.length > 0) {
      let actionUrl = action;
      try { actionUrl = new URL(action, url).href; } catch { /* keep relative */ }
      forms.push({ action: actionUrl, method, fields });
    }
  });

  // Login status detection
  const lower = html.toLowerCase();
  const loggedIn = lower.includes("logout") || lower.includes("sign out") ||
    lower.includes("my account") || lower.includes("my profile");
  const loggedOut = lower.includes("log in") || lower.includes("sign in") || lower.includes("register");

  const loginStatus = loggedIn && !loggedOut ? "logged_in" :
    loggedOut && !loggedIn ? "logged_out" : "unknown";

  // Error messages
  const errors = [];
  $(".error, .alert-danger, .alert-error, .invalid-feedback, .text-danger").each((_, el) => {
    const text = $(el).text().trim();
    if (text) errors.push(text.slice(0, 200));
  });

  // Success messages
  const successes = [];
  $(".success, .alert-success, .text-success, .notice").each((_, el) => {
    const text = $(el).text().trim();
    if (text) successes.push(text.slice(0, 200));
  });

  return { title, textContent, links, forms, loginStatus, errors, successes };
}

/**
 * Main moltbook tool.
 */
export async function moltbook(input) {
  try {
    const text = typeof input === "string" ? input : (input?.text || "");
    const context = typeof input === "object" ? (input?.context || {}) : {};
    const action = context.action || inferAction(text);

    console.log(`[moltbook] Action: ${action}`);

    switch (action) {
      case "register": return await handleRegister(text, context);
      case "login": return await handleLogin(text, context);
      case "logout": return await handleLogout();
      case "browse": return await handleBrowse(text, context);
      case "profile": return await handleProfile(text, context);
      case "search": return await handleSearch(text, context);
      case "interact": return await handleInteract(text, context);
      case "status": return await handleStatus();
      case "storeCredentials": return await handleStoreCredentials(text, context);
      case "verify_email": return await handleVerifyEmail(text, context);
      default: return await handleBrowse(text, context);
    }
  } catch (err) {
    console.error("[moltbook] Error:", err.message);
    return {
      tool: "moltbook",
      success: false,
      final: true,
      error: err.message,
      data: { text: `Moltbook error: ${err.message}` }
    };
  }
}

// ---- Action Inference ----

function inferAction(text) {
  const lower = text.toLowerCase();
  if (/\b(register|sign\s*up|create\s+account)\b/.test(lower)) return "register";
  if (/\b(log\s*in|sign\s*in|authenticate)\b/.test(lower)) return "login";
  if (/\b(log\s*out|sign\s*out)\b/.test(lower)) return "logout";
  if (/\b(profile|my\s+account)\b/.test(lower)) return "profile";
  if (/\b(search|find|look\s+for)\b/.test(lower)) return "search";
  if (/\b(like|comment|follow|post|share|interact)\b/.test(lower)) return "interact";
  if (/\b(status|check|session)\b/.test(lower)) return "status";
  if (/\b(store|save|remember)\s*(credential|password|login)\b/.test(lower)) return "storeCredentials";
  if (/\b(verify|verification|confirm)\s*(email|mail)\b/.test(lower)) return "verify_email";
  return "browse";
}

// ---- Credential extraction helpers ----

function extractCredentials(text, context) {
  if (context.credentials) return context.credentials;

  const userMatch = text.match(/(?:user(?:name)?|email|login)\s*[:=]\s*(\S+)/i);
  const passMatch = text.match(/(?:pass(?:word)?)\s*[:=]\s*(\S+)/i);
  const emailMatch = text.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);

  if (userMatch && passMatch) {
    return { username: userMatch[1], password: passMatch[1], email: emailMatch?.[1] };
  }
  return null;
}

// ---- Action Handlers ----

async function handleRegister(text, context) {
  const client = getClient();
  const url = context.url || fullUrl(PATHS.register);

  // Get registration page
  const page = await client.get(url);
  if (!page.ok) {
    return fail(`Failed to load registration page: HTTP ${page.status}`);
  }

  const html = typeof page.data === "string" ? page.data : "";
  const parsed = parsePage(html, url);

  // Find registration form
  const regForm = parsed.forms.find(f =>
    f.method === "POST" &&
    f.fields.some(field => field.type === "password") &&
    (f.fields.some(field => field.name.match(/email/i)) || f.fields.length >= 3)
  );

  if (!regForm) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: `Could not find a registration form at ${url}. Page title: "${parsed.title}"\n\nAvailable forms: ${parsed.forms.length}`,
        action: "register",
        title: parsed.title,
        forms: parsed.forms,
        content: parsed.textContent.slice(0, 1000)
      }
    };
  }

  // Extract or request credentials
  let credentials = extractCredentials(text, context);
  if (!credentials) {
    try {
      credentials = await getCredential(SESSION_NAME);
    } catch { /* not available */ }
  }

  if (!credentials) {
    // Return form preview for user to provide data
    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `Found registration form at ${url}. Please provide your registration details.\n\nRequired fields: ${regForm.fields.filter(f => f.type !== "hidden").map(f => f.name).join(", ")}`,
        action: "register",
        mode: "preview",
        formAction: regForm.action,
        fields: regForm.fields.filter(f => f.type !== "hidden"),
        title: parsed.title,
        needsCredentials: true
      }
    };
  }

  // Build form data
  const formData = {};
  for (const field of regForm.fields) {
    if (field.type === "hidden") {
      formData[field.name] = field.value;
    } else if (field.type === "password") {
      formData[field.name] = credentials.password;
    } else if (field.name.match(/email/i)) {
      formData[field.name] = credentials.email || credentials.username;
    } else if (field.name.match(/user|name|login/i)) {
      formData[field.name] = credentials.username || credentials.name || "";
    }
  }

  // Submit registration
  const result = await client.submitForm(regForm.action, formData);
  const resultHtml = typeof result.data === "string" ? result.data : "";
  const resultParsed = parsePage(resultHtml, result.url || url);

  const hasError = resultParsed.errors.length > 0 ||
    resultHtml.toLowerCase().includes("already exists") ||
    resultHtml.toLowerCase().includes("already taken");

  return {
    tool: "moltbook",
    success: !hasError && result.ok,
    final: true,
    data: {
      text: hasError
        ? `Registration may have failed. Errors: ${resultParsed.errors.join("; ") || "Check page content."}`
        : `Registration submitted successfully! ${resultParsed.successes.length > 0 ? resultParsed.successes[0] : "Check your email for verification."}`,
      action: "register",
      title: resultParsed.title,
      errors: resultParsed.errors,
      successes: resultParsed.successes,
      content: resultParsed.textContent.slice(0, 2000),
      statusCode: result.status,
      needsVerification: resultHtml.toLowerCase().includes("verify") || resultHtml.toLowerCase().includes("confirm")
    }
  };
}

async function handleLogin(text, context) {
  const client = getClient();

  // Check for stored credentials first
  let credentials = extractCredentials(text, context);
  if (!credentials) {
    try {
      credentials = await getCredential(SESSION_NAME);
      if (credentials) console.log("[moltbook] Using stored credentials");
    } catch { /* credential store unavailable */ }
  }

  if (!credentials) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: "No credentials available for moltbook. Please provide them:\n- In the message: login to moltbook username: your_user password: your_pass\n- Or store them first: store my moltbook credentials username: your_user password: your_pass",
        action: "login",
        needsCredentials: true
      }
    };
  }

  const url = context.url || fullUrl(PATHS.login);

  // GET login page
  const loginPage = await client.get(url);
  if (!loginPage.ok) {
    return fail(`Failed to load login page: HTTP ${loginPage.status}`);
  }

  const html = typeof loginPage.data === "string" ? loginPage.data : "";
  const parsed = parsePage(html, url);

  // Find login form
  const loginForm = parsed.forms.find(f =>
    f.method === "POST" &&
    f.fields.some(field => field.type === "password")
  );

  if (!loginForm) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: `Could not find a login form at ${url}. Page: "${parsed.title}"`,
        action: "login",
        title: parsed.title,
        forms: parsed.forms
      }
    };
  }

  // Build form data
  const formData = {};
  for (const field of loginForm.fields) {
    if (field.type === "hidden") {
      formData[field.name] = field.value;
    } else if (field.type === "password") {
      formData[field.name] = credentials.password;
    } else if (field.type === "email" || field.name.match(/user|email|login/i)) {
      formData[field.name] = credentials.username || credentials.email;
    } else if (field.type === "text") {
      formData[field.name] = credentials.username || credentials.email || "";
    }
  }

  // Submit login
  const result = await client.submitForm(loginForm.action, formData);
  const resultHtml = typeof result.data === "string" ? result.data : "";
  const resultParsed = parsePage(resultHtml, result.url || url);

  const success = resultParsed.loginStatus === "logged_in" ||
    result.status === 302 ||
    resultParsed.errors.length === 0 && !resultHtml.toLowerCase().includes("invalid");

  return {
    tool: "moltbook",
    success,
    final: true,
    data: {
      text: success
        ? `Successfully logged in to moltbook! Session saved.`
        : `Login failed. ${resultParsed.errors.length > 0 ? "Errors: " + resultParsed.errors.join("; ") : "Check credentials."}`,
      action: "login",
      sessionActive: success,
      loginStatus: resultParsed.loginStatus,
      title: resultParsed.title,
      errors: resultParsed.errors,
      successes: resultParsed.successes,
      statusCode: result.status,
      session: SESSION_NAME
    }
  };
}

async function handleLogout() {
  const client = getClient();

  // Try POST first, then GET
  let result = await client.post(fullUrl(PATHS.logout));
  if (!result.ok) {
    result = await client.get(fullUrl(PATHS.logout));
  }

  const html = typeof result.data === "string" ? result.data : "";
  const parsed = parsePage(html, result.url || fullUrl(PATHS.logout));

  return {
    tool: "moltbook",
    success: true,
    final: true,
    data: {
      text: "Logged out of moltbook. Session cookies cleared from request. Note: server-side session may still be valid until expiry.",
      action: "logout",
      loginStatus: parsed.loginStatus,
      title: parsed.title
    }
  };
}

async function handleBrowse(text, context) {
  const client = getClient();

  // Extract URL or path from text/context
  let url = context.url || null;

  if (!url) {
    // Try to extract a path from text
    const pathMatch = text.match(/(?:browse|visit|go to|open|navigate to)\s+(.+)/i);
    if (pathMatch) {
      const target = pathMatch[1].trim();
      if (target.startsWith("http")) {
        url = target;
      } else if (target.startsWith("/")) {
        url = fullUrl(target);
      } else {
        // Check known paths
        const knownPath = PATHS[target.toLowerCase()];
        if (knownPath) {
          url = fullUrl(knownPath);
        } else {
          url = fullUrl("/" + target);
        }
      }
    } else {
      url = fullUrl(PATHS.home);
    }
  }

  const response = await client.get(url);

  if (!response.ok) {
    // If 401/403, try re-login
    if (response.status === 401 || response.status === 403) {
      return {
        tool: "moltbook",
        success: false,
        final: true,
        data: {
          text: `Access denied (HTTP ${response.status}). You may need to log in first. Try: login to moltbook`,
          action: "browse",
          statusCode: response.status,
          needsAuth: true
        }
      };
    }

    return fail(`Failed to load ${url}: HTTP ${response.status}`);
  }

  const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  const parsed = parsePage(html, url);

  return {
    tool: "moltbook",
    success: true,
    final: true,
    data: {
      text: `Browsed moltbook: "${parsed.title}"\n\n${parsed.textContent.slice(0, 2000)}`,
      action: "browse",
      url: response.url || url,
      title: parsed.title,
      content: parsed.textContent,
      links: parsed.links,
      forms: parsed.forms,
      loginStatus: parsed.loginStatus,
      sessionActive: parsed.loginStatus === "logged_in",
      statusCode: response.status,
      session: SESSION_NAME
    }
  };
}

async function handleProfile(text, context) {
  const url = context.url || fullUrl(PATHS.profile);
  return handleBrowse(text, { ...context, url, action: "browse" });
}

async function handleSearch(text, context) {
  const client = getClient();
  const query = context.query || text.replace(/^.*?(search|find|look\s+for)\s*/i, "").trim();

  // Try common search patterns
  const searchUrl = fullUrl(PATHS.search + "?q=" + encodeURIComponent(query));
  const response = await client.get(searchUrl);

  if (!response.ok) {
    return fail(`Search failed: HTTP ${response.status}`);
  }

  const html = typeof response.data === "string" ? response.data : "";
  const parsed = parsePage(html, searchUrl);

  return {
    tool: "moltbook",
    success: true,
    final: true,
    data: {
      text: `Search results for "${query}" on moltbook:\n\n${parsed.textContent.slice(0, 3000)}`,
      action: "search",
      query,
      url: response.url || searchUrl,
      title: parsed.title,
      content: parsed.textContent,
      links: parsed.links,
      statusCode: response.status,
      session: SESSION_NAME
    }
  };
}

async function handleInteract(text, context) {
  const client = getClient();
  const url = context.url;

  if (!url) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: "Please specify what to interact with and provide a URL. Example: like the post at moltbook.com/posts/123",
        action: "interact"
      }
    };
  }

  const formData = context.formData || {};
  const method = context.method || "post";

  let response;
  if (method === "get") {
    response = await client.get(url);
  } else {
    response = await client.submitForm(url, formData);
  }

  const html = typeof response.data === "string" ? response.data : "";
  const parsed = parsePage(html, response.url || url);

  return {
    tool: "moltbook",
    success: response.ok,
    final: true,
    data: {
      text: response.ok
        ? `Interaction successful. ${parsed.successes.length > 0 ? parsed.successes[0] : ""}`
        : `Interaction failed: ${parsed.errors.length > 0 ? parsed.errors[0] : "HTTP " + response.status}`,
      action: "interact",
      url: response.url || url,
      title: parsed.title,
      content: parsed.textContent.slice(0, 1000),
      statusCode: response.status,
      errors: parsed.errors,
      successes: parsed.successes,
      session: SESSION_NAME
    }
  };
}

async function handleStatus() {
  const client = getClient();

  // Try to access a page that requires login
  const response = await client.get(fullUrl(PATHS.home));
  const html = typeof response.data === "string" ? response.data : "";
  const parsed = parsePage(html, fullUrl(PATHS.home));

  // Check cookies
  const cookies = await client.getCookies(BASE_URL());
  const hasCreds = !!(await getCredential(SESSION_NAME).catch(() => null));

  return {
    tool: "moltbook",
    success: true,
    final: true,
    data: {
      text: `Moltbook session status:\n- Login: ${parsed.loginStatus}\n- Cookies: ${cookies.length}\n- Stored credentials: ${hasCreds ? "yes" : "no"}\n- Base URL: ${BASE_URL()}\n- Page: "${parsed.title}"`,
      action: "status",
      loginStatus: parsed.loginStatus,
      sessionActive: parsed.loginStatus === "logged_in",
      cookieCount: cookies.length,
      hasStoredCredentials: hasCreds,
      baseUrl: BASE_URL(),
      title: parsed.title,
      session: SESSION_NAME
    }
  };
}

async function handleStoreCredentials(text, context) {
  let credentials = extractCredentials(text, context);

  if (!credentials) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: "Please provide credentials to store. Format: store moltbook credentials username: your_user password: your_pass",
        action: "storeCredentials",
        needsCredentials: true
      }
    };
  }

  try {
    await storeCredential(SESSION_NAME, credentials);
    return {
      tool: "moltbook",
      success: true,
      final: true,
      data: {
        text: `Moltbook credentials stored securely (AES-256-GCM encrypted). Username: ${credentials.username || credentials.email}`,
        action: "storeCredentials",
        service: SESSION_NAME,
        username: credentials.username || credentials.email
      }
    };
  } catch (err) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: { text: `Failed to store credentials: ${err.message}` }
    };
  }
}

async function handleVerifyEmail(text, context) {
  const domain = context.domain || "moltbook.com";

  console.log(`[moltbook] Searching for verification email from ${domain}...`);

  const emailResult = await findVerificationEmail(domain, {
    maxAge: context.maxAge || 1,
    maxWait: context.maxWait || 120000,
    pollInterval: context.pollInterval || 10000
  });

  if (!emailResult.found) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: emailResult.error || `No verification email found from ${domain}.`,
        action: "verify_email",
        found: false
      }
    };
  }

  if (!emailResult.link) {
    return {
      tool: "moltbook",
      success: false,
      final: true,
      data: {
        text: `Found email "${emailResult.subject}" but could not extract a verification link. You may need to verify manually.`,
        action: "verify_email",
        found: true,
        subject: emailResult.subject,
        noLink: true
      }
    };
  }

  // Click the verification link
  const clickResult = await clickVerificationLink(emailResult.link, SESSION_NAME);

  return {
    tool: "moltbook",
    success: clickResult.success,
    final: true,
    data: {
      text: clickResult.success
        ? `Email verified! Clicked verification link from "${emailResult.subject}". Page: "${clickResult.pageTitle}"`
        : `Found verification link but clicking it returned HTTP ${clickResult.statusCode}.`,
      action: "verify_email",
      found: true,
      subject: emailResult.subject,
      link: emailResult.link,
      verified: clickResult.success,
      pageTitle: clickResult.pageTitle,
      statusCode: clickResult.statusCode
    }
  };
}

// ---- Helpers ----

function fail(message) {
  return {
    tool: "moltbook",
    success: false,
    final: true,
    error: message,
    data: { text: message }
  };
}

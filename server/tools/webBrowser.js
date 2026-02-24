// server/tools/webBrowser.js
// General-purpose web interaction tool with session persistence
// Foundation for moltbook and any future site-specific tools

import * as cheerio from "cheerio";
import { createHttpClient } from "../utils/httpClient.js";
import { storeCredential, getCredential } from "../utils/credentialStore.js";

const MAX_CONTENT = 8000;
const MAX_LINKS = 50;
const MAX_FORMS = 10;

/**
 * Extract domain from URL for session naming.
 */
function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "default";
  }
}

/**
 * Parse HTML and extract structured page data.
 */
function parsePage(html, baseUrl) {
  const $ = cheerio.load(html);

  // Remove scripts, styles, nav, footer for clean text
  $("script, style, noscript, nav, footer, header, iframe").remove();

  // Title
  const title = $("title").text().trim() || $("h1").first().text().trim() || "";

  // Meta description
  const description = $('meta[name="description"]').attr("content") || "";

  // Main text content
  let textContent = "";
  const mainEl = $("main, article, .content, .main, #content, #main, [role='main']").first();
  if (mainEl.length) {
    textContent = mainEl.text().replace(/\s+/g, " ").trim();
  } else {
    textContent = $("body").text().replace(/\s+/g, " ").trim();
  }

  if (textContent.length > MAX_CONTENT) {
    textContent = textContent.slice(0, MAX_CONTENT) + `... (truncated)`;
  }

  // Links
  const links = [];
  $("a[href]").each((_, el) => {
    if (links.length >= MAX_LINKS) return false;
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && text && !href.startsWith("#") && !href.startsWith("javascript:")) {
      try {
        const absoluteUrl = new URL(href, baseUrl).href;
        links.push({ text: text.slice(0, 100), url: absoluteUrl });
      } catch { /* skip invalid URLs */ }
    }
  });

  // Forms
  const forms = [];
  $("form").each((_, formEl) => {
    if (forms.length >= MAX_FORMS) return false;
    const action = $(formEl).attr("action") || "";
    const method = ($(formEl).attr("method") || "GET").toUpperCase();

    const fields = [];
    $(formEl).find("input, textarea, select").each((__, fieldEl) => {
      const name = $(fieldEl).attr("name");
      const type = $(fieldEl).attr("type") || $(fieldEl).prop("tagName").toLowerCase();
      const value = $(fieldEl).attr("value") || "";
      const required = $(fieldEl).attr("required") !== undefined;
      const placeholder = $(fieldEl).attr("placeholder") || "";

      if (name) {
        fields.push({ name, type, value, required, placeholder });
      }
    });

    if (fields.length > 0) {
      let actionUrl = action;
      try {
        actionUrl = new URL(action, baseUrl).href;
      } catch { /* keep relative */ }

      forms.push({ action: actionUrl, method, fields });
    }
  });

  // Headings for structure
  const headings = [];
  $("h1, h2, h3").each((_, el) => {
    const text = $(el).text().trim();
    const level = parseInt($(el).prop("tagName").charAt(1));
    if (text) headings.push({ level, text: text.slice(0, 120) });
  });

  return { title, description, textContent, links, forms, headings };
}

/**
 * Detect if a page indicates the user is logged in.
 */
function detectLoginStatus(html) {
  const lower = html.toLowerCase();
  const loggedIn =
    lower.includes("logout") ||
    lower.includes("sign out") ||
    lower.includes("my account") ||
    lower.includes("my profile") ||
    lower.includes("dashboard");
  const loggedOut =
    lower.includes("log in") ||
    lower.includes("sign in") ||
    lower.includes("register");

  if (loggedIn && !loggedOut) return "logged_in";
  if (loggedOut && !loggedIn) return "logged_out";
  return "unknown";
}

/**
 * Main web browser tool.
 * Input: { text, context } where context may include:
 *   action: "browse" | "submitForm" | "extractLinks" | "extractForms" | "extractText" | "login" | "setCredentials"
 *   url: target URL
 *   formData: { field: value, ... } for form submissions
 *   session: custom session name (default: domain-based)
 *   credentials: { username, password } for login or credential storage
 *   service: service name for credential storage
 */
export async function webBrowser(input) {
  try {
    const text = typeof input === "string" ? input : (input?.text || "");
    const context = typeof input === "object" ? (input?.context || {}) : {};

    // Determine action
    const action = context.action || inferAction(text);

    // Extract URL from context or text
    let url = context.url || extractUrl(text);
    const sessionName = context.session || (url ? domainFromUrl(url) : "default");

    // Handle credential storage
    if (action === "setCredentials") {
      return handleSetCredentials(text, context);
    }

    if (!url) {
      return {
        tool: "webBrowser",
        success: false,
        final: true,
        error: "No URL provided. Please specify a URL to browse.",
        data: { text: "I need a URL to browse. Please provide one like: browse https://example.com" }
      };
    }

    // Ensure URL has protocol
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }

    const client = createHttpClient(sessionName);

    switch (action) {
      case "login":
        return await handleLogin(client, url, text, context, sessionName);

      case "submitForm":
        return await handleSubmitForm(client, url, context);

      case "extractLinks":
        return await handleExtract(client, url, "links");

      case "extractForms":
        return await handleExtract(client, url, "forms");

      case "extractText":
        return await handleExtract(client, url, "text");

      case "browse":
      default:
        return await handleBrowse(client, url, sessionName);
    }

  } catch (err) {
    console.error("[webBrowser] Error:", err.message);
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      error: err.message,
      data: { text: `Web browser error: ${err.message}` }
    };
  }
}

// ---- Action Inference ----

function inferAction(text) {
  const lower = text.toLowerCase();
  if (/\b(log\s*in|sign\s*in|authenticate)\b/.test(lower)) return "login";
  if (/\b(submit|post|fill)\s*(form|data)\b/.test(lower)) return "submitForm";
  if (/\bextract\s*links\b/.test(lower)) return "extractLinks";
  if (/\bextract\s*forms\b/.test(lower)) return "extractForms";
  if (/\bextract\s*text\b/.test(lower)) return "extractText";
  if (/\b(store|save|set)\s*(credential|password)\b/.test(lower)) return "setCredentials";
  return "browse";
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/\S+/);
  if (match) return match[0].replace(/[.,;:!?]+$/, "");

  // Check for domain-like patterns
  const domainMatch = text.match(/\b([a-z0-9-]+\.(?:com|org|net|io|dev|app|co)(?:\/\S*)?)\b/i);
  if (domainMatch) return "https://" + domainMatch[1];

  return null;
}

// ---- Action Handlers ----

async function handleBrowse(client, url, sessionName) {
  const response = await client.get(url);

  if (!response.ok) {
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      data: {
        text: `Failed to load ${url}: HTTP ${response.status}`,
        statusCode: response.status,
        url
      }
    };
  }

  const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  const page = parsePage(html, url);
  const loginStatus = detectLoginStatus(html);

  return {
    tool: "webBrowser",
    success: true,
    final: true,
    data: {
      text: `Browsed ${page.title || url}\n\n${page.textContent.slice(0, 2000)}`,
      url: response.url || url,
      title: page.title,
      description: page.description,
      content: page.textContent,
      links: page.links,
      forms: page.forms,
      headings: page.headings,
      statusCode: response.status,
      sessionActive: loginStatus === "logged_in",
      loginStatus,
      session: sessionName
    }
  };
}

async function handleLogin(client, url, text, context, sessionName) {
  // Check for stored credentials
  let credentials = context.credentials || null;

  if (!credentials) {
    try {
      const stored = await getCredential(sessionName);
      if (stored) {
        credentials = stored;
        console.log(`[webBrowser] Using stored credentials for ${sessionName}`);
      }
    } catch { /* credential store unavailable */ }
  }

  if (!credentials) {
    // Try to extract from text
    const userMatch = text.match(/(?:user(?:name)?|email)\s*[:=]\s*(\S+)/i);
    const passMatch = text.match(/(?:pass(?:word)?)\s*[:=]\s*(\S+)/i);
    if (userMatch && passMatch) {
      credentials = { username: userMatch[1], password: passMatch[1] };
    }
  }

  if (!credentials) {
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      data: {
        text: "No credentials available. Please provide username and password, or store them first with: store credentials for " + sessionName,
        action: "login",
        needsCredentials: true
      }
    };
  }

  // Step 1: GET login page to extract CSRF and form structure
  const loginPage = await client.get(url);
  if (!loginPage.ok) {
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      data: { text: `Failed to load login page: HTTP ${loginPage.status}`, statusCode: loginPage.status }
    };
  }

  const html = typeof loginPage.data === "string" ? loginPage.data : "";
  const page = parsePage(html, url);

  // Find login form
  const loginForm = page.forms.find(f =>
    f.fields.some(field => field.type === "password") &&
    f.method === "POST"
  );

  if (!loginForm) {
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      data: { text: "Could not find a login form on this page.", forms: page.forms }
    };
  }

  // Build form data
  const formData = {};
  for (const field of loginForm.fields) {
    if (field.type === "hidden") {
      formData[field.name] = field.value; // CSRF tokens, etc.
    } else if (field.type === "password") {
      formData[field.name] = credentials.password;
    } else if (field.type === "email" || field.name.match(/user|email|login/i)) {
      formData[field.name] = credentials.username || credentials.email;
    } else if (field.type === "text") {
      formData[field.name] = credentials.username || credentials.email || "";
    }
  }

  // Step 2: Submit login form
  const loginResult = await client.submitForm(loginForm.action, formData);

  // Check if login succeeded
  const resultHtml = typeof loginResult.data === "string" ? loginResult.data : "";
  const loginStatus = detectLoginStatus(resultHtml);
  const resultPage = parsePage(resultHtml, loginResult.url || url);

  const success = loginStatus === "logged_in" ||
    loginResult.status === 302 ||
    loginResult.status === 301 ||
    (loginResult.ok && !resultHtml.toLowerCase().includes("invalid") && !resultHtml.toLowerCase().includes("incorrect"));

  return {
    tool: "webBrowser",
    success,
    final: true,
    data: {
      text: success
        ? `Successfully logged in to ${sessionName}. Session cookies saved.`
        : `Login may have failed. Page title: "${resultPage.title}". Check the response for error messages.`,
      action: "login",
      url: loginResult.url || loginForm.action,
      title: resultPage.title,
      statusCode: loginResult.status,
      sessionActive: success,
      loginStatus,
      content: resultPage.textContent.slice(0, 2000),
      session: sessionName
    }
  };
}

async function handleSubmitForm(client, url, context) {
  const formData = context.formData || {};

  const response = await client.submitForm(url, formData);
  const html = typeof response.data === "string" ? response.data : "";
  const page = parsePage(html, response.url || url);

  return {
    tool: "webBrowser",
    success: response.ok,
    final: true,
    data: {
      text: response.ok
        ? `Form submitted successfully to ${url}. Response: "${page.title}"`
        : `Form submission returned HTTP ${response.status}`,
      action: "submitForm",
      url: response.url || url,
      title: page.title,
      content: page.textContent.slice(0, 2000),
      statusCode: response.status
    }
  };
}

async function handleExtract(client, url, extractType) {
  const response = await client.get(url);

  if (!response.ok) {
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      data: { text: `Failed to load ${url}: HTTP ${response.status}` }
    };
  }

  const html = typeof response.data === "string" ? response.data : "";
  const page = parsePage(html, url);

  if (extractType === "links") {
    const linkText = page.links.map(l => `- [${l.text}](${l.url})`).join("\n");
    return {
      tool: "webBrowser",
      success: true,
      final: true,
      data: {
        text: `Found ${page.links.length} links on ${page.title || url}:\n\n${linkText}`,
        links: page.links,
        url,
        title: page.title
      }
    };
  }

  if (extractType === "forms") {
    const formText = page.forms.map((f, i) =>
      `Form ${i + 1}: ${f.method} ${f.action}\n  Fields: ${f.fields.map(field => `${field.name} (${field.type}${field.required ? ", required" : ""})`).join(", ")}`
    ).join("\n\n");

    return {
      tool: "webBrowser",
      success: true,
      final: true,
      data: {
        text: `Found ${page.forms.length} form(s) on ${page.title || url}:\n\n${formText}`,
        forms: page.forms,
        url,
        title: page.title
      }
    };
  }

  // extractText
  return {
    tool: "webBrowser",
    success: true,
    final: true,
    data: {
      text: `Text from ${page.title || url}:\n\n${page.textContent}`,
      content: page.textContent,
      url,
      title: page.title
    }
  };
}

async function handleSetCredentials(text, context) {
  const service = context.service || "default";
  let credentials = context.credentials;

  if (!credentials) {
    const userMatch = text.match(/(?:user(?:name)?|email)\s*[:=]\s*(\S+)/i);
    const passMatch = text.match(/(?:pass(?:word)?)\s*[:=]\s*(\S+)/i);
    if (userMatch && passMatch) {
      credentials = { username: userMatch[1], password: passMatch[1] };
    }
  }

  if (!credentials) {
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      data: { text: "Please provide credentials in the format: username: your_user, password: your_pass" }
    };
  }

  try {
    await storeCredential(service, credentials);
    return {
      tool: "webBrowser",
      success: true,
      final: true,
      data: {
        text: `Credentials for "${service}" stored securely (encrypted with AES-256-GCM).`,
        action: "setCredentials",
        service
      }
    };
  } catch (err) {
    return {
      tool: "webBrowser",
      success: false,
      final: true,
      data: { text: `Failed to store credentials: ${err.message}` }
    };
  }
}

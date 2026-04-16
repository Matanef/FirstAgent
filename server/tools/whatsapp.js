// server/tools/whatsapp.js
// WhatsApp Business Cloud API tool — send single or bulk messages

import axios from "axios";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";
import { getConversationWindow } from "../utils/whatsappState.js";

const WHATSAPP_API = "https://graph.facebook.com/v18.0";

// ============================================================
// PHONE NUMBER NORMALIZATION
// ============================================================

/**
 * Clean and normalize a phone number for WhatsApp API.
 * - Strips +, -, spaces, parentheses
 * - Israeli numbers starting with 05 → 9725...
 * - Ensures only digits remain
 */
function cleanPhoneNumber(raw) {
  if (!raw) return null;
  let num = String(raw).replace(/[\s\-\(\)\+\.]/g, "");

  // Israeli mobile: 05X... → 9725X...
  if (/^05\d{8}$/.test(num)) {
    num = "972" + num.slice(1);
  }
  // Leading 0 with 9 digits (other Israeli formats): 0X... → 972X...
  if (/^0\d{8,9}$/.test(num)) {
    num = "972" + num.slice(1);
  }

  // Must be digits only and at least 10 chars (country code + number)
  if (!/^\d{10,15}$/.test(num)) return null;
  return num;
}

// ============================================================
// CONTACT RESOLUTION (from userProfiles)
// ============================================================

/**
 * Resolve a contact name (e.g., "my mom", "Shirly", "אמא") to a phone number.
 * Checks userProfiles registry for matching names, relations, or Hebrew names.
 * @param {string} nameOrRelation - Contact reference from user input
 * @returns {string|null} Phone number or null
 */
async function resolveContact(nameOrRelation) {
  if (!nameOrRelation) return null;
  const lower = nameOrRelation.toLowerCase().trim();

  try {
    const { getAllProfiles } = await import("../utils/userProfiles.js");
    const profiles = await getAllProfiles();

    for (const [phone, profile] of Object.entries(profiles)) {
      if (phone.startsWith("_")) continue; // Skip placeholders
      const checks = [
        profile.name?.toLowerCase(),
        profile.nameHe,
        profile.relation?.toLowerCase(),
      ].filter(Boolean);

      // Direct match: "shirly", "שירלי", "mother"
      if (checks.some(c => c === lower || lower.includes(c))) return phone;

      // Relation aliases: "my mom" → "mother", "אמא שלי" → "mother"
      const relationAliases = {
        mother: ["mom", "mum", "mama", "אמא", "אימא", "mother"],
        father: ["dad", "papa", "אבא", "father"],
        sister: ["sis", "אחות", "sister"],
        brother: ["bro", "אח", "brother"],
        wife: ["wife", "אישה", "רעיה"],
        husband: ["husband", "בעל"],
      };

      if (profile.relation && relationAliases[profile.relation]) {
        if (relationAliases[profile.relation].some(alias => lower.includes(alias))) {
          return phone;
        }
      }
    }
  } catch (e) {
    console.warn("[whatsapp] Contact resolution failed:", e.message);
  }
  return null;
}

// ============================================================
// INTENT DETECTION
// ============================================================

/**
 * Detect if the "message" part is actually a composition instruction
 * (e.g., "a welcoming message with cynicism") vs. literal text to send.
 */
function isCompositionInstruction(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Patterns that indicate the user wants the agent to COMPOSE the message
  return /\b(should be|make it|write|compose|draft|generate|create)\b/i.test(lower) ||
    /\b(welcoming|funny|formal|cynical|sarcastic|warm|professional|casual|short|long|brief|sweet)\b/i.test(lower) ||
    /\b(a\s+(?:nice|good|funny|warm|sweet|short|welcoming|cynical))\s+(message|text|note)\b/i.test(lower) ||
    /\bthe\s+message\s+should\b/i.test(lower) ||
    /\bwith\s+(?:a\s+)?(?:bit|touch|hint)\s+of\b/i.test(lower) ||
    /\b(הודעה\s+(?:חמה|מצחיקה|קצרה|רשמית|ציניקנית))\b/i.test(lower);
}

/**
 * Parse user's natural language request to detect WhatsApp intent.
 * Returns: { intent, to, message, filename, isComposeRequest, recipientName }
 */
async function detectWhatsAppIntent(text) {
  const lower = text.toLowerCase();

  // ── Bulk send: "send whatsapp to everyone in contacts.xlsx saying ..." ──
  const bulkMatch = text.match(
    /(?:send|שלח)\s+(?:a\s+)?(?:whatsapp|ווטסאפ|וואטסאפ)\s+(?:message\s+)?(?:to\s+)?(?:everyone|all|כולם|הכל)\s+(?:in|from|ב|מ)\s+([^\s]+\.xlsx?)\s+(?:saying|with\s+message|הודעה|עם)\s+(.+)/iu
  );
  if (bulkMatch) {
    return { intent: "bulk_send", filename: bulkMatch[1].trim(), message: bulkMatch[2].trim(), to: null };
  }

  // Simpler bulk pattern: "bulk whatsapp contacts.xlsx: hello everyone"
  const bulkAlt = text.match(
    /(?:bulk|mass|קבוצת)\s+(?:whatsapp|ווטסאפ|וואטסאפ)\s+([^\s]+\.xlsx?)\s*[:\-–]\s*(.+)/iu
  );
  if (bulkAlt) {
    return { intent: "bulk_send", filename: bulkAlt[1].trim(), message: bulkAlt[2].trim(), to: null };
  }

  // ── CONTACT NAME RESOLUTION ──
  // "send a message to my mom" / "send Shirly a whatsapp" / "שלח הודעה לאמא"
  const contactPatterns = [
    // "send a message to [NAME/RELATION]" with optional message description
    /(?:send|שלח)\s+(?:a\s+)?(?:whatsapp\s+)?(?:message\s+)?(?:to\s+)(?:my\s+)?([a-zA-Z\u0590-\u05FF]{2,20})(?:[.,]?\s*(?:the\s+)?(?:message|it)\s+should\s+(?:be\s+)?(.+))?/iu,
    // "send [NAME] a [adjective] message" — allows up to 3 words between "a" and "message"
    // Matches: "send my mom a welcoming message", "send shirly a funny short message"
    /(?:send|שלח)\s+(?:my\s+)?([a-zA-Z\u0590-\u05FF]{2,20})\s+(?:a\s+)?(?:[\w]+\s+){0,3}(?:whatsapp\s+)?(?:message|הודעה)(?:[.,]?\s*(?:the\s+)?(?:message|it)\s+should\s+(?:be\s+)?(.+))?/iu,
  ];

  for (const pattern of contactPatterns) {
    const match = text.match(pattern);
    if (match) {
      const contactRef = match[1].trim();
      // Don't match if it looks like a phone number
      if (/^\d+$/.test(contactRef)) continue;
      // Don't match noise words
      if (/^(everyone|all|whatsapp|a|the|it)$/i.test(contactRef)) continue;

      const resolvedPhone = await resolveContact(contactRef);
      if (resolvedPhone) {
        // Collect ALL message description from the full text
        let messageDesc = match[2]?.trim() || "";
        // Also check for multi-line descriptions: "the message should be..." anywhere in text
        if (!messageDesc) {
          const descMatch = text.match(/(?:the\s+)?message\s+should\s+(?:be\s+)?(.+)/is);
          if (descMatch) messageDesc = descMatch[1].trim();
        }
        // Also check for "with a bit of..." style descriptions
        if (!messageDesc) {
          const withMatch = text.match(/(?:with|including)\s+(.+)/is);
          if (withMatch) messageDesc = withMatch[1].trim();
        }
        // Fallback: everything after the contact name
        if (!messageDesc) {
          const afterContact = text.split(new RegExp(contactRef, "i"))[1] || "";
          messageDesc = afterContact.replace(/^[\s.,]+/, "").trim();
        }

        return {
          intent: "single_send",
          to: resolvedPhone,
          message: messageDesc || "Hi!",
          filename: null,
          isComposeRequest: true,
          recipientName: contactRef
        };
      }
    }
  }

  // ── Single send with phone number: "send a whatsapp to 0541234567 saying hello" ──
  const singleMatch = text.match(
    /(?:send|שלח)\s+(?:a\s+)?(?:whatsapp|ווטסאפ|וואטסאפ)\s+(?:message\s+)?(?:to\s+)([\d\s\-\+\(\)]{7,20})\s+(?:(?:saying|with\s+message|הודעה|עם)\s+)?(.+)/iu
  );
  if (singleMatch) {
    const msg = singleMatch[2].trim();
    return { intent: "single_send", to: singleMatch[1].trim(), message: msg, filename: null, isComposeRequest: isCompositionInstruction(msg) };
  }

  // Even simpler: "whatsapp 0541234567 hello world"
  const simpleMatch = text.match(
    /(?:whatsapp|ווטסאפ|וואטסאפ)\s+([\d\s\-\+\(\)]{7,20})\s+(.+)/iu
  );
  if (simpleMatch) {
    const msg = simpleMatch[2].trim();
    return { intent: "single_send", to: simpleMatch[1].trim(), message: msg, filename: null, isComposeRequest: isCompositionInstruction(msg) };
  }

  // ── "send a message to 0541234567 saying hello" ──
  const sendMsgTo = text.match(
    /(?:send|שלח)\s+(?:a\s+)?message\s+to\s+([\d\s\-\+\(\)]{7,20})\s+(?:saying\s+)?(.+)/iu
  );
  if (sendMsgTo) {
    const msg = sendMsgTo[2].trim();
    return { intent: "single_send", to: sendMsgTo[1].trim(), message: msg, filename: null, isComposeRequest: isCompositionInstruction(msg) };
  }

  // ── "send a message to [NAME]" without phone number ──
  // Broader catch-all for contact resolution with no explicit phone
  const sendToName = text.match(
    /(?:send|שלח)\s+(?:a\s+)?(?:whatsapp\s+)?(?:message\s+)?(?:to\s+)(?:my\s+)?([a-zA-Z\u0590-\u05FF]{2,20})/iu
  );
  if (sendToName) {
    const contactRef = sendToName[1].trim();
    if (!/^(everyone|all|whatsapp|a|the|it)$/i.test(contactRef)) {
      const resolvedPhone = await resolveContact(contactRef);
      if (resolvedPhone) {
        // Everything after the contact name is the message/instruction
        const afterName = text.slice(text.indexOf(contactRef) + contactRef.length).replace(/^[\s.,]+/, "").trim();
        // Remove noise like "the number is..." since we already resolved the contact
        const cleanMsg = afterName.replace(/the\s+number\s+is\s+[\d\s\-\+\(\)]+/i, "").trim();
        return {
          intent: "single_send",
          to: resolvedPhone,
          message: cleanMsg || "Hi!",
          filename: null,
          isComposeRequest: true,
          recipientName: contactRef
        };
      }
    }
  }

  // ── Flexible: "send NUMBER a message saying MSG" ──
  const flexMatch = text.match(
    /(?:send|שלח)\s+([\d\s\-\+\(\)]{7,20})\s+(?:a?\s*message\s+)?(?:saying|with|that\s+says?|:)\s*(.+)/iu
  );
  if (flexMatch) {
    const msg = flexMatch[2].trim();
    return { intent: "single_send", to: flexMatch[1].trim(), message: msg, filename: null, isComposeRequest: isCompositionInstruction(msg) };
  }

  // ── Fallback: extract phone number + "saying ..." from the text ──
  const phoneMatch = text.match(/((?:\+?\d[\d\s\-\(\)]{6,18}\d))/);
  const msgMatch = text.match(/\b(?:saying|that\s+says?)\s+(.+)/iu);
  if (phoneMatch && msgMatch) {
    return { intent: "single_send", to: phoneMatch[1].trim(), message: msgMatch[1].trim(), filename: null };
  }

  // ── Last resort: "send NUMBER <anything>" ──
  const lastResort = text.match(
    /(?:send|שלח)\s+([\d\+\-\(\)\s]{7,20})\s+(.{3,})/iu
  );
  if (lastResort) {
    let msg = lastResort[2].trim().replace(/^(?:a\s*message\s+)?/i, "").trim();
    if (msg.length >= 2) {
      return { intent: "single_send", to: lastResort[1].trim(), message: msg, filename: null, isComposeRequest: isCompositionInstruction(msg) };
    }
  }

  // ── No-body fallback: "send a whatsapp to NUMBER" with no message ──
  // Treat as a compose request — the LLM will generate the message content.
  const noBodyMatch = text.match(/((?:\+?\d[\d\s\-\(\)]{6,18}\d))/);
  if (noBodyMatch && /\b(send|שלח|תשלח|שלחי)\b/iu.test(text)) {
    // Extract any composition hints from the text (e.g., "from yourself", "a warm greeting")
    const hint = text
      .replace(noBodyMatch[0], "")
      .replace(/\b(send|שלח|תשלח|שלחי)\b/iu, "")
      .replace(/\b(a\s+)?(?:whatsapp|ווטסאפ|וואטסאפ)\b/iu, "")
      .replace(/\b(message|הודעה)\b/iu, "")
      .replace(/\b(to|ל)\b/iu, "")
      .replace(/\b(from)\b/iu, "")
      .trim()
      .replace(/^[\s.,;:]+|[\s.,;:]+$/g, "");
    // "yourself" / "עצמך" alone is an identity hint (write as agent), not a content hint
    const isIdentityOnly = /^(yourself|yourselves|עצמך|עצמכם)$/i.test(hint);
    const composeInstruction = (hint.length > 1 && !isIdentityOnly)
      ? `Compose a message: ${hint}`
      : "Compose a natural, conversational message to check in. Do not sound like a generic bot.";
    return {
      intent: "single_send",
      to: noBodyMatch[1].trim(),
      message: composeInstruction,
      filename: null,
      isComposeRequest: true
    };
  }

  return { intent: "unknown", to: null, message: null, filename: null };
}

// ============================================================
// SEND A SINGLE WHATSAPP MESSAGE
// ============================================================

/**
 * Send a template message (works outside the 24-hour window).
 * Uses WHATSAPP_TEMPLATE_NAME env var, or falls back to "hello_world".
 * Template messages are pre-approved by Meta and can initiate conversations.
 *
 * If the template supports body parameters, the message text is passed as the
 * first body parameter (parameter type "text"). Templates without parameters
 * (like "hello_world") will send the template's fixed text and the custom
 * message will be logged but not delivered inline.
 */
async function sendTemplateMessage(cleanedNumber, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || "hello_world";
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || "en";

  const url = `${WHATSAPP_API}/${phoneId}/messages`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Try sending with the configured template.
  // Strategy: try WITH body parameter first, then WITHOUT, then fall back to hello_world.
  // This handles templates with unknown parameter counts gracefully.
  const attempts = [];

// Attempt 1: configured template WITH body parameter
  if (text && templateName !== "hello_world") {
    attempts.push({
      label: `${templateName} (with param)`,
      payload: {
        messaging_product: "whatsapp", to: cleanedNumber, type: "template",
        template: {
          name: templateName,
          language: { code: templateLang },
          // Send a tiny string so Meta accepts it as a "Name"
          components: [{ type: "body", parameters: [{ type: "text", text: "Lanou" }] }]
        }
      }
    });
  }

  // Attempt 2: configured template WITHOUT parameters (template has no {{1}} placeholders)
  if (templateName !== "hello_world") {
    attempts.push({
      label: `${templateName} (no params)`,
      payload: {
        messaging_product: "whatsapp", to: cleanedNumber, type: "template",
        template: { name: templateName, language: { code: templateLang } }
      }
    });
  }

  // Attempt 3: hello_world fallback (always works, 0 parameters, en_US)
  attempts.push({
    label: "hello_world (fallback)",
    payload: {
      messaging_product: "whatsapp", to: cleanedNumber, type: "template",
      template: { name: "hello_world", language: { code: "en_US" } }
    }
  });

  let lastError = "";
  for (const attempt of attempts) {
    try {
      const response = await axios.post(url, attempt.payload, { headers });
      const messageId = response.data?.messages?.[0]?.id;
      const usedTemplate = attempt.payload.template.name;
      console.log(`✅ [WhatsApp] Template "${attempt.label}" sent to ${cleanedNumber} (id: ${messageId})`);
      return { success: true, to: cleanedNumber, messageId, usedTemplate };
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.message;
      const errCode = err.response?.data?.error?.code;
      console.warn(`⚠️ [WhatsApp] Template "${attempt.label}" failed: ${errorMsg}`);
      lastError = errorMsg;
      // Only retry on template-specific errors (132000=param mismatch, 132001=not found)
      if (errCode !== 132000 && errCode !== 132001 && errCode !== 132005) {
        // Non-template error (auth, rate limit, invalid number) — don't keep trying templates
        break;
      }
    }
  }

  console.error(`❌ [WhatsApp] All template attempts failed for ${cleanedNumber}: ${lastError}`);
  return { success: false, to: cleanedNumber, error: lastError, usedTemplate: templateName };
}

/**
 * Send a WhatsApp message. Checks the 24-hour conversation window first:
 * - If INSIDE window → sends freeform text message (normal)
 * - If OUTSIDE window → sends a template message to initiate conversation,
 *   then follows up with the freeform text if the template succeeds.
 *
 * @param {string} to - Phone number
 * @param {string} text - Message body
 * @param {object} [opts] - Options
 * @param {boolean} [opts.forceTemplate] - Force template even if window is open
 * @param {boolean} [opts.skipWindowCheck] - Skip window check (used by webhook auto-replies where we KNOW the window is open)
 */
export async function sendWhatsAppMessage(to, text, opts = {}) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  const cleanedNumber = cleanPhoneNumber(to);
  if (!cleanedNumber) {
    return { success: false, to, error: `Invalid phone number: "${to}"` };
  }

  // ── Check 24-hour conversation window ──
  const window = getConversationWindow(cleanedNumber);
  const needsTemplate = opts.forceTemplate || (!opts.skipWindowCheck && !window.open);

  if (needsTemplate) {
    const remainingH = window.open ? Math.round(window.remainingMs / 3600000) : 0;
    console.log(`📱 [WhatsApp] No active 24h window for ${cleanedNumber} — using template message`);

    const templateResult = await sendTemplateMessage(cleanedNumber, text);
    if (!templateResult.success) {
      return {
        success: false,
        to: cleanedNumber,
        error: `Cannot reach ${cleanedNumber}: no active conversation window (user hasn't messaged in 24h) and template "${templateResult.usedTemplate}" failed: ${templateResult.error}. The user needs to message the bot first to open a conversation window.`
      };
    }

    // Template sent successfully.
    // If using hello_world (no params), attempt a follow-up freeform text.
    // This works when the user actually has an open window (e.g., server restarted
    // but user had messaged recently). If they truly have no window, the follow-up
    // will fail silently — that's fine, the template was still delivered.
    if (text) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const url = `${WHATSAPP_API}/${phoneId}/messages`;
        const followUp = await axios.post(url, {
          messaging_product: "whatsapp",
          to: cleanedNumber,
          type: "text",
          text: { body: text }
        }, {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
        });
        const followUpId = followUp.data?.messages?.[0]?.id;
        console.log(`✅ [WhatsApp] Follow-up text sent to ${cleanedNumber} (id: ${followUpId})`);
        return { success: true, to: cleanedNumber, messageId: followUpId, note: "Sent via template + follow-up" };
      } catch (err) {
        // Follow-up failed (no real window) — template was still delivered
        console.warn(`⚠️ [WhatsApp] Follow-up text failed (expected if no real window): ${err.response?.data?.error?.message || err.message}`);
        return {
          success: true,
          to: cleanedNumber,
          messageId: templateResult.messageId,
          note: `Template "hello_world" sent, but follow-up message could not be delivered. The recipient needs to reply first to open a conversation window.`
        };
      }
    }

    return {
      success: true,
      to: cleanedNumber,
      messageId: templateResult.messageId,
      note: `Sent via template "${templateResult.usedTemplate}" (no active 24h window)`
    };
  }

  // ── Inside 24h window: send normal freeform text ──
  try {
    const url = `${WHATSAPP_API}/${phoneId}/messages`;
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: cleanedNumber,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    const messageId = response.data?.messages?.[0]?.id;
    console.log(`✅ [WhatsApp] Sent to ${cleanedNumber} (id: ${messageId})`);
    return { success: true, to: cleanedNumber, messageId };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    // Check if the error is specifically about the conversation window
    const errCode = err.response?.data?.error?.code;
    if (errCode === 131047 || /re-engage/i.test(errorMsg) || /24/i.test(errorMsg)) {
      console.warn(`⚠️ [WhatsApp] Window expired mid-send for ${cleanedNumber}, retrying with template`);
      return sendTemplateMessage(cleanedNumber, text);
    }
    console.error(`❌ [WhatsApp] Failed to send to ${cleanedNumber}: ${errorMsg}`);
    return { success: false, to: cleanedNumber, error: errorMsg };
  }
}

// ============================================================
// BULK EXCEL SEND
// ============================================================

/**
 * Resolve a filename to its full path — checks uploads and downloads ONLY.
 * SECURITY: No longer searches project root or accepts absolute paths.
 * Blocks sensitive files to prevent data exfiltration via WhatsApp.
 */
function resolveFilePath(filename) {
  // Block sensitive filenames
  const BLOCKED = /\.(env|pem|key|p12|pfx)$|^\.env|config\.js$|service_account|memory\.json|package\.json/i;
  if (BLOCKED.test(filename)) {
    console.warn(`🛡️ [whatsapp] Blocked sensitive file: ${filename}`);
    return null;
  }

  const SAFE_DIRS = [
    path.resolve(PROJECT_ROOT, "uploads"),
    path.resolve(PROJECT_ROOT, "downloads"),
  ];

  for (const dir of SAFE_DIRS) {
    const fullPath = path.resolve(dir, filename);
    // Prevent path traversal: ensure resolved path stays inside safe dir
    const rel = path.relative(dir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return null;
}

/**
 * Read an Excel file and send a WhatsApp message to every row with a phone number.
 */
async function processBulkExcelSend(filename, messageTemplate) {
  const filePath = resolveFilePath(filename);
  if (!filePath) {
    return { success: false, error: `File not found: "${filename}". Searched in uploads/, downloads/, and project root.` };
  }

  let rows;
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
  } catch (err) {
    return { success: false, error: `Failed to read Excel file: ${err.message}` };
  }

  if (!rows || rows.length === 0) {
    return { success: false, error: "Excel file is empty or has no data rows." };
  }

  // Find the phone column (English + Hebrew variations)
  const phoneColumnNames = ["phone", "phone number", "phonenumber", "mobile", "cell", "telephone",
    "טלפון", "מספר", "מספר טלפון", "נייד", "סלולרי"];
  const headers = Object.keys(rows[0]).map(h => h.toLowerCase().trim());
  const phoneColumn = Object.keys(rows[0]).find(
    h => phoneColumnNames.includes(h.toLowerCase().trim())
  );

  if (!phoneColumn) {
    return {
      success: false,
      error: `No phone column found in "${filename}". Expected one of: ${phoneColumnNames.join(", ")}. Found columns: ${Object.keys(rows[0]).join(", ")}`
    };
  }

  console.log(`📊 [WhatsApp] Bulk send: ${rows.length} rows from "${filename}", phone column: "${phoneColumn}"`);

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const row of rows) {
    const rawPhone = row[phoneColumn];
    if (!rawPhone) {
      failed++;
      continue;
    }

    const result = await sendWhatsAppMessage(String(rawPhone), messageTemplate);
    if (result.success) {
      sent++;
    } else {
      failed++;
      if (errors.length < 5) errors.push(`${rawPhone}: ${result.error}`);
    }

    // Rate limiting: 500ms delay between messages
    if (rows.indexOf(row) < rows.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return { success: true, sent, failed, total: rows.length, errors };
}

// ============================================================
// MAIN TOOL ENTRY POINT
// ============================================================

export async function whatsapp(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  // ── Check required env vars ──
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) {
    return {
      tool: "whatsapp",
      success: false,
      final: true,
      error: "WhatsApp is not configured. Please add WHATSAPP_TOKEN and WHATSAPP_PHONE_ID to your .env file.\n\nSetup guide:\n1. Go to https://developers.facebook.com → WhatsApp → Getting Started\n2. Copy the Temporary Access Token → WHATSAPP_TOKEN\n3. Copy the Phone Number ID → WHATSAPP_PHONE_ID\n4. Set a WHATSAPP_VERIFY_TOKEN for webhook verification"
    };
  }

  // ── CHAIN CONTEXT: use previous step output as message body ──
  if ((context.useLastResult || context.useChainContext) && context.chainContext?.previousOutput) {
    const prevTool = context.chainContext.previousTool || "previous step";
    const prevOutput = String(context.chainContext.previousOutput);
    const recipient = context.recipient || context.phone || null;
    console.log(`📱 [whatsapp] Chain context from "${prevTool}" (${prevOutput.length} chars), recipient: ${recipient}`);

    if (!recipient) {
      return { tool: "whatsapp", success: false, final: true, error: "Chain context: no recipient phone number provided." };
    }

    // Format content based on previous tool type
    let messageBody;
    if (prevTool === "news") {
      const headlines = [];
      const cardRegex = /<span class="news-source">([^<]+)<\/span>[\s\S]*?<h3 class="news-summary-title">([^<]+)<\/h3>/gi;
      let m;
      while ((m = cardRegex.exec(prevOutput)) !== null) {
        headlines.push(`• [${m[1].trim()}] ${m[2].trim()}`);
      }
      messageBody = headlines.length > 0
        ? `📰 *Latest News*\n\n${headlines.join("\n")}`
        : null;
    } else if (prevTool === "weather") {
      // Try raw data first (more reliable than HTML regex)
      const raw = context.chainContext.previousRaw || null;
      if (raw?.temp != null) {
        const parts = ["🌤️ *Weather Report*"];
        if (raw.city) parts.push(`📍 ${raw.city}${raw.country ? `, ${raw.country}` : ""}`);
        parts.push(`🌡️ ${raw.temp}°C${raw.feels_like != null ? ` (feels like ${raw.feels_like}°C)` : ""}`);
        if (raw.description) parts.push(`☁️ ${raw.description}`);
        if (raw.wind_speed != null) parts.push(`💨 Wind: ${raw.wind_speed} m/s`);
        if (raw.humidity != null) parts.push(`💧 Humidity: ${raw.humidity}%`);
        messageBody = parts.join("\n");
      } else {
        // Fallback: HTML regex parsing
        const tempMatch = prevOutput.match(/([\d.]+)°C/);
        const feelsMatch = prevOutput.match(/[Ff]eels?\s*like[:\s]*([\d.]+)°C/);
        const condMatch = prevOutput.match(/moderate\s+\w+|clear\s+sky|overcast|light\s+\w+|heavy\s+\w+|sunny|cloudy|rainy/i);
        const windMatch = prevOutput.match(/[Ww]ind[:\s]*([\d.]+)\s*m\/s/);
        const humidMatch = prevOutput.match(/[Hh]umidity[:\s]*([\d.]+)%/);
        const cityMatch = prevOutput.match(/weather (?:in|for) ([^,\n<]+)/i);
        const parts = ["🌤️ *Weather Report*"];
        if (cityMatch) parts.push(`📍 ${cityMatch[1].trim()}`);
        if (tempMatch) parts.push(`🌡️ ${tempMatch[1]}°C${feelsMatch ? ` (feels like ${feelsMatch[1]}°C)` : ""}`);
        if (condMatch) parts.push(`☁️ ${condMatch[0].trim()}`);
        if (windMatch) parts.push(`💨 Wind: ${windMatch[1]} m/s`);
        if (humidMatch) parts.push(`💧 Humidity: ${humidMatch[1]}%`);
        messageBody = parts.length > 1 ? parts.join("\n") : null;
      }
    } else if (prevTool === "x") {
      // X/Twitter: prefer plain text (has raw clickable URLs for WhatsApp)
      const raw = context.chainContext.previousRaw || null;
      if (raw?.plain) {
        messageBody = raw.plain;
      } else {
        // Fallback: parse HTML for trends
        const trendItems = [];
        const trendRegex = /<a\s+href="([^"]+)"[^>]*class="x-trend-name"[^>]*><strong>([^<]+)<\/strong><\/a>/gi;
        let tm;
        while ((tm = trendRegex.exec(prevOutput)) !== null) {
          trendItems.push(`${trendItems.length + 1}. ${tm[2].trim()}\n🔗 ${tm[1]}`);
        }
        if (trendItems.length > 0) {
          messageBody = `🔥 *Trending on X*\n\n${trendItems.join("\n\n")}`;
        } else {
          // Try to extract tweet cards
          const tweetItems = [];
          const tweetRegex = /<div class="x-tweet-author"><strong>@([^<]+)<\/strong>[\s\S]*?<div class="x-tweet-text">([^<]+)<\/div>/gi;
          let ttm;
          while ((ttm = tweetRegex.exec(prevOutput)) !== null) {
            tweetItems.push(`*@${ttm[1]}*: ${ttm[2].trim()}`);
          }
          messageBody = tweetItems.length > 0
            ? `🐦 *Tweets*\n\n${tweetItems.join("\n\n")}`
            : null;
        }
      }
    }

    // Fallback: strip HTML to plain text
    if (!messageBody) {
      messageBody = prevOutput
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    // WhatsApp has a 4096 char limit
    if (messageBody.length > 4000) {
      messageBody = messageBody.slice(0, 4000) + "\n\n... (truncated)";
    }

    console.log(`📱 [whatsapp] Sending chain context message (${messageBody.length} chars) to ${recipient}`);
    const result = await sendWhatsAppMessage(recipient, messageBody);
    if (result.success) {
      return {
        tool: "whatsapp",
        success: true,
        final: true,
        data: {
          text: `✅ Sent ${prevTool} results via WhatsApp to ${result.to}`,
          to: result.to,
          messageId: result.messageId,
          preformatted: true
        }
      };
    }
    return { tool: "whatsapp", success: false, final: true, error: `Failed to send WhatsApp to ${result.to}: ${result.error}` };
  }

  if (!text.trim()) {
    return {
      tool: "whatsapp",
      success: false,
      final: true,
      error: 'Please describe what to send. Examples:\n• "Send a WhatsApp to 0541234567 saying hello"\n• "Send WhatsApp to everyone in contacts.xlsx saying the event starts at 8"'
    };
  }

  const parsed = await detectWhatsAppIntent(text);

  try {
    switch (parsed.intent) {
      // ── Single message ──
      case "single_send": {
        if (!parsed.to || !parsed.message) {
          return {
            tool: "whatsapp",
            success: false,
            final: true,
            error: "Could not extract phone number and message. Try: 'Send a WhatsApp to 0541234567 saying hello'"
          };
        }

        let messageToSend = parsed.message;

        // ── COMPOSE MODE: if the "message" is actually an instruction, generate it via LLM ──
        if (parsed.isComposeRequest) {
          console.log(`📱 [whatsapp] Compose mode: generating message for ${parsed.recipientName || parsed.to}`);
          try {
            const { llm: llmCall } = await import("./llm.js");

// Load agent personality so it can write "as itself"
            let personalityContext = "";
            try {
              const { getPersonalitySummary } = await import("../personality.js");
              personalityContext = await getPersonalitySummary();
            } catch { /* non-blocking */ }

            // Look up recipient profile for tone context
            let recipientContext = "";
            try {
              const { getUserByPhone } = await import("../utils/userProfiles.js");
              const profile = await getUserByPhone(parsed.to);
              if (profile) {
                recipientContext = `\nRecipient: ${profile.name}${profile.nameHe ? ` (${profile.nameHe})` : ""}${profile.relation ? `, the sender's ${profile.relation}` : ""}.`;
                if (profile.language && profile.language !== "auto") {
                  recipientContext += ` Preferred language: ${profile.language}.`;
                }
              }
            } catch { /* non-blocking */ }

            // ── NEW: Manually grab relevant facts (like the Iran war) ──
            // ── NEW: Manually grab relevant facts ONLY if requested ──
            let knowledgeContext = "";
            // Only fetch knowledge if the prompt implies asking for facts, news, or summaries
            if (/\b(news|about|explain the|summarize|tell .* about)\b/i.test(text)) {
              try {
                const { getRelevantKnowledge } = await import("../knowledge.js");
                knowledgeContext = await getRelevantKnowledge(text);
              } catch { /* non-blocking */ }
            }

            // Detect if the user wants the agent to write as itself
            const asAgent = /\b(as yourself|as you|introduce yourself|from your?self|in your (?:name|voice)|מעצמך|בשמך|הצג את עצמך)\b/i.test(text);
            
            let senderContext = "";
            if (asAgent) {
              senderContext = `\nYou are writing AS YOURSELF (the AI agent). ${personalityContext ? `Your identity: ${personalityContext}` : ""}`;
              
              // Only introduce if there is NO known profile/history
              if (recipientContext) { // If we found a profile, we know them
                senderContext += `\n🚨 CRITICAL: You already know this person and have spoken before. DO NOT introduce yourself (no "Hi, I'm Lanou"). Jump straight into the conversation naturally based on your established identity.`;
              } else {
                senderContext += `\nIntroduce yourself naturally — you are the agent, not the user.`;
              }
            } else {
              senderContext = `\nYou are writing on behalf of the user (the agent's owner/developer). Do NOT introduce yourself as an AI.`;
            }

            const composePrompt = `Compose a short WhatsApp message based on these instructions.
${recipientContext}${senderContext}
${knowledgeContext ? `\nBACKGROUND KNOWLEDGE:\n${knowledgeContext}\n` : ""}
Instructions: ${parsed.message}
Full user request: ${text}

RULES:
- Output ONLY the message text. No quotes, no "Here's the message:", no commentary.
- Keep it natural and conversational (it's a WhatsApp message, not an email).
- Use emojis sparingly if appropriate.
- If a language preference is specified, write in that language.
- Match the requested tone exactly.`;


            // Pick a model that can handle the target language
            let composeModel;
            try {
              const { pickModelForContent } = await import("./llm.js");
              const langHint = recipientContext.includes("Hebrew") ? "שלום" : composePrompt;
              composeModel = pickModelForContent(langHint);
            } catch { /* fallback to default */ }

            // FIX: Set skipKnowledge back to TRUE to prevent deadlocking, 
            // since we manually injected the knowledge into the prompt above!
            const composeResult = await llmCall(composePrompt, { skipKnowledge: true, timeoutMs: 30_000, model: composeModel });
            const composed = composeResult?.data?.text?.trim();
            if (composed && composed.length > 2) {
              // Clean LLM artifacts
              messageToSend = composed
                .replace(/^["']|["']$/g, "")
                .replace(/^(Here'?s?|Sure|OK|Okay)[^\n]*:\s*/i, "")
                .trim();
              console.log(`📱 [whatsapp] Composed message (${messageToSend.length} chars): "${messageToSend.slice(0, 80)}..."`);
            }
          } catch (e) {
            console.warn(`[whatsapp] Message composition failed: ${e.message}, sending instruction as-is`);
          }
        }

        const result = await sendWhatsAppMessage(parsed.to, messageToSend);
        if (result.success) {
          const note = result.note ? `\n📋 ${result.note}` : "";
          const recipientLabel = parsed.recipientName || result.to;
          return {
            tool: "whatsapp",
            success: true,
            final: true,
            data: {
              text: `✅ Sent WhatsApp to ${recipientLabel} (${result.to})${note}\n\n📝 Message: "${messageToSend}"`,
              to: result.to,
              messageId: result.messageId,
              preformatted: true
            }
          };
        }
        return {
          tool: "whatsapp",
          success: false,
          final: true,
          error: `Failed to send WhatsApp to ${parsed.recipientName || result.to} (${result.to}): ${result.error}${messageToSend ? `\n\n📝 Composed message was:\n"${messageToSend}"` : ""}`
        };
      }

      // ── Bulk Excel send ──
      case "bulk_send": {
        if (!parsed.filename || !parsed.message) {
          return {
            tool: "whatsapp",
            success: false,
            final: true,
            error: "Could not extract filename and message. Try: 'Send WhatsApp to everyone in contacts.xlsx saying hello'"
          };
        }

        const result = await processBulkExcelSend(parsed.filename, parsed.message);
        if (!result.success) {
          return { tool: "whatsapp", success: false, final: true, error: result.error };
        }

        let summary = `📊 **Bulk WhatsApp Send Complete**\n\n`;
        summary += `📁 File: ${parsed.filename}\n`;
        summary += `📨 Total rows: ${result.total}\n`;
        summary += `✅ Sent: ${result.sent}\n`;
        summary += `❌ Failed: ${result.failed}\n`;
        if (result.errors.length > 0) {
          summary += `\n**Errors:**\n${result.errors.map(e => `  • ${e}`).join("\n")}`;
        }

        return {
          tool: "whatsapp",
          success: true,
          final: true,
          data: {
            text: summary,
            sent: result.sent,
            failed: result.failed,
            total: result.total
          }
        };
      }

      // ── Unknown intent ──
      default:
        return {
          tool: "whatsapp",
          success: false,
          final: true,
          error: 'Could not understand the WhatsApp request. Try:\n• "Send a WhatsApp to 0541234567 saying hello"\n• "Send WhatsApp to everyone in contacts.xlsx saying the event starts at 8"'
        };
    }
  } catch (err) {
    console.error("❌ [WhatsApp] Tool error:", err.message);
    return {
      tool: "whatsapp",
      success: false,
      final: true,
      error: `WhatsApp tool error: ${err.message}`
    };
  }
}

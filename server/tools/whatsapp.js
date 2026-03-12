// server/tools/whatsapp.js
// WhatsApp Business Cloud API tool — send single or bulk messages

import axios from "axios";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";

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
// INTENT DETECTION
// ============================================================

/**
 * Parse user's natural language request to detect WhatsApp intent.
 * Returns: { intent, to, message, filename }
 */
function detectWhatsAppIntent(text) {
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

  // ── Single send: "send a whatsapp to 0541234567 saying hello" ──
  // Also handles: "send a whatsapp to 0541234567 hello" (no connector word)
  const singleMatch = text.match(
    /(?:send|שלח)\s+(?:a\s+)?(?:whatsapp|ווטסאפ|וואטסאפ)\s+(?:message\s+)?(?:to\s+)([\d\s\-\+\(\)]{7,20})\s+(?:(?:saying|with\s+message|הודעה|עם)\s+)?(.+)/iu
  );
  if (singleMatch) {
    return { intent: "single_send", to: singleMatch[1].trim(), message: singleMatch[2].trim(), filename: null };
  }

  // Even simpler: "whatsapp 0541234567 hello world"
  const simpleMatch = text.match(
    /(?:whatsapp|ווטסאפ|וואטסאפ)\s+([\d\s\-\+\(\)]{7,20})\s+(.+)/iu
  );
  if (simpleMatch) {
    return { intent: "single_send", to: simpleMatch[1].trim(), message: simpleMatch[2].trim(), filename: null };
  }

  // ── "send a message to 0541234567 saying hello" ──
  const sendMsgTo = text.match(
    /(?:send|שלח)\s+(?:a\s+)?message\s+to\s+([\d\s\-\+\(\)]{7,20})\s+(?:saying\s+)?(.+)/iu
  );
  if (sendMsgTo) {
    return { intent: "single_send", to: sendMsgTo[1].trim(), message: sendMsgTo[2].trim(), filename: null };
  }

  // ── Flexible: "send NUMBER a message saying MSG" ──
  // Handles: "use whatsapp to send NUMBER a message saying MSG"
  // Also:    "send NUMBER amessage saying MSG" (typo with no space)
  const flexMatch = text.match(
    /(?:send|שלח)\s+([\d\s\-\+\(\)]{7,20})\s+(?:a?\s*message\s+)?(?:saying|with|that\s+says?|:)\s*(.+)/iu
  );
  if (flexMatch) {
    return { intent: "single_send", to: flexMatch[1].trim(), message: flexMatch[2].trim(), filename: null };
  }

  // ── Fallback: extract phone number + "saying ..." from the text ──
  // Use word boundary (\b) to avoid matching "amessage" as "message"
  const phoneMatch = text.match(/((?:\+?\d[\d\s\-\(\)]{6,18}\d))/);
  const msgMatch = text.match(/\b(?:saying|that\s+says?)\s+(.+)/iu);
  if (phoneMatch && msgMatch) {
    return { intent: "single_send", to: phoneMatch[1].trim(), message: msgMatch[1].trim(), filename: null };
  }

  // ── Last resort: "send NUMBER <anything>" ──
  // "send 0587426393 go to sleep" → to=0587426393, message="go to sleep"
  const lastResort = text.match(
    /(?:send|שלח)\s+([\d\+\-\(\)\s]{7,20})\s+(.{3,})/iu
  );
  if (lastResort) {
    // Strip common noise words from the start of the message
    let msg = lastResort[2].trim().replace(/^(?:a\s*message\s+)?/i, "").trim();
    if (msg.length >= 2) {
      return { intent: "single_send", to: lastResort[1].trim(), message: msg, filename: null };
    }
  }

  return { intent: "unknown", to: null, message: null, filename: null };
}

// ============================================================
// SEND A SINGLE WHATSAPP MESSAGE
// ============================================================

export async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  const cleanedNumber = cleanPhoneNumber(to);
  if (!cleanedNumber) {
    return { success: false, to, error: `Invalid phone number: "${to}"` };
  }

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
    console.error(`❌ [WhatsApp] Failed to send to ${cleanedNumber}: ${errorMsg}`);
    return { success: false, to: cleanedNumber, error: errorMsg };
  }
}

// ============================================================
// BULK EXCEL SEND
// ============================================================

/**
 * Resolve a filename to its full path — checks uploads, downloads, and project root
 */
function resolveFilePath(filename) {
  const searchDirs = [
    path.resolve(PROJECT_ROOT, "uploads"),
    path.resolve(PROJECT_ROOT, "downloads"),
    PROJECT_ROOT
  ];

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, filename);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  // Try as absolute path
  if (path.isAbsolute(filename) && fs.existsSync(filename)) return filename;

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
  if (context.useLastResult && context.chainContext?.previousOutput) {
    const prevTool = context.chainContext.previousTool || "previous step";
    const prevOutput = String(context.chainContext.previousOutput);
    const recipient = context.recipient || null;
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

  const parsed = detectWhatsAppIntent(text);

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

        const result = await sendWhatsAppMessage(parsed.to, parsed.message);
        if (result.success) {
          return {
            tool: "whatsapp",
            success: true,
            final: true,
            data: {
              text: `✅ Successfully sent WhatsApp message to ${result.to}`,
              to: result.to,
              messageId: result.messageId
            }
          };
        }
        return {
          tool: "whatsapp",
          success: false,
          final: true,
          error: `Failed to send WhatsApp to ${result.to}: ${result.error}`
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

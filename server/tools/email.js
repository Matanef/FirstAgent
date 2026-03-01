// server/tools/email.js
// Email tool: draft/send emails + browse/read inbox via Gmail API
// Uses gmail.send scope for sending and gmail.readonly scope for reading

import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";
import { resolveContact, extractContactRef } from "./contacts.js";
import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";
import { getMemory } from "../memory.js";

const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const subjectRegex = /subject[:\s]+([^\n]+)/i;
const sayingRegex = /saying[:\s]+(.+?)(?:\s+with\s+(?:the\s+)?(?:planner|executor|subject|attachment)|$)/is;

const attachmentPatterns = [
  /with\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))\s+attached/gi,
  /attach(?:ing)?\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi,
  /send\s+(?:the\s+)?(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi
];

function stripMarkdown(text) {
  return text.replace(/[_*`~]/g, "");
}

// ============================================================
// SEND EMAIL FUNCTIONALITY (existing)
// ============================================================

async function parseEmailRequest(query) {
  await getMemory();

  let to = null;
  let subject = "Message from AI Agent";
  let body = query;

  const cleanQuery = stripMarkdown(query);
  const emailMatch = cleanQuery.match(emailRegex);
  if (emailMatch) {
    to = emailMatch[0].toLowerCase();
    console.log(`📧 Extracted email address: ${to}`);
  } else {
    const contactRef = extractContactRef(query);
    if (contactRef) {
      const resolved = await resolveContact(contactRef);
      if (resolved?.contact?.email) {
        to = resolved.contact.email;
        console.log(`📧 Resolved contact "${contactRef}" → ${to}`);
      }
    }
  }

  const subjectMatch = cleanQuery.match(subjectRegex);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  }

  let bodyMatch = query.match(sayingRegex);
  if (bodyMatch) {
    body = bodyMatch[1].trim();
  } else {
    body = query
      .replace(/send (?:an )?email to [^\s]+/i, "")
      .replace(/with the planner/i, "")
      .replace(/subject[:\s]+[^\n]+/i, "")
      .trim();
  }

  const requestedAttachments = [];
  for (const pattern of attachmentPatterns) {
    let match;
    while ((match = pattern.exec(cleanQuery)) !== null) {
      requestedAttachments.push(match[1].trim());
    }
  }

  return { to, subject, body, requestedAttachments };
}

async function findAttachment(filename) {
  const searchPaths = [
    path.resolve(PROJECT_ROOT, "uploads", filename),
    path.resolve(PROJECT_ROOT, "downloads", filename),
    path.resolve(PROJECT_ROOT, filename)
  ];
  for (const p of searchPaths) {
    try { await fs.access(p); return p; } catch { /* try next */ }
  }
  return null;
}

// ============================================================
// BROWSE / READ EMAIL FUNCTIONALITY (new)
// ============================================================

/**
 * Browse/search emails in the inbox
 */
async function browseEmails(query, options = {}) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const maxResults = options.maxResults || 20;
    const q = options.searchQuery || buildSearchQuery(query);

    console.log(`📧 Searching emails: q="${q}", max=${maxResults}`);

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults,
      labelIds: options.labelIds || undefined
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      return {
        tool: "email",
        success: true,
        final: true,
        data: {
          mode: "browse",
          text: `📧 No emails found matching "${q}".`,
          emails: [],
          preformatted: true
        }
      };
    }

    // Fetch metadata for each message
    const emails = [];
    for (const msg of messages.slice(0, maxResults)) {
      try {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"]
        });

        const headers = detail.data.payload?.headers || [];
        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

        const hasAttachments = detail.data.payload?.parts?.some(p => p.filename && p.filename.length > 0) || false;
        const attachmentNames = (detail.data.payload?.parts || [])
          .filter(p => p.filename && p.filename.length > 0)
          .map(p => p.filename);

        emails.push({
          id: msg.id,
          threadId: msg.threadId,
          from: getHeader("From"),
          to: getHeader("To"),
          subject: getHeader("Subject") || "(no subject)",
          date: getHeader("Date"),
          snippet: detail.data.snippet || "",
          hasAttachments,
          attachmentNames,
          labels: detail.data.labelIds || [],
          unread: (detail.data.labelIds || []).includes("UNREAD")
        });
      } catch (err) {
        console.warn(`[email] Failed to fetch message ${msg.id}:`, err.message);
      }
    }

    // Build formatted output
    let text = `### 📧 Emails${q ? ` — "${q}"` : ""} (${emails.length} results)\n\n`;
    text += "| # | From | Subject | Date | 📎 |\n";
    text += "|--:|------|---------|------|----|\n";

    emails.forEach((e, i) => {
      const from = e.from.replace(/<[^>]+>/, "").trim().slice(0, 30);
      const subject = e.subject.slice(0, 50);
      const date = new Date(e.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const unread = e.unread ? "**" : "";
      const attachIcon = e.hasAttachments ? "📎" : "";
      text += `| ${i + 1} | ${from} | ${unread}${subject}${unread} | ${date} | ${attachIcon} |\n`;
    });

    text += `\n*Say "read email #N" to view full content, or "download attachments from email #N"*`;

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        mode: "browse",
        text,
        emails,
        count: emails.length,
        totalEstimate: listRes.data.resultSizeEstimate || emails.length,
        preformatted: true
      }
    };
  } catch (err) {
    console.error("[email] Browse failed:", err.message);
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Email browsing failed: ${err.message}. Make sure Gmail OAuth is configured with readonly scope.`
    };
  }
}

/**
 * Read a specific email by ID or index
 */
async function readEmail(messageId) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const detail = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full"
    });

    const headers = detail.data.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    // Extract body text
    let bodyText = "";
    const parts = detail.data.payload?.parts || [];

    if (parts.length === 0 && detail.data.payload?.body?.data) {
      // Single-part message
      bodyText = Buffer.from(detail.data.payload.body.data, "base64").toString("utf-8");
    } else {
      // Multi-part: look for text/plain first, then text/html
      const textPart = parts.find(p => p.mimeType === "text/plain");
      const htmlPart = parts.find(p => p.mimeType === "text/html");

      if (textPart?.body?.data) {
        bodyText = Buffer.from(textPart.body.data, "base64").toString("utf-8");
      } else if (htmlPart?.body?.data) {
        // Strip HTML tags for display
        bodyText = Buffer.from(htmlPart.body.data, "base64")
          .toString("utf-8")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      // Check nested parts (multipart/alternative inside multipart/mixed)
      if (!bodyText) {
        for (const part of parts) {
          if (part.parts) {
            const nested = part.parts.find(p => p.mimeType === "text/plain");
            if (nested?.body?.data) {
              bodyText = Buffer.from(nested.body.data, "base64").toString("utf-8");
              break;
            }
          }
        }
      }
    }

    // List attachments
    const attachments = [];
    function findAttachmentParts(partsList) {
      for (const p of partsList || []) {
        if (p.filename && p.filename.length > 0) {
          attachments.push({
            filename: p.filename,
            mimeType: p.mimeType,
            size: p.body?.size || 0,
            attachmentId: p.body?.attachmentId
          });
        }
        if (p.parts) findAttachmentParts(p.parts);
      }
    }
    findAttachmentParts(parts);

    let text = `### 📧 Email\n\n`;
    text += `**From:** ${getHeader("From")}\n`;
    text += `**To:** ${getHeader("To")}\n`;
    text += `**Subject:** ${getHeader("Subject")}\n`;
    text += `**Date:** ${getHeader("Date")}\n`;

    if (attachments.length > 0) {
      text += `\n📎 **Attachments (${attachments.length}):**\n`;
      attachments.forEach(a => {
        text += `• ${a.filename} (${(a.size / 1024).toFixed(1)} KB)\n`;
      });
    }

    text += `\n---\n\n${bodyText.slice(0, 5000)}`;

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        mode: "read",
        text,
        messageId,
        from: getHeader("From"),
        subject: getHeader("Subject"),
        body: bodyText,
        attachments,
        preformatted: true
      }
    };
  } catch (err) {
    console.error("[email] Read failed:", err.message);
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Failed to read email: ${err.message}`
    };
  }
}

/**
 * Download an attachment from an email
 */
async function downloadEmailAttachment(messageId, attachmentId, filename) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const attachment = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId
    });

    const data = Buffer.from(attachment.data.data, "base64url");
    const downloadDir = path.resolve(PROJECT_ROOT, "downloads");

    try { await fs.mkdir(downloadDir, { recursive: true }); } catch { }

    const filePath = path.resolve(downloadDir, filename);
    await fs.writeFile(filePath, data);

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        mode: "download",
        text: `📎 Downloaded **${filename}** (${(data.length / 1024).toFixed(1)} KB) to ${filePath}`,
        filename,
        filePath,
        size: data.length,
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Attachment download failed: ${err.message}`
    };
  }
}

/**
 * Build a Gmail search query from natural language
 */
function buildSearchQuery(text) {
  const lower = text.toLowerCase();
  let q = "";

  // Extract sender
  const fromMatch = text.match(/(?:from|sender)\s+([^\s,]+)/i);
  if (fromMatch) q += `from:${fromMatch[1]} `;

  // Extract date range
  if (/\blast\s+year\b/i.test(lower)) {
    const year = new Date().getFullYear() - 1;
    q += `after:${year}/1/1 before:${year}/12/31 `;
  } else if (/\blast\s+month\b/i.test(lower)) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    q += `after:${d.getFullYear()}/${d.getMonth() + 1}/1 `;
  } else if (/\blast\s+week\b/i.test(lower)) {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    q += `after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} `;
  } else if (/\btoday\b/i.test(lower)) {
    const d = new Date();
    q += `after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} `;
  }

  // Has attachment
  if (/\b(attachment|attached|bill|invoice|receipt|pdf|document)\b/i.test(lower)) {
    q += `has:attachment `;
  }

  // Unread only
  if (/\bunread\b/i.test(lower)) {
    q += `is:unread `;
  }

  // Subject search
  const subjectMatch = text.match(/(?:subject|about)\s+["']?(.+?)["']?\s*$/i);
  if (subjectMatch) {
    q += `subject:${subjectMatch[1]} `;
  }

  // Specific filename
  const filenameMatch = text.match(/(?:named?|called|filename)\s+["']?(.+?)["']?\b/i);
  if (filenameMatch) {
    q += `filename:${filenameMatch[1]} `;
  }

  // Generic keyword search — extract remaining meaningful words
  if (!q.trim()) {
    const cleaned = text
      .replace(/\b(check|go over|browse|read|show|list|get|my|the|all|emails?|inbox|mail)\b/gi, "")
      .trim();
    if (cleaned.length > 2) q = cleaned;
  }

  return q.trim() || "in:inbox";
}

// ============================================================
// MAIN EXPORTS
// ============================================================

export async function email(query, context = {}) {
  const action = context?.action || inferEmailAction(query);

  switch (action) {
    case "browse":
    case "inbox":
    case "search":
      return browseEmails(query, context);
    case "read":
      if (context.messageId) return readEmail(context.messageId);
      return { tool: "email", success: false, final: true, error: "Please specify which email to read (provide messageId)." };
    case "download":
      if (context.messageId && context.attachmentId && context.filename) {
        return downloadEmailAttachment(context.messageId, context.attachmentId, context.filename);
      }
      return { tool: "email", success: false, final: true, error: "Please specify messageId, attachmentId, and filename for download." };
    case "send":
    default:
      return sendEmailDraft(query);
  }
}

function inferEmailAction(query) {
  const lower = (query || "").toLowerCase();
  if (/\b(browse|check|go\s+over|list|show|inbox|read\s+my|my\s+emails?|unread)\b/i.test(lower) &&
      !/\b(send|draft|compose|write)\b/i.test(lower)) {
    return "browse";
  }
  if (/\b(read|open|view)\s+(email|message)\s*(#?\d+)?/i.test(lower)) return "read";
  if (/\b(download|save)\s+(attachment|file)/i.test(lower)) return "download";
  return "send";
}

async function sendEmailDraft(query) {
  try {
    const { to, subject, body, requestedAttachments } = await parseEmailRequest(query);

    if (!to) {
      return {
        tool: "email",
        success: false,
        final: true,
        error:
          "Could not detect recipient email address.\n\nTry:\n• 'send email to john@example.com'\n• 'email mom about dinner' (if mom is a saved contact)"
      };
    }

    const attachments = [];
    for (const filename of requestedAttachments) {
      const filepath = await findAttachment(filename);
      if (filepath) {
        const stat = await fs.stat(filepath);
        attachments.push({ filename: path.basename(filepath), filepath, size: stat.size });
      }
    }

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        mode: "draft",
        to,
        subject,
        body,
        attachments,
        pendingEmail: { to, subject, body, attachments },
        message:
          `📧 **Email Draft:**\n\n` +
          `**To:** ${to}\n` +
          `**Subject:** ${subject}\n` +
          `**Message:**\n${body}` +
          (attachments.length > 0
            ? `\n\n📎 **Attachments (${attachments.length}):**\n${attachments.map(a => `• ${a.filename}`).join('\n')}`
            : "") +
          `\n\n✅ Say "send it" to confirm, or "cancel" to discard.`
      }
    };
  } catch (err) {
    console.error("Email tool error:", err);
    return { tool: "email", success: false, final: true, error: `Email operation failed: ${err.message}` };
  }
}

export async function sendConfirmedEmail({ to, subject, body, attachments = [] }) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const raw = Buffer.from(
      [`To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0",
       "Content-Type: text/plain; charset=utf-8", "", body].join("\n")
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

    return {
      tool: "email",
      success: true,
      final: true,
      data: { to, subject, body, messageId: res.data.id, message: `✅ Email sent successfully to ${to}` }
    };
  } catch (err) {
    return { tool: "email", success: false, final: true, error: `Email sending failed: ${err.message}` };
  }
}

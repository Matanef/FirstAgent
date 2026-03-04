// server/tools/email.js
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

  // If no explicit subject found, try common patterns
  if (subject === "Message from AI Agent") {
    const aboutMatch = cleanQuery.match(/(?:about|regarding|re:)\s+(.{5,60}?)(?:\s+saying|\s+with|\s+and\s|[.!?]|$)/i);
    if (aboutMatch) {
      subject = aboutMatch[1].trim();
    }
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

/**
 * Browse/list emails from inbox using Gmail API
 */
async function browseEmails(queryText) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const lower = queryText.toLowerCase();
    let q = "";

    if (/\bunread\b/.test(lower)) q = "is:unread";
    else if (/\bsent\b/.test(lower)) q = "in:sent";
    else if (/\bstarred?\b/.test(lower)) q = "is:starred";
    else if (/\bimportant\b/.test(lower)) q = "is:important";
    else q = "in:inbox";

    // Extract search terms (e.g., "emails about invoices")
    const aboutMatch = lower.match(/(?:about|regarding|from|subject)\s+(.+?)(?:\s+in\s+|\s+from\s+|$)/i);
    if (aboutMatch) q += ` ${aboutMatch[1].trim()}`;

    const res = await gmail.users.messages.list({ userId: "me", q, maxResults: 10 });

    if (!res.data.messages || res.data.messages.length === 0) {
      return {
        tool: "email",
        success: true,
        final: true,
        data: { message: "No emails found matching your criteria.", emails: [], preformatted: true, text: "No emails found matching your criteria." }
      };
    }

    const emails = [];
    for (const msg of res.data.messages.slice(0, 10)) {
      const detail = await gmail.users.messages.get({
        userId: "me", id: msg.id, format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"]
      });
      const headers = detail.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      emails.push({
        id: msg.id,
        from: getHeader("From"),
        to: getHeader("To"),
        subject: getHeader("Subject") || "(no subject)",
        date: getHeader("Date"),
        snippet: detail.data.snippet || "",
        unread: (detail.data.labelIds || []).includes("UNREAD")
      });
    }

    const summary = emails.map((e, i) =>
      `${i + 1}. ${e.unread ? "[UNREAD] " : ""}**${e.subject}**\n   From: ${e.from}\n   ${e.date}\n   ${e.snippet.substring(0, 80)}...`
    ).join("\n\n");

    const text = `**Your emails** (${emails.length} results):\n\n${summary}`;
    return {
      tool: "email",
      success: true,
      final: true,
      data: { emails, message: text, preformatted: true, text }
    };
  } catch (err) {
    console.error("[email] Browse error:", err);
    return { tool: "email", success: false, final: true, error: `Failed to browse emails: ${err.message}` };
  }
}

export async function email(query) {
  try {
    // Handle both string and object input
    const queryText = typeof query === "string" ? query : (query?.text || query?.input || "");
    const context = (typeof query === "object") ? (query?.context || {}) : {};
    const action = context.action || "";

    // BROWSE/READ emails
    if (action === "browse" || /\b(check|read|browse|inbox|list|show|go\s+over|latest|recent|unread)\b/i.test(queryText.toLowerCase())) {
      return await browseEmails(queryText);
    }

    // DELETE emails (not supported yet)
    if (action === "delete") {
      return {
        tool: "email",
        success: false,
        final: true,
        error: "Email deletion is not currently supported. The Gmail API requires additional permissions (gmail.modify scope) for this operation."
      };
    }

    // COMPOSE email (original behavior)
    const { to, subject, body, requestedAttachments } = await parseEmailRequest(queryText);

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
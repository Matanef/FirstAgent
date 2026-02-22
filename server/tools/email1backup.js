// server/tools/email.js
// COMPLETE FIX: Email with proper draft persistence in data field

import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";
import { resolveContact, extractContactRef } from "./contacts.js";
import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";
import { getMemory } from "../memory.js";

async function parseEmailRequest(query) {
  const lower = query.toLowerCase();
  const memory = await getMemory();

  // Extract email address or resolve contact
  let to = null;
  const emailMatch = query.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (emailMatch) {
    to = emailMatch[0];
  } else {
    const contactRef = extractContactRef(query);
    if (contactRef) {
      const resolved = await resolveContact(contactRef);
      if (resolved && resolved.contact.email) {
        to = resolved.contact.email;
        console.log(`📧 Resolved contact "${contactRef}" to ${to}`);
      }
    }
  }

  // Extract subject
  let subject = "Message from AI Agent";
  const subjectMatch = lower.match(/subject[:\s]+([^\n]+)/i);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  }

  // Extract body
  let body = query;
  const sayingMatch = query.match(/saying[:\s]+(.+?)(?:\s+with|$)/is);
  if (sayingMatch) {
    body = sayingMatch[1].trim();
  }

  // Extract attachments
  const requestedAttachments = [];
  const attachmentPatterns = [
    /with\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))\s+attached/gi,
    /attach(?:ing)?\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi,
    /send\s+(?:the\s+)?(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi
  ];

  for (const pattern of attachmentPatterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
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

  for (const searchPath of searchPaths) {
    try {
      await fs.access(searchPath);
      return searchPath;
    } catch {
      continue;
    }
  }
  return null;
}

export async function email(query) {
  try {
    const { to, subject, body, requestedAttachments } = await parseEmailRequest(query);

    if (!to) {
      return {
        tool: "email",
        success: false,
        final: true,
        error: "Could not detect recipient email address.\n\nTry:\n• 'send email to john@example.com'\n• 'email mom about dinner' (if mom is a saved contact)"
      };
    }

    // Process attachments
    const attachments = [];
    if (requestedAttachments && requestedAttachments.length > 0) {
      for (const filename of requestedAttachments) {
        const filepath = await findAttachment(filename);
        if (filepath) {
          const stat = await fs.stat(filepath);
          attachments.push({
            filename: path.basename(filepath),
            filepath,
            size: stat.size
          });
        }
      }
    }

    // FIX #3: Store complete draft in data.pendingEmail for executor to find
    return {
      tool: "email",
      success: true,
      final: true, // Mark as final so it doesn't get summarized
      data: {
        mode: "draft",
        to,
        subject,
        body,
        attachments,
        pendingEmail: { to, subject, body, attachments }, // CRITICAL: Store here for "send it"
        message: `📧 **Email Draft:**\n\n**To:** ${to}\n**Subject:** ${subject}\n**Message:**\n${body}\n${attachments.length > 0 ? `\n📎 **Attachments (${attachments.length}):**\n${attachments.map(a => `• ${a.filename}`).join('\n')}\n` : ""}\n\n✅ Say "send it" to confirm, or "cancel" to discard.`
      }
    };
  } catch (err) {
    console.error("Email tool error:", err);
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Email operation failed: ${err.message}`
    };
  }
}

export async function sendConfirmedEmail({ to, subject, body, attachments = [] }) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const message = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body
    ].join("\n");

    const raw = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw }
    });

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        to,
        subject,
        body,
        messageId: res.data.id,
        message: `✅ Email sent successfully to ${to}`
      }
    };
  } catch (err) {
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Email sending failed: ${err.message}`
    };
  }
}

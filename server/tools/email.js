// server/tools/email.js
import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";
import { resolveContact, extractContactRef } from "./contacts.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT, CONFIG } from "../utils/config.js";
import { getMemory } from "../memory.js";
import { llm } from "./llm.js";

import { emailRegex, subjectRegex, sayingRegex, attachmentPatterns, SENTIMENT_KEYWORDS, stripMarkdown, detectSentiment } from './emailUtils.js';


/**
 * Generate an email body using the LLM, based on sentiment, context, and word count.
 */
async function generateEmailBody({ sentiment, subject, recipient, purpose, senderName, wordCount }) {
  const safeSentiment = sentiment || "neutral";
  const safeSubject = subject || "Message";
  const safeRecipient = recipient || "the recipient";
  const safePurpose = purpose || subject || "the topic mentioned";

  const lengthReq = wordCount 
    ? `Strictly around ${wordCount} words in total.` 
    : "medium (2–5 short paragraphs)";

  const signatureReq = senderName
    ? `Sign off the email naturally using the name: ${senderName}. Do NOT use placeholders like [Your Name].`
    : `Do NOT include any placeholders like [NAME]; just write the email as if you know the recipient.`;

  const prompt = `
You are writing an email.

Write a ${safeSentiment} email.

Recipient: ${safeRecipient}
Subject: ${safeSubject}
Purpose / context: ${safePurpose}

Requirements:
- Tone: ${safeSentiment}
- Length: ${lengthReq}
- Style: natural, human, warm, and appropriate for the sentiment
- ${signatureReq}
`;

  console.log("🧠 [email] Calling LLM for body generation. Words:", wordCount || "auto", "Sentiment:", safeSentiment);

  const result = await llm(prompt);
const text = result && result.data ? result.data.text : "Hi,\n\nThis is an automatically generated email.\n\nBest regards,\nYour AI agent";

  console.log("🧠 [email] LLM returned body length:", text.length);

  return text.trim();
}

/**
 * Parse a natural-language email request into structured fields.
 * Supports: to, cc, bcc, subject, body, HTML flag, multi-attachments.
 */
export async function parseEmailRequest(query) {
  await getMemory();

  let to = null;
  let cc = [];
  let bcc = [];
  let subject = "Message from AI Agent";
  let body = query;
  let isHtml = false;

  const cleanQuery = stripMarkdown(query);
  const lower = cleanQuery.toLowerCase();

  // HTML email detection
  if (/\b(html email|as html|in html)\b/i.test(lower)) {
    isHtml = true;
  }

  // To
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

  // If no email found via regex or contacts, check for "me"/"myself" → default email
  if (!to) {
    if (/\b(email\s+me|send\s+(it\s+)?to\s+me|mail\s+me|to\s+myself|send\s+me|for\s+me)\b/i.test(lower) ||
        /\bemail\s+me\b/i.test(lower)) {
      if (CONFIG.DEFAULT_EMAIL) {
        to = CONFIG.DEFAULT_EMAIL;
        console.log(`📧 Resolved "me" → default email: ${to}`);
      }
    }
  }

  // CC / BCC
  const ccMatch = cleanQuery.match(/cc[:\s]+([^\n]+)/i);
  if (ccMatch) {
    cc = ccMatch[1]
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(s => emailRegex.test(s));
  }

  const bccMatch = cleanQuery.match(/bcc[:\s]+([^\n]+)/i);
  if (bccMatch) {
    bcc = bccMatch[1]
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(s => emailRegex.test(s));
  }

  // Subject
  const subjectMatch = cleanQuery.match(subjectRegex);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  }

  // Fallback subject from "about/regarding"
  if (subject === "Message from AI Agent") {
    const aboutMatch = cleanQuery.match(
      /(?:about|regarding|re:)\s+(.{5,60}?)(?:\s+saying|\s+with|\s+and\s|[.!?]|$)/i
    );
    if (aboutMatch) {
      subject = aboutMatch[1].trim();
    }
  }

  // Body
  const bodyMatch = query.match(sayingRegex);
  if (bodyMatch) {
    body = bodyMatch[1].trim();
  } else {
    body = query
      .replace(/send (?:an )?email to [^\s]+/i, "")
      .replace(/write (?:an )?email to [^\s]+/i, "")
      .replace(/email to [^\s]+/i, "")
      .replace(/with the planner/i, "")
      .replace(/subject[:\s]+[^\n]+/i, "")
      .trim();
  }

  // Attachments
  let requestedAttachments = [];

  // Multi-file attachment support: "attach file1.txt and file2.txt"
  const multiAttachRegex =
    /attach(?:ing)?\s+((?:[^\s]+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))(?:\s*(?:and|,)\s*[^\s]+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))*)/gi;

  let multiMatch;
  let multiFound = false;

  while ((multiMatch = multiAttachRegex.exec(cleanQuery)) !== null) {
    multiFound = true;
    const files = multiMatch[1]
      .split(/\s*(?:and|,)\s*/i)
      .map(s => s.trim())
      .filter(Boolean);
    requestedAttachments.push(...files);
  }

  // Single-file patterns only if multi-file not found
  if (!multiFound) {
    for (const pattern of attachmentPatterns) {
      let match;
      while ((match = pattern.exec(cleanQuery)) !== null) {
        requestedAttachments.push(match[1].trim());
      }
    }
  }

  // Deduplicate
  requestedAttachments = [...new Set(requestedAttachments)];

  return { to, cc, bcc, subject, body, requestedAttachments, isHtml };
}

/**
 * List all attachments for a given Gmail message ID.
 * Returns array of { filename, mimeType, attachmentId, size }.
 * Useful for previewing what's available before triggering a download.
 */
export async function listAttachmentsForMessage(messageId) {
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: "v1", auth });

  const detail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const attachments = [];
  function walk(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0,
        });
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(detail.data.payload?.parts);
  // Handle single-part messages where the payload itself is the attachment
  if (detail.data.payload?.body?.attachmentId && detail.data.payload?.filename) {
    attachments.push({
      filename: detail.data.payload.filename,
      mimeType: detail.data.payload.mimeType || "application/octet-stream",
      attachmentId: detail.data.payload.body.attachmentId,
      size: detail.data.payload.body.size || 0,
    });
  }

  return attachments;
}

/**
 * Resolve a filename to an actual path in known folders.
 * SECURITY: Only searches uploads/ and downloads/ — NOT project root.
 * Blocks sensitive files (.env, config, service accounts, source code).
 */
export async function findAttachment(filename) {
  // Block sensitive filenames regardless of path
  const BLOCKED_PATTERNS = /\.(env|pem|key|p12|pfx)$|^\.env|config\.js$|service_account|memory\.json|package\.json/i;
  if (BLOCKED_PATTERNS.test(filename)) {
    console.warn(`🛡️ [email] Blocked sensitive attachment: ${filename}`);
    return null;
  }

  const SAFE_DIRS = [
    path.resolve(PROJECT_ROOT, "uploads"),
    path.resolve(PROJECT_ROOT, "downloads"),
  ];
  for (const dir of SAFE_DIRS) {
    const resolved = path.resolve(dir, filename);
    // Ensure resolved path is actually inside the safe dir (prevent ../../../ traversal)
    const rel = path.relative(dir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Browse/list emails from inbox using Gmail API, with optional label/filter support.
 */
export async function browseEmails(queryText, context = {}) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const lower = queryText.toLowerCase();
    let q = "";

    // Label / system filters
    if (context.label) {
      q += ` label:${context.label}`;
    } else if (/\bunread\b/.test(lower)) q += " is:unread";
    else if (/\bsent\b/.test(lower)) q += " in:sent";
    else if (/\bstarred?\b/.test(lower)) q += " is:starred";
    else if (/\bimportant\b/.test(lower)) q += " is:important";
    else q += " in:inbox";

    // Sender filter
    const fromMatch = lower.match(/from\s+([^\s]+@[^\s]+)/i);
    if (fromMatch) {
      q += ` from:${fromMatch[1]}`;
    }

    // Attachment search
    const attachSearch = lower.match(/attachments?\s+(?:named?\s+|called\s+|like\s+)?["']?(\w+)["']?/i);
    if (attachSearch) {
      q += ` has:attachment filename:${attachSearch[1]}`;
    } else if (/\bwith\s+attachment\b/i.test(lower) || /\bhas\s+attachment\b/i.test(lower)) {
      q += " has:attachment";
      const attachTopicMatch = lower.match(/attachment\s+(?:about\s+|named?\s+|called\s+)?["']?(\w+)["']?/i);
      if (attachTopicMatch && !["the", "a", "an", "my"].includes(attachTopicMatch[1])) {
        q += ` filename:${attachTopicMatch[1]}`;
      }
    }

    // Subject/keyword filter
    const aboutMatch = lower.match(/(?:about|regarding|subject)\s+(.+?)(?:\s+in\s+|\s+from\s+|$)/i);
    if (aboutMatch) q += ` ${aboutMatch[1].trim()}`;
let res;
try {
  res = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: 10
  });
} catch (err) {
  console.error("[email] Browse error:", err);
  return {
    tool: "email",
    success: false,
    final: true,
    error: `Failed to browse emails: ${err.message}`
  };
}

    if (!res.data.messages || res.data.messages.length === 0) {
      const text = "No emails found matching your criteria.";
      return {
        tool: "email",
        success: true,
        final: true,
        data: { message: text, emails: [], preformatted: true, text }
      };
    }

    const emails = [];
    for (const msg of res.data.messages.slice(0, 10)) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"]
      });
      const headers = detail.data.payload?.headers || [];
      const getHeader = name =>
        headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

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

    const summary = emails
      .map((e, i) => `${i + 1}. ${e.unread ? "[UNREAD] " : ""}**${e.subject}**\n   From: ${e.from}\n   ${e.date}\n   ${e.snippet.substring(0, 80)}...`)
      .join("\n\n");

    const text = `**Your emails** (${emails.length} results):\n\n${summary}`;
    return {
      tool: "email",
      success: true,
      final: true,
      data: { emails, message: text, preformatted: true, text }
    };

  } catch (err) {
    console.error("[email] Browse error:", err);
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Failed to browse emails: ${err.message}`
    };
  }
}

/**
 * Delete emails matching filters (sender, time, etc.).
 * Uses Gmail "trash" (requires gmail.modify scope).
 */
async function deleteEmails(queryText, context = {}) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const lower = queryText.toLowerCase();
    let q = " in:inbox";

    // Sender
    const fromMatch = lower.match(/from\s+([^\s]+@[^\s]+)/i);
    if (fromMatch) {
      q += ` from:${fromMatch[1]}`;
    }

    // Before/after
    const beforeMatch = lower.match(/before\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i);
    if (beforeMatch) {
      q += ` before:${beforeMatch[1].replace(/\//g, "-")}`;
    }
    const afterMatch = lower.match(/after\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i);
    if (afterMatch) {
      q += ` after:${afterMatch[1].replace(/\//g, "-")}`;
    }

    // Subject/keywords
    const aboutMatch = lower.match(
      /(?:about|regarding|subject)\s+(.+?)(?:\s+in\s+|\s+from\s+|$)/i
    );
    if (aboutMatch) q += ` ${aboutMatch[1].trim()}`;

    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 50
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
      const text = "No emails matched the delete criteria.";
      return {
        tool: "email",
        success: true,
        final: true,
        data: { message: text, deleted: 0, preformatted: true, text }
      };
    }

    let deleted = 0;
    for (const msg of messages) {
      await gmail.users.messages.trash({ userId: "me", id: msg.id });
      deleted++;
    }

    const text = `🗑️ Moved ${deleted} email(s) to Trash based on your filters.`;
    return {
      tool: "email",
      success: true,
      final: true,
      data: { message: text, deleted, preformatted: true, text }
    };
  } catch (err) {
    console.error("[email] Delete error:", err);
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Failed to delete emails: ${err.message}`
    };
  }
}

/**
 * Build raw MIME message (text or HTML, with optional attachments and reply headers).
 */
async function buildRawMessage({
  to,
  cc = [],
  bcc = [],
  subject,
  body,
  attachments = [],
  isHtml = false,
  inReplyTo,
  references
}) {
  const headers = [];
  headers.push(`To: ${to}`);
  if (cc.length > 0) headers.push(`Cc: ${cc.join(", ")}`);
  if (bcc.length > 0) headers.push(`Bcc: ${bcc.join(", ")}`);
  headers.push(`Subject: ${subject}`);
  headers.push("MIME-Version: 1.0");
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  // No attachments → simple text or HTML
  if (!attachments || attachments.length === 0) {
    const contentType = isHtml
      ? 'Content-Type: text/html; charset="utf-8"'
      : 'Content-Type: text/plain; charset="utf-8"';
    const msg = [...headers, contentType, "", body].join("\n");
    return Buffer.from(msg)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // With attachments → multipart/mixed
  const boundary = "mixed_boundary_" + Date.now();
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [];

  // Text/HTML part
  const textContentType = isHtml
    ? 'Content-Type: text/html; charset="utf-8"'
    : 'Content-Type: text/plain; charset="utf-8"';
  parts.push(
    `--${boundary}`,
    textContentType,
    "Content-Transfer-Encoding: 7bit",
    "",
    body
  );

  // Attachments
  for (const att of attachments) {
    try {
      const fileData = await fs.readFile(att.filepath);
      const base64Data = fileData
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const filename = att.filename || path.basename(att.filepath);

      parts.push(
        `--${boundary}`,
        `Content-Type: application/octet-stream; name="${filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${filename}"`,
        "",
        base64Data
      );
    } catch (err) {
      console.error("[email] Attachment read error:", err);
    }
  }

  parts.push(`--${boundary}--`, "");

  const msg = [...headers, "", ...parts].join("\n");
  return Buffer.from(msg)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Main email tool:
 * - browse (with label/filter support)
 * - delete (by sender/time/subject)
 * - reply (via context)
 * - compose draft (with CC/BCC, HTML, multi-attachments, sentiment + LLM)
 */
export async function email(query) {
  console.log("📨 [email] ENTERED TOOL");

  try {
    const queryText = typeof query === "string" ? query : query?.text || query?.input || "";
    const context = typeof query === "object" ? query?.context || {} : {};
    
    console.log("📨 [email] queryText:", queryText);
    console.log("📨 [email] context:", context);

    const lower = queryText.toLowerCase();
    const action = context.action || "";

    console.log("📨 [email] lower:", lower);
    console.log("📨 [email] action:", action);

    // DELETE emails
    if (action === "delete" || lower.includes("delete") || lower.includes("remove") || lower.includes("trash")) {
      console.log("📨 [email] DELETE branch");
      return await deleteEmails(queryText, context);
    }

    // REPLY to email
    if (action === "reply") {
      console.log("📨 [email] REPLY branch");
      const replyToId = context.messageId;
      if (!replyToId) {
        console.log("📨 [email] replyToId missing");
        return {
          tool: "email",
          success: false,
          final: true,
          error: "Missing messageId for reply."
        };
      }

      console.log("📨 [email] replyToId:", replyToId);

      const auth = await getAuthorizedClient();
      const gmail = google.gmail({ version: "v1", auth });

      console.log("📨 [email] Fetching original message...");

      const original = await gmail.users.messages.get({
        userId: "me",
        id: replyToId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Message-ID", "References"]
      });

      console.log("📨 [email] Original message fetched");

      const headers = original.data.payload?.headers || [];
      const getHeader = name =>
        headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ||
        "";

      const originalFrom = getHeader("From");
      const originalSubject = getHeader("Subject") || "(no subject)";
      const messageId = getHeader("Message-ID");
      const references = getHeader("References");

      console.log("📨 [email] Reply headers:", {
        originalFrom,
        originalSubject,
        messageId,
        references
      });

      const replySubject = originalSubject.startsWith("Re:")
        ? originalSubject
        : `Re: ${originalSubject}`;

      const body = queryText;

      console.log("📨 [email] Building reply MIME...");

      const raw = await buildRawMessage({
        to: originalFrom,
        subject: replySubject,
        body,
        attachments: [],
        isHtml: false,
        inReplyTo: messageId || undefined,
        references: references || messageId || undefined
      });

      console.log("📨 [email] Sending reply...");

let res;
try {
  res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw }
  });
} catch (err) {
  console.error("[email] Send error:", err);
  return {
    tool: "email",
    success: false,
    final: true,
    error: `Email sending failed: ${err.message}`
  };
}

      console.log("📨 [email] Reply sent!");

      return {
        tool: "email",
        success: true,
        final: true,
        data: {
          to: originalFrom,
          subject: replySubject,
          body,
          messageId: res.data.id,
          message: `Reply sent.`,
          preformatted: true,
          text: `Reply sent.`
        }
      };
    }

    // BROWSE inbox
    if (
      action === "browse" ||
      /\b(check (?:my )?inbox|show (?:my )?inbox|read (?:my )?inbox|browse (?:my )?inbox|list (?:my )?inbox|unread (?:my )?inbox)\b/i.test(
        lower
      )
    ) {
      console.log("📨 [email] BROWSE branch");
      return await browseEmails(queryText, context);
    }

    console.log("📨 [email] ENTERING COMPOSE BRANCH");

    // COMPOSE email (draft)
    const parsed = await parseEmailRequest(queryText);

    console.log("📨 [email] Parsed request:", parsed);

    let { to, cc, bcc, subject, body, requestedAttachments, isHtml } = parsed;

    // ── CHAIN CONTEXT: use recipient from planner if not extracted from text ──
    if (!to && context.to) {
      to = context.to;
      console.log("📨 [email] Using recipient from planner context:", to);
    }

    if (!to) {
      console.log("📨 [email] NO RECIPIENT FOUND");
      return {
        tool: "email",
        success: false,
        final: true,
        error: "Could not detect recipient email address."
      };
    }

    // ── CHAIN CONTEXT: inject previous step output into email body ──
    if (context.useLastResult && context.chainContext?.previousOutput) {
      const prevTool = context.chainContext.previousTool || "previous step";
      const prevOutput = String(context.chainContext.previousOutput);
      console.log(`📨 [email] Injecting chain context from "${prevTool}" (${prevOutput.length} chars)`);

      let plainContent;

      // ── Smart formatting per tool type ──
if (prevTool === "news") {
        const headlines = [];
        // This regex matches your news tool output precisely
        const storyRegex = /\*\*(\d+)\.\s+(.+?)\*\*\s*\*\[(.+?)\]\*\n([\s\S]*?)\n🔗\s+(https?:\/\/[^\s]+)/gm;
        
        let match;
        while ((match = storyRegex.exec(prevOutput)) !== null) {
          headlines.push({
            index: match[1],
            title: match[2].trim(),
            source: match[3].trim(),
            summary: match[4].trim(),
            url: match[5].trim()
          });
        }

        if (headlines.length > 0) {
          let rawAnalysis = prevOutput.split(/### 📋 TOP STORIES/i)[0] || "";
          rawAnalysis = rawAnalysis.replace(/### 🚨 TOPIC:.*?\n|### 🤖 AI ANALYSIS\n/gi, "").trim();
          const topicLabel = context.chainContext?.topic || "News Summary";

          isHtml = true; 
          
          let newsHtml = `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; padding: 10px;">`;
          
          // Header Section
          newsHtml += `<h1 style="color: #d32f2f; font-size: 24px; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 10px;">🚨 NEWS SUMMARY</h1>`;
          
          // AI Analysis Section - using display: block to prevent tailing
          newsHtml += `<div style="background: #f8f9fa; border-left: 4px solid #1a73e8; padding: 15px; margin-bottom: 25px;">`;
          newsHtml += `<h2 style="color: #1a73e8; font-size: 18px; margin-top: 0; display: block;">🤖 AI ANALYSIS</h2>`;
          newsHtml += `<p style="margin-top: 10px; display: block;">${rawAnalysis.replace(/\n/g, '<br>')}</p>`;
          newsHtml += `</div>`;
          
          newsHtml += `<h2 style="font-size: 16px; color: #666; text-transform: uppercase; margin-bottom: 15px;">📋 Top Stories</h2>`;

          headlines.forEach((h) => {
            newsHtml += `<div style="margin-bottom: 30px; border-top: 1px solid #f0f0f0; padding-top: 15px;">`;
            
            // Article Title - Explicitly block to prevent mid-word breaks or tailing
            newsHtml += `<div style="font-weight: bold; font-size: 20px; color: #000; line-height: 1.3; display: block; margin-bottom: 5px;">${h.index}. ${h.title}</div>`;
            
            // Source line
            newsHtml += `<div style="font-size: 13px; color: #888; margin-bottom: 10px; font-style: italic;">Source: ${h.source}</div>`;
            
            // Summary
            if (h.summary) {
                newsHtml += `<p style="margin: 10px 0; color: #444; font-size: 15px; display: block;">${h.summary}</p>`;
            }
            
            // The Button
            newsHtml += `<a href="${h.url}" style="display: inline-block; background-color: #1a73e8; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 13px; margin-top: 5px;">🔗 READ FULL ARTICLE</a>`;
            
            newsHtml += `</div>`;
          });

          newsHtml += `</div>`;
          
          // CRITICAL: We set plainContent to the same as newsHtml to bypass the generic stripper
          plainContent = newsHtml; 
          body = newsHtml;
        }
      } else if (prevTool === "weather") {
        // Extract weather data from HTML/text output
        const tempMatch = prevOutput.match(/([\d.]+)°C/);
        const feelsMatch = prevOutput.match(/[Ff]eels?\s*like[:\s]*([\d.]+)°C/);
        const condMatch = prevOutput.match(/(?:condition|weather)[:\s]*([^\n<,]+)/i) ||
                          prevOutput.match(/moderate\s+\w+|clear\s+sky|overcast|light\s+\w+|heavy\s+\w+|sunny|cloudy|rainy/i);
        const windMatch = prevOutput.match(/[Ww]ind[:\s]*([\d.]+)\s*m\/s/);
        const humidMatch = prevOutput.match(/[Hh]umidity[:\s]*([\d.]+)%/);
        const cityMatch = prevOutput.match(/weather (?:in|for) ([^,\n<]+)/i);
        plainContent = "🌤️ Weather Report\n" + "=".repeat(30) + "\n\n";
        if (cityMatch) plainContent += `📍 Location: ${cityMatch[1].trim()}\n`;
        if (tempMatch) plainContent += `🌡️ Temperature: ${tempMatch[1]}°C`;
        if (feelsMatch) plainContent += ` (Feels like: ${feelsMatch[1]}°C)`;
        plainContent += "\n";
        if (condMatch) plainContent += `☁️ Condition: ${(condMatch[1] || condMatch[0]).trim()}\n`;
        if (windMatch) plainContent += `💨 Wind: ${windMatch[1]} m/s\n`;
        if (humidMatch) plainContent += `💧 Humidity: ${humidMatch[1]}%\n`;
      }

      // LLM analysis output: convert markdown to clean HTML email
      if (!plainContent && (prevTool === "llm" || prevTool === "nlp_tool")) {
        // The LLM output is markdown-formatted text — convert to HTML for a clean email
        let html = prevOutput
          // Escape HTML entities first
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          // Bold: **text** → <strong>text</strong>
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          // Italic: *text* → <em>text</em>
          .replace(/\*([^*]+)\*/g, "<em>$1</em>")
          // Markdown links: [text](url) → <a href="url">text</a>
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
          // Bare URLs: wrap in <a> tags (but not already inside href)
          .replace(/(?<!href=")(https?:\/\/[^\s<)"]+)/g, '<a href="$1">$1</a>')
          // Numbered list items: "1. " → proper list formatting
          .replace(/^(\d+)\.\s+/gm, '<li style="margin-bottom: 6px;">')
          // Paragraph breaks: double newline → </p><p>
          .replace(/\n{2,}/g, '</p><p style="margin: 12px 0;">')
          // Single newlines within paragraphs → <br>
          .replace(/\n/g, "<br>\n");

        plainContent = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: #333; line-height: 1.6; max-width: 700px;">
<p style="margin: 12px 0;">${html}</p>
</div>`;
        isHtml = true;
      }

      // Fallback: generic HTML-to-text stripping
      if (!plainContent) {
        plainContent = prevOutput
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\s{2,}/g, " ")
          .trim();
      }

      // Truncate if too long
      if (plainContent.length > 10000) {
        plainContent = plainContent.slice(0, 10000) + "\n\n... (truncated)";
      }

      body = plainContent;

      // Generate a smart subject based on the previous tool
      if (!subject || subject === "Message from AI Agent") {
        const toolSubjects = {
          news: "Latest News Summary",
          search: "Search Results Summary",
          weather: "Weather Report",
          finance: "Stock Market Update",
          sports: "Sports Scores Update",
          review: "Code Review Results",
          githubTrending: "Trending GitHub Repos",
          youtube: "YouTube Search Results",
          x: "X/Twitter Trends & Tweets",
          llm: "AI Analysis Summary"
        };
        subject = toolSubjects[prevTool] || `Results from ${prevTool}`;
      }
      console.log(`📨 [email] Chain context injected. Subject: "${subject}", Body length: ${body.length}`);
    }

    // NEW: Get user name from memory
    const { getMemory } = await import("../memory.js");
    const memory = await getMemory();
    const senderName = memory.profile?.name || null;

    // NEW: Detect word count requests (e.g., "100 words", "50 word")
    const wordMatch = queryText.match(/\b(\d+)\s*[-]?\s*words?\b/i);
    const wordCount = wordMatch ? wordMatch[1] : null;
    // Sentiment detection
    const sentiment = detectSentiment(queryText);
    console.log("🧠 [email] Detected sentiment:", sentiment);

    // If sentiment OR word count is present, generate a new body with the LLM
    // Skip LLM generation if body was populated from chain context
    if ((sentiment || wordCount) && !context.chainContext?.previousOutput) {
      console.log("🧠 [email] Generating body via LLM...");
      const purpose = subject || body || queryText;
      body = await generateEmailBody({
        sentiment,
        subject,
        recipient: to,
        purpose,
        senderName,
        wordCount
      });
      console.log("🧠 [email] New body generated (length):", body.length);
    }
    // ── AUTO-HTML DETECTION ──
    // If the body contains HTML tags (like those generated by the news/LLM pipeline), 
    // force the email to send as HTML so the tags render correctly instead of showing as text.
    if (!isHtml && /<\/?[a-z][\s\S]*>/i.test(body)) {
      console.log("📨 [email] Auto-detected HTML tags in body. Switching to HTML mode.");
      isHtml = true;
    }
    // --- NEW 11/04/2026 22:01: MARKDOWN TO HTML CONVERTER ---
    // If we are sending an HTML email, we must convert LLM markdown (**) to HTML (<strong>)
    if (isHtml && typeof body === 'string') {
      // Convert **text** to <strong>text</strong>
      body = body.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Convert *text* to <em>text</em> (for italics)
      body = body.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    }
    console.log("📨 [email] Resolving attachments:", requestedAttachments);


    const attachments = [];
    for (const filename of requestedAttachments) {
      const filepath = await findAttachment(filename);
      console.log("📨 [email] Attachment resolved:", filename, filepath);
      if (filepath) {
        const stat = await fs.stat(filepath);
        attachments.push({
          filename: path.basename(filepath),
          filepath,
          size: stat.size
        });
      }
    }

    console.log("📨 [email] Final attachments:", attachments);

    console.log("📨 [email] BUILDING DRAFT");

    // --- FINAL MARKDOWN SCRUBBER ---
    // This is the last line of defense. It removes any stray hashes or stars 
    // from the body before it ever touches the email draft.
// --- FINAL CLEANUP AND SMART WRAP ---
    if (typeof body === 'string' && !isHtml) {
      // We REMOVED \u200B from the forbidden list so it stays in the email
      body = body.replace(/[#*]/g, "").trim();

      body = body.split('\n').map(line => {
        // Preserve our "anchor" lines (Zero Width Space)
        if (line.includes("\u200B")) return line;
        if (line.includes("\n")) return line;
        if (line.length <= 100 || line.includes("🔗")) return line;
        
        return line.replace(/(.{1,100})(\s|$)/g, "$1\n").trim();
      }).join('\n');
    }

    const textLines = [];
    textLines.push("📧 **Email Draft:**\n");
    textLines.push(`**To:** ${to}`);
    if (cc.length > 0) textLines.push(`**Cc:** ${cc.join(", ")}`);
    if (bcc.length > 0) textLines.push(`**Bcc:** ${bcc.join(", ")}`);
    textLines.push(`**Subject:** ${subject}`);
    // For HTML emails, show a clean plain-text preview in chat instead of raw HTML
    if (isHtml) {
      const plainPreview = body
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<li[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\n{8,}/g, "\n\n\n") // Be much more generous
        .trim();
      textLines.push(`**Message:**\n${plainPreview}`);
      textLines.push("\n_(Formatted as HTML email)_");
    } else {
      textLines.push(`**Message:**\n${body}`);
    }
    if (attachments.length > 0) {
      textLines.push(
        `\n📎 **Attachments (${attachments.length}):**\n${attachments
          .map(a => `• ${a.filename}`)
          .join("\n")}`
      );
    }
    textLines.push(`\n\nSay "send it" to confirm, or "cancel" to discard.`);

    const text = textLines.join("\n");

    console.log("📨 [email] RETURNING DRAFT");

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        mode: "draft",
        to,
        cc,
        bcc,
        subject,
        body,
        isHtml,
        attachments,
        pendingEmail: { to, cc, bcc, subject, body, isHtml, attachments },
        message: text,
        preformatted: true,
        text
      }
    };
  } catch (err) {
    console.error("❌ [email] ERROR:", err);
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Email operation failed: ${err.message}`
    };
  }
}

/**
 * sendConfirmedEmail
 * Used by executor.js after user says "send it".
 */
export async function sendConfirmedEmail({
  to,
  cc = [],
  bcc = [],
  subject,
  body,
  attachments = [],
  isHtml = false,
  inReplyTo,
  references
}) {
  try {
    // 🔥 ULTIMATE OVERRIDE: If the body contains HTML tags, FORCE HTML mode
    if (/<\/?[a-z][\s\S]*>/i.test(body)) {
      isHtml = true;
      console.log("📨 [email] Hard override: HTML tags detected at send phase. Forcing HTML mode.");
    }

    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const raw = await buildRawMessage({
      to,
      cc,
      bcc,
      subject,
      body,
      attachments,
      isHtml,
      inReplyTo,
      references
    });

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
        cc,
        bcc,
        subject,
        body,
        messageId: res.data.id,
        message: `✅ Email sent successfully to ${to}`
      }
    };
  } catch (err) {
    console.error("[email] Send error:", err);
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Email sending failed: ${err.message}`
    };
  }
}
// server/tools/email.js
import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";
import { resolveContact, extractContactRef } from "./contacts.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../utils/config.js";
import { getMemory } from "../memory.js";
import { llm } from "./llm.js";

const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const subjectRegex = /subject[:\s]+([^\n]+)/i;
const sayingRegex =
  /saying[:\s]+(.+?)(?:\s+with\s+(?:the\s+)?(?:planner|executor|subject|attachment)|$)/is;

const attachmentPatterns = [
  /with\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))\s+attached/gi,
  /attach(?:ing)?\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi,
  /send\s+(?:the\s+)?(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi
];

function stripMarkdown(text) {
  return text.replace(/[_*`~]/g, "");
}

/**
 * Simple sentiment dictionary and detection.
 */
const SENTIMENT_KEYWORDS = [
  "happy",
  "sad",
  "funny",
  "formal",
  "official",
  "comforting",
  "motivational",
  "romantic",
  "angry",
  "apologetic",
  "professional",
  "casual",
  "friendly",
  "serious",
  "solemn",
  "sarcastic",
  "enthusiastic",
  "grateful"
];

function detectSentiment(text) {
  const lower = text.toLowerCase();

  // Direct patterns like "happy email", "sad email", etc.
  for (const s of SENTIMENT_KEYWORDS) {
    const direct = new RegExp(`\\b${s}\\b`, "i");
    if (direct.test(lower)) {
      return s;
    }
  }

  // Patterns like "make it happy", "make the email happy"
  const makeItRegex = /\bmake (?:it|the email)\s+([a-z]+)/i;
  const makeItMatch = lower.match(makeItRegex);
  if (makeItMatch && SENTIMENT_KEYWORDS.includes(makeItMatch[1])) {
    return makeItMatch[1];
  }

  // Patterns like "do it in a happy style", "in a happy tone", "with a happy vibe"
  const styleRegex =
    /\b(?:in|with)\s+(?:a|an)?\s*([a-z]+)\s+(?:style|tone|vibe|way)\b/i;
  const styleMatch = lower.match(styleRegex);
  if (styleMatch && SENTIMENT_KEYWORDS.includes(styleMatch[1])) {
    return styleMatch[1];
  }

  // Patterns like "a happy thank you email", "write a happy email"
  const beforeEmailRegex = /\b([a-z]+)\s+(?:thank you\s+)?email\b/i;
  const beforeEmailMatch = lower.match(beforeEmailRegex);
  if (beforeEmailMatch && SENTIMENT_KEYWORDS.includes(beforeEmailMatch[1])) {
    return beforeEmailMatch[1];
  }

  return null;
}

/**
 * Generate an email body using the LLM, based on sentiment and context.
 */
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
  const text =
    result?.data?.text ||
    "Hi,\n\nThis is an automatically generated email.\n\nBest regards,\nYour AI agent";

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
 * Resolve a filename to an actual path in known folders.
 */
export async function findAttachment(filename) {
  const searchPaths = [
    path.resolve(PROJECT_ROOT, "uploads", filename),
    path.resolve(PROJECT_ROOT, "downloads", filename),
    path.resolve(PROJECT_ROOT, filename)
  ];
  for (const p of searchPaths) {
    try {
      await fs.access(p);
      return p;
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

    // Attachment search: "find attachments named bills", "emails with attachment invoice"
    const attachSearch = lower.match(/attachments?\s+(?:named?\s+|called\s+|like\s+)?["']?(\w+)["']?/i);
    if (attachSearch) {
      q += ` has:attachment filename:${attachSearch[1]}`;
    } else if (/\bwith\s+attachment\b/i.test(lower) || /\bhas\s+attachment\b/i.test(lower)) {
      q += " has:attachment";
      // Try to extract the attachment topic
      const attachTopicMatch = lower.match(/attachment\s+(?:about\s+|named?\s+|called\s+)?["']?(\w+)["']?/i);
      if (attachTopicMatch && !["the", "a", "an", "my"].includes(attachTopicMatch[1])) {
        q += ` filename:${attachTopicMatch[1]}`;
      }
    }

    // Subject/keyword filter
    const aboutMatch = lower.match(
      /(?:about|regarding|subject)\s+(.+?)(?:\s+in\s+|\s+from\s+|$)/i
    );
    if (aboutMatch) q += ` ${aboutMatch[1].trim()}`;

    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 10
    });

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
        headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ||
        "";

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
      .map(
        (e, i) =>
          `${i + 1}. ${e.unread ? "[UNREAD] " : ""}**${e.subject}**\n   From: ${
            e.from
          }\n   ${e.date}\n   ${e.snippet.substring(0, 80)}...`
      )
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

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw }
      });

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
        // Extract structured headlines from news HTML
        const headlines = [];
        const cardRegex = /<span class="news-source">([^<]+)<\/span>[\s\S]*?<h3 class="news-summary-title">([^<]+)<\/h3>[\s\S]*?<p class="news-summary-text">([^<]*)<\/p>[\s\S]*?<a href="([^"]+)"[^>]*>Read full article/gi;
        let match;
        while ((match = cardRegex.exec(prevOutput)) !== null) {
          headlines.push({
            source: match[1].trim(),
            title: match[2].trim(),
            summary: match[3].trim(),
            url: match[4].trim()
          });
        }
        if (headlines.length > 0) {
          plainContent = "📰 Latest News Summary\n" + "=".repeat(40) + "\n\n";
          headlines.forEach((h, i) => {
            plainContent += `${i + 1}. [${h.source}] ${h.title}\n`;
            if (h.summary && h.summary !== h.title) {
              plainContent += `   ${h.summary}\n`;
            }
            plainContent += `   ${h.url}\n\n`;
          });
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
          x: "X/Twitter Trends & Tweets"
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

    const textLines = [];
    textLines.push("📧 **Email Draft:**\n");
    textLines.push(`**To:** ${to}`);
    if (cc.length > 0) textLines.push(`**Cc:** ${cc.join(", ")}`);
    if (bcc.length > 0) textLines.push(`**Bcc:** ${bcc.join(", ")}`);
    textLines.push(`**Subject:** ${subject}`);
    textLines.push(`**Message:**\n${body}`);
    if (attachments.length > 0) {
      textLines.push(
        `\n📎 **Attachments (${attachments.length}):**\n${attachments
          .map(a => `• ${a.filename}`)
          .join("\n")}`
      );
    }
    if (isHtml) {
      textLines.push("\n(Will be sent as an HTML email)");
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
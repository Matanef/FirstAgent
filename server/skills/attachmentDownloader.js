// server/skills/attachmentDownloader.js
// Downloads email attachments from Gmail based on sender and date range.
// Usage: "Download attachments from user@example.com since 01/01/2025"
//        "Download attachments from user@example.com between 01/01/2025 and 15/03/2025"

import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";
import { PROJECT_ROOT } from "../utils/config.js";
import fs from "fs/promises";
import path from "path";

const DOWNLOAD_ROOT = path.resolve(PROJECT_ROOT, "downloads");

// ── SECURITY ──────────────────────────────────────────────────────────
const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".bash", ".ps1", ".vbs", ".wsf",
  ".msi", ".dll", ".so", ".com", ".scr", ".pif", ".jar", ".cpl",
]);

const BLOCKED_PATTERNS = /\.(env|pem|key|p12|pfx)$/i;

/**
 * Strip dangerous characters from filenames to prevent traversal / injection.
 */
function sanitizeFilename(raw) {
  if (!raw || typeof raw !== "string") return `unnamed_${Date.now()}`;
  // Remove path separators, null bytes, and control chars
  let clean = raw
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\.{2,}/g, ".")        // collapse double dots
    .replace(/^\.+/, "")            // no leading dots
    .trim();
  if (!clean) clean = `unnamed_${Date.now()}`;
  // Cap length at 200 chars
  if (clean.length > 200) {
    const ext = path.extname(clean);
    clean = clean.slice(0, 200 - ext.length) + ext;
  }
  return clean;
}

/**
 * Check if a filename is an executable type.
 */
function isExecutable(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

// ── DATE PARSING ──────────────────────────────────────────────────────

/**
 * Parse a date string in multiple formats to YYYY/MM/DD for Gmail query.
 * Supports: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD, YYYY/MM/DD
 * Also handles natural language: "yesterday", "last week", "last month", etc.
 */
function parseDate(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const ddmmyyyy = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return `${y}/${m.padStart(2, "0")}/${d.padStart(2, "0")}`;
  }

  // YYYY-MM-DD or YYYY/MM/DD
  const yyyymmdd = trimmed.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
  if (yyyymmdd) {
    const [, y, m, d] = yyyymmdd;
    return `${y}/${m.padStart(2, "0")}/${d.padStart(2, "0")}`;
  }

  // Natural language
  const lower = trimmed.toLowerCase();
  const now = new Date();

  if (lower === "today") {
    return formatDateGmail(now);
  }
  if (lower === "yesterday") {
    now.setDate(now.getDate() - 1);
    return formatDateGmail(now);
  }
  if (/^last\s+week$/i.test(lower)) {
    now.setDate(now.getDate() - 7);
    return formatDateGmail(now);
  }
  if (/^last\s+month$/i.test(lower)) {
    now.setMonth(now.getMonth() - 1);
    return formatDateGmail(now);
  }
  if (/^last\s+year$/i.test(lower)) {
    now.setFullYear(now.getFullYear() - 1);
    return formatDateGmail(now);
  }

  // Try native Date parse as last resort
  const attempt = new Date(trimmed);
  if (!isNaN(attempt.getTime())) {
    return formatDateGmail(attempt);
  }

  return null;
}

function formatDateGmail(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/**
 * Format a date as YYYY-MM-DD for folder naming.
 */
function formatDateFolder(gmailDate) {
  return gmailDate.replace(/\//g, "-");
}

// ── REQUEST PARSING ───────────────────────────────────────────────────

/**
 * Extract sender email, start date, and end date from user's natural language request.
 */
function parseRequest(text) {
  const lower = text.toLowerCase();

  // Extract email address
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/i);
  const senderEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

  let startDate = null;
  let endDate = null;

  // Pattern 1: "between DATE1 and/to DATE2"
  const betweenMatch = text.match(
    /between\s+(.+?)\s+(?:and|to)\s+(.+?)(?:\s*$|\s+from|\s+of|\s+for)/i
  );
  if (betweenMatch) {
    startDate = parseDate(betweenMatch[1]);
    endDate = parseDate(betweenMatch[2]);
  }

  // Pattern 2: "since DATE" or "from DATE" or "after DATE"
  if (!startDate) {
    const sinceMatch = text.match(
      /(?:since|from|after|starting)\s+([\d/\-.\w\s]+?)(?:\s+(?:and|to|until|till)\s+([\d/\-.\w\s]+?))?(?:\s*$|\s+from\s+[\w@])/i
    );
    if (sinceMatch) {
      startDate = parseDate(sinceMatch[1]);
      if (sinceMatch[2]) endDate = parseDate(sinceMatch[2]);
    }
  }

  // Pattern 3: "before DATE" (only end date)
  if (!startDate && !endDate) {
    const beforeMatch = text.match(/before\s+([\d/\-.\w]+)/i);
    if (beforeMatch) {
      endDate = parseDate(beforeMatch[1]);
    }
  }

  // Default: if no end date specified, use tomorrow (to include today)
  if (startDate && !endDate) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    endDate = formatDateGmail(tomorrow);
  }

  return { senderEmail, startDate, endDate };
}

// ── GMAIL ATTACHMENT FETCHING ─────────────────────────────────────────

/**
 * Recursively walk message parts to find all attachment parts.
 */
function collectAttachmentParts(parts, collected = []) {
  if (!parts) return collected;
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      collected.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      collectAttachmentParts(part.parts, collected);
    }
  }
  return collected;
}

// ── MAIN SKILL ────────────────────────────────────────────────────────

export async function attachmentDownloader(request) {
  const text = typeof request === "string"
    ? request
    : (request?.text || request?.input || request?.context?.rawInput || "");

  if (!text) {
    return {
      success: false,
      final: true,
      error: "Please specify a sender email and date range. Example: \"Download attachments from user@example.com since 01/01/2025\""
    };
  }

  // ── 1. PARSE REQUEST ──
  const { senderEmail, startDate, endDate } = parseRequest(text);

  if (!senderEmail) {
    return {
      success: false,
      final: true,
      error: "Could not find an email address in your request. Example: \"Download attachments from user@example.com since 01/01/2025\""
    };
  }

  if (!startDate) {
    return {
      success: false,
      final: true,
      error: `Could not parse a date from your request. Supported formats: DD/MM/YYYY, YYYY-MM-DD, or natural language like "since last week". Example: "Download attachments from ${senderEmail} since 01/01/2025"`
    };
  }

  console.log(`📂 [attachmentDownloader] Searching for attachments from ${senderEmail} | after:${startDate} before:${endDate}`);

  // ── 2. AUTHENTICATE & SEARCH GMAIL ──
  let auth, gmail;
  try {
    auth = await getAuthorizedClient();
    gmail = google.gmail({ version: "v1", auth });
  } catch (err) {
    return {
      success: false,
      final: true,
      error: `Gmail authentication failed: ${err.message}. Make sure OAuth is set up.`
    };
  }

  const query = `from:${senderEmail} has:attachment after:${startDate} before:${endDate}`;
  console.log(`📂 [attachmentDownloader] Gmail query: ${query}`);

  let allMessages = [];
  let pageToken = null;

  try {
    // Paginate through all matching messages (Gmail returns max 100 per page)
    do {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      });

      const messages = listRes.data.messages || [];
      allMessages.push(...messages);
      pageToken = listRes.data.nextPageToken || null;

      // Safety cap: 500 messages max to prevent runaway downloads
      if (allMessages.length >= 500) {
        console.warn("📂 [attachmentDownloader] Hit 500 message cap, stopping pagination.");
        break;
      }
    } while (pageToken);
  } catch (err) {
    return {
      success: false,
      final: true,
      error: `Gmail search failed: ${err.message}`
    };
  }

  if (allMessages.length === 0) {
    return {
      success: true,
      final: true,
      data: {
        text: `No emails with attachments found from **${senderEmail}** in the specified date range (${formatDateFolder(startDate)} to ${formatDateFolder(endDate)}).`,
      }
    };
  }

  console.log(`📂 [attachmentDownloader] Found ${allMessages.length} email(s) with attachments.`);

  // ── 3. CREATE DOWNLOAD DIRECTORY ──
  // Use the start date for folder naming
  const dateFolderName = formatDateFolder(startDate);
  // Sanitize the email for use as a folder name
  const emailFolderName = senderEmail.replace(/[^a-zA-Z0-9@.\-_]/g, "_");
  const downloadDir = path.resolve(DOWNLOAD_ROOT, dateFolderName, emailFolderName);

  // Verify the resolved path is inside DOWNLOAD_ROOT (prevent traversal)
  const rel = path.relative(DOWNLOAD_ROOT, downloadDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      success: false,
      final: true,
      error: "Security error: computed download path escapes the downloads directory."
    };
  }

  await fs.mkdir(downloadDir, { recursive: true });
  console.log(`📂 [attachmentDownloader] Download directory: ${downloadDir}`);

  // ── 4. DOWNLOAD ATTACHMENTS ──
  const downloaded = [];
  const skipped = [];
  const warnings = [];
  let totalBytes = 0;

  for (const msg of allMessages) {
    let detail;
    try {
      detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });
    } catch (err) {
      console.error(`📂 [attachmentDownloader] Failed to fetch message ${msg.id}:`, err.message);
      skipped.push({ messageId: msg.id, reason: err.message });
      continue;
    }

    // Get message date for context
    const headers = detail.data.payload?.headers || [];
    const dateHeader = headers.find(h => h.name.toLowerCase() === "date")?.value || "";
    const subjectHeader = headers.find(h => h.name.toLowerCase() === "subject")?.value || "(no subject)";

    // Find all attachment parts
    const attachmentParts = collectAttachmentParts(
      detail.data.payload?.parts || (detail.data.payload?.body?.attachmentId ? [detail.data.payload] : [])
    );

    for (const att of attachmentParts) {
      const safeName = sanitizeFilename(att.filename);

      // Security: block sensitive file patterns
      if (BLOCKED_PATTERNS.test(safeName)) {
        console.warn(`📂 [attachmentDownloader] Blocked sensitive file: ${safeName}`);
        skipped.push({ filename: safeName, reason: "Blocked sensitive file type" });
        continue;
      }

      // Security: warn about executables (still download but flag it)
      if (isExecutable(safeName)) {
        warnings.push(`⚠️ Executable detected: **${safeName}** — review before opening.`);
      }

      const destPath = path.resolve(downloadDir, safeName);

      // Verify destination is still inside download dir
      const destRel = path.relative(downloadDir, destPath);
      if (destRel.startsWith("..") || path.isAbsolute(destRel)) {
        skipped.push({ filename: safeName, reason: "Path traversal blocked" });
        continue;
      }

      // Dedup: skip if file already exists with same name
      try {
        const existing = await fs.stat(destPath);
        if (existing.isFile()) {
          skipped.push({ filename: safeName, reason: "Already exists" });
          continue;
        }
      } catch {
        // File doesn't exist — proceed
      }

      // Fetch the actual attachment data
      try {
        const attRes = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: msg.id,
          id: att.attachmentId,
        });

        const data = attRes.data.data; // base64url encoded
        if (!data) {
          skipped.push({ filename: safeName, reason: "Empty attachment data" });
          continue;
        }

        // Decode base64url → Buffer
        const buffer = Buffer.from(data, "base64url");

        await fs.writeFile(destPath, buffer);
        totalBytes += buffer.length;

        downloaded.push({
          filename: safeName,
          size: buffer.length,
          fromSubject: subjectHeader,
          fromDate: dateHeader,
        });

        console.log(`📂 [attachmentDownloader] ✅ Saved: ${safeName} (${formatBytes(buffer.length)})`);
      } catch (err) {
        console.error(`📂 [attachmentDownloader] Failed to download ${safeName}:`, err.message);
        skipped.push({ filename: safeName, reason: err.message });
      }
    }
  }

  // ── 5. BUILD RESPONSE ──
  const lines = [];
  lines.push(`📂 **Attachment Download Complete**\n`);
  lines.push(`**Sender:** ${senderEmail}`);
  lines.push(`**Date range:** ${formatDateFolder(startDate)} → ${formatDateFolder(endDate)}`);
  lines.push(`**Emails scanned:** ${allMessages.length}`);
  lines.push(`**Directory:** \`${path.relative(PROJECT_ROOT, downloadDir)}\`\n`);

  if (downloaded.length > 0) {
    lines.push(`✅ **Downloaded ${downloaded.length} file(s)** (${formatBytes(totalBytes)} total):\n`);
    for (const f of downloaded) {
      lines.push(`  • **${f.filename}** — ${formatBytes(f.size)} _(from: "${f.fromSubject}")_`);
    }
  } else {
    lines.push(`No new attachments to download.`);
  }

  if (skipped.length > 0) {
    lines.push(`\n⏭️ **Skipped ${skipped.length}:**`);
    for (const s of skipped) {
      const label = s.filename || `message ${s.messageId}`;
      lines.push(`  • ${label} — ${s.reason}`);
    }
  }

  if (warnings.length > 0) {
    lines.push(`\n${warnings.join("\n")}`);
  }

  return {
    success: true,
    final: true,
    data: {
      text: lines.join("\n"),
      downloadDir: path.relative(PROJECT_ROOT, downloadDir),
      filesDownloaded: downloaded.length,
      filesSkipped: skipped.length,
      totalBytes,
    }
  };
}

// ── UTILITIES ─────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

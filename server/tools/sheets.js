// server/tools/sheets.js
// Google Sheets integration — read, append, and manage spreadsheet data
// Authenticates via service account JSON key file

import path from "path";
import { PROJECT_ROOT } from "../utils/config.js";

// ============================================================
// AUTH & CLIENT (lazy initialization)
// ============================================================

// ── SECURITY: Service account key path configurable via env var ──
// Prefer GOOGLE_SERVICE_ACCOUNT_PATH env var over hardcoded location
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
  || path.join(PROJECT_ROOT, ".config", "google", "service_account.json");
let sheetsClient = null;

async function ensureClient() {
  if (sheetsClient) return sheetsClient;

  try {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    sheetsClient = google.sheets({ version: "v4", auth });
    console.log("[sheets] Google Sheets client initialized");
    return sheetsClient;
  } catch (err) {
    console.error("[sheets] Auth failed:", err.message);
    throw new Error(
      `Google Sheets auth failed. Ensure ${KEY_FILE} exists with a valid service account key.\n` +
      `Setup: Create a service account at console.cloud.google.com → APIs → Credentials, ` +
      `enable Sheets API, download JSON key, place at .config/google/service_account.json.\n` +
      `Then share your sheet with the service account email (xxx@xxx.iam.gserviceaccount.com).`
    );
  }
}

// ============================================================
// INTENT DETECTION
// ============================================================

function detectSheetsIntent(text) {
  const lower = (text || "").toLowerCase();
  if (/\b(append|add\s+row|insert\s+row|batch\s*append|write\s+to)\b/i.test(lower)) return "append";
  if (/\b(read|get|fetch|show|view)\b/i.test(lower)) return "read";
  if (/\b(clear|wipe|empty)\b/i.test(lower)) return "clear";
  return "append"; // default for chained operations
}

function extractSheetId(text, context) {
  // From context (passed by planner/orchestrator)
  if (context?.spreadsheetId) return context.spreadsheetId;
  if (context?.sheetId) return context.sheetId;

  // From text — Google Sheet IDs are long alphanumeric strings
  const idMatch = text.match(/\b([a-zA-Z0-9_-]{20,60})\b/);
  if (idMatch) return idMatch[1];

  // From URL
  const urlMatch = text.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];

  return null;
}

function extractRange(text, context) {
  if (context?.range) return context.range;
  const rangeMatch = text.match(/\b(Sheet\d+![A-Z]+\d*:[A-Z]+\d*|[A-Z]+\d*:[A-Z]+\d*)\b/i);
  return rangeMatch ? rangeMatch[1] : "Sheet1!A:Z";
}

// ============================================================
// OPERATIONS
// ============================================================

async function batchAppend(spreadsheetId, range, rows) {
  const client = await ensureClient();

  const response = await client.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: rows,
    },
  });

  return {
    success: true,
    updatedRange: response.data.updates?.updatedRange || range,
    updatedRows: response.data.updates?.updatedRows || rows.length,
    updatedCells: response.data.updates?.updatedCells || 0,
  };
}

async function readSheet(spreadsheetId, range) {
  const client = await ensureClient();

  const response = await client.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = response.data.values || [];
  return {
    success: true,
    range: response.data.range,
    rows,
    totalRows: rows.length,
  };
}

async function clearSheet(spreadsheetId, range) {
  const client = await ensureClient();

  const response = await client.spreadsheets.values.clear({
    spreadsheetId,
    range,
    requestBody: {},
  });

  return {
    success: true,
    clearedRange: response.data.clearedRange,
  };
}

// ============================================================
// FORMATTERS
// ============================================================

function formatAppendResult(result) {
  return `<div class="sheets-result">
    <h3>📊 Google Sheets — Rows Appended</h3>
    <p>✅ Added <strong>${result.updatedRows}</strong> rows (${result.updatedCells} cells) to <code>${result.updatedRange}</code></p>
  </div>`;
}

function formatReadResult(result, spreadsheetId) {
  if (result.rows.length === 0) {
    return `<div class="sheets-result"><p>📊 Sheet is empty (range: ${result.range})</p></div>`;
  }

  // First row as header, rest as data
  const header = result.rows[0] || [];
  const dataRows = result.rows.slice(1);

  const headerHTML = header.map(h => `<th style="padding: 4px 8px; border-bottom: 2px solid var(--border);">${h}</th>`).join("");
  const rowsHTML = dataRows.slice(0, 50).map(row => {
    const cells = row.map(c => `<td style="padding: 4px 8px; border-bottom: 1px solid var(--border);">${c || ""}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("\n");

  const truncated = dataRows.length > 50 ? `<p style="color: gray; font-size: 0.8em;">Showing 50 of ${dataRows.length} rows</p>` : "";

  return `<div class="sheets-result">
    <h3>📊 Google Sheets — ${result.totalRows} rows</h3>
    <table style="border-collapse: collapse; width: 100%; font-size: 0.9em;">
      <thead><tr>${headerHTML}</tr></thead>
      <tbody>${rowsHTML}</tbody>
    </table>
    ${truncated}
  </div>`;
}

// ============================================================
// MAIN TOOL ENTRY
// ============================================================

export async function sheets(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};

  const intent = context.action || detectSheetsIntent(text);
  console.log(`📊 [sheets] Intent: ${intent} | Text: "${text.slice(0, 80)}"`);

  try {
    const spreadsheetId = extractSheetId(text, context);

    if (!spreadsheetId) {
      return {
        tool: "sheets", success: false, final: true,
        data: {
          text: "❌ No Google Sheet ID found. Please provide a spreadsheet ID or URL.\n\n" +
            "**Usage:**\n" +
            '- "append to sheet 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"\n' +
            '- "read from https://docs.google.com/spreadsheets/d/YOUR_ID/edit"'
        },
      };
    }

    // ── APPEND ──
    if (intent === "append") {
      let rows = context.rows || null;

      // Try chain context first (from previous tool in pipeline, e.g., LLM categorization)
      if (!rows && context.chainContext?.previousOutput) {
        const prevOutput = String(context.chainContext.previousOutput);
        console.log(`📊 [sheets] Extracting rows from chain context (${prevOutput.length} chars)`);
        try {
          // Strip markdown code fences if present
          const cleaned = prevOutput.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
              rows = parsed.map(r => Array.isArray(r) ? r.map(String) : Object.values(r).map(String));
              console.log(`📊 [sheets] Extracted ${rows.length} rows from chain context`);
            }
          }
        } catch (e) {
          console.warn(`📊 [sheets] Failed to parse chain context as JSON: ${e.message}`);
        }
      }

      // Fallback: try to parse rows from text input
      if (!rows) {
        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
              rows = parsed.map(r => Array.isArray(r) ? r.map(String) : Object.values(r).map(String));
            }
          }
        } catch { /* not JSON, that's fine */ }
      }

      if (!rows || rows.length === 0) {
        return {
          tool: "sheets", success: false, final: true,
          data: { text: "❌ No data rows to append. Pass rows as context.rows (array of arrays) or as JSON in the text." },
        };
      }

      const range = extractRange(text, context);
      console.log(`📊 [sheets] Appending ${rows.length} rows to ${spreadsheetId} range ${range}`);

      const result = await batchAppend(spreadsheetId, range, rows);
      return {
        tool: "sheets", success: true, final: true,
        data: {
          text: formatAppendResult(result),
          plain: `📊 Appended ${result.updatedRows} rows (${result.updatedCells} cells) to ${result.updatedRange}`,
          raw: result,
        },
      };
    }

    // ── READ ──
    if (intent === "read") {
      const range = extractRange(text, context);
      console.log(`📊 [sheets] Reading ${spreadsheetId} range ${range}`);

      const result = await readSheet(spreadsheetId, range);
      return {
        tool: "sheets", success: true, final: true,
        data: {
          text: formatReadResult(result, spreadsheetId),
          plain: result.rows.map(r => r.join(" | ")).join("\n"),
          raw: result,
        },
      };
    }

    // ── CLEAR ──
    if (intent === "clear") {
      const range = extractRange(text, context);
      console.log(`📊 [sheets] Clearing ${spreadsheetId} range ${range}`);

      const result = await clearSheet(spreadsheetId, range);
      return {
        tool: "sheets", success: true, final: true,
        data: {
          text: `<p>📊 Cleared range: <code>${result.clearedRange}</code></p>`,
          plain: `📊 Cleared range: ${result.clearedRange}`,
          raw: result,
        },
      };
    }

    return { tool: "sheets", success: false, final: true, data: { text: `❌ Unknown sheets intent: ${intent}` } };

  } catch (err) {
    console.error("[sheets] Error:", err.message);
    return {
      tool: "sheets", success: false, final: true,
      data: { text: `❌ Google Sheets error: ${err.message}` },
    };
  }
}

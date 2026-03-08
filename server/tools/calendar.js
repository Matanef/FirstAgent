// server/tools/calendar.js
// Google Calendar integration — list events, create events, check availability,
// and extract data to Excel (bilingual: English + Hebrew)
// Uses existing Google OAuth infrastructure from googleOAuth.js

import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Get authorized Google Calendar service
 */
async function getCalendarService() {
  const auth = await getAuthorizedClient();
  return google.calendar({ version: "v3", auth });
}

/**
 * Detect calendar intent from natural language
 */
function detectCalendarIntent(query) {
  const lower = (query || "").toLowerCase();

  // Extract / Export to Excel — bilingual (English + Hebrew)
  if (/\b(extract|scan|export|excel|spreadsheet|xlsx)\b/i.test(lower) ||
      /(?:חלץ|ייצא|אקסל|סרוק|לאקסל|ייצוא)/u.test(query)) {
    return "extract";
  }
  if (/\b(create|add|schedule|set\s+up|book|make)\s+(an?\s+)?(event|meeting|appointment|reminder|block)\b/i.test(lower)) {
    return "create";
  }
  if (/\b(free|busy|available|availability|open\s+slot|free\s+time)\b/i.test(lower)) {
    return "freebusy";
  }
  if (/\b(delete|remove|cancel)\s+(the\s+)?(event|meeting|appointment)\b/i.test(lower)) {
    return "delete";
  }
  if (/\b(update|change|modify|move|reschedule)\s+(the\s+)?(event|meeting|appointment)\b/i.test(lower)) {
    return "update";
  }
  // Default: list events
  return "list";
}

/**
 * Parse date/time from natural language (basic patterns)
 */
function parseDateTimeHints(query) {
  const lower = (query || "").toLowerCase();
  const now = new Date();
  const hints = {};

  // "today", "tomorrow", "next Monday", etc.
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    hints.date = d.toISOString().split("T")[0];
  } else if (/\btoday\b/.test(lower)) {
    hints.date = now.toISOString().split("T")[0];
  } else if (/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower)) {
    // "next [day]" should ALWAYS be 7+ days away (next week's occurrence)
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const match = lower.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (match) {
      const targetDay = dayNames.indexOf(match[1].toLowerCase());
      const d = new Date(now);
      const daysUntil = ((targetDay - d.getDay()) + 7) % 7;
      // Always add 7 so "next Friday" on Wednesday = 9 days, not 2
      d.setDate(d.getDate() + daysUntil + 7);
      hints.date = d.toISOString().split("T")[0];
    }
  } else if (/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower)) {
    // "this [day]" = nearest future occurrence of that day (0-6 days)
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const match = lower.match(/this\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (match) {
      const targetDay = dayNames.indexOf(match[1].toLowerCase());
      const d = new Date(now);
      const daysUntil = ((targetDay - d.getDay()) + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntil);
      hints.date = d.toISOString().split("T")[0];
    }
  } else if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower) &&
             !/\b(next|this|last|every)\b/i.test(lower)) {
    // Bare day name (no "next"/"this"/"last" prefix) = nearest future occurrence
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const match = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (match) {
      const targetDay = dayNames.indexOf(match[1].toLowerCase());
      const d = new Date(now);
      const daysUntil = ((targetDay - d.getDay()) + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntil);
      hints.date = d.toISOString().split("T")[0];
    }
  } else if (/\bthis\s+week\b/.test(lower)) {
    hints.timeRange = "week";
  } else if (/\bnext\s+week\b/.test(lower)) {
    hints.timeRange = "next_week";
  }

  // Time: "at 3pm", "at 14:00", "from 2-4pm"
  const timeMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;
    hints.time = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  // Duration: "for 30 minutes", "for 1 hour", "1h"
  const durMatch = lower.match(/(?:for\s+)?(\d+)\s*(hour|hr|h|minute|min|m)\b/i);
  if (durMatch) {
    const val = parseInt(durMatch[1]);
    const unit = durMatch[2].toLowerCase();
    hints.durationMinutes = unit.startsWith("h") ? val * 60 : val;
  }

  // Title extraction: multi-pattern with priority order
  // 1. Explicit "called/titled/named" patterns
  const explicitTitle = query.match(/(?:called|titled|named)\s+["']?([^"'\n,]+?)["']?(?:\s+(?:at|on|from|tomorrow|today|next)|$)/i);
  if (explicitTitle) {
    hints.title = explicitTitle[1].trim();
    return hints;
  }

  // 2. Quoted text
  const quotedTitle = query.match(/"([^"]+)"/);
  if (quotedTitle) {
    hints.title = quotedTitle[1].trim();
    return hints;
  }

  // 3. "schedule/create/set up/book [a/an] TITLE [at/on/tomorrow...]"
  const actionTitle = query.match(
    /(?:schedule|create|add|set\s+up|book|make)\s+(?:a|an|the)?\s*(meeting|appointment|call|event|session|standup|sync|review|lunch|dinner|breakfast|interview|demo|presentation|check-?in|catch-?up|workshop|training|class|lesson|reminder|block)(?:\s+(?:with|for|about|regarding)\s+([^,\n]+?))?(?:\s+(?:at|on|from|tomorrow|today|next|for\s+\d)|$)/i
  );
  if (actionTitle) {
    let title = actionTitle[1];
    if (actionTitle[2]) title += ` with ${actionTitle[2].trim()}`;
    hints.title = title.charAt(0).toUpperCase() + title.slice(1);
    return hints;
  }

  // 4. "about/regarding TOPIC" patterns
  const aboutTitle = query.match(/(?:about|regarding|re:)\s+["']?([^"'\n,]+?)["']?(?:\s+(?:at|on|from|tomorrow|today|next)|$)/i);
  if (aboutTitle) {
    hints.title = aboutTitle[1].trim();
    return hints;
  }

  // 5. Extract noun phrase after create/schedule verbs as last resort
  const verbTitle = query.match(
    /(?:schedule|create|add|set\s+up|book)\s+(?:a|an)?\s*([a-zA-Z][a-zA-Z\s]{2,30}?)(?:\s+(?:at|on|from|for|tomorrow|today|next\s|in\s)|$)/i
  );
  if (verbTitle) {
    const candidate = verbTitle[1].trim();
    // Avoid extracting noise words
    const skipWords = new Set(["event", "new event", "something", "it", "one", "this"]);
    if (!skipWords.has(candidate.toLowerCase()) && candidate.length > 2) {
      hints.title = candidate.charAt(0).toUpperCase() + candidate.slice(1);
    }
  }

  return hints;
}

/**
 * List upcoming calendar events
 */
async function listEvents(query) {
  try {
    const calendar = await getCalendarService();
    const hints = parseDateTimeHints(query);

    let timeMin = new Date();
    let timeMax = new Date();

    if (hints.date) {
      timeMin = new Date(hints.date + "T00:00:00");
      timeMax = new Date(hints.date + "T23:59:59");
    } else if (hints.timeRange === "week") {
      timeMax.setDate(timeMax.getDate() + 7);
    } else if (hints.timeRange === "next_week") {
      const dayOfWeek = timeMin.getDay();
      const daysToNextMonday = ((8 - dayOfWeek) % 7) || 7;
      timeMin.setDate(timeMin.getDate() + daysToNextMonday);
      timeMax = new Date(timeMin);
      timeMax.setDate(timeMax.getDate() + 7);
    } else {
      // Default: next 7 days
      timeMax.setDate(timeMax.getDate() + 7);
    }

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = res.data.items || [];

    if (events.length === 0) {
      return {
        tool: "calendar",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: `No events found between ${timeMin.toLocaleDateString()} and ${timeMax.toLocaleDateString()}.`,
          events: [],
        },
      };
    }

    const lines = ["## Upcoming Events\n"];
    lines.push("| Date | Time | Event | Location |");
    lines.push("|------|------|-------|----------|");

    for (const ev of events) {
      const start = ev.start.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date);
      const dateStr = start.toLocaleDateString("en-GB", { weekday: "short", month: "short", day: "numeric" });
      const timeStr = ev.start.dateTime
        ? start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : "All day";
      const location = ev.location || "-";
      lines.push(`| ${dateStr} | ${timeStr} | ${ev.summary || "(No title)"} | ${location} |`);
    }

    return {
      tool: "calendar",
      success: true,
      final: true,
      data: {
        preformatted: true,
        text: lines.join("\n"),
        events: events.map(e => ({
          id: e.id,
          summary: e.summary,
          start: e.start,
          end: e.end,
          location: e.location,
        })),
      },
    };
  } catch (err) {
    return {
      tool: "calendar",
      success: false,
      error: `Calendar list failed: ${err.message}`,
    };
  }
}

/**
 * Create a new calendar event
 */
async function createEvent(query) {
  try {
    const calendar = await getCalendarService();
    const hints = parseDateTimeHints(query);

    const title = hints.title || "New Event";
    const date = hints.date || new Date().toISOString().split("T")[0];
    const time = hints.time || "09:00";
    const durationMinutes = hints.durationMinutes || 60;

    const startDate = new Date(`${date}T${time}:00`);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

    const event = {
      summary: title,
      start: { dateTime: startDate.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      end: { dateTime: endDate.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    };

    // Extract location if mentioned
    const locMatch = query.match(/(?:at|in|location:?)\s+["']?([^"',\n]+?)["']?(?:\s+(?:at|on|from|tomorrow)|$)/i);
    if (locMatch && !locMatch[1].match(/^\d/)) {
      event.location = locMatch[1].trim();
    }

    const res = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    return {
      tool: "calendar",
      success: true,
      final: true,
      data: {
        preformatted: true,
        text: `Event created successfully!\n\n**${res.data.summary}**\n- Date: ${startDate.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}\n- Time: ${startDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} - ${endDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}\n- Duration: ${durationMinutes} minutes${event.location ? `\n- Location: ${event.location}` : ""}\n- [Open in Calendar](${res.data.htmlLink})`,
        event: { id: res.data.id, summary: res.data.summary, start: res.data.start, end: res.data.end },
      },
    };
  } catch (err) {
    return {
      tool: "calendar",
      success: false,
      error: `Failed to create event: ${err.message}`,
    };
  }
}

/**
 * Check free/busy slots
 */
async function checkAvailability(query) {
  try {
    const calendar = await getCalendarService();
    const hints = parseDateTimeHints(query);

    let timeMin = new Date();
    let timeMax = new Date();

    if (hints.date) {
      timeMin = new Date(hints.date + "T00:00:00");
      timeMax = new Date(hints.date + "T23:59:59");
    } else {
      // Default: today
      timeMax.setHours(23, 59, 59);
    }

    const res = await calendar.freebusy.query({
      resource: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: "primary" }],
      },
    });

    const busySlots = res.data.calendars?.primary?.busy || [];
    const dateStr = timeMin.toLocaleDateString("en-GB", { weekday: "long", month: "long", day: "numeric" });

    if (busySlots.length === 0) {
      return {
        tool: "calendar",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: `You're completely free on **${dateStr}**!`,
          busy: [],
        },
      };
    }

    const lines = [`## Busy slots on ${dateStr}\n`];
    lines.push("| Start | End | Duration |");
    lines.push("|-------|-----|----------|");

    for (const slot of busySlots) {
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      const duration = Math.round((end - start) / (1000 * 60));
      lines.push(
        `| ${start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} | ${end.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} | ${duration} min |`
      );
    }

    return {
      tool: "calendar",
      success: true,
      final: true,
      data: {
        preformatted: true,
        text: lines.join("\n"),
        busy: busySlots,
      },
    };
  } catch (err) {
    return {
      tool: "calendar",
      success: false,
      error: `Availability check failed: ${err.message}`,
    };
  }
}

// ============================================================
// EXTRACT TO EXCEL — Bilingual (English + Hebrew)
// ============================================================

/**
 * Parse extraction filters from user query (bilingual)
 * Supports DD/MM/YYYY dates, city names, price filters
 */
function parseExtractFilters(query) {
  const filters = {};

  // Date range: DD/MM/YYYY to DD/MM/YYYY (Israeli/European format)
  // Also supports: DD.MM.YYYY, DD-MM-YYYY
  const dateRangeMatch = query.match(
    /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\s*(?:to|until|till|עד|ל|–|-)\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/
  );
  if (dateRangeMatch) {
    const [, d1, m1, y1, d2, m2, y2] = dateRangeMatch;
    filters.timeMin = new Date(parseInt(y1), parseInt(m1) - 1, parseInt(d1));
    filters.timeMax = new Date(parseInt(y2), parseInt(m2) - 1, parseInt(d2), 23, 59, 59);
  } else {
    // Single date: DD/MM/YYYY
    const singleDate = query.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
    if (singleDate) {
      const [, d, m, y] = singleDate;
      filters.timeMin = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
      filters.timeMax = new Date(parseInt(y), parseInt(m) - 1, parseInt(d), 23, 59, 59);
    } else {
      // Year range: "from 2021 to 2026", "2021-2026", "משנת 2021 עד 2026"
      const yearRange = query.match(/(?:from|since|משנת?|מ-?)\s*(\d{4})\s*(?:to|until|till|עד|ל|–|-)\s*(\d{4})/i);
      if (yearRange) {
        filters.timeMin = new Date(parseInt(yearRange[1]), 0, 1);
        filters.timeMax = new Date(parseInt(yearRange[2]), 11, 31, 23, 59, 59);
      } else {
        // Default: last 1 year
        filters.timeMax = new Date();
        filters.timeMin = new Date();
        filters.timeMin.setFullYear(filters.timeMin.getFullYear() - 1);
      }
    }
  }

  // City filter (English and Hebrew common city names)
  const cityMatch = query.match(
    /(?:in|from|city|עיר|ב-?|מ-?)\s*["']?([A-Za-z\u0590-\u05FF]{2,25})["']?/u
  );
  if (cityMatch) {
    const candidate = cityMatch[1].trim();
    // Exclude noise words
    const noise = new Set(["calendar", "events", "excel", "the", "my", "all", "from", "to", "extract", "scan", "export", "אקסל", "ייצא", "חלץ", "סרוק"]);
    if (!noise.has(candidate.toLowerCase())) {
      filters.city = candidate;
    }
  }

  // Price filter — bilingual
  // English: "price above 300", "more than 300", ">300", "under 500"
  // Hebrew: "מעל 300", "יותר מ-300", "מחיר מעל 300 שקל", "פחות מ-500"
  const priceAbove = query.match(
    /(?:price\s*(?:above|over|more\s*than|>=?|higher\s*than)|above|over|more\s*than|>\s*|מעל\s*|יותר\s*מ-?)\s*(\d+[\d,.]*)/iu
  );
  const priceBelow = query.match(
    /(?:price\s*(?:below|under|less\s*than|<=?|lower\s*than)|below|under|less\s*than|<\s*|מתחת\s*ל?-?|פחות\s*מ-?)\s*(\d+[\d,.]*)/iu
  );

  if (priceAbove) {
    filters.priceMin = parseFloat(priceAbove[1].replace(/,/g, ""));
  }
  if (priceBelow) {
    filters.priceMax = parseFloat(priceBelow[1].replace(/,/g, ""));
  }

  return filters;
}

/**
 * Fetch ALL events in a time range using pageToken pagination
 */
async function fetchAllEvents(calendar, timeMin, timeMax) {
  const allEvents = [];
  let pageToken = null;

  do {
    const params = {
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: 250, // Max per page
      singleEvents: true,
      orderBy: "startTime",
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await calendar.events.list(params);
    const items = res.data.items || [];
    allEvents.push(...items);
    pageToken = res.data.nextPageToken || null;

    console.log(`[calendar extract] Fetched page: ${items.length} events (total: ${allEvents.length})`);
  } while (pageToken);

  return allEvents;
}

/**
 * Extract structured data from a single calendar event using regex
 * Returns null if no phone number found (MANDATORY requirement)
 */
function mineEventData(event) {
  const summary = event.summary || "";
  const description = event.description || "";
  const location = event.location || "";
  const combined = `${summary}\n${description}\n${location}`;

  // ── PHONE NUMBER (MANDATORY — skip event if not found) ──
  // Israeli: 05X-XXXXXXX, 05XXXXXXXX, 972-5X-XXXXXXX, +972...
  // International: +XXX-XXX-XXXX, (XXX) XXX-XXXX
  const phoneRx = /(?:\+?972[\s.-]?|0)(?:5[0-9])[\s.-]?\d{3}[\s.-]?\d{4}|(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
  const phones = combined.match(phoneRx);
  if (!phones || phones.length === 0) return null; // MANDATORY: skip if no phone

  const phone = phones[0].trim();

  // ── NAME ──
  // Try to extract from summary (common pattern: "Meeting with John Smith")
  let name = "";
  const nameFromSummary = summary.match(
    /(?:with|meeting|call|w\/|עם|פגישה\s+עם)\s+([A-Za-z\u0590-\u05FF][A-Za-z\u0590-\u05FF\s.''-]{1,40})/iu
  );
  if (nameFromSummary) {
    name = nameFromSummary[1].trim();
  } else {
    // Fallback: use summary itself if it looks like a name (2-3 capitalized words)
    const possibleName = summary.match(/^([A-Z\u0590-\u05FF][a-z\u0590-\u05FF]+(?:\s+[A-Z\u0590-\u05FF][a-z\u0590-\u05FF]+){0,2})\b/u);
    if (possibleName) name = possibleName[1].trim();
  }

  // ── EMAIL ──
  const emailRx = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const emails = combined.match(emailRx);
  const email = emails ? emails[0] : "";

  // ── ADDRESS (from location field primarily) ──
  let city = "";
  let street = "";
  if (location) {
    // Try to split location into street + city
    const parts = location.split(/,\s*/);
    if (parts.length >= 2) {
      street = parts[0].trim();
      city = parts[parts.length > 2 ? parts.length - 2 : 1].trim();
    } else {
      city = location.trim();
    }
  }

  // Also scan description for addresses
  if (!city) {
    const cityInDesc = combined.match(
      /(?:city|עיר|location|מיקום|כתובת|address)[:\s]*["']?([A-Za-z\u0590-\u05FF][A-Za-z\u0590-\u05FF\s]{2,25})["']?/iu
    );
    if (cityInDesc) city = cityInDesc[1].trim();
  }

  // ── PRICE ──
  // Currency symbols: $, €, £, ₪
  // Hebrew keywords: שח, שקל, שקלים, מחיר, עלות
  // English keywords: price, cost, total, fee, rate
  let price = "";
  const pricePatterns = [
    // "$300", "€250", "£100", "₪500"
    /[$€£₪]\s*(\d[\d,.]+)/,
    // "300$", "250₪", "500 שח", "300 שקל", "300 שקלים", "300 ILS"
    /(\d[\d,.]+)\s*[$€£₪]|(\d[\d,.]+)\s*(?:שח|שקל(?:ים)?|ש"ח|ILS|NIS)\b/u,
    // "price: 300", "cost 500", "מחיר: 300", "עלות: 500", "fee: 200"
    /(?:price|cost|total|fee|rate|מחיר|עלות|תשלום|סכום)[:\s]*(\d[\d,.]+)/iu,
    // "300 dollars", "500 euros", "200 shekels"
    /(\d[\d,.]+)\s*(?:dollars?|euros?|pounds?|shekels?)/i,
  ];

  for (const rx of pricePatterns) {
    const m = combined.match(rx);
    if (m) {
      // Extract the first captured number
      price = (m[1] || m[2] || "").replace(/,/g, "");
      break;
    }
  }

  // ── EVENT DATE ──
  const startDt = event.start?.dateTime || event.start?.date || "";
  const eventDate = startDt ? new Date(startDt).toLocaleDateString("en-GB") : "";

  return { name, phone, email, city, street, price, eventDate, rawSummary: summary };
}

/**
 * Apply user filters (city, price) to extracted data
 */
function applyFilters(records, filters) {
  return records.filter(rec => {
    // City filter
    if (filters.city) {
      const filterCity = filters.city.toLowerCase();
      const recCity = (rec.city || "").toLowerCase();
      const recStreet = (rec.street || "").toLowerCase();
      if (!recCity.includes(filterCity) && !recStreet.includes(filterCity)) {
        return false;
      }
    }
    // Price filters
    if (filters.priceMin != null || filters.priceMax != null) {
      const p = parseFloat(rec.price);
      if (isNaN(p)) return false; // No price → drop if price filter active
      if (filters.priceMin != null && p < filters.priceMin) return false;
      if (filters.priceMax != null && p > filters.priceMax) return false;
    }
    return true;
  });
}

/**
 * Generate Excel file from extracted records
 */
function generateExcel(records) {
  // Map to clean column headers
  const rows = records.map(r => ({
    "Name": r.name || "",
    "Phone": r.phone || "",
    "Email": r.email || "",
    "City": r.city || "",
    "Street": r.street || "",
    "Price": r.price || "",
    "Event Date": r.eventDate || "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Auto-size columns
  const colWidths = Object.keys(rows[0] || {}).map(key => ({
    wch: Math.max(key.length, ...rows.map(r => String(r[key] || "").length)) + 2
  }));
  ws["!cols"] = colWidths;

  XLSX.utils.book_append_sheet(wb, ws, "Calendar Extract");

  // Save to downloads directory
  const downloadsDir = path.resolve(PROJECT_ROOT, "downloads");
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `Calendar_Extract_${timestamp}.xlsx`;
  const filePath = path.join(downloadsDir, filename);

  XLSX.writeFile(wb, filePath);
  console.log(`[calendar extract] Excel saved: ${filePath}`);

  return { filePath, filename, rowCount: rows.length };
}

/**
 * Main extraction pipeline
 */
async function extractCalendarData(query) {
  try {
    const calendarService = await getCalendarService();
    const filters = parseExtractFilters(query);

    console.log(`[calendar extract] Filters:`, JSON.stringify({
      timeMin: filters.timeMin?.toISOString(),
      timeMax: filters.timeMax?.toISOString(),
      city: filters.city,
      priceMin: filters.priceMin,
      priceMax: filters.priceMax,
    }));

    // 1. Fetch ALL events with pagination
    const allEvents = await fetchAllEvents(calendarService, filters.timeMin, filters.timeMax);
    console.log(`[calendar extract] Total events fetched: ${allEvents.length}`);

    if (allEvents.length === 0) {
      return {
        tool: "calendar",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: `No events found between ${filters.timeMin.toLocaleDateString("en-GB")} and ${filters.timeMax.toLocaleDateString("en-GB")}.`,
        },
      };
    }

    // 2. Mine data from each event (skip events without phone numbers)
    const extracted = [];
    let skippedNoPhone = 0;
    for (const ev of allEvents) {
      const record = mineEventData(ev);
      if (record) {
        extracted.push(record);
      } else {
        skippedNoPhone++;
      }
    }

    console.log(`[calendar extract] Extracted: ${extracted.length} records, skipped (no phone): ${skippedNoPhone}`);

    // 3. Apply user filters (city, price)
    const filtered = applyFilters(extracted, filters);
    console.log(`[calendar extract] After filters: ${filtered.length} records`);

    if (filtered.length === 0) {
      const filterDesc = [];
      if (filters.city) filterDesc.push(`city: "${filters.city}"`);
      if (filters.priceMin != null) filterDesc.push(`price ≥ ${filters.priceMin}`);
      if (filters.priceMax != null) filterDesc.push(`price ≤ ${filters.priceMax}`);

      return {
        tool: "calendar",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: `📊 **Calendar Data Extraction Complete**\n\n` +
            `- Events scanned: **${allEvents.length}**\n` +
            `- Events with phone numbers: **${extracted.length}**\n` +
            `- Matching filters${filterDesc.length ? ` (${filterDesc.join(", ")})` : ""}: **0**\n\n` +
            `No matching records found. Try adjusting your filters.`,
        },
      };
    }

    // 4. Generate Excel file
    const { filePath, filename, rowCount } = generateExcel(filtered);

    // 5. Build response
    const filterDesc = [];
    if (filters.city) filterDesc.push(`City: "${filters.city}"`);
    if (filters.priceMin != null) filterDesc.push(`Price ≥ ${filters.priceMin}`);
    if (filters.priceMax != null) filterDesc.push(`Price ≤ ${filters.priceMax}`);

    // Preview first 5 rows
    const previewRows = filtered.slice(0, 5).map((r, i) =>
      `| ${i + 1} | ${r.name || "-"} | ${r.phone} | ${r.city || "-"} | ${r.price || "-"} | ${r.eventDate} |`
    );

    const responseText =
      `📊 **Calendar Data Extraction Complete**\n\n` +
      `- Date range: **${filters.timeMin.toLocaleDateString("en-GB")}** to **${filters.timeMax.toLocaleDateString("en-GB")}**\n` +
      `- Events scanned: **${allEvents.length}**\n` +
      `- Events with phone numbers: **${extracted.length}**\n` +
      `- Skipped (no phone): **${skippedNoPhone}**\n` +
      (filterDesc.length ? `- Filters applied: ${filterDesc.join(", ")}\n` : "") +
      `- **Records exported: ${rowCount}**\n\n` +
      `| # | Name | Phone | City | Price | Date |\n` +
      `|---|------|-------|------|-------|------|\n` +
      previewRows.join("\n") +
      (filtered.length > 5 ? `\n| ... | *${filtered.length - 5} more rows* | | | | |\n` : "\n") +
      `\n📁 **File saved:** \`${filePath}\`\n` +
      `📄 Filename: **${filename}**`;

    return {
      tool: "calendar",
      success: true,
      final: true,
      data: {
        preformatted: true,
        text: responseText,
        filePath,
        filename,
        totalEvents: allEvents.length,
        extractedCount: extracted.length,
        exportedCount: rowCount,
        skippedNoPhone,
      },
    };
  } catch (err) {
    console.error("[calendar extract] Error:", err);
    return {
      tool: "calendar",
      success: false,
      error: `Calendar extraction failed: ${err.message}`,
    };
  }
}

/**
 * Main calendar tool entry point
 */
export async function calendar(query) {
  const input = typeof query === "object" ? query.text || query.input || "" : query;
  // Use planner's pre-detected action if available, otherwise detect from text
  const contextAction = typeof query === "object" ? query.context?.action : null;
  const intent = contextAction || detectCalendarIntent(input);

  console.log(`[calendar] Intent: ${intent}, Query: "${input}"`);

  switch (intent) {
    case "extract":
      return await extractCalendarData(input);
    case "create":
      return await createEvent(input);
    case "freebusy":
      return await checkAvailability(input);
    case "list":
    default:
      return await listEvents(input);
  }
}

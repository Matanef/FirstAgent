// server/tools/calendar.js
// Google Calendar integration — list events, create events, check availability
// Uses existing Google OAuth infrastructure from googleOAuth.js

import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";

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
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const match = lower.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
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

  // Title extraction: text after "called/titled/named" or between quotes
  const titleMatch = query.match(/(?:called|titled|named|about)\s+["']?([^"'\n,]+?)["']?(?:\s+(?:at|on|from|tomorrow|today|next)|$)/i) ||
                     query.match(/"([^"]+)"/);
  if (titleMatch) {
    hints.title = titleMatch[1].trim();
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
    case "create":
      return await createEvent(input);
    case "freebusy":
      return await checkAvailability(input);
    case "list":
    default:
      return await listEvents(input);
  }
}

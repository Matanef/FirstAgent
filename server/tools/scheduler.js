// server/tools/scheduler.js
// Schedule recurring and one-time tasks (cron-like)
// Persists schedules to server/data/schedules.json

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, "..", "data");
const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");

// In-memory timers
const activeTimers = new Map();

// ── Notification system ──
const notifications = [];
const MAX_NOTIFICATIONS = 50;

export function addNotification(notif) {
  notifications.unshift(notif);
  if (notifications.length > MAX_NOTIFICATIONS) notifications.pop();
}

export function getNotifications() { return [...notifications]; }
export function clearNotifications() { notifications.length = 0; }

// ──────────────────────────────────────────────────────────
// PERSISTENCE
// ──────────────────────────────────────────────────────────

function loadSchedules() {
  try {
    if (fsSync.existsSync(SCHEDULES_FILE)) {
      return JSON.parse(fsSync.readFileSync(SCHEDULES_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("[scheduler] Could not load schedules:", e.message);
  }
  return [];
}

async function saveSchedules(schedules) {
  try {
    if (!fsSync.existsSync(DATA_DIR)) {
      await fs.mkdir(DATA_DIR, { recursive: true });
    }
    // Write to a temporary file first, then rename (prevents file corruption on crash)
    const tempPath = SCHEDULES_FILE + ".tmp";
    await fs.writeFile(tempPath, JSON.stringify(schedules, null, 2), "utf8");
    await fs.rename(tempPath, SCHEDULES_FILE);
  } catch (err) {
    console.error("[scheduler] Persistence error:", err.message);
  }
}

// ──────────────────────────────────────────────────────────
// TIME PARSING
// ──────────────────────────────────────────────────────────

/**
 * Parse natural language time/frequency into a schedule object
 */
function parseSchedule(text) {
  const lower = text.toLowerCase();

  // "every X minutes/hours/days"
  const everyMatch = lower.match(/every\s+(\d+)\s*(minute|min|hour|hr|day|second|sec)s?/);
  if (everyMatch) {
    const amount = parseInt(everyMatch[1]);
    const unit = everyMatch[2];
    let intervalMs;
    if (unit.startsWith("sec")) intervalMs = amount * 1000;
    else if (unit.startsWith("min")) intervalMs = amount * 60 * 1000;
    else if (unit.startsWith("hour") || unit.startsWith("hr")) intervalMs = amount * 3600 * 1000;
    else if (unit.startsWith("day")) intervalMs = amount * 86400 * 1000;
    return { type: "interval", intervalMs, description: `every ${amount} ${unit}(s)` };
  }

// 1. SPECIFIC TIME (The highest priority)
  const atMatch = lower.match(/at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
  if (atMatch) {
    let hour = parseInt(atMatch[1]);
    const minute = parseInt(atMatch[2] || "0");
    const ampm = atMatch[3];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return { type: "daily", hour, minute, description: `daily at ${hour}:${String(minute).padStart(2, "0")}` };
  }

  // 2. SPECIFIC DELAY (Secondary priority)
  const inMatch = lower.match(/in\s+(\d+)\s*(minute|min|hour|hr|second|sec|day)s?/);
  if (inMatch) {
    const amount = parseInt(inMatch[1]);
    const unit = inMatch[2];
    let delayMs;
    if (unit.startsWith("sec")) delayMs = amount * 1000;
    else if (unit.startsWith("min")) delayMs = amount * 60 * 1000;
    else if (unit.startsWith("hour") || unit.startsWith("hr")) delayMs = amount * 3600 * 1000;
    else if (unit.startsWith("day")) delayMs = amount * 86400 * 1000;
    const runAt = new Date(Date.now() + delayMs);
    return { type: "once", runAt: runAt.toISOString(), delayMs, description: `in ${amount} ${unit}(s)` };
  }

  // 3. GENERIC KEYWORDS (The fallbacks)
  if (/every\s+morning/i.test(lower)) {
    return { type: "daily", hour: 8, minute: 0, description: "every morning at 8:00 AM" };
  }
  if (/every\s+evening/i.test(lower)) {
    return { type: "daily", hour: 18, minute: 0, description: "every evening at 6:00 PM" };
  }
  if (/every\s+night/i.test(lower)) {
    return { type: "daily", hour: 21, minute: 0, description: "every night at 9:00 PM" };
  }

  // "daily" with no specific time
  if (/\bdaily\b/.test(lower)) {
    return { type: "daily", hour: 9, minute: 0, description: "daily at 9:00 AM" };
  }

  // "hourly"
  if (/\bhourly\b/.test(lower)) {
    return { type: "interval", intervalMs: 3600 * 1000, description: "every hour" };
  }

  // "weekly"
  if (/\bweekly\b/.test(lower)) {
    return { type: "interval", intervalMs: 7 * 86400 * 1000, description: "weekly" };
  }

  return null;
}

/**
 * Extract the task/action from the scheduling request
 */
function extractTask(text) {
  const lower = text.toLowerCase();

  // "schedule X every Y" / "remind me to X every Y"
  let match = text.match(/(?:schedule|set up|create)\s+(?:a\s+)?(.+?)\s+(?:every|at|in\s+\d|daily|hourly|weekly)/i);
  if (match) return match[1].trim();

  match = text.match(/(?:remind\s+me\s+to|remind\s+me\s+about)\s+(.+?)\s+(?:every|at|in\s+\d|daily|hourly|weekly)/i);
  if (match) return match[1].trim();

  // "every X do Y"
  match = text.match(/(?:every\s+\w+(?:\s+\w+)?)\s+(?:do|run|execute|check|get|show|fetch)\s+(.+)/i);
  if (match) return match[1].trim();

  // Fallback: remove schedule-related words
  let task = text
    .replace(/^(schedule|set up|create|remind me to|remind me about)\s*/i, "")
    .replace(/\s*(every\s+\d+\s*\w+|at\s+\d+[:\d]*\s*(am|pm)?|in\s+\d+\s*\w+|daily|hourly|weekly)\s*/gi, "")
    .trim();

  return task || text;
}

/**
 * Detect intent from scheduling text
 */
function detectSchedulerIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(list|show|view|my)\s*(schedule|scheduled|recurring|timer)/i.test(lower)) return "list";
  if (/\b(cancel|stop|remove|delete|clear)\s*(schedule|timer|recurring|all)/i.test(lower)) return "cancel";
  if (/\b(pause|disable)\s*(schedule|timer)/i.test(lower)) return "pause";
  if (/\b(resume|enable|unpause)\s*(schedule|timer)/i.test(lower)) return "resume";
  return "create";
}

// ──────────────────────────────────────────────────────────
// SCHEDULE EXECUTION (in-process timer)
// ──────────────────────────────────────────────────────────

/**
 * Execute a scheduled task by running it through the agent pipeline.
 * Uses dynamic imports to avoid circular dependencies.
 */
async function executeScheduledTask(schedule) {
  console.log(`\n⏰ [scheduler] Executing task: "${schedule.task}"`);
  try {
    const { executeAgent } = await import("../utils/coordinator.js");

    const results = await executeAgent({ message: schedule.task });

    // Update metadata safely
    try {
      const schedules = loadSchedules();
      const idx = schedules.findIndex(s => s.id === schedule.id);
      if (idx !== -1) {
        schedules[idx].lastRun = new Date().toISOString();
        schedules[idx].runCount = (schedules[idx].runCount || 0) + 1;
        await saveSchedules(schedules); // Use the async version we'll define below
      }
    } catch (dbErr) {
      console.error("[scheduler] Failed to update schedule metadata:", dbErr.message);
    }

    console.log(`✅ [scheduler] Task "${schedule.task}" completed.`);

    // ── Notification: in-app + WhatsApp ──
    const notif = {
      type: "scheduled_task_complete",
      taskId: schedule.id,
      taskName: schedule.task,
      result: "success",
      timestamp: new Date().toISOString()
    };
    addNotification(notif);

    // Send WhatsApp notification if configured
    try {
      const { CONFIG } = await import("../utils/config.js");
      const recipient = CONFIG.WHATSAPP_DEFAULT_RECIPIENT;
      if (recipient && process.env.WHATSAPP_TOKEN) {
        const { sendWhatsAppMessage } = await import("./whatsapp.js");
        const summary = `⏰ *Scheduled Task Complete*\n\n📋 ${schedule.task}\n✅ Status: Success\n🕐 ${new Date().toLocaleTimeString()}`;
        await sendWhatsAppMessage(recipient, summary);
      }
    } catch (waErr) {
      console.warn("[scheduler] WhatsApp notification failed:", waErr.message);
    }

    return results;
  } catch (err) {
    // THIS IS THE CRITICAL PART: Catch everything so the server stays alive
    console.error(`❌ [scheduler] FATAL TASK ERROR ("${schedule.task}"):`, err.message);
    console.error(err.stack);

    // Notification for failure
    addNotification({
      type: "scheduled_task_complete",
      taskId: schedule.id,
      taskName: schedule.task,
      result: "failed",
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
}

function startTimer(schedule) {
  if (activeTimers.has(schedule.id)) {
    clearTimeout(activeTimers.get(schedule.id));
    clearInterval(activeTimers.get(schedule.id));
  }

  if (schedule.type === "once") {
    const delay = new Date(schedule.runAt).getTime() - Date.now();
    if (delay > 0) {
      const timer = setTimeout(async () => {
        await executeScheduledTask(schedule);
        activeTimers.delete(schedule.id);
      }, delay);
      activeTimers.set(schedule.id, timer);
      console.log(`[scheduler] One-time task "${schedule.task}" fires in ${Math.round(delay / 1000)}s`);
    }

  } else if (schedule.type === "interval") {
    const timer = setInterval(async () => {
      await executeScheduledTask(schedule);
    }, schedule.intervalMs);
    activeTimers.set(schedule.id, timer);
    console.log(`[scheduler] Interval task "${schedule.task}" every ${Math.round(schedule.intervalMs / 60000)} min`);

  } else if (schedule.type === "daily") {
    // Calculate milliseconds until next firing time
    const now = new Date();
    const next = new Date(now);
    next.setHours(schedule.hour || 0, schedule.minute || 0, 0, 0);
    // If we already passed today's time, schedule for tomorrow
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();

    console.log(`[scheduler] Daily task "${schedule.task}" next run at ${next.toLocaleTimeString()} (in ${Math.round(delay / 60000)} min)`);

    const timer = setTimeout(async () => {
      await executeScheduledTask(schedule);
      // Re-schedule for next day (recursive)
      startTimer(schedule);
    }, delay);
    activeTimers.set(schedule.id, timer);
  }
}

// ──────────────────────────────────────────────────────────
// HANDLERS
// ──────────────────────────────────────────────────────────

function handleCreate(text) {
  const schedule = parseSchedule(text);
  if (!schedule) {
    return {
      tool: "scheduler", success: false, final: true,
      data: {
        text: "I couldn't understand the scheduling request. Please specify a time or frequency.\n\n**Examples:**\n" +
          "- \"Schedule weather check every 30 minutes\"\n" +
          "- \"Remind me to check emails at 9am daily\"\n" +
          "- \"Schedule news update every morning\"\n" +
          "- \"Remind me to stand up in 45 minutes\"\n" +
          "- \"Schedule moltbook heartbeat every 30 minutes\"",
        action: "create"
      }
    };
  }

  const task = extractTask(text);

  const schedules = loadSchedules();
  const newSchedule = {
    id: `sched_${Date.now()}`,
    task,
    ...schedule,
    status: "active",
    createdAt: new Date().toISOString(),
    lastRun: null,
    runCount: 0
  };

  schedules.push(newSchedule);
  // Save synchronously to avoid race
  if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });
  fsSync.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf8");

  // Start the timer
  startTimer(newSchedule);

  return {
    tool: "scheduler", success: true, final: true,
    data: {
      preformatted: true,
      text: `**Schedule Created**\n\n` +
        `**Task:** ${task}\n` +
        `**Frequency:** ${schedule.description}\n` +
        `**ID:** ${newSchedule.id}\n` +
        `**Status:** Active\n\n` +
        `Note: Schedules persist across restarts. Use "list schedules" to see all active schedules.`,
      action: "create",
      schedule: newSchedule
    }
  };
}

function handleList() {
  const schedules = loadSchedules();
  const active = schedules.filter(s => s.status === "active");
  const paused = schedules.filter(s => s.status === "paused");

  if (schedules.length === 0) {
    return {
      tool: "scheduler", success: true, final: true,
      data: {
        preformatted: true,
        text: "**No scheduled tasks.**\n\nCreate one with: \"Schedule [task] every [frequency]\"",
        action: "list", schedules: []
      }
    };
  }

  let output = `**Scheduled Tasks (${schedules.length} total)**\n\n`;

  if (active.length > 0) {
    output += `**Active (${active.length}):**\n`;
    for (const s of active) {
      output += `- **${s.task}** -- ${s.description} (ID: ${s.id})\n`;
      if (s.lastRun) output += `  Last run: ${new Date(s.lastRun).toLocaleString()} | Runs: ${s.runCount || 0}\n`;
    }
  }

  if (paused.length > 0) {
    output += `\n**Paused (${paused.length}):**\n`;
    for (const s of paused) {
      output += `- **${s.task}** -- ${s.description} (ID: ${s.id})\n`;
    }
  }

  return {
    tool: "scheduler", success: true, final: true,
    data: { preformatted: true, text: output.trim(), action: "list", schedules }
  };
}

function handleCancel(text) {
  const schedules = loadSchedules();

  if (/\ball\b/i.test(text)) {
    // Cancel all
    for (const s of schedules) {
      if (activeTimers.has(s.id)) {
        clearTimeout(activeTimers.get(s.id));
        clearInterval(activeTimers.get(s.id));
        activeTimers.delete(s.id);
      }
    }
    fsSync.writeFileSync(SCHEDULES_FILE, "[]", "utf8");
    return { tool: "scheduler", success: true, final: true, data: { preformatted: true, text: `Cancelled all ${schedules.length} scheduled tasks.`, action: "cancel" } };
  }

  // Find by ID or task name
  const idMatch = text.match(/sched_\d+/);
  const id = idMatch ? idMatch[0] : null;

  let idx = -1;
  if (id) {
    idx = schedules.findIndex(s => s.id === id);
  } else {
    // Try fuzzy match on task
    const lower = text.toLowerCase().replace(/cancel|stop|remove|delete|schedule|timer/gi, "").trim();
    idx = schedules.findIndex(s => s.task.toLowerCase().includes(lower));
  }

  if (idx === -1) {
    return { tool: "scheduler", success: false, final: true, data: { text: "Could not find that schedule. Use \"list schedules\" to see all.", action: "cancel" } };
  }

  const removed = schedules.splice(idx, 1)[0];
  if (activeTimers.has(removed.id)) {
    clearTimeout(activeTimers.get(removed.id));
    clearInterval(activeTimers.get(removed.id));
    activeTimers.delete(removed.id);
  }

  fsSync.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf8");

  return { tool: "scheduler", success: true, final: true, data: { preformatted: true, text: `Cancelled schedule: **${removed.task}** (${removed.description})`, action: "cancel" } };
}

function handlePause(text) {
  const schedules = loadSchedules();
  const idMatch = text.match(/sched_\d+/);
  const id = idMatch ? idMatch[0] : null;

  let schedule;
  if (id) {
    schedule = schedules.find(s => s.id === id);
  } else {
    const lower = text.toLowerCase().replace(/pause|disable|schedule|timer/gi, "").trim();
    schedule = schedules.find(s => s.task.toLowerCase().includes(lower));
  }

  if (!schedule) {
    return { tool: "scheduler", success: false, final: true, data: { text: "Could not find that schedule.", action: "pause" } };
  }

  schedule.status = "paused";
  if (activeTimers.has(schedule.id)) {
    clearTimeout(activeTimers.get(schedule.id));
    clearInterval(activeTimers.get(schedule.id));
    activeTimers.delete(schedule.id);
  }

  fsSync.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf8");
  return { tool: "scheduler", success: true, final: true, data: { preformatted: true, text: `Paused schedule: **${schedule.task}**`, action: "pause" } };
}

function handleResume(text) {
  const schedules = loadSchedules();
  const idMatch = text.match(/sched_\d+/);
  const id = idMatch ? idMatch[0] : null;

  let schedule;
  if (id) {
    schedule = schedules.find(s => s.id === id);
  } else {
    const lower = text.toLowerCase().replace(/resume|enable|unpause|schedule|timer/gi, "").trim();
    schedule = schedules.find(s => s.task.toLowerCase().includes(lower));
  }

  if (!schedule) {
    return { tool: "scheduler", success: false, final: true, data: { text: "Could not find that schedule.", action: "resume" } };
  }

  schedule.status = "active";
  startTimer(schedule);

  fsSync.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf8");
  return { tool: "scheduler", success: true, final: true, data: { preformatted: true, text: `Resumed schedule: **${schedule.task}** (${schedule.description})`, action: "resume" } };
}

// ──────────────────────────────────────────────────────────
// MAIN TOOL
// ──────────────────────────────────────────────────────────

export async function scheduler(query) {
  const text = typeof query === "string" ? query : (query?.text || query?.input || "");
  const context = typeof query === "object" ? (query?.context || {}) : {};

  try {
    const intent = context.action || detectSchedulerIntent(text);

    console.log(`[scheduler] Intent: ${intent}`);

    switch (intent) {
      case "list":   return handleList();
      case "cancel": return handleCancel(text);
      case "pause":  return handlePause(text);
      case "resume": return handleResume(text);
      default:       return handleCreate(text);
    }
  } catch (err) {
    console.error("[scheduler] Error:", err);
    return {
      tool: "scheduler", success: false, final: true,
      error: `Scheduler error: ${err.message}`
    };
  }
}

// ──────────────────────────────────────────────────────────
// AUTO-BOOTSTRAP: Restart active schedules on server startup
// ──────────────────────────────────────────────────────────

function bootstrapSchedules() {
  try {
    const schedules = loadSchedules();
    const active = schedules.filter(s => s.status === "active");
    if (active.length > 0) {
      console.log(`\n⏰ [scheduler] Bootstrapping ${active.length} active schedule(s)...`);
      active.forEach(s => {
        console.log(`   → ${s.task} (${s.type}${s.type === "daily" ? ` at ${String(s.hour || 0).padStart(2, "0")}:${String(s.minute || 0).padStart(2, "0")}` : ""})`);
        startTimer(s);
      });
    }
  } catch (err) {
    console.error("[scheduler] Bootstrap error:", err.message);
  }
}

// Delay bootstrap to let other modules initialize
setTimeout(bootstrapSchedules, 3000);

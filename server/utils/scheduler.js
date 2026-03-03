// server/utils/scheduler.js
// Cron-like time-based automation — schedule recurring tool actions
// Stores scheduled tasks in server/data/scheduled.json

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEDULE_FILE = path.resolve(__dirname, "..", "data", "scheduled.json");
const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

let _tasks = [];
let _intervalId = null;
let _toolExecutor = null; // Set via init()

// ============================================================
// PERSISTENCE
// ============================================================

function ensureDataDir() {
  const dir = path.dirname(SCHEDULE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadTasks() {
  try {
    ensureDataDir();
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    const raw = fs.readFileSync(SCHEDULE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  ensureDataDir();
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(tasks, null, 2), "utf8");
}

// ============================================================
// CRON PARSING (simplified subset)
// Supports: "every X minutes", "every X hours", "daily at HH:MM",
// "weekly on DAY at HH:MM", "every DAY at HH:MM"
// ============================================================

const DAY_MAP = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Parse a natural language schedule string into a schedule object
 */
export function parseSchedule(text) {
  const lower = (text || "").toLowerCase().trim();

  // "every X minutes"
  const minMatch = lower.match(/every\s+(\d+)\s*min/);
  if (minMatch) {
    return { type: "interval", intervalMinutes: parseInt(minMatch[1]) };
  }

  // "every X hours"
  const hourMatch = lower.match(/every\s+(\d+)\s*hour/);
  if (hourMatch) {
    return { type: "interval", intervalMinutes: parseInt(hourMatch[1]) * 60 };
  }

  // "daily at HH:MM" or "every day at HH:MM"
  const dailyMatch = lower.match(/(?:daily|every\s+day)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (dailyMatch) {
    let h = parseInt(dailyMatch[1]);
    const m = dailyMatch[2] ? parseInt(dailyMatch[2]) : 0;
    if (dailyMatch[3] === "pm" && h < 12) h += 12;
    if (dailyMatch[3] === "am" && h === 12) h = 0;
    return { type: "daily", hour: h, minute: m };
  }

  // "weekly on Monday at HH:MM" or "every Monday at HH:MM"
  const weeklyMatch = lower.match(/(?:weekly\s+on|every)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (weeklyMatch) {
    const dayOfWeek = DAY_MAP[weeklyMatch[1]];
    let h = parseInt(weeklyMatch[2]);
    const m = weeklyMatch[3] ? parseInt(weeklyMatch[3]) : 0;
    if (weeklyMatch[4] === "pm" && h < 12) h += 12;
    if (weeklyMatch[4] === "am" && h === 12) h = 0;
    return { type: "weekly", dayOfWeek, hour: h, minute: m };
  }

  return null;
}

/**
 * Check if a task should run now based on its schedule
 */
function shouldRunNow(task) {
  const now = new Date();
  const schedule = task.schedule;
  const lastRun = task.lastRun ? new Date(task.lastRun) : null;

  switch (schedule.type) {
    case "interval": {
      if (!lastRun) return true;
      const elapsed = (now - lastRun) / (1000 * 60);
      return elapsed >= schedule.intervalMinutes;
    }
    case "daily": {
      if (now.getHours() !== schedule.hour || now.getMinutes() !== schedule.minute) return false;
      if (lastRun && lastRun.toDateString() === now.toDateString()) return false;
      return true;
    }
    case "weekly": {
      if (now.getDay() !== schedule.dayOfWeek) return false;
      if (now.getHours() !== schedule.hour || now.getMinutes() !== schedule.minute) return false;
      if (lastRun) {
        const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
        if (daysSinceLastRun < 1) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

// ============================================================
// TASK MANAGEMENT
// ============================================================

/**
 * Add a scheduled task
 * @param {Object} options
 * @param {string} options.name - Human-readable name
 * @param {string} options.scheduleText - Natural language schedule ("every 30 minutes", "daily at 9am")
 * @param {string} options.tool - Tool to execute
 * @param {string} options.input - Input to pass to the tool
 * @param {Object} options.context - Optional context
 * @returns {Object} The created task
 */
export function addTask({ name, scheduleText, tool, input, context = {} }) {
  const schedule = parseSchedule(scheduleText);
  if (!schedule) {
    return { success: false, error: `Could not parse schedule: "${scheduleText}"` };
  }

  const task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    schedule,
    scheduleText,
    tool,
    input,
    context,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    runCount: 0,
  };

  _tasks.push(task);
  saveTasks(_tasks);

  console.log(`[scheduler] Task added: "${name}" (${scheduleText}) → ${tool}`);
  return { success: true, task };
}

/**
 * Remove a scheduled task by ID or name
 */
export function removeTask(idOrName) {
  const lower = (idOrName || "").toLowerCase();
  const idx = _tasks.findIndex(
    t => t.id === idOrName || t.name.toLowerCase() === lower
  );

  if (idx === -1) {
    return { success: false, error: `Task not found: "${idOrName}"` };
  }

  const removed = _tasks.splice(idx, 1)[0];
  saveTasks(_tasks);
  console.log(`[scheduler] Task removed: "${removed.name}"`);
  return { success: true, removed };
}

/**
 * Enable/disable a task
 */
export function toggleTask(idOrName, enabled) {
  const lower = (idOrName || "").toLowerCase();
  const task = _tasks.find(
    t => t.id === idOrName || t.name.toLowerCase() === lower
  );
  if (!task) return { success: false, error: `Task not found: "${idOrName}"` };

  task.enabled = enabled;
  saveTasks(_tasks);
  return { success: true, task };
}

/**
 * List all scheduled tasks
 */
export function listTasks() {
  return _tasks.map(t => ({
    id: t.id,
    name: t.name,
    schedule: t.scheduleText,
    tool: t.tool,
    enabled: t.enabled,
    lastRun: t.lastRun,
    runCount: t.runCount,
  }));
}

// ============================================================
// EXECUTION LOOP
// ============================================================

async function checkAndRunTasks() {
  if (!_toolExecutor) return;

  for (const task of _tasks) {
    if (!task.enabled) continue;

    if (shouldRunNow(task)) {
      console.log(`[scheduler] Running task: "${task.name}" (${task.tool})`);
      try {
        const result = await _toolExecutor(task.tool, task.input, task.context);
        task.lastRun = new Date().toISOString();
        task.runCount++;
        task.lastResult = {
          success: result?.success ?? true,
          summary: (result?.data?.text || result?.output || "").slice(0, 200),
        };
        console.log(`[scheduler] Task "${task.name}" completed (run #${task.runCount})`);
      } catch (err) {
        console.error(`[scheduler] Task "${task.name}" failed:`, err.message);
        task.lastRun = new Date().toISOString();
        task.lastResult = { success: false, error: err.message };
      }
      saveTasks(_tasks);
    }
  }
}

/**
 * Initialize the scheduler
 * @param {Function} toolExecutor - Function(tool, input, context) that executes a tool
 */
export function initScheduler(toolExecutor) {
  _toolExecutor = toolExecutor;
  _tasks = loadTasks();

  if (_intervalId) clearInterval(_intervalId);
  _intervalId = setInterval(checkAndRunTasks, CHECK_INTERVAL_MS);

  console.log(`[scheduler] Initialized with ${_tasks.length} task(s), checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

/**
 * Stop the scheduler
 */
export function stopScheduler() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  console.log("[scheduler] Stopped");
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  return {
    running: !!_intervalId,
    taskCount: _tasks.length,
    enabledCount: _tasks.filter(t => t.enabled).length,
    tasks: listTasks(),
  };
}

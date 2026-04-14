// server/routes/dashboard.js
// Agent Dashboard — system health, memory stats, tool usage, routing info

import express from "express";
import { getMemory, MEMORY_FILE } from "../memory.js";
import { getConversationStats } from "../utils/conversationMemory.js";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ── In-memory tool call log (last 50 calls) ──
const _toolCallLog = [];
const MAX_LOG_ENTRIES = 50;

/**
 * Log a tool call — called from executor.js
 */
export function logToolCall(toolName, success, durationMs, input) {
  _toolCallLog.push({
    tool: toolName,
    success,
    durationMs: Math.round(durationMs),
    input: (input || "").slice(0, 100),
    timestamp: new Date().toISOString()
  });
  if (_toolCallLog.length > MAX_LOG_ENTRIES) {
    _toolCallLog.splice(0, _toolCallLog.length - MAX_LOG_ENTRIES);
  }
}

// ── In-memory routing match log (last 30 decisions) ──
const _routingLog = [];
const MAX_ROUTING_LOG = 30;

/**
 * Log a routing decision — called from planner.js
 */
export function logRoutingDecision(input, tool, priority, reasoning) {
  _routingLog.push({
    input: (input || "").slice(0, 100),
    tool,
    priority,
    reasoning,
    timestamp: new Date().toISOString()
  });
  if (_routingLog.length > MAX_ROUTING_LOG) {
    _routingLog.splice(0, _routingLog.length - MAX_ROUTING_LOG);
  }
}

const _serverStartTime = Date.now();

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

// ============================================================
// JSON DASHBOARD ENDPOINT
// ============================================================
router.get("/api/dashboard", async (req, res) => {
  try {
    const memory = await getMemory();
    const convoStats = await getConversationStats();

    // Memory file size
    let fileSizeKB = 0;
    try {
      const stat = fsSync.statSync(MEMORY_FILE);
      fileSizeKB = Math.round(stat.size / 1024);
    } catch {}

    // Backup info
    let lastBackup = null;
    try {
      const dir = path.dirname(MEMORY_FILE);
      const base = path.basename(MEMORY_FILE);
      const files = fsSync.readdirSync(dir).filter(f => f.startsWith(base) && f.includes(".bak.1"));
      if (files.length > 0) {
        const stat = fsSync.statSync(path.join(dir, files[0]));
        lastBackup = stat.mtime.toISOString();
      }
    } catch {}

    // Tool registry info
    let registeredTools = [];
    try {
      const toolsDir = path.resolve(__dirname, "..", "tools");
      registeredTools = fsSync.readdirSync(toolsDir)
        .filter(f => f.endsWith(".js"))
        .map(f => f.replace(".js", ""));
    } catch {}

    // Scheduler info — schedules live at server/data/schedules.json (written by tools/scheduler.js)
    // and use `status: "active" | "paused"`, not `enabled`.
    let schedulerInfo = { activeTasks: 0, nextFire: null };
    try {
      const schedulerPath = path.resolve(__dirname, "..", "data", "schedules.json");
      if (fsSync.existsSync(schedulerPath)) {
        const schedules = JSON.parse(fsSync.readFileSync(schedulerPath, "utf8"));
        const active = Array.isArray(schedules)
          ? schedules.filter(s => (s.status || "active") === "active")
          : [];
        schedulerInfo.activeTasks = active.length;
      }
    } catch {}

    const dashboard = {
      uptime: formatUptime(Date.now() - _serverStartTime),
      uptimeMs: Date.now() - _serverStartTime,
      serverStartedAt: new Date(_serverStartTime).toISOString(),
      memory: {
        conversations: Object.keys(memory.conversations || {}).length,
        totalMessages: Object.values(memory.conversations || {}).reduce(
          (sum, conv) => sum + (Array.isArray(conv) ? conv.length : 0), 0
        ),
        profileKeys: Object.keys(memory.profile || {}).length,
        durableItems: Array.isArray(memory.durable) ? memory.durable.length : 0,
        fileSizeKB,
        lastBackup,
        conversationSummaries: convoStats.totalSummarized,
        recentTopics: convoStats.recentTopics
      },
      tools: {
        registered: registeredTools,
        totalCount: registeredTools.length,
        recentCalls: _toolCallLog.slice(-10).reverse()
      },
      routing: {
        recentDecisions: _routingLog.slice(-10).reverse()
      },
      scheduler: schedulerInfo
    };

    res.json(dashboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HTML DASHBOARD PAGE
// ============================================================
router.get("/dashboard", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lanou Agent Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e4e4e7; padding: 24px; }
    h1 { font-size: 1.8rem; margin-bottom: 16px; color: #a78bfa; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1a1b26; border-radius: 12px; padding: 20px; border: 1px solid #2a2b36; }
    .card h2 { font-size: 1rem; color: #818cf8; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #2a2b36; }
    .stat:last-child { border-bottom: none; }
    .stat .label { color: #a1a1aa; }
    .stat .value { color: #f4f4f5; font-weight: 600; }
    .log-entry { font-size: 0.85rem; padding: 6px 8px; background: #12131d; border-radius: 6px; margin-bottom: 4px; display: flex; justify-content: space-between; }
    .log-entry .tool { color: #34d399; font-weight: 600; }
    .log-entry .time { color: #71717a; font-size: 0.75rem; }
    .log-entry.fail .tool { color: #f87171; }
    .refresh { color: #71717a; font-size: 0.8rem; margin-top: 16px; text-align: center; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge.ok { background: #064e3b; color: #34d399; }
    .badge.warn { background: #78350f; color: #fbbf24; }
  </style>
</head>
<body>
  <h1>Lanou Agent Dashboard</h1>
  <div id="content">Loading...</div>
  <div class="refresh">Auto-refreshes every 15 seconds</div>

  <script>
    async function load() {
      try {
        const r = await fetch('/api/dashboard');
        const d = await r.json();
        document.getElementById('content').innerHTML = \`
          <div class="grid">
            <div class="card">
              <h2>System</h2>
              <div class="stat"><span class="label">Uptime</span><span class="value">\${d.uptime}</span></div>
              <div class="stat"><span class="label">Started</span><span class="value">\${new Date(d.serverStartedAt).toLocaleString()}</span></div>
              <div class="stat"><span class="label">Tools Registered</span><span class="value">\${d.tools.totalCount}</span></div>
              <div class="stat"><span class="label">Scheduled Tasks</span><span class="value">\${d.scheduler.activeTasks}</span></div>
            </div>

            <div class="card">
              <h2>Memory</h2>
              <div class="stat"><span class="label">Conversations</span><span class="value">\${d.memory.conversations}</span></div>
              <div class="stat"><span class="label">Total Messages</span><span class="value">\${d.memory.totalMessages.toLocaleString()}</span></div>
              <div class="stat"><span class="label">Profile Keys</span><span class="value">\${d.memory.profileKeys}</span></div>
              <div class="stat"><span class="label">Durable Items</span><span class="value">\${d.memory.durableItems}</span></div>
              <div class="stat"><span class="label">File Size</span><span class="value">\${d.memory.fileSizeKB} KB</span></div>
              <div class="stat"><span class="label">Last Backup</span><span class="value">\${d.memory.lastBackup ? new Date(d.memory.lastBackup).toLocaleString() : 'None'}</span></div>
              <div class="stat"><span class="label">Summaries</span><span class="value">\${d.memory.conversationSummaries}</span></div>
            </div>

            <div class="card">
              <h2>Recent Tool Calls</h2>
              \${d.tools.recentCalls.length === 0 ? '<div style="color:#71717a">No recent calls</div>' :
                d.tools.recentCalls.map(c => \`
                  <div class="log-entry \${c.success ? '' : 'fail'}">
                    <span class="tool">\${c.tool}</span>
                    <span>\${c.durationMs}ms</span>
                    <span class="time">\${new Date(c.timestamp).toLocaleTimeString()}</span>
                  </div>\`).join('')}
            </div>

            <div class="card">
              <h2>Recent Routing</h2>
              \${d.routing.recentDecisions.length === 0 ? '<div style="color:#71717a">No recent decisions</div>' :
                d.routing.recentDecisions.map(r => \`
                  <div class="log-entry">
                    <span class="tool">\${r.tool}</span>
                    <span style="color:#a1a1aa;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${r.input}</span>
                    <span class="time">\${new Date(r.timestamp).toLocaleTimeString()}</span>
                  </div>\`).join('')}
            </div>
          </div>
        \`;
      } catch (e) {
        document.getElementById('content').innerHTML = '<div style="color:#f87171">Failed to load dashboard: ' + e.message + '</div>';
      }
    }
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`);
});

export default router;

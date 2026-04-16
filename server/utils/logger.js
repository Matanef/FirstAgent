// server/utils/logger.js
import fs from "fs";
import path from "path";

// Define the root logs directory
const LOG_ROOT = "D:/local-llm-ui/logs";

// Level ordering for threshold filtering
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Creates a dedicated logger for a specific process/tool.
 *
 * @param {string} processName       Folder name under /logs (e.g. "llm", "deepResearch")
 * @param {object} [opts]
 * @param {boolean} [opts.silent]    If true, nothing is printed to the PM2 console — only the
 *                                   rotating file is written. Use for high-frequency callsites
 *                                   (LLM lifecycle, Express request middleware) so PM2 logs stay
 *                                   readable.
 * @param {string}  [opts.consoleLevel] Minimum level to echo to PM2 console ("debug"|"info"|"warn"|"error").
 *                                   Defaults to "warn" so info-level chatter stays file-only.
 */
export function createLogger(processName, { silent = false, consoleLevel = "warn" } = {}) {
  // 1. Ensure the directory exists (e.g., D:/local-llm-ui/logs/deepResearch)
  const dirPath = path.join(LOG_ROOT, processName);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const consoleLevelNum = LEVEL_ORDER[consoleLevel] ?? LEVEL_ORDER.warn;

  // 2. Return the logging function
  return function log(message, type = "info") {
    const now = new Date();
    // Daily rotating file name: "2026-04-17.log"
    const dateStr = now.toISOString().split("T")[0];
    const logFile = path.join(dirPath, `${dateStr}.log`);

    // Format the log entry
    const timestamp = now.toISOString();
    const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;

    // Always write to the tool's own rotating log file
    fs.appendFile(logFile, logEntry, (err) => {
      if (err) console.error(`Failed to write to ${processName} log:`, err);
    });

    // Echo to PM2 console only when not silenced AND level meets the threshold
    if (!silent) {
      const typeNum = LEVEL_ORDER[type] ?? LEVEL_ORDER.info;
      if (typeNum >= consoleLevelNum) {
        const consoleFn = type === "error" ? console.error : type === "warn" ? console.warn : console.log;
        consoleFn(`[${processName}] [${type.toUpperCase()}] ${message}`);
      }
    }
  };
}
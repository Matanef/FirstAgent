// server/utils/logger.js
import fs from "fs";
import path from "path";

// Define the root logs directory
const LOG_ROOT = "D:/local-llm-ui/logs";

/**
 * Creates a dedicated logger for a specific process/tool.
 * @param {string} processName - The name of the folder (e.g., "llm", "search", "email")
 */
export function createLogger(processName) {
  // 1. Ensure the directory exists (e.g., D:/local-llm-ui/logs/search)
  const dirPath = path.join(LOG_ROOT, processName);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // 2. Return the logging function
  return function log(message, type = "info") {
    const now = new Date();
    // Create a daily rotating file name, e.g., "2026-04-10.log"
    const dateStr = now.toISOString().split("T")[0]; 
    const logFile = path.join(dirPath, `${dateStr}.log`);

    // Format the log line with a timestamp
    const timestamp = now.toISOString();
    const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;

    // Write it to the specific tool's file (asynchronously so it doesn't block the server)
    fs.appendFile(logFile, logEntry, (err) => {
      if (err) console.error(`Failed to write to ${processName} log:`, err);
    });

    // Optional: Still print to the main PM2 console so `pm2 logs` shows a live feed
    console.log(`[${processName}] ${message}`);
  };
}
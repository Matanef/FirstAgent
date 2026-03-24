// server/utils/webhookHandler.js
import fs from "fs/promises";
import path from "path";
import { PROJECT_ROOT } from "./config.js";

const LOG_FILE = path.join(PROJECT_ROOT, "data", "webhook_events.json");

export async function getLatestMessages() {
  try {
    const data = await fs.readFile(LOG_FILE, "utf8");
    const events = JSON.parse(data);
    
    // Filter for actual message payloads (example for WhatsApp/Generic)
    return events.map(event => ({
      time: event.timestamp,
      sender: event.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id || "Unknown",
      text: event.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body || "No text content",
      raw: event.body
    })).slice(-5); // Return last 5 messages
  } catch (e) {
    return [];
  }
}

export async function clearWebhookLogs() {
  await fs.writeFile(LOG_FILE, "[]");
  return "Logs cleared.";
}
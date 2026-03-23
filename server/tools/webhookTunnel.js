// server/tools/webhookTunnel.js
// Opens an ngrok tunnel to receive incoming webhooks (WhatsApp, Discord, etc.)

import http from "http";
import fs from "fs/promises";
import path from "path";
import ngrok from "ngrok";
import { PROJECT_ROOT } from "../utils/config.js";

// Global state to keep the server alive across tool executions
let activeServer = null;
let activeTunnelUrl = null;
const PORT = 5050; // Default port for our listener

export async function webhookTunnel(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const lowerText = text.toLowerCase();

  try {
    // Handle shutdown intent
    if (lowerText.includes("stop") || lowerText.includes("close") || lowerText.includes("kill")) {
      if (!activeServer && !activeTunnelUrl) {
        return { tool: "webhookTunnel", success: true, final: true, data: { text: "No active tunnel to stop.", preformatted: true } };
      }
      
      if (activeTunnelUrl) await ngrok.disconnect();
      if (activeServer) activeServer.close();
      
      activeServer = null;
      activeTunnelUrl = null;
      
      return { tool: "webhookTunnel", success: true, final: true, data: { text: "🛑 Webhook tunnel and server successfully shut down.", preformatted: true } };
    }

    // Handle start intent
    if (activeTunnelUrl) {
      return { tool: "webhookTunnel", success: true, final: true, data: { text: `⚠️ Tunnel is already running at: **${activeTunnelUrl}**\nListening on port ${PORT}.`, preformatted: true } };
    }

    // Ensure our data directory exists
    const dataDir = path.join(PROJECT_ROOT, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const logFile = path.join(dataDir, "webhook_events.json");

    // Start native HTTP server
    activeServer = http.createServer(async (req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const payload = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body ? JSON.parse(body) : {}
          };

          // Append to log file (agent can read this file later)
          const currentData = await fs.readFile(logFile, "utf8").catch(() => "[]");
          const events = JSON.parse(currentData);
          events.push(payload);
          await fs.writeFile(logFile, JSON.stringify(events, null, 2));

          console.log(`[Webhook] Received event at ${req.url}`);
        } catch (e) {
          console.error("[Webhook] Failed to process payload", e);
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      });
    });

    activeServer.listen(PORT);

    // Start ngrok tunnel
    activeTunnelUrl = await ngrok.connect({
      addr: PORT,
      authtoken: process.env.NGROK_AUTHTOKEN // Required for ngrok
    });

    return {
      tool: "webhookTunnel",
      success: true,
      final: true,
      data: {
        text: `✅ **Webhook Tunnel Established**\n\n**Public URL:** ${activeTunnelUrl}\n**Local Port:** ${PORT}\n\nIncoming events will be logged to \`data/webhook_events.json\`. You can use this URL for your WhatsApp/Discord webhook configurations.`,
        preformatted: true
      }
    };

  } catch (error) {
    return {
      tool: "webhookTunnel",
      success: false,
      final: true,
      error: `Action failed: Could not manage webhook tunnel - ${error.message}`
    };
  }
}
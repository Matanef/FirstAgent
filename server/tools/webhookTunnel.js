// server/tools/webhookTunnel.js
// Opens an ngrok tunnel to receive incoming webhooks (WhatsApp, Discord, etc.)
// Using native child_process to bypass the buggy ngrok npm wrapper on Windows.

import http from "http";
import fs from "fs/promises";
import path from "path";
import { spawn, execSync } from "child_process";
import { PROJECT_ROOT } from "../utils/config.js";

// Global state to keep the processes alive across tool executions
let activeServer = null;
let activeTunnelUrl = null;
let ngrokProcess = null; 
const PORT = 5055; // Port 5055 avoids common Windows UDP/TCP collisions

export async function webhookTunnel(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const lowerText = text.toLowerCase();

  try {
    // 1. Handle shutdown intent
    if (lowerText.match(/(stop|close|kill|shutdown)/)) {
      console.log("🛑 Shutting down webhook tunnel and server...");
      
      if (ngrokProcess) {
        ngrokProcess.kill();
        ngrokProcess = null;
      }
      
      if (activeServer) {
        activeServer.close();
        activeServer = null;
      }

      activeTunnelUrl = null;

      // Final insurance: Kill any dangling ngrok binaries
      try {
        if (process.platform === 'win32') {
          execSync('taskkill /f /t /im ngrok.exe', { stdio: 'ignore' });
        }
      } catch (e) {
        // No process found, which is fine
      }

      return { 
        tool: "webhookTunnel", 
        success: true, 
        final: true, 
        data: { text: "🛑 Webhook tunnel and local server successfully shut down.", preformatted: true } 
      };
    }

    // 2. Prevent duplicate tunnels
    if (activeTunnelUrl) {
      return { 
        tool: "webhookTunnel", 
        success: true, 
        final: true, 
        data: { text: `⚠️ Tunnel is already running at: **${activeTunnelUrl}**\nListening on port ${PORT}.`, preformatted: true } 
      };
    }

    // 3. Clean up any orphaned server instances before starting
    if (activeServer) {
      activeServer.close();
      activeServer = null;
    }

    // 4. Setup logging for incoming events
    const dataDir = path.join(PROJECT_ROOT, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const logFile = path.join(dataDir, "webhook_events.json");

// 5. Start the local HTTP listener with Meta Verification Support
    activeServer = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
      
      // --- META/WHATSAPP VERIFICATION HANDSHAKE ---
      // If Meta is verifying the webhook, they send a GET with hub.challenge
      if (req.method === "GET") {
        const mode = parsedUrl.searchParams.get("hub.mode");
        const token = parsedUrl.searchParams.get("hub.verify_token");
        const challenge = parsedUrl.searchParams.get("hub.challenge");

        if (mode && token) {
          console.log(`[Webhook] Verification attempt: ${mode}`);
          // You can set WHATSAPP_VERIFY_TOKEN in your .env for extra security
          const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "my_secure_token";
          
          if (token === verifyToken) {
            console.log("✅ Webhook Verified by Meta.");
            res.writeHead(200, { "Content-Type": "text/plain" });
            return res.end(challenge); // They MUST receive just the challenge string
          } else {
            console.error("❌ Verification Failed: Token mismatch.");
            res.writeHead(403);
            return res.end("Forbidden");
          }
        }
      }

      // --- ACTUAL WEBHOOK DATA HANDLING ---
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

          // Only log to file if it contains actual message content (skip noisy status pings)
          const hasMessage = payload.body?.entry?.[0]?.changes?.[0]?.value?.messages?.length > 0;
          const isStatusOnly = payload.body?.entry?.[0]?.changes?.[0]?.value?.statuses && !hasMessage;

          if (!isStatusOnly) {
            const currentData = await fs.readFile(logFile, "utf8").catch(() => "[]");
            const events = JSON.parse(currentData);
            events.push(payload);
            await fs.writeFile(logFile, JSON.stringify(events, null, 2));
            console.log(`[Webhook] Received ${req.method} from ${req.headers['user-agent'] || 'Unknown'}`);
          }
        } catch (e) {
          console.error("[Webhook] Payload processing error:", e.message);
        }
        res.writeHead(200);
        res.end("OK");
      });
    });

    activeServer.on('error', (e) => console.error("🚨 [webhookTunnel] Server Error:", e.message));
    activeServer.listen(PORT);

    // 6. OS-Level Sweep: Kill any existing ngrok processes to prevent 'tunnel already exists'
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /f /t /im ngrok.exe', { stdio: 'ignore' });
      } else {
        execSync('pkill -9 ngrok', { stdio: 'ignore' });
      }
      // Brief pause to allow OS to release socket locks
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (e) {}

    // 7. Initialize Ngrok via Native CLI
    const token = process.env.NGROK_AUTHTOKEN?.trim();
    if (!token) throw new Error("NGROK_AUTHTOKEN is missing from environment variables.");

    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    
    // Set the token
    execSync(`${npxCmd} ngrok config add-authtoken ${token}`, { stdio: 'ignore' });

    // Spawn the tunnel process with { shell: true } for Windows compatibility
    ngrokProcess = spawn(npxCmd, ['ngrok', 'http', PORT.toString()], { shell: true });

    // 8. Polling Logic: Retrieve the Public URL from the Ngrok local API
    let urlFound = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for cloud handshake
      
      // Check common API ports (4040, 4041) in case of port shifting
      for (let apiPort = 4040; apiPort <= 4041; apiPort++) {
        try {
          const apiRes = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
          if (!apiRes.ok) continue;

          const apiData = await apiRes.json();
          if (apiData.tunnels && apiData.tunnels.length > 0) {
            activeTunnelUrl = apiData.tunnels[0].public_url;
            urlFound = true;
            break;
          }
        } catch (e) {
          // API not ready yet on this port
        }
      }
      if (urlFound) break;
      console.log(`   ⏳ Waiting for ngrok cloud tunnel... (Attempt ${attempt}/6)`);
    }

    if (!urlFound) {
      throw new Error("Native ngrok process started but failed to provide a Public URL within 12s.");
    }

    return {
      tool: "webhookTunnel",
      success: true,
      final: true,
      data: {
        text: `✅ **Webhook Tunnel Established**\n\n**Public URL:** ${activeTunnelUrl}\n**Local Port:** ${PORT}\n\nIncoming events are being logged to \`data/webhook_events.json\`.`,
        preformatted: true
      }
    };

  } catch (error) {
    // Cleanup on failure
    if (activeServer) { activeServer.close(); activeServer = null; }
    if (ngrokProcess) { ngrokProcess.kill(); ngrokProcess = null; }
    
    console.error("🚨 [webhookTunnel] RAW ERROR:", error.message);
    return {
      tool: "webhookTunnel",
      success: false,
      final: true,
      error: `Action failed: ${error.message}`
    };
  }
}
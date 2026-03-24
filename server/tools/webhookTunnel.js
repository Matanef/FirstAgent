// server/tools/webhookTunnel.js
import http from "http";
import fs from "fs/promises";
import path from "path";
import { spawn, execSync } from "child_process";
import { PROJECT_ROOT } from "../utils/config.js";

let activeServer = null;
let activeTunnelUrl = null;
let ngrokProcess = null; // Track the native process
const PORT = 5055; 

export async function webhookTunnel(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");

  try {
    if (text.toLowerCase().match(/(stop|close|kill)/)) {
      if (ngrokProcess) { ngrokProcess.kill(); ngrokProcess = null; }
      if (activeServer) { activeServer.close(); activeServer = null; }
      activeTunnelUrl = null;
      try {
        if (process.platform === 'win32') execSync('taskkill /f /t /im ngrok.exe', { stdio: 'ignore' });
      } catch (e) {}
      return { tool: "webhookTunnel", success: true, final: true, data: { text: "🛑 Webhook tunnel shut down.", preformatted: true } };
    }

    if (activeTunnelUrl) return { tool: "webhookTunnel", success: true, final: true, data: { text: `⚠️ Tunnel is already running at: **${activeTunnelUrl}**`, preformatted: true } };

    if (activeServer) { activeServer.close(); activeServer = null; }

    const dataDir = path.join(PROJECT_ROOT, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const logFile = path.join(dataDir, "webhook_events.json");

    activeServer = http.createServer(async (req, res) => {
      let body = "";
      req.on("data", chunk => body += chunk.toString());
      req.on("end", async () => {
        try {
          const payload = { timestamp: new Date().toISOString(), method: req.method, url: req.url, body: body ? JSON.parse(body) : {} };
          const currentData = await fs.readFile(logFile, "utf8").catch(() => "[]");
          const events = JSON.parse(currentData);
          events.push(payload);
          await fs.writeFile(logFile, JSON.stringify(events, null, 2));
        } catch (e) {}
        res.writeHead(200); res.end("OK");
      });
    });

    activeServer.listen(PORT);

    // 1. Sweep Zombies
    try {
      if (process.platform === 'win32') execSync('taskkill /f /t /im ngrok.exe', { stdio: 'ignore' });
    } catch (e) {}

    // 2. Set Token Natively
    const token = process.env.NGROK_AUTHTOKEN.trim();
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    execSync(`${npxCmd} ngrok config add-authtoken ${token}`, { stdio: 'ignore' });

// 3. Spawn Native CLI (Exactly what you ran manually)
    ngrokProcess = spawn(npxCmd, ['ngrok', 'http', PORT.toString()], { shell: true });

    // 4. Poller (Checks 4040, 4041, etc., just in case)
    let urlFound = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      for (let apiPort = 4040; apiPort <= 4042; apiPort++) {
        try {
          const apiRes = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
          if (!apiRes.ok) continue;
          const apiData = await apiRes.json();
          if (apiData.tunnels && apiData.tunnels.length > 0) {
            activeTunnelUrl = apiData.tunnels[0].public_url;
            urlFound = true;
            break;
          }
        } catch (e) {}
      }
      if (urlFound) break;
    }

    if (!urlFound) throw new Error("Could not retrieve URL from native ngrok process.");

    return {
      tool: "webhookTunnel",
      success: true,
      final: true,
      data: {
        text: `✅ **Webhook Tunnel Established**\n\n**Public URL:** ${activeTunnelUrl}\n**Local Port:** ${PORT}`,
        preformatted: true
      }
    };

  } catch (error) {
    if (activeServer) { activeServer.close(); activeServer = null; }
    if (ngrokProcess) { ngrokProcess.kill(); ngrokProcess = null; }
    console.error("🚨 RAW ERROR:", error.message);
    return { tool: "webhookTunnel", success: false, final: true, error: `Action failed: ${error.message}` };
  }
}
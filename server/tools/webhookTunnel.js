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
const PORT = 3000; // Port 5055 avoids common Windows UDP/TCP collisions

// Phase 18G — orphan ngrok cleanup at boot. If a previous Lanou instance
// crashed or was killed without running its exit handlers (Windows kill,
// hard reboot, PM2 god-process desync), an `ngrok.exe` may still be running
// and holding port 4040 (its API) or other resources. On the *next* boot we
// scan for orphan ngrok processes and kill them BEFORE webhookTunnel tries
// to start its own ngrok — preventing the stuck-PM2-restart cycle the user
// hit repeatedly in Phase 17.
function killOrphanNgrokAtBoot() {
  if (process.platform !== "win32") {
    // Best-effort POSIX cleanup: pkill is harmless if no match
    try { execSync("pkill -f ngrok 2>/dev/null", { stdio: "ignore" }); } catch {}
    return;
  }
  try {
    const out = execSync(
      `tasklist /FI "IMAGENAME eq ngrok.exe" /FO CSV /NH`,
      { encoding: "utf8" }
    );
    if (!out || /INFO: No tasks/i.test(out)) return;
    const pids = [...out.matchAll(/"ngrok\.exe","(\d+)"/g)].map(m => m[1]);
    if (pids.length === 0) return;
    console.warn(`[webhookTunnel] orphan check: found ${pids.length} stray ngrok process(es) from a prior run — cleaning up`);
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      } catch { /* already dead or access denied — skip */ }
    }
    console.warn(`[webhookTunnel] orphan check: cleanup complete`);
  } catch {
    // tasklist not available or failed — silently skip; we'll still try to
    // bind, and the EADDRINUSE retry path covers the worst case.
  }
}
// Run immediately at module load — the first thing Lanou does for tunnels.
killOrphanNgrokAtBoot();

// Windows: kill the *entire* ngrok process tree on parent exit. With
// `shell: true` + `detached: true`, .kill() only terminates the cmd.exe wrapper —
// ngrok.exe itself survives as an orphan, holds stdio handles, and causes PM2
// to mark the (dead) parent as "errored" while it's actually still listed as
// PID-alive. taskkill /F /T walks the whole tree.
function killNgrokTree() {
  if (!ngrokProcess || !ngrokProcess.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${ngrokProcess.pid}`, { stdio: "ignore" });
    } else {
      process.kill(-ngrokProcess.pid);  // negative = process group
    }
  } catch { /* already dead */ }
  ngrokProcess = null;
}

// Register exit hooks once at module load so PM2 stop/restart cleans up.
let _exitHooksRegistered = false;
function registerExitHooks() {
  if (_exitHooksRegistered) return;
  _exitHooksRegistered = true;
  const cleanup = () => { try { killNgrokTree(); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
registerExitHooks();

export async function webhookTunnel(request) {
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  const lowerText = text.toLowerCase();

  try {
    // 1. Handle shutdown intent
    if (lowerText.match(/(stop|close|kill|shutdown)/)) {
      console.log("🛑 Shutting down webhook tunnel and server...");
      
      killNgrokTree();
      
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

// ── BEGIN DYNAMIC MODEL ROUTING ──
          let targetModel = "aya-expanse:8b"; // Safe, multilingual default for family (fixes broken Hebrew)
          if (hasMessage) {
            try {
              const incomingPhoneNumber = payload.body.entry[0].changes[0].value.messages[0].from;
              const { getUserByPhone } = await import("../utils/userProfiles.js");
              const profile = await getUserByPhone(incomingPhoneNumber);

              // Switch to the uncensored model ONLY if the sender is the owner
              if (profile && profile.role === "owner") {
                targetModel = "dolphin-llama3:latest"; 
              }
              console.log(`🧠 [Model Route] Assigned ${targetModel} to incoming message from ${incomingPhoneNumber}`);
            } catch (err) {
              console.warn(`⚠️ [Model Route] Failed to assign model: ${err.message}`);
            }
          }
          // ── END DYNAMIC MODEL ROUTING ──

          // ── PROXY to main Express server's /webhook/whatsapp route ──
          const mainPort = process.env.PORT || 3000;
          
          const proxyHeaders = { 
            "Content-Type": "application/json",
            "x-target-model": targetModel // Inject the model via header!
          };
          
          if (req.headers["x-hub-signature-256"]) {
            proxyHeaders["x-hub-signature-256"] = req.headers["x-hub-signature-256"];
          }

          try {
            const proxyRes = await fetch(`http://127.0.0.1:${mainPort}/webhook/whatsapp`, {
              method: "POST",
              headers: proxyHeaders,
              body: body, // Send the unmodified original body
              signal: AbortSignal.timeout(30000)
            });
            if (!proxyRes.ok) {
              console.warn(`[Webhook] Proxy to main server returned ${proxyRes.status}`);
            }
          } catch (proxyErr) {
            console.warn(`[Webhook] Proxy to main server failed: ${proxyErr.message}`);
          }
        } catch (e) {
          console.error("[Webhook] Payload processing error:", e.message);
        }
        res.writeHead(200);
        res.end("OK");
      });
    });

    activeServer.on('error', (e) => console.error("🚨 [webhookTunnel] Server Error:", e.message));

    // Phase 17I — listen() with one EADDRINUSE retry. After pm2 restart the
    // previous process's socket may sit in TIME_WAIT for a few seconds, or a
    // leftover process may still hold the port. A single 1s retry resolves
    // both cases without crashing the agent. If the second attempt also
    // fails, log and continue without the tunnel — agent stays usable.
    await new Promise((resolve) => {
      let retried = false;
      const attemptListen = () => {
        const onListenError = (e) => {
          if (e?.code === "EADDRINUSE" && !retried) {
            retried = true;
            console.warn(`[webhookTunnel] port ${PORT} in use, retrying once in 1s…`);
            activeServer.removeListener("error", onListenError);
            setTimeout(attemptListen, 1000);
          } else if (e?.code === "EADDRINUSE") {
            console.error(`[webhookTunnel] port ${PORT} still in use after retry — skipping tunnel startup`);
            activeServer.removeListener("error", onListenError);
            resolve();   // graceful skip, agent stays alive
          } else {
            // Non-EADDRINUSE error — let the existing on('error') handler log it
            resolve();
          }
        };
        activeServer.once("error", onListenError);
        activeServer.listen(PORT, () => {
          activeServer.removeListener("error", onListenError);
          resolve();
        });
      };
      attemptListen();
    });

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

    // Spawn the tunnel process with { shell: true } for Windows compatibility.
    // detached + unref: ngrok runs in its own process group so stdio pipes don't
    // tether the parent — fixes PM2 desync on Windows where shell-spawned children
    // outlive the parent and keep PM2 thinking the parent is "errored, uptime 0"
    // while the actual node process is still serving (orphan-child desync bug).
    ngrokProcess = spawn(npxCmd, ['ngrok', 'http', PORT.toString()], {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    ngrokProcess.unref();

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

    // ── Auto-register with Meta WhatsApp webhook (if credentials available) ──
    let metaStatus = "";
    const waAppId = process.env.WHATSAPP_APP_ID || process.env.META_APP_ID;
    const waAppSecret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
    const waVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (waAppId && waAppSecret && waVerifyToken) {
      try {
        // Get app access token
        const tokenRes = await fetch(`https://graph.facebook.com/oauth/access_token?client_id=${waAppId}&client_secret=${waAppSecret}&grant_type=client_credentials`);
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          const appToken = tokenData.access_token;
          const callbackUrl = `${activeTunnelUrl}/webhook/whatsapp`;

          // Subscribe to WhatsApp webhook
          const subRes = await fetch(`https://graph.facebook.com/v21.0/${waAppId}/subscriptions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              object: "whatsapp_business_account",
              callback_url: callbackUrl,
              verify_token: waVerifyToken,
              fields: "messages",
              access_token: appToken
            })
          });
          if (subRes.ok) {
            metaStatus = `\n**Meta Webhook:** Auto-registered → ${callbackUrl}`;
            console.log(`✅ [webhookTunnel] Meta webhook updated to: ${callbackUrl}`);
          } else {
            const err = await subRes.text();
            metaStatus = `\n**Meta Webhook:** Registration failed (${subRes.status}) — update manually in Meta dashboard`;
            console.warn(`⚠️ [webhookTunnel] Meta webhook registration failed: ${err}`);
          }
        }
      } catch (e) {
        metaStatus = `\n**Meta Webhook:** Auto-registration error — ${e.message}`;
        console.warn(`⚠️ [webhookTunnel] Meta auto-registration error: ${e.message}`);
      }
    } else {
      metaStatus = "\n**Meta Webhook:** Set WHATSAPP_APP_ID + WHATSAPP_APP_SECRET in .env for auto-registration, or update manually in Meta dashboard";
    }

    return {
      tool: "webhookTunnel",
      success: true,
      final: true,
      data: {
        text: `✅ **Webhook Tunnel Established**\n\n**Public URL:** ${activeTunnelUrl}\n**Local Port:** ${PORT}${metaStatus}\n\nIncoming events are being logged to \`data/webhook_events.json\`.`,
        preformatted: true
      }
    };

  } catch (error) {
    // Cleanup on failure
    if (activeServer) { activeServer.close(); activeServer = null; }
    killNgrokTree();
    
    console.error("🚨 [webhookTunnel] RAW ERROR:", error.message);
    return {
      tool: "webhookTunnel",
      success: false,
      final: true,
      error: `Action failed: ${error.message}`
    };
  }
}
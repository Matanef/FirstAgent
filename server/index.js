// server/index.js
// Application entry point — Express setup, middleware, and route mounting
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory of the current file (server folder)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Point directly to the .env file inside the server folder
dotenv.config({ path: path.join(__dirname, ".env") });
import express from "express";
import cors from "cors";
import { PROJECT_ROOT } from "./utils/config.js";

// Route modules
import chatRoutes from "./routes/chat.js";
import conversationRoutes from "./routes/conversations.js";
import fileRoutes from "./routes/files.js";
import reviewRoutes from "./routes/review.js";
import duplicateRoutes from "./routes/duplicates.js";
import oauthCallback from "./routes/oauthCallback.js";
import browseRoutes from "./routes/browse.js";
import whatsappWebhook from "./routes/whatsappWebhook.js";
import dashboardRoutes from "./routes/dashboard.js";
import { loadSkills } from "./executor.js";
import { createLogger } from "./utils/logger.js";

// File-only request log — high-frequency endpoints (dashboard, /api/logs) stay out of PM2 stdout
const requestLog = createLogger("express", { silent: true });

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
// ── SECURITY: Restrict CORS to localhost and configured origins ──
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173", "http://127.0.0.1:3000"];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn(`🛡️ CORS blocked origin: ${origin}`);
    callback(new Error("CORS: origin not allowed"));
  },
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => { req.rawBody = buf; }  // Preserve raw bytes for webhook HMAC verification
}));
app.use("/", oauthCallback);


// Request logging with IP extraction.
// All requests → logs/express/<date>.log (silent: file only, no PM2 flood).
// High-signal requests (chat, files, webhooks) also → PM2 console.warn so they
// remain visible without the 15-second /api/dashboard poll cluttering the stream.
const SILENT_PATHS = new Set(["/api/dashboard", "/dashboard"]);
app.use((req, res, next) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.ip ||
    req.connection?.remoteAddress;
  req.clientIp = clientIp;
  requestLog(`${req.method} ${req.path} - IP: ${clientIp}`, "info");
  // Echo important routes to PM2 stdout so they remain searchable in `pm2 logs`
  if (!SILENT_PATHS.has(req.path) && req.method !== "GET") {
    console.log(`[express] ${req.method} ${req.path} - IP: ${clientIp}`);
  }
  next();
});

// ============================================================
// MOUNT ROUTES
// ============================================================
app.use(chatRoutes);
app.use(conversationRoutes);
app.use(fileRoutes);
app.use("/api", reviewRoutes);
app.use("/api", duplicateRoutes);
app.use("/api/browse", browseRoutes);
app.use("/webhook/whatsapp", whatsappWebhook);
app.use(dashboardRoutes);

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, async () => {
  const bootStart = Date.now();
  console.log("\n" + "=".repeat(70));
  console.log("🤖 AI AGENT SERVER");
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`📂 Project root: ${PROJECT_ROOT}`);
  console.log("=".repeat(70) + "\n");

  console.time("[boot] loadSkills");
  await loadSkills();
  console.timeEnd("[boot] loadSkills");

  // ── Auto-prune old conversations (non-blocking) ──
  import("./utils/conversationMemory.js")
    .then(mod => mod.pruneOldConversations())
    .catch(e => console.warn("⚠️ [startup] Conversation pruning skipped:", e.message));

  // ── Auto-start ngrok tunnel for WhatsApp webhooks ──
  if (process.env.WHATSAPP_TOKEN && process.env.NGROK_AUTHTOKEN) {
    try {
      console.time("[boot] webhookTunnel");
      const { webhookTunnel } = await import("./tools/webhookTunnel.js");
      console.log("🔗 [startup] Opening ngrok tunnel for WhatsApp webhooks...");
      const result = await webhookTunnel({ text: "open tunnel", context: { action: "open" } });
      console.timeEnd("[boot] webhookTunnel");
      if (result.success) {
        console.log(`✅ [startup] Tunnel active — update Meta webhook URL if needed`);
      } else {
        console.warn(`⚠️ [startup] Tunnel failed: ${result.error || "unknown"}`);
      }
    } catch (e) {
      console.warn(`⚠️ [startup] Could not auto-start tunnel: ${e.message}`);
    }
  }

  console.log(`⏱️  [boot] total ready in ${Date.now() - bootStart}ms`);
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});

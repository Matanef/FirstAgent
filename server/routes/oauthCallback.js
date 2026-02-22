// server/routes/oauthCallback.js
import express from "express";
import fs from "fs/promises";
import path from "path";
import { google } from "googleapis";
import { CONFIG } from "../utils/config.js";

const router = express.Router();
const TOKEN_PATH = path.join(process.cwd(), "server", "tokens", "google_oauth_token.json");

router.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send("Missing code query parameter");
    }

    const oAuth2Client = new google.auth.OAuth2(
      CONFIG.GOOGLE_CLIENT_ID,
      CONFIG.GOOGLE_CLIENT_SECRET,
      CONFIG.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await oAuth2Client.getToken(code);
    // Ensure tokens contain refresh_token for long-term use
    if (!tokens.refresh_token) {
      // If refresh_token is missing, user may have previously consented; instruct to reauthorize with prompt=consent
      console.warn("No refresh_token returned. Reauthorize with prompt=consent to obtain a refresh token.");
    }

    // Ensure token directory exists
    await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });

    // Save token to disk (gitignore this file)
    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });

    // Optionally: return a friendly HTML page or JSON
    res.send(`
      <html>
        <body style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
          <h2>Gmail OAuth completed</h2>
          <p>Tokens saved to <code>${TOKEN_PATH}</code>. You can close this window.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth exchange failed: " + err.message);
  }
});

export default router;
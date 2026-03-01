// server/utils/googleOAuth.js
// Gmail OAuth2 helper with local JSON token storage

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { CONFIG } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN_PATH = path.join(__dirname, "..", "tokens", "google_oauth_token.json");

function ensureTokenDir() {
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createOAuthClient() {
  if (!CONFIG.GOOGLE_CLIENT_ID || !CONFIG.GOOGLE_CLIENT_SECRET || !CONFIG.GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth2 not configured in environment.");
  }

  return new google.auth.OAuth2(
    CONFIG.GOOGLE_CLIENT_ID,
    CONFIG.GOOGLE_CLIENT_SECRET,
    CONFIG.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl() {
  const oAuth2Client = createOAuthClient();
  const scopes = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events"
  ];

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent"
  });

  return authUrl;
}

export function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const content = fs.readFileSync(TOKEN_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function saveToken(token) {
  ensureTokenDir();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
}

export async function getAuthorizedClient() {
  const oAuth2Client = createOAuthClient();
  const token = loadToken();

  if (!token) {
    const authUrl = getAuthUrl();
    throw new Error(
      `No Gmail OAuth token found. Visit this URL in your browser, complete the consent flow, ` +
        `and then implement a small handler to exchange the code for a token:\n\n${authUrl}\n`
    );
  }

  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}
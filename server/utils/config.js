// server/utils/config.js (CORRECTED - properly detects Gmail OAuth)
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic project root — works regardless of where the repo is cloned
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ⚠️ Single source of truth: server/.env (NOT project-root .env).
// Historical bug: `import 'dotenv/config'` loads from CWD (project root), while
// server/index.js loads from server/.env explicitly. This caused CORE_API_KEY
// (read here in config.js) to silently miss values that were only in server/.env.
// Fix: always load server/.env explicitly from this file too.
const SERVER_ENV_PATH = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: SERVER_ENV_PATH });

const warnings = [];

// Finance
if (!process.env.ALPHA_VANTAGE_KEY && !process.env.FINNHUB_KEY) {
  warnings.push("⚠️  No finance API keys set - finance tool will be unavailable");
}

// GitHub
if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
  warnings.push("⚠️  GITHUB_PERSONAL_ACCESS_TOKEN not set - GitHub tool will be unavailable");
}

// Search
if (!process.env.SERPAPI_KEY) {
  warnings.push("⚠️  SERPAPI_KEY not set - search features may be limited");
}

// Weather
if (!process.env.OPENWEATHER_KEY) {
  warnings.push("⚠️  OPENWEATHER_KEY not set - weather tool will be unavailable");
}

// Sports
if (!process.env.SPORTS_API_KEY) {
  warnings.push("⚠️  SPORTS_API_KEY not set - sports tool will be unavailable");
}

// YouTube
if (!process.env.YOUTUBE_API_KEY) {
  warnings.push("⚠️  YOUTUBE_API_KEY not set - YouTube tool will be unavailable");
}

// X (Twitter) via agent-twitter-client
if (!process.env.TWITTER_USERNAME || !process.env.TWITTER_PASSWORD) {
  warnings.push("⚠️  TWITTER_USERNAME/TWITTER_PASSWORD not set - X/Twitter tool will be unavailable");
}

// Spotify
if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
  warnings.push("⚠️  SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET not set - Spotify tool will be unavailable");
} else if (!process.env.SPOTIFY_REFRESH_TOKEN) {
  warnings.push("⚠️  SPOTIFY_REFRESH_TOKEN not set - Spotify tool will be unavailable");
}

// Email - CORRECTED: Check for Gmail OAuth OR SMTP OR Email API
if (!process.env.GOOGLE_CLIENT_ID && !process.env.EMAIL_API_KEY && !process.env.SMTP_HOST) {
  warnings.push("⚠️  No email configuration found - email tool will be unavailable");
} else if (process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_SECRET) {
  warnings.push("⚠️  GOOGLE_CLIENT_ID set but GOOGLE_CLIENT_SECRET missing - email tool will be unavailable");
} else if (process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_REDIRECT_URI) {
  warnings.push("⚠️  Gmail OAuth incomplete - GOOGLE_REDIRECT_URI missing");
}

export const CONFIG = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // LLM
  LLM_MODEL: process.env.LLM_MODEL || 'qwen2.5-coder:7b',
  LLM_API_URL: process.env.LLM_API_URL || 'http://localhost:11434/',

  // Agent Limits
  MAX_STEPS: parseInt(process.env.MAX_STEPS || '3'),
  TOOL_BUDGET_SEARCH: parseInt(process.env.TOOL_BUDGET_SEARCH || '3'),
  TOOL_BUDGET_FINANCE: parseInt(process.env.TOOL_BUDGET_FINANCE || '2'),
  TOOL_BUDGET_CALCULATOR: parseInt(process.env.TOOL_BUDGET_CALCULATOR || '1'),
  
  //Smart Evolution
  CHARTS_DIR: path.resolve(process.cwd(), "data", "charts"),

  // Finance Providers
  FINANCE_PROVIDER: process.env.FINANCE_PROVIDER || 'alpha',
  ALPHA_VANTAGE_KEY: process.env.ALPHA_VANTAGE_KEY,
  FINNHUB_KEY: process.env.FINNHUB_KEY,
  FMP_API_KEY: process.env.FMP_API_KEY,

  // Search
  SERPAPI_KEY: process.env.SERPAPI_KEY,

  // Academic Research APIs (open-access sources — no paywall)
  CORE_API_KEY: process.env.CORE_API_KEY,                       // core.ac.uk — free, register at https://core.ac.uk/services/api
  SEMANTIC_SCHOLAR_KEY: process.env.SEMANTIC_SCHOLAR_KEY || "", // optional: higher rate limits at https://api.semanticscholar.org/

  // Weather
  OPENWEATHER_KEY: process.env.OPENWEATHER_KEY,

  // Sports
  SPORTS_API_KEY: process.env.SPORTS_API_KEY,

  // GitHub
  GITHUB_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,

  // YouTube
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,

  // Email (Gmail OAuth, SMTP, or API)
  EMAIL_API_KEY: process.env.EMAIL_API_KEY,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,

  // Google Auth (for Gmail)
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,

// X (Twitter) via agent-twitter-client
  TWITTER_USERNAME: process.env.TWITTER_USERNAME,
  TWITTER_PASSWORD: process.env.TWITTER_PASSWORD,
  TWITTER_EMAIL: process.env.TWITTER_EMAIL,

  // Default Email (for "email me" resolution)
  DEFAULT_EMAIL: process.env.DEFAULT_EMAIL || "",

  // WhatsApp Bot Config
  WHATSAPP_BOT_NUMBER: process.env.WHATSAPP_BOT_NUMBER,
  WHATSAPP_DEFAULT_RECIPIENT: process.env.WHATSAPP_DEFAULT_RECIPIENT || "972587426393",

  // Credential Encryption
  CREDENTIAL_MASTER_KEY: process.env.CREDENTIAL_MASTER_KEY,

  // Spotify
  SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN: process.env.SPOTIFY_REFRESH_TOKEN,

  // MCP (Model Context Protocol)
  // JSON string mapping server names to spawn configs:
  // e.g. {"sqlite": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite", "test.db"]}}
  MCP_SERVERS: process.env.MCP_SERVERS || null,

  // Moltbook
  MOLTBOOK_BASE_URL: process.env.MOLTBOOK_BASE_URL || 'https://moltbook.com',

  // Obsidian Knowledge OS
  OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH || null,
  RESEARCH_LIBRARY_PATH: process.env.RESEARCH_LIBRARY_PATH || null,

  // Runtime-editable agent constraints (deepResearch synthesizer reads this fresh per call).
  // Defaults to data/agent-constraints.json under PROJECT_ROOT when unset.
  AGENT_CONSTRAINTS_PATH: process.env.AGENT_CONSTRAINTS_PATH || null,

  // Cache
  SEARCH_CACHE_TTL: parseInt(process.env.SEARCH_CACHE_TTL || '3600000'),

  // Helper methods
  isFinanceAvailable() {
    return !!(this.ALPHA_VANTAGE_KEY || this.FINNHUB_KEY || this.FMP_API_KEY);
  },

  isEmailAvailable() {
    return !!(
      this.EMAIL_API_KEY ||
      this.SMTP_HOST ||
      (this.GOOGLE_CLIENT_ID && this.GOOGLE_CLIENT_SECRET && this.GOOGLE_REDIRECT_URI)
    );
  },

  isXAvailable() {
    return !!(this.TWITTER_USERNAME && this.TWITTER_PASSWORD);
  },

  getWarnings() {
    return warnings;
  }
};

// Log warnings
if (warnings.length > 0) {
  console.warn('\n' + '='.repeat(60));
  console.warn('⚠️  CONFIGURATION WARNINGS:');
  warnings.forEach(w => console.warn(w));
  console.warn('='.repeat(60) + '\n');
}

// Credential encryption
if (!process.env.CREDENTIAL_MASTER_KEY) {
  warnings.push("  No CREDENTIAL_MASTER_KEY set - credential storage will be unavailable");
}

if (!process.env.LLM_MODEL) {
  console.info(`ℹ️  Using default LLM model: ${CONFIG.LLM_MODEL}`);
}

// Log successful configurations
console.log('\n' + '='.repeat(60));
console.log('✅ ACTIVE CONFIGURATIONS:');
if (CONFIG.isFinanceAvailable()) console.log('  ✓ Finance APIs configured');
if (CONFIG.OPENWEATHER_KEY) console.log('  ✓ Weather API configured');
if (CONFIG.SERPAPI_KEY) console.log('  ✓ Search API configured');
if (CONFIG.SPORTS_API_KEY) console.log('  ✓ Sports API configured');
if (CONFIG.YOUTUBE_API_KEY) console.log('  ✓ YouTube API configured');
if (CONFIG.isEmailAvailable()) {
  if (CONFIG.GOOGLE_CLIENT_ID) console.log('  ✓ Gmail OAuth configured');
  else if (CONFIG.SMTP_HOST) console.log('  ✓ SMTP configured');
  else console.log('  ✓ Email API configured');
}
if (CONFIG.isXAvailable()) console.log('  ✓ X/Twitter API configured');
if (CONFIG.SPOTIFY_CLIENT_ID && CONFIG.SPOTIFY_CLIENT_SECRET && CONFIG.SPOTIFY_REFRESH_TOKEN) console.log('  ✓ Spotify API configured');
if (CONFIG.CREDENTIAL_MASTER_KEY) console.log('  ✓ Credential encryption configured');
if (CONFIG.MOLTBOOK_BASE_URL !== 'https://moltbook.com') console.log(`  ✓ Moltbook URL: ${CONFIG.MOLTBOOK_BASE_URL}`);
if (CONFIG.GITHUB_TOKEN) console.log('  ✓ GitHub API configured');
if (CONFIG.OBSIDIAN_VAULT_PATH) console.log(`  ✓ Obsidian vault: ${CONFIG.OBSIDIAN_VAULT_PATH}`);
else console.log('  ℹ Obsidian vault not configured (set OBSIDIAN_VAULT_PATH)');
if (CONFIG.RESEARCH_LIBRARY_PATH) console.log(`  ✓ Research library: ${CONFIG.RESEARCH_LIBRARY_PATH}`);
if (CONFIG.CORE_API_KEY) console.log('  ✓ CORE academic API configured');
if (CONFIG.SEMANTIC_SCHOLAR_KEY) console.log('  ✓ Semantic Scholar API key configured (higher rate limits)');
console.log('='.repeat(60) + '\n');

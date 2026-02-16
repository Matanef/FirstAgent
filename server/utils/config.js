// server/utils/config.js
import 'dotenv/config';

/**
 * Centralized configuration with validation
 */

const warnings = [];

if (!process.env.SPORTS_API_KEY) {
  warnings.push("⚠️  SPORTS_API_KEY not set - sports tool will be unavailable");
}
if (!process.env.YOUTUBE_API_KEY) {
  warnings.push("⚠️  YOUTUBE_API_KEY not set - YouTube tool will be unavailable");
}
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
  warnings.push("⚠️  Google OAuth2 not fully configured - email tool will be unavailable");
}

// Finance
if (!process.env.ALPHA_VANTAGE_KEY && !process.env.FINNHUB_KEY) {
  warnings.push("⚠️  No finance API keys set - finance tool will be unavailable");
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

// Email
if (!process.env.EMAIL_API_KEY && !process.env.SMTP_HOST) {
  warnings.push("⚠️  No email configuration found - email tool will be unavailable");
}

export const CONFIG = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // LLM
  LLM_MODEL: process.env.LLM_MODEL || 'llama3.2',
  LLM_API_URL: process.env.LLM_API_URL || 'http://localhost:11434',

  // Agent Limits
  MAX_STEPS: parseInt(process.env.MAX_STEPS || '3'),
  TOOL_BUDGET_SEARCH: parseInt(process.env.TOOL_BUDGET_SEARCH || '3'),
  TOOL_BUDGET_FINANCE: parseInt(process.env.TOOL_BUDGET_FINANCE || '2'),
  TOOL_BUDGET_CALCULATOR: parseInt(process.env.TOOL_BUDGET_CALCULATOR || '1'),

  // Finance Providers
  FINANCE_PROVIDER: process.env.FINANCE_PROVIDER || 'alpha',
  ALPHA_VANTAGE_KEY: process.env.ALPHA_VANTAGE_KEY,
  FINNHUB_KEY: process.env.FINNHUB_KEY,

  // Search
  SERPAPI_KEY: process.env.SERPAPI_KEY,

  // Weather
  OPENWEATHER_KEY: process.env.OPENWEATHER_KEY,

  // Sports
  SPORTS_API_KEY: process.env.SPORTS_API_KEY,

  // YouTube
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,

  // Email (SMTP or API)
  EMAIL_API_KEY: process.env.EMAIL_API_KEY,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,

  // Google Auth
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,


  // Cache
  SEARCH_CACHE_TTL: parseInt(process.env.SEARCH_CACHE_TTL || '3600000'),

  isFinanceAvailable() {
    return !!(this.ALPHA_VANTAGE_KEY || this.FINNHUB_KEY);
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

if (!process.env.LLM_MODEL) {
  console.info(`ℹ️  Using default LLM model: ${CONFIG.LLM_MODEL}`);
}
// server/utils/config.js
import 'dotenv/config';

/**
 * Centralized configuration with validation
 */

const warnings = [];

// Validate finance providers
if (!process.env.ALPHA_VANTAGE_KEY && !process.env.FINNHUB_KEY) {
  warnings.push("⚠️  No finance API keys set - finance tool will be unavailable");
}

// Validate search
if (!process.env.SERPAPI_KEY) {
  warnings.push("⚠️  SERPAPI_KEY not set - search features may be limited");
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
  FINANCE_PROVIDER: process.env.FINANCE_PROVIDER || 'alpha', // alpha | finnhub

  ALPHA_VANTAGE_KEY: process.env.ALPHA_VANTAGE_KEY,
  FINNHUB_KEY: process.env.FINNHUB_KEY,

  // Search
  SERPAPI_KEY: process.env.SERPAPI_KEY,

  // Critical Tools
  CRITICAL_TOOLS: (process.env.CRITICAL_TOOLS || 'finance').split(','),

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
  console.log("Alpha Vantage Key:", CONFIG.ALPHA_VANTAGE_KEY);
  console.log("Finnhub Key:", CONFIG.FINNHUB_KEY);
  console.log("Finance Provider:", CONFIG.FINANCE_PROVIDER);
}

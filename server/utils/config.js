// server/utils/config.js
import 'dotenv/config';

/**
 * Centralized configuration with validation
 */

const requiredEnvVars = {
  FMP_API_KEY: process.env.FMP_API_KEY,
  SERPAPI_KEY: process.env.SERPAPI_KEY
};

const warnings = [];

// Validate required environment variables
for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    warnings.push(`⚠️  ${key} not set - ${key.toLowerCase().includes('fmp') ? 'finance' : 'search'} features will be unavailable`);
  }
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

  // API Keys
  FMP_API_KEY: process.env.FMP_API_KEY,
  SERPAPI_KEY: process.env.SERPAPI_KEY,

  // Critical Tools (won't fallback to LLM if these fail)
  CRITICAL_TOOLS: (process.env.CRITICAL_TOOLS || 'finance').split(','),

  // Cache
  SEARCH_CACHE_TTL: parseInt(process.env.SEARCH_CACHE_TTL || '3600000'), // 1 hour

  // Validation
  isValid() {
    return this.FMP_API_KEY && this.SERPAPI_KEY;
  },

  getWarnings() {
    return warnings;
  }
};

// Log warnings on startup
if (warnings.length > 0) {
  console.warn('\n' + '='.repeat(60));
  console.warn('⚠️  CONFIGURATION WARNINGS:');
  warnings.forEach(w => console.warn(w));
  console.warn('='.repeat(60) + '\n');
}

// Validate LLM settings
if (!process.env.LLM_MODEL) {
  console.info(`ℹ️  Using default LLM model: ${CONFIG.LLM_MODEL}`);
}


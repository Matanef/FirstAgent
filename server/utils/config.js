export const CONFIG = {
  MAX_STEPS: 5,
  TOOL_BUDGET: 3,

  FMP_API_KEY: process.env.FMP_API_KEY,
  SERPAPI_KEY: process.env.SERPAPI_KEY,

  CRITICAL_TOOLS: ["finance"]
};

if (!CONFIG.FMP_API_KEY) {
  console.warn("⚠️ FMP_API_KEY not set.");
}

if (!CONFIG.SERPAPI_KEY) {
  console.warn("⚠️ SERPAPI_KEY not set.");
}

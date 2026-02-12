import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

export async function getTopStocks(limit = 10) {
  if (!CONFIG.FMP_API_KEY) {
    return { error: "Missing API key", results: [] };
  }

  // Free tier compatible endpoint
  const url = `https://financialmodelingprep.com/api/v3/sp500_constituent?apikey=${CONFIG.FMP_API_KEY}`;
  console.log("Using FMP key:", CONFIG.FMP_API_KEY);

  const data = await safeFetch(url);

  if (!data || !Array.isArray(data)) {
    return { error: "Invalid financial data", results: [] };
  }

  // Sort by market cap descending (if available)
  const sorted = data
    .filter(s => s.marketCap)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, limit)
    .map(s => ({
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      marketCap: s.marketCap
    }));

  return { results: sorted };
}

import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

export async function getTopStocks(params = {}) {
  const { sector = null, limit = 10 } = params;

  if (!CONFIG.FMP_API_KEY) {
    return { error: "Missing API key", results: [] };
  }

  let url = `https://financialmodelingprep.com/api/v3/stock-screener?marketCapMoreThan=10000000000&limit=100&apikey=${CONFIG.FMP_API_KEY}`;

  if (sector) {
    url = `https://financialmodelingprep.com/api/v3/stock-screener?sector=${encodeURIComponent(
      sector
    )}&limit=100&apikey=${CONFIG.FMP_API_KEY}`;
  }

  const data = await safeFetch(url);

  if (!data || !Array.isArray(data)) {
    return { error: "Finance API unavailable", results: [] };
  }

  const sorted = data
    .filter(s => s.marketCap)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, limit)
    .map(s => ({
      symbol: s.symbol,
      name: s.companyName,
      sector: s.sector,
      industry: s.industry,
      marketCap: s.marketCap,
      price: s.price
    }));

  return { results: sorted };
}

export async function getStockPrice(symbol) {
  if (!CONFIG.FMP_API_KEY) {
    return { error: "Missing API key" };
  }

  const url = `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${CONFIG.FMP_API_KEY}`;
  const data = await safeFetch(url);

  if (!data || !Array.isArray(data) || data.length === 0) {
    return { error: "No stock data found" };
  }

  return data[0];
}

import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

export async function getTopStocks(limit = 10) {
  if (!CONFIG.FMP_API_KEY) {
    return { error: "Missing API key", results: [] };
  }

  const url = `https://financialmodelingprep.com/api/v3/stock_market/actives?apikey=${CONFIG.FMP_API_KEY}`;

  const data = await safeFetch(url);

  if (!data || !Array.isArray(data)) {
    return { error: "Invalid financial data", results: [] };
  }

  const results = data.slice(0, limit).map(s => ({
    symbol: s.symbol,
    name: s.name,
    price: s.price,
    change: s.change
  }));

  return { results };
}

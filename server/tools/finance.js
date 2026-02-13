// server/tools/finance.js
// Finance tool using Financial Modeling Prep API
// Structured deterministic return format

import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

export async function finance(params = {}) {
  const { type = "top", symbol = null, sector = null, limit = 5 } = params;

  if (!CONFIG.FMP_API_KEY) {
    return {
      tool: "finance",
      success: false,
      final: true,
      error: "Missing FMP API key"
    };
  }

  try {
    if (type === "price" && symbol) {
      const url = `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${CONFIG.FMP_API_KEY}`;
      const data = await safeFetch(url);

      if (!data || !Array.isArray(data) || data.length === 0) {
        return {
          tool: "finance",
          success: false,
          final: true,
          error: "No stock data found"
        };
      }

      return {
        tool: "finance",
        success: true,
        final: true,
        data: {
          type: "price",
          stock: data[0]
        }
      };
    }

    // default: top stocks
    let url = `https://financialmodelingprep.com/api/v3/stock-screener?marketCapMoreThan=10000000000&limit=100&apikey=${CONFIG.FMP_API_KEY}`;

    if (sector) {
      url = `https://financialmodelingprep.com/api/v3/stock-screener?sector=${encodeURIComponent(
        sector
      )}&limit=100&apikey=${CONFIG.FMP_API_KEY}`;
    }

    const data = await safeFetch(url);

    if (!data || !Array.isArray(data)) {
      return {
        tool: "finance",
        success: false,
        final: true,
        error: "Finance API unavailable"
      };
    }

    const results = data
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

    return {
      tool: "finance",
      success: true,
      final: true,
      data: {
        type: "top",
        results
      }
    };

  } catch (err) {
    return {
      tool: "finance",
      success: false,
      final: true,
      error: "Finance request failed"
    };
  }
}

// server/tools/finance.js
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

function extractTickers(text) {
  const matches = text.match(/\b[A-Z]{1,5}\b/g);
  return matches || [];
}

export async function finance(query) {
  if (!CONFIG.FMP_API_KEY) {
    return {
      tool: "finance",
      success: false,
      final: true,
      error: "Missing FMP API key"
    };
  }

  try {
    const tickers = extractTickers(query);

    if (!tickers.length) {
      return {
        tool: "finance",
        success: false,
        final: true,
        error: "No stock ticker found"
      };
    }

    const results = [];

    for (const ticker of tickers) {
      const url = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${CONFIG.FMP_API_KEY}`;
      const data = await safeFetch(url);

      if (data && data[0]) {
        results.push({
          symbol: data[0].symbol,
          price: data[0].price,
          change: data[0].change,
          change_percent: data[0].changesPercentage
        });
      }
    }

    const summary = results.map(r =>
      `${r.symbol}: $${r.price} (${r.change_percent}%)`
    ).join("\n");

    return {
      tool: "finance",
      success: true,
      final: true,
      data: {
        stocks: results,
        text: `Stock information:\n${summary}`
      }
    };

  } catch (err) {
    return {
      tool: "finance",
      success: false,
      final: true,
      error: err.message
    };
  }
}

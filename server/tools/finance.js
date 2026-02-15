// server/tools/finance.js
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

/**
 * Extract uppercase tickers (1–5 letters)
 */
function extractTickers(text) {
  const matches = text.match(/\b[A-Z]{1,5}\b/g);
  return matches || [];
}

/**
 * Alpha Vantage fetcher
 */
async function fetchAlpha(symbol) {
  if (!CONFIG.ALPHA_VANTAGE_KEY) return null;

  const url =
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${CONFIG.ALPHA_VANTAGE_KEY}`;

  const data = await safeFetch(url);

  if (!data || !data["Global Quote"]) return null;

  return {
    symbol,
    price: data["Global Quote"]["05. price"],
    change_percent: data["Global Quote"]["10. change percent"]
  };
}

/**
 * Finnhub fetcher
 */
async function fetchFinnhub(symbol) {
  if (!CONFIG.FINNHUB_KEY) return null;

  const url =
    `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${CONFIG.FINNHUB_KEY}`;

  const data = await safeFetch(url);

  if (!data || data.c === undefined) return null;

  return {
    symbol,
    price: data.c,
    change_percent: data.dp + "%"
  };
}

/**
 * Main finance tool
 * Accepts a raw query string, extracts tickers, fetches data, returns summary.
 */
export async function finance(query) {
  if (!CONFIG.isFinanceAvailable()) {
    return {
      tool: "finance",
      success: false,
      final: true,
      error: "No finance API keys configured"
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

    for (const symbol of tickers) {
      let data = null;

      // Primary provider
      if (CONFIG.FINANCE_PROVIDER === "alpha") {
        data = await fetchAlpha(symbol);
        if (!data) data = await fetchFinnhub(symbol);
      } else {
        data = await fetchFinnhub(symbol);
        if (!data) data = await fetchAlpha(symbol);
      }

      if (data) results.push(data);
    }

    if (!results.length) {
      return {
        tool: "finance",
        success: false,
        final: true,
        error: "Failed to fetch stock data"
      };
    }

    const summary = results
      .map(r => `${r.symbol}: $${r.price} (${r.change_percent})`)
      .join("\n");

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
// server/tools/finance.js
import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";

/**
 * Company name → ticker symbol mapping
 */
const COMPANY_TO_TICKER = {
  tesla: "TSLA", apple: "AAPL", google: "GOOGL", alphabet: "GOOGL",
  amazon: "AMZN", microsoft: "MSFT", meta: "META", nvidia: "NVDA",
  amd: "AMD", intel: "INTC", netflix: "NFLX", disney: "DIS",
  boeing: "BA", ford: "F", paypal: "PYPL", uber: "UBER",
  spotify: "SPOT", shopify: "SHOP", twitter: "X", snap: "SNAP",
  coinbase: "COIN", palantir: "PLTR", rivian: "RIVN", lucid: "LCID",
  // Cybersecurity
  "check point": "CHKP", checkpoint: "CHKP", fortinet: "FTNT",
  "palo alto": "PANW", crowdstrike: "CRWD", zscaler: "ZS",
  sentinelone: "S", "sentinel one": "S", cyberark: "CYBR",
  // Finance & Banking
  "jp morgan": "JPM", jpmorgan: "JPM", "goldman sachs": "GS",
  "bank of america": "BAC", visa: "V", mastercard: "MA",
  // Healthcare
  pfizer: "PFE", moderna: "MRNA", "johnson & johnson": "JNJ",
  unitedhealth: "UNH", abbvie: "ABBV",
  // Other major
  walmart: "WMT", costco: "COST", starbucks: "SBUX",
  "coca cola": "KO", pepsi: "PEP", salesforce: "CRM",
  oracle: "ORCL", adobe: "ADBE", broadcom: "AVGO"
};

/**
 * Common English stopwords to filter out from uppercase matches
 */
const TICKER_STOPWORDS = new Set([
  "I", "A", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "IF", "IN",
  "IS", "IT", "MY", "NO", "OF", "ON", "OR", "SO", "TO", "UP", "WE",
  "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HAD",
  "HER", "WAS", "ONE", "OUR", "OUT", "HOW", "HAS", "ITS", "HIS", "HIM",
  "GET", "GOT", "LET", "MAY", "NEW", "NOW", "OLD", "SEE", "WAY", "WHO",
  "DID", "SAY", "SHE", "TWO", "USE", "HEY", "SHOW", "TELL", "WHAT",
  "WHEN", "WELL", "ALSO", "BACK", "BEEN", "COME", "EACH", "FIND",
  "FROM", "GIVE", "HAVE", "HERE", "HIGH", "JUST", "KNOW", "LAST",
  "LIKE", "LONG", "LOOK", "MAKE", "MANY", "MUCH", "MUST", "NAME",
  "OVER", "PART", "SOME", "TAKE", "THAN", "THAT", "THEM", "THEN",
  "THIS", "TIME", "VERY", "WILL", "WITH", "WORK", "YEAR", "YOUR",
  "DOES", "DONE", "GOOD", "BEST", "REAL", "FREE", "HELP", "KEEP"
]);

/**
 * Extract tickers from text — supports both direct symbols and company names
 */
function extractTickers(text) {
  const tickers = [];

  // 1. Direct ticker symbols (uppercase 1-5 letters, filtered)
  const directMatches = text.match(/\b[A-Z]{1,5}\b/g) || [];
  for (const m of directMatches) {
    if (!TICKER_STOPWORDS.has(m) && !tickers.includes(m)) {
      tickers.push(m);
    }
  }

  // 2. Company name → ticker resolution
  const lower = text.toLowerCase();
  for (const [name, ticker] of Object.entries(COMPANY_TO_TICKER)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(lower) && !tickers.includes(ticker)) {
      tickers.push(ticker);
    }
  }

  // 3. S&P 500 special handling (avoid splitting "S" and "P")
  if (/s\s*&\s*p\s*500|s&p/i.test(lower) && !tickers.includes("SPY")) {
    tickers.push("SPY");
    // Remove any erroneous "S" or "P" entries that came from splitting "S&P"
    const sIdx = tickers.indexOf("S");
    if (sIdx !== -1) tickers.splice(sIdx, 1);
    const pIdx = tickers.indexOf("P");
    if (pIdx !== -1) tickers.splice(pIdx, 1);
  }

  return tickers;
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
 * Build an HTML table for stock price results
 */
function buildStockHtml(results) {
  const rows = results.map(r => {
    const price = r.price != null ? `$${r.price}` : "-";
    const change = r.change_percent || "-";
    const isPositive = String(change).includes("-") ? false : true;
    const changeClass = isPositive ? "stock-up" : "stock-down";
    return `<tr>
      <td><strong>${r.symbol}</strong></td>
      <td>${price}</td>
      <td class="${changeClass}">${change}</td>
    </tr>`;
  }).join("");

  return `<table class="finance-table">
    <thead><tr><th>Symbol</th><th>Price</th><th>Change</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
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
        error: `Failed to fetch stock data for: ${tickers.join(", ")}. The API did not return results for these tickers.`
      };
    }

    // Build HTML table
    const html = buildStockHtml(results);

    const summary = results
      .map(r => `${r.symbol}: $${r.price} (${r.change_percent})`)
      .join("\n");

    return {
      tool: "finance",
      success: true,
      final: true,
      data: {
        stocks: results,
        html,
        text: `Stock information:\n${summary}`,
        preformatted: true
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
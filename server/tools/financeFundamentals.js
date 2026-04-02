// server/tools/financeFundamentals.js

import { safeFetch } from "../utils/fetch.js";
import { CONFIG } from "../utils/config.js";
import { search } from "./search.js";
import { getCache } from "../utils/cache.js";
import { fetchYahooQuote, fetchYahooHistory } from "../utils/yahoo.js";
import { fetchTradingViewSnapshot } from "../utils/tradingview.js";

const FUND_CACHE = getCache("fundamentals", Number(process.env.SEARCH_CACHE_TTL || 3600000));

/**
 * Normalize numeric strings like "4.442T", "1.2B", "500M", "51,268,269".
 */
function normalizeNumber(str) {
  if (str == null) return null;
  if (typeof str === "number") return str.toString();

  const s = String(str).replace(/[, ]/g, "");
  const m = s.match(/^([\$€£]?)([0-9]*\.?[0-9]+)([MBT]|billion|million|trillion)?/i);
  if (!m) return s.trim();

  let value = parseFloat(m[2]);
  const unit = m[3]?.toLowerCase();

  if (unit === "m" || unit === "million") value *= 1e6;
  if (unit === "b" || unit === "billion") value *= 1e9;
  if (unit === "t" || unit === "trillion") value *= 1e12;

  return value.toString();
}

/**
 * Extract 52-week range as { low, high } from text.
 */
function extractRange(text) {
  if (!text) return { low: null, high: null };

  const m = text.match(/([0-9]+\.[0-9]+|[0-9]+)\s*[-–]\s*([0-9]+\.[0-9]+|[0-9]+)/);
  if (!m) {
    const single = text.match(/([0-9]+\.[0-9]+|[0-9]+)/);
    if (!single) return { low: null, high: null };
    return { low: single[1], high: single[1] };
  }

  return { low: m[1], high: m[2] };
}

/**
 * FMP fundamentals (single snapshot)
 */
async function fetchFMPFundamentals(symbol) {
  if (!CONFIG.FMP_API_KEY) return null;
  const url = `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(symbol)}?apikey=${CONFIG.FMP_API_KEY}`;
  const data = await safeFetch(url);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;

  return {
    marketCap: row.mktCap ?? null,
    peRatio: row.pe ?? null,
    dividendYield: row.lastDiv ? `${row.lastDiv}%` : null,
    eps: row.eps ?? null,
    beta: row.beta ?? null,
    week52High: row.range?.split("-")[1]?.trim() ?? null,
    week52Low: row.range?.split("-")[0]?.trim() ?? null,
    volume: row.volAvg ?? null,
    analystRating: row.rating ?? null,
    analystTarget: row.priceTarget ?? null
  };
}

/**
 * AlphaVantage fundamentals (very limited; mostly price/PE via other endpoints)
 * You can extend this later with more specific functions.
 */
async function fetchAlphaFundamentals(symbol) {
  if (!CONFIG.ALPHA_VANTAGE_KEY) return null;
  const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${CONFIG.ALPHA_VANTAGE_KEY}`;
  const data = await safeFetch(url);
  if (!data || !data.Symbol) return null;

  return {
    marketCap: data.MarketCapitalization ?? null,
    peRatio: data.PERatio ?? null,
    dividendYield: data.DividendYield ? `${(Number(data.DividendYield) * 100).toFixed(2)}%` : null,
    eps: data.EPS ?? null,
    beta: data.Beta ?? null,
    week52High: data["52WeekHigh"] ?? null,
    week52Low: data["52WeekLow"] ?? null,
    volume: null,
    analystRating: data.AnalystRating ?? null,
    analystTarget: data.AnalystTargetPrice ?? null
  };
}

/**
 * Finnhub fundamentals (snapshot)
 */
async function fetchFinnhubFundamentals(symbol) {
  if (!CONFIG.FINNHUB_KEY) return null;
  const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${CONFIG.FINNHUB_KEY}`;
  const data = await safeFetch(url);
  const m = data?.metric;
  if (!m) return null;

  return {
    marketCap: m.marketCapitalization ?? null,
    peRatio: m.peTTM ?? null,
    dividendYield: m.dividendYieldIndicatedAnnual ? `${m.dividendYieldIndicatedAnnual}%` : null,
    eps: m.epsTTM ?? null,
    beta: m.beta ?? null,
    week52High: m["52WeekHigh"] ?? null,
    week52Low: m["52WeekLow"] ?? null,
    volume: null,
    analystRating: null,
    analystTarget: m.targetMean ?? null
  };
}

/**
 * Fallback: extract fundamentals from web search results using your existing search tool.
 */
async function fetchFromSearchFallback(symbol) {
  const query = `${symbol} stock key statistics market cap pe ratio dividend yield 52 week range volume beta`;
  const result = await search(query);

  const data = result?.data || {};
  const results = data.results || [];

  const mergedText = [
    data.text || "",
    ...results.map(r => `${r.title} ${r.snippet || ""}`)
  ].join("\n");

  function extract(pattern) {
    const m = mergedText.match(pattern);
    return m ? m[1].trim() : null;
  }

  const marketCapRaw = extract(/market cap[^0-9$]*([\$€£]?[0-9\.,]+\s*(?:[MBT]|billion|million|trillion)?)/i);
  const peRaw =
    extract(/P\/E[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i) ||
    extract(/PE ratio[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i);
  const divRaw = extract(/dividend yield[^0-9]*([0-9]+\.[0-9]+%|[0-9]+%)/i);
  const epsRaw = extract(/EPS[^0-9\-]*(-?[0-9]+\.[0-9]+|-?[0-9]+)/i);
  const rangeRaw = extract(/52[-\s]?week (?:range|high|low)[^0-9]*([0-9\.\s\-–]+)/i);
  const volRaw = extract(/volume[^0-9]*([0-9,]+\s*(?:[MBT]|million|billion|trillion)?)/i);
  const betaRaw = extract(/beta[^0-9]*([0-9]+\.[0-9]+|[0-9]+)/i);
  const ratingRaw = extract(/(strong buy|buy|hold|sell|strong sell)/i);
  const targetRaw = extract(/price target[^0-9]*([\$€£]?[0-9\.,]+)/i);

  const range = extractRange(rangeRaw || "");

  return {
    marketCap: marketCapRaw || null,
    marketCapNormalized: marketCapRaw ? normalizeNumber(marketCapRaw) : null,
    peRatio: peRaw,
    dividendYield: divRaw,
    eps: epsRaw,
    week52High: range.high,
    week52Low: range.low,
    volume: volRaw,
    beta: betaRaw,
    analystRating: ratingRaw,
    analystTarget: targetRaw
  };
}

/**
 * Merge fundamentals from multiple providers with a simple priority.
 */
function mergeFundamentals(symbol, sources) {
  const merged = {
    marketCap: null,
    marketCapNormalized: null,
    peRatio: null,
    dividendYield: null,
    eps: null,
    week52High: null,
    week52Low: null,
    volume: null,
    beta: null,
    analystRating: null,
    analystTarget: null
  };

  const order = ["yahoo", "fmp", "alpha", "finnhub", "search", "tradingview"];

  for (const key of order) {
    const src = sources[key];
    if (!src) continue;

    if (src.marketCap != null && merged.marketCap == null) {
      merged.marketCap = src.marketCap;
      merged.marketCapNormalized = normalizeNumber(src.marketCap);
    }
    if (src.peRatio != null && merged.peRatio == null) merged.peRatio = src.peRatio;
    if (src.dividendYield != null && merged.dividendYield == null) merged.dividendYield = src.dividendYield;
    if (src.eps != null && merged.eps == null) merged.eps = src.eps;
    if (src.week52High != null && merged.week52High == null) merged.week52High = src.week52High;
    if (src.week52Low != null && merged.week52Low == null) merged.week52Low = src.week52Low;
    if (src.volume != null && merged.volume == null) merged.volume = src.volume;
    if (src.beta != null && merged.beta == null) merged.beta = src.beta;
    if (src.analystRating != null && merged.analystRating == null) merged.analystRating = src.analystRating;
    if (src.analystTarget != null && merged.analystTarget == null) merged.analystTarget = src.analystTarget;
  }

  return merged;
}

/**
 * Company name → ticker symbol mapping
 */
const COMPANY_TO_TICKER = {
  tesla: "TSLA", apple: "AAPL", google: "GOOGL", alphabet: "GOOGL",
  amazon: "AMZN", microsoft: "MSFT", meta: "META", nvidia: "NVDA",
  amd: "AMD", intel: "INTC", netflix: "NFLX", disney: "DIS",
  boeing: "BA", ford: "F", paypal: "PYPL", uber: "UBER",
  spotify: "SPOT", shopify: "SHOP",
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

const TICKER_STOPWORDS = new Set([
  "I", "A", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "IF", "IN",
  "IS", "IT", "MY", "NO", "OF", "ON", "OR", "SO", "TO", "UP", "WE",
  "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HAD",
  "HER", "WAS", "ONE", "OUR", "OUT", "HOW", "HAS", "ITS", "HIS", "HIM",
  "GET", "GOT", "LET", "MAY", "NEW", "NOW", "OLD", "SEE", "WAY", "WHO",
  "DID", "SAY", "SHE", "TWO", "USE", "SHOW", "TELL", "WHAT", "WHEN",
  "WELL", "ALSO", "BACK", "BEEN", "COME", "EACH", "FIND", "FROM",
  "GIVE", "HAVE", "HERE", "HIGH", "JUST", "KNOW", "LAST", "LIKE",
  "LONG", "LOOK", "MAKE", "MANY", "MUCH", "MUST", "NAME", "OVER",
  "PART", "SOME", "TAKE", "THAN", "THAT", "THEM", "THEN", "THIS",
  "TIME", "VERY", "WILL", "WITH", "WORK", "YEAR", "YOUR", "DOES",
  "DONE", "GOOD", "BEST", "REAL", "FREE", "HELP", "KEEP", "ME"
]);

/**
 * Normalize ticker symbols from user input — supports company names.
 */
function extractTickers(message) {
  const tickers = new Set();

  // Strip financial terms that look like tickers before extraction
  // P/E, EPS, PE, ROI, ROE, YTD, etc.
  const cleaned = message
    .replace(/\bP\s*[\/\\]\s*E\b/g, "")     // P/E ratio
    .replace(/\bEPS\b/g, "")                  // Earnings per share
    .replace(/\bROI\b/g, "")                  // Return on investment
    .replace(/\bROE\b/g, "")                  // Return on equity
    .replace(/\bYTD\b/g, "")                  // Year to date
    .replace(/\bIPO\b/g, "")                  // Initial public offering
    .replace(/\bETF\b/g, "")                  // Exchange traded fund
    .replace(/\bPE\b/g, "");                  // P/E without slash

  // Parenthesized tickers: (TSLA)
  const parenMatches = cleaned.match(/\(([A-Z]{1,5})\)/g) || [];
  for (const m of parenMatches) {
    const t = m.replace(/[()]/g, "");
    if (!TICKER_STOPWORDS.has(t)) tickers.add(t);
  }

  // Uppercase word tickers (filtered)
  const wordMatches = cleaned.match(/\b[A-Z]{1,5}\b/g) || [];
  for (const w of wordMatches) {
    if (!TICKER_STOPWORDS.has(w)) tickers.add(w);
  }

  // Company name resolution
  const lower = message.toLowerCase();
  for (const [name, ticker] of Object.entries(COMPANY_TO_TICKER)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(lower)) {
      tickers.add(ticker);
    }
  }

  // S&P 500 special handling
  if (/s\s*&\s*p\s*500|s&p/i.test(lower)) {
    tickers.add("SPY");
    tickers.delete("S");
    tickers.delete("P");
  }

  return [...tickers];
}

/**
 * Build an HTML table for multi‑ticker fundamentals comparison.
 */
function buildFundamentalsHtml(tickers, fundamentals) {
  if (!tickers.length) return "";

  const headers = [
    "Ticker",
    "Market Cap",
    "P/E Ratio",
    "Dividend Yield",
    "EPS",
    "52W Low",
    "52W High",
    "Volume",
    "Beta",
    "Analyst Rating",
    "Analyst Target"
  ];

  const rows = tickers.map(ticker => {
    const f = fundamentals[ticker] || {};
    return `
      <tr>
        <td>${ticker}</td>
        <td>${f.marketCap ?? "-"}</td>
        <td>${f.peRatio ?? "-"}</td>
        <td>${f.dividendYield ?? "-"}</td>
        <td>${f.eps ?? "-"}</td>
        <td>${f.week52Low ?? "-"}</td>
        <td>${f.week52High ?? "-"}</td>
        <td>${f.volume ?? "-"}</td>
        <td>${f.beta ?? "-"}</td>
        <td>${f.analystRating ?? "-"}</td>
        <td>${f.analystTarget ?? "-"}</td>
      </tr>
    `;
  }).join("");

  return `
    <table class="fundamentals-table">
      <thead>
        <tr>
          ${headers.map(h => `<th>${h}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

/**
 * Build multi‑ticker comparison chart data (PE & EPS over time).
 * For now we use Yahoo price history + latest EPS as a simple approximation.
 */
async function buildComparisonChartData(tickers, fundamentals) {
  const labelsSet = new Set();
  const peSeries = {};
  const epsSeries = {};

  for (const ticker of tickers) {
    const hist = await fetchYahooHistory(ticker);
    if (!hist) continue;

    const eps = Number(fundamentals[ticker]?.eps || 0) || null;
    peSeries[ticker] = [];
    epsSeries[ticker] = [];

    for (let i = 0; i < hist.labels.length; i++) {
      const label = hist.labels[i];
      const price = hist.prices[i];
      labelsSet.add(label);

      // naive PE approximation: price / latest EPS
      const pe = eps ? price / eps : null;

      peSeries[ticker].push(pe);
      epsSeries[ticker].push(eps);
    }
  }

  const labels = Array.from(labelsSet).sort();

  return {
    labels,
    series: {
      pe: peSeries,
      eps: epsSeries
    }
  };
}

/**
 * Main fundamentals tool
 */
export async function financeFundamentals(message) {
  const tickers = extractTickers(message);

  if (!tickers.length) {
    return {
      tool: "finance-fundamentals",
      success: false,
      final: true,
      error: "No valid tickers found in the request."
    };
  }

  const cacheKey = tickers.sort().join(",");
  const cached = FUND_CACHE.get(cacheKey);
  if (cached) {
    return {
      tool: "finance-fundamentals",
      success: true,
      final: true,
      data: cached.data,
      reasoning: cached.reasoning
    };
  }

  const fundamentals = {};

  for (const ticker of tickers) {
    // Tier 1: Direct finance APIs (fast, structured, low cost)
    const [fmp, alpha, finnhub] = await Promise.all([
      fetchFMPFundamentals(ticker),
      fetchAlphaFundamentals(ticker),
      fetchFinnhubFundamentals(ticker)
    ]);

    // Check if Tier 1 got enough data (at least marketCap or peRatio)
    const tier1 = mergeFundamentals(ticker, { fmp, alpha, finnhub });
    const hasCoreData = tier1.marketCap != null || tier1.peRatio != null;

    // Tier 2: Only fetch Yahoo, TradingView, and search if Tier 1 is insufficient
    let yahoo = null, tv = null, searchFallback = null;
    if (!hasCoreData) {
      console.log(`[financeFundamentals] Tier 1 insufficient for ${ticker}, fetching Tier 2...`);
      [yahoo, tv, searchFallback] = await Promise.all([
        fetchYahooQuote(ticker),
        fetchTradingViewSnapshot(ticker),
        fetchFromSearchFallback(ticker)
      ]);
    } else {
      // Still try Yahoo for quote data (it's fast) but skip expensive search
      yahoo = await fetchYahooQuote(ticker).catch(() => null);
    }

    fundamentals[ticker] = mergeFundamentals(ticker, {
      yahoo,
      fmp,
      alpha,
      finnhub,
      tradingview: tv,
      search: searchFallback
    });
  }

  // Validate: flag tickers where ALL data fields are null (no real data fetched)
  const validTickers = [];
  const failedTickers = [];
  for (const ticker of tickers) {
    const f = fundamentals[ticker];
    const hasAnyData = f && Object.entries(f).some(([k, v]) => k !== "marketCapNormalized" && v != null);
    if (hasAnyData) {
      validTickers.push(ticker);
    } else {
      failedTickers.push(ticker);
      console.warn(`[financeFundamentals] ⚠️ No data returned for ${ticker} — all fields null`);
    }
  }

  if (!validTickers.length) {
    return {
      tool: "finance-fundamentals",
      success: false,
      final: true,
      error: `Could not fetch fundamentals for: ${tickers.join(", ")}. All API sources returned no data.`
    };
  }

  const html = buildFundamentalsHtml(validTickers, fundamentals);
  const chartData = await buildComparisonChartData(tickers, fundamentals);

  const failedNote = failedTickers.length
    ? `\n⚠️ No data available for: ${failedTickers.join(", ")}`
    : "";

  const payload = {
    tickers: validTickers,
    failedTickers,
    fundamentals,
    html: html + (failedTickers.length
      ? `<p class="finance-warning">⚠️ No data available for: ${failedTickers.join(", ")}</p>`
      : ""),
    charts: {
      type: "multi-ticker-comparison",
      metrics: ["pe", "eps"],
      data: chartData
    }
  };

  const reasoning =
    "Aggregated fundamentals from Yahoo, FMP, AlphaVantage, Finnhub, and search fallback, " +
    "then built a multi-ticker comparison table and PE/EPS chart data.";

  FUND_CACHE.set(cacheKey, { data: payload, reasoning });

  return {
    tool: "finance-fundamentals",
    success: true,
    final: true,
    data: payload,
    reasoning
  };
}
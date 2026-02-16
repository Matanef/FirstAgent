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
 * Normalize ticker symbols from user input.
 */
function extractTickers(message) {
  const tickers = new Set();

  const parenMatches = message.match(/\(([A-Z]{1,5})\)/g) || [];
  for (const m of parenMatches) {
    const t = m.replace(/[()]/g, "");
    tickers.add(t);
  }

  const wordMatches = message.match(/\b[A-Z]{1,5}\b/g) || [];
  for (const w of wordMatches) {
    tickers.add(w);
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
    const [yahoo, fmp, alpha, finnhub, tv, searchFallback] = await Promise.all([
      fetchYahooQuote(ticker),
      fetchFMPFundamentals(ticker),
      fetchAlphaFundamentals(ticker),
      fetchFinnhubFundamentals(ticker),
      fetchTradingViewSnapshot(ticker),
      fetchFromSearchFallback(ticker)
    ]);

    fundamentals[ticker] = mergeFundamentals(ticker, {
      yahoo,
      fmp,
      alpha,
      finnhub,
      tradingview: tv,
      search: searchFallback
    });
  }

  const html = buildFundamentalsHtml(tickers, fundamentals);
  const chartData = await buildComparisonChartData(tickers, fundamentals);

  const payload = {
    tickers,
    fundamentals,
    html,
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
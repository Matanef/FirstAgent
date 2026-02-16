// server/utils/yahoo.js
import { safeFetch } from "./fetch.js";

const YF_BASE = "https://query1.finance.yahoo.com";

export async function fetchYahooQuote(symbol) {
  const url = `${YF_BASE}/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const data = await safeFetch(url);
  const result = data?.quoteResponse?.result?.[0];
  if (!result) return null;

  return {
    symbol: result.symbol,
    marketCap: result.marketCap ?? null,
    peRatio: result.trailingPE ?? null,
    eps: result.epsTrailingTwelveMonths ?? null,
    beta: result.beta ?? null,
    week52High: result.fiftyTwoWeekHigh ?? null,
    week52Low: result.fiftyTwoWeekLow ?? null,
    volume: result.regularMarketVolume ?? null
  };
}

// very lightweight “history” via Yahoo chart API (PE/EPS approximated from EPS + price)
export async function fetchYahooHistory(symbol) {
  const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=3mo`;
  const data = await safeFetch(url);
  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  const labels = [];
  const prices = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const price = closes[i];
    if (!ts || price == null) continue;
    const d = new Date(ts * 1000);
    labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    prices.push(price);
  }

  return { labels, prices };
}

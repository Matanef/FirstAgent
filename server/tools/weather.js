// D:\local-llm-ui\server\tools\weather.js
// Weather tool with temperature recording & seasonal history

import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";
import { getMemory } from "../memory.js";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_DIR = path.resolve(__dirname, "..", "data", "weather");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");

// ── History persistence ──

function ensureHistoryDir() {
  if (!fsSync.existsSync(HISTORY_DIR)) {
    fsSync.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function loadHistory() {
  ensureHistoryDir();
  try {
    if (fsSync.existsSync(HISTORY_FILE)) {
      return JSON.parse(fsSync.readFileSync(HISTORY_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("[weather] Could not load history:", e.message);
  }
  return { recordings: [] };
}

async function saveHistory(history) {
  ensureHistoryDir();
  const tmp = HISTORY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(history, null, 2), "utf8");
  await fs.rename(tmp, HISTORY_FILE);
}

async function recordTemperature(city, country, temp, feelsLike, humidity, windSpeed, description) {
  try {
    const history = loadHistory();
    history.recordings.push({
      city,
      country,
      temp,
      feelsLike,
      humidity,
      windSpeed,
      description,
      ts: new Date().toISOString()
    });
    // Keep last 2000 recordings (~2 months at 30min intervals)
    if (history.recordings.length > 2000) {
      history.recordings = history.recordings.slice(-2000);
    }
    await saveHistory(history);
    console.log(`🌡️ [weather] Recorded: ${city} ${temp}°C (${history.recordings.length} total)`);
  } catch (e) {
    console.warn("[weather] Failed to record temperature:", e.message);
  }
}

// ── Query type detection ──

function wantsForecast(query) {
  const text = typeof query === "string" ? query : query?.text || "";
  const lower = text.toLowerCase();
  return (
    lower.includes("5 day") ||
    lower.includes("five day") ||
    lower.includes("forecast") ||
    lower.includes("this week") ||
    lower.includes("next days")
  );
}

function wantsHistory(query) {
  const text = typeof query === "string" ? query : query?.text || "";
  const lower = text.toLowerCase();
  return /\b(history|trend|graph|record|seasonal|compare|past|yesterday|last\s+week|last\s+month|temperature\s+over|temps?\s+over|how\s+warm\s+was|how\s+cold\s+was)\b/i.test(lower);
}

// ── History analysis ──

function analyzeHistory(recordings, city, daysBack = 7) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const cityLower = city.toLowerCase();

  // Filter to requested city and time window
  const relevant = recordings.filter(r => {
    if (r.city.toLowerCase() !== cityLower) return false;
    return new Date(r.ts) >= cutoff;
  });

  if (relevant.length === 0) return null;

  const temps = relevant.map(r => r.temp);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;

  // Group by date for daily stats
  const byDate = {};
  for (const r of relevant) {
    const date = r.ts.split("T")[0];
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(r);
  }

  const dailyStats = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, recs]) => {
    const dayTemps = recs.map(r => r.temp);
    return {
      date,
      min: Math.min(...dayTemps),
      max: Math.max(...dayTemps),
      avg: +(dayTemps.reduce((a, b) => a + b, 0) / dayTemps.length).toFixed(1),
      readings: recs.length,
      conditions: [...new Set(recs.map(r => r.description).filter(Boolean))]
    };
  });

  // Seasonal comparison: same period last year (if data exists)
  const oneYearAgo = new Date(cutoff.getTime() - 365 * 24 * 60 * 60 * 1000);
  const oneYearAgoEnd = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const lastYearRecs = recordings.filter(r => {
    if (r.city.toLowerCase() !== cityLower) return false;
    const d = new Date(r.ts);
    return d >= oneYearAgo && d <= oneYearAgoEnd;
  });

  let seasonal = null;
  if (lastYearRecs.length > 0) {
    const lyTemps = lastYearRecs.map(r => r.temp);
    seasonal = {
      avg: +(lyTemps.reduce((a, b) => a + b, 0) / lyTemps.length).toFixed(1),
      min: Math.min(...lyTemps),
      max: Math.max(...lyTemps),
      readings: lastYearRecs.length,
      diff: +(avg - lyTemps.reduce((a, b) => a + b, 0) / lyTemps.length).toFixed(1)
    };
  }

  return {
    city,
    period: `${daysBack} day(s)`,
    from: cutoff.toISOString().split("T")[0],
    to: now.toISOString().split("T")[0],
    totalReadings: relevant.length,
    overall: { min: +min.toFixed(1), max: +max.toFixed(1), avg: +avg.toFixed(1) },
    daily: dailyStats,
    seasonal
  };
}

function buildHistoryText(analysis) {
  if (!analysis) return "No temperature history found for this city. History builds up automatically over time.";

  let text = `🌡️ **Temperature History: ${analysis.city}**\n`;
  text += `📅 ${analysis.from} → ${analysis.to} (${analysis.totalReadings} readings)\n\n`;
  text += `**Overall:** Min ${analysis.overall.min}°C | Max ${analysis.overall.max}°C | Avg ${analysis.overall.avg}°C\n\n`;

  text += `**Daily Breakdown:**\n`;
  for (const day of analysis.daily) {
    const conditions = day.conditions.length > 0 ? ` (${day.conditions.join(", ")})` : "";
    text += `  ${day.date}: ${day.min}°C – ${day.max}°C (avg ${day.avg}°C, ${day.readings} readings)${conditions}\n`;
  }

  if (analysis.seasonal) {
    const direction = analysis.seasonal.diff > 0 ? "warmer" : "cooler";
    text += `\n**Seasonal Comparison (vs same period last year):**\n`;
    text += `  Last year avg: ${analysis.seasonal.avg}°C | This year: ${analysis.overall.avg}°C\n`;
    text += `  → ${Math.abs(analysis.seasonal.diff)}°C ${direction} than last year\n`;
  }

  return text;
}

// ── Main weather tool ──

export async function weather(query) {
  if (!process.env.OPENWEATHER_KEY || !process.env.OPENWEATHER_KEY.trim()) {
    return {
      tool: "weather",
      success: false,
      final: true,
      error: "Weather API key not configured."
    };
  }

  try {
    let city = query?.context?.city || null;
    const text = typeof query === "string" ? query : query?.text || "";

    console.log("🌤️ Weather tool received:", { city, context: query?.context });

    if (city === "__USE_GEOLOCATION__" || !city) {
      try {
        const memory = await getMemory();
        const savedCity = memory.profile?.location || memory.profile?.city || null;
        if (savedCity) {
          city = savedCity;
          console.log(`🌤️ Using saved location from memory: ${city}`);
        }
      } catch (e) {
        console.warn("[weather] Could not read memory for location:", e.message);
      }
    }

    if (!city || city === "__USE_GEOLOCATION__") {
      return {
        tool: "weather",
        success: false,
        final: true,
        error: "No location saved. Please specify a city (e.g., 'weather in London') or save your location with 'remember my location is [city]'."
      };
    }

    // ── HISTORY MODE ──
    if (wantsHistory(query)) {
      const daysMatch = text.match(/(?:last|past)\s+(\d+)\s*days?/i);
      const daysBack = daysMatch ? parseInt(daysMatch[1]) : (text.toLowerCase().includes("month") ? 30 : 7);
      const history = loadHistory();
      const analysis = analyzeHistory(history.recordings, city, daysBack);
      const historyText = buildHistoryText(analysis);

      return {
        tool: "weather",
        success: true,
        final: true,
        data: {
          mode: "history",
          city,
          analysis,
          text: historyText,
          preformatted: true
        }
      };
    }

    const forecastMode = wantsForecast(query);

    const endpoint = forecastMode
      ? "https://api.openweathermap.org/data/2.5/forecast"
      : "https://api.openweathermap.org/data/2.5/weather";

    const url = `${endpoint}?q=${encodeURIComponent(city)}&units=metric&appid=${process.env.OPENWEATHER_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (res.status === 401) {
      return {
        tool: "weather",
        success: false,
        final: true,
        error: "Weather API error: 401 (Invalid API key)"
      };
    }

    if (res.status === 404) {
      return {
        tool: "weather",
        success: false,
        final: true,
        error: `I couldn't find weather data for "${city}". Please check the city name.`
      };
    }

    if (!res.ok) {
      return {
        tool: "weather",
        success: false,
        final: true,
        error: `Weather API error: ${res.status}`
      };
    }

    if (forecastMode) {
      const grouped = {};

      for (const entry of data.list) {
        const date = entry.dt_txt.split(" ")[0];
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push({
          time: entry.dt_txt,
          temp: entry.main.temp,
          feels_like: entry.main.feels_like,
          humidity: entry.main.humidity,
          wind_speed: entry.wind.speed,
          description: entry.weather?.[0]?.description
        });
      }

      return {
        tool: "weather",
        success: true,
        final: true,
        data: {
          mode: "forecast",
          city,
          country: data.city?.country,
          forecast: grouped,
          raw: data
        }
      };
    }

// ── CURRENT WEATHER + AUTO-RECORD ──
    const temp = data.main?.temp;
    const feelsLike = data.main?.feels_like;
    const humidity = data.main?.humidity;
    const windSpeed = data.wind?.speed;
    const description = data.weather?.[0]?.description;
    const country = data.sys?.country;

// =========================================================
    // 🚀 NEW: FETCH AIR QUALITY (AQI) & DUST/PARTICLE DATA
    // =========================================================
    let aqi = null;
    let aqi_description = null;
    let pm10 = null;
    let pm2_5 = null;
    
    // The first weather call gives us the lat/lon needed for the AQI call
    if (data.coord && data.coord.lat && data.coord.lon) {
      try {
        const aqiUrl = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${data.coord.lat}&lon=${data.coord.lon}&appid=${process.env.OPENWEATHER_KEY}`;
        const aqiRes = await fetch(aqiUrl);
        if (aqiRes.ok) {
          const aqiData = await aqiRes.json();
          if (aqiData.list && aqiData.list.length > 0) {
            aqi = aqiData.list[0].main.aqi; 
            pm10 = aqiData.list[0].components.pm10;     
            pm2_5 = aqiData.list[0].components.pm2_5;   
            
            // Map the OpenWeather scale (1-5) to English for the LLM
            const aqiMap = {
              1: "Good",
              2: "Fair",
              3: "Moderate",
              4: "Poor (High Pollution/Dust)",
              5: "Very Poor (Hazardous)"
            };
            aqi_description = aqiMap[aqi] || "Unknown";
            
            data.air_pollution = aqiData; 
          }
        }
      } catch (aqiErr) {
        console.warn("⚠️ [weather] Failed to fetch AQI data:", aqiErr.message);
      }
    }
    // =========================================================

// Record temperature in background (don't await — fire & forget)
    recordTemperature(city, country, temp, feelsLike, humidity, windSpeed, description);

    // =========================================================
    // 🎨 NEW: GENERATE THE WEATHER HTML WIDGET
    // =========================================================
    const weatherHtml = `
      <div class="weather-widget" style="background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 0.3rem;">
          <div style="font-size: 1.25rem; font-weight: 600; color: var(--text-primary);">📍 ${city}, ${country || ''}</div>
          <div style="font-size: 0.95rem; color: var(--text-secondary); text-transform: capitalize;">${description}</div>
          
          <div style="font-size: 0.85rem; color: var(--text-secondary); display: flex; gap: 1rem; margin-top: 0.5rem;">
            <span>💧 Humidity: ${humidity}%</span>
            <span>💨 Wind: ${windSpeed} m/s</span>
          </div>
          
          ${aqi_description ? `
          <div style="font-size: 0.85rem; color: var(--text-primary); margin-top: 0.3rem; background: var(--bg-secondary); padding: 0.3rem 0.6rem; border-radius: 4px; display: inline-block; width: fit-content; border: 1px solid var(--border);">
            🍃 Air Quality: <strong>${aqi_description}</strong> ${pm10 ? `| PM10: ${pm10}` : ''}
          </div>` : ''}
        </div>
        
        <div style="text-align: right;">
          <div style="font-size: 2.8rem; font-weight: bold; color: var(--accent); line-height: 1;">${Math.round(temp)}°C</div>
          <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.4rem;">Feels like ${Math.round(feelsLike)}°C</div>
        </div>
      </div>
    `;

    // THIS is the successful return block!
    return {
      tool: "weather",
      success: true,
      final: false, // <-- Correctly set to false
      data: {
        mode: "current",
        city,
        country,
        temp,
        feels_like: feelsLike,
        humidity,
        wind_speed: windSpeed,
        description,
        aqi,
        aqi_description,
        pm10,
        pm2_5,
        raw: data,
        html: weatherHtml, // <-- We now pass the widget to the coordinator!
        text: `Current weather in ${city}: ${temp}°C, ${description}. AQI: ${aqi_description || 'Unknown'}.`
      }
    };
  } catch (err) {
    // THIS is the error return block!
    return {
      tool: "weather",
      success: false, // <-- This should be false if it caught an error
      final: true,
      error: `Weather tool failed: ${err.message}`
    };
  }
}
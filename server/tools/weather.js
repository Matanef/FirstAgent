// server/tools/weather.js (unchanged behavior: never saves location; reads memory read-only)
import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";
import { getMemory } from "../memory.js";

// Detect if user wants a 5-day forecast
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

// STRICT city extraction
function extractCity(query) {
  const text = typeof query === "string" ? query : query?.text || "";
  const lower = text.toLowerCase().trim();

  // 1. Look for "in <city>"
  const inMatch = lower.match(/\bin\s+([a-zA-Z\s\-]+)$/);
  if (inMatch) return formatCity(inMatch[1]);

  // 2. Look for "for <city>"
  const forMatch = lower.match(/\bfor\s+([a-zA-Z\s\-]+)$/);
  if (forMatch) return formatCity(forMatch[1]);

  // 3. Try last two words ONLY if they look like a real city
  const words = lower.split(/\s+/);
  const lastTwo = words.slice(-2).join(" ");
  if (isLikelyCity(lastTwo)) return formatCity(lastTwo);

  // 4. Try last word
  const last = words[words.length - 1];
  if (isLikelyCity(last)) return formatCity(last);

  return null;
}

// Heuristic: Is this likely a city?
function isLikelyCity(text) {
  const blacklist = [
    "table", "please", "forecast", "weather", "temperature",
    "humidity", "rain", "snow", "wind", "week", "days",
    "next", "show", "it", "in", "for", "here", "the",
    "morning", "afternoon", "evening", "night"
  ];

  const cleaned = text.trim().toLowerCase();
  if (blacklist.includes(cleaned)) return false;
  if (!/^[a-zA-Z\s\-]+$/.test(cleaned)) return false;
  if (cleaned.length < 3) return false;
  return true;
}

// Capitalize each word
function formatCity(city) {
  return city.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Main weather tool (NEVER SAVES LOCATION)
export async function weather(query) {
  if (!CONFIG.OPENWEATHER_KEY) {
    return { tool: "weather", success: false, final: true, error: "Weather API key not configured." };
  }

  try {
    // 1. Determine city from multiple sources
    let city = query?.context?.city || null;
    const wasGeolocationAttempt = query?.context?.wasGeolocationAttempt;

    console.log("🌤️ Weather tool received:", { city, wasGeolocationAttempt });

    // If context explicitly set city to null but was a geo attempt
    if (!city && wasGeolocationAttempt) {
      console.log("📍 Geolocation failed, checking memory for saved location...");
      const memory = await getMemory();
      if (memory.profile?.location) {
        city = memory.profile.location;
        console.log("✅ Using saved location from profile:", city);
      } else {
        return {
          tool: "weather",
          success: false,
          final: true,
          error: "I couldn't determine your location. Please tell me your city, or say 'remember my location is [City]' so I can help you next time!",
          data: { suggestion: "Set your location by saying: 'remember my location is Tel Aviv'" }
        };
      }
    }

    // If caller set __USE_GEOLOCATION__ but didn't resolve it
    if (city === "__USE_GEOLOCATION__") city = null;

    // If still no city, try extraction from message
    if (!city) {
      city = extractCity(query);
      console.log("🔍 Extracted city from message:", city);
    }

    // Final check: do we have a city?
    if (!city) {
      return { tool: "weather", success: false, final: true, error: "No city detected. Please specify a location (e.g., 'weather in Paris') or set your location with 'remember my location is [City]'." };
    }

    // CRITICAL: NEVER SAVE LOCATION HERE

    // 2. Determine mode (current vs forecast)
    const forecastMode = wantsForecast(query);
    const endpoint = forecastMode ? "https://api.openweathermap.org/data/2.5/forecast" : "https://api.openweathermap.org/data/2.5/weather";
    const url = `${endpoint}?q=${encodeURIComponent(city)}&units=metric&appid=${CONFIG.OPENWEATHER_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    // 3. Error handling
    if (res.status === 401) return { tool: "weather", success: false, final: true, error: "Weather API error: 401 (Invalid API key or key not activated)" };
    if (res.status === 404) return { tool: "weather", success: false, final: true, error: `I couldn't find weather data for "${city}". Please check the city name.` };
    if (!res.ok) return { tool: "weather", success: false, final: true, error: `Weather API error: ${res.status}` };

    // 4. Forecast mode
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
      return { tool: "weather", success: true, final: true, data: { mode: "forecast", city, country: data.city?.country, forecast: grouped, raw: data } };
    }

    // 5. Current weather mode
    return {
      tool: "weather",
      success: true,
      final: true,
      data: {
        mode: "current",
        city,
        country: data.sys?.country,
        temp: data.main?.temp,
        feels_like: data.main?.feels_like,
        humidity: data.main?.humidity,
        wind_speed: data.wind?.speed,
        description: data.weather?.[0]?.description,
        raw: data
      }
    };
  } catch (err) {
    return { tool: "weather", success: false, final: true, error: `Weather tool failed: ${err.message}` };
  }
}
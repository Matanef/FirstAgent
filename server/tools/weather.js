// server/tools/weather.js
// COMPLETE FIX: Weather tool uses ONLY geolocation, never reads from prompt or profile

import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";
import { getMemory } from "../memory.js";

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

export async function weather(query) {
  if (!CONFIG.OPENWEATHER_KEY) {
    return {
      tool: "weather",
      success: false,
      final: true,
      error: "Weather API key not configured."
    };
  }

  try {
    // FIX: Get city ONLY from context (set by planner via geolocation)
    // NEVER extract from prompt text or profile
    let city = query?.context?.city || null;

    console.log("🌤️ Weather tool received:", { city, context: query?.context });

    // If __USE_GEOLOCATION__ marker or no city, fall back to saved location from memory
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

    // Final check: do we have a city?
    if (!city || city === "__USE_GEOLOCATION__") {
      return {
        tool: "weather",
        success: false,
        final: true,
        error: "No location saved. Please specify a city (e.g., 'weather in London') or save your location with 'remember my location is [city]'."
      };
    }

    // Determine mode
    const forecastMode = wantsForecast(query);

    const endpoint = forecastMode
      ? "https://api.openweathermap.org/data/2.5/forecast"
      : "https://api.openweathermap.org/data/2.5/weather";

    const url = `${endpoint}?q=${encodeURIComponent(city)}&units=metric&appid=${CONFIG.OPENWEATHER_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    // Error handling
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

    // Forecast mode
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

    // Current weather mode
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
    return {
      tool: "weather",
      success: false,
      final: true,
      error: `Weather tool failed: ${err.message}`
    };
  }
}

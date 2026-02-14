import { safeFetch } from "../utils/fetch.js";

export async function weather(query) {
  try {
    const cityMatch = query.match(/in\s+([A-Za-z\s]+)/i);
    const city = cityMatch ? cityMatch[1].trim() : "London";

    const geo = await safeFetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${city}`
    );

    if (!geo.results?.length) {
      return {
        tool: "weather",
        success: false,
        final: true,
        error: "City not found"
      };
    }

    const { latitude, longitude } = geo.results[0];

    const weatherData = await safeFetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
    );

    return {
      tool: "weather",
      success: true,
      final: true,
      data: {
        text: `Current temperature in ${city}: ${weatherData.current_weather.temperature}°C`
      }
    };

  } catch (err) {
    return {
      tool: "weather",
      success: false,
      final: true,
      error: err.message
    };
  }
}

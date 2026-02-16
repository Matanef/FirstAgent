// server/tools/sports.js
import fetch from "node-fetch";
import { CONFIG } from "../utils/config.js";

export async function sports(query) {
  if (!CONFIG.SPORTS_API_KEY) {
    return {
      tool: "sports",
      success: false,
      final: true,
      error: "Sports API key not configured."
    };
  }

  try {
    // Very simple example: API-Football status endpoint
    const url = "https://v3.football.api-sports.io/status";

    const res = await fetch(url, {
      headers: {
        "x-apisports-key": CONFIG.SPORTS_API_KEY
      }
    });

    if (!res.ok) {
      return {
        tool: "sports",
        success: false,
        final: true,
        error: `Sports API error: ${res.status}`
      };
    }

    const data = await res.json();

    return {
      tool: "sports",
      success: true,
      final: true,
      data: {
        status: data?.response?.[0] || data,
        note:
          "Sports tool is wired to API-Football. Extend this to query fixtures, results, leagues, etc.",
        raw: data
      }
    };
  } catch (err) {
    return {
      tool: "sports",
      success: false,
      final: true,
      error: `Sports tool failed: ${err.message}`
    };
  }
}
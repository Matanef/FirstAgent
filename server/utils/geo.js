// server/utils/geo.js
import fetch from "node-fetch";

const GEO_API_URL = "https://ipapi.co";

export async function resolveCityFromIp(ip) {
  try {
    if (!ip || ip === "::1" || ip === "127.0.0.1") {
      return null;
    }

    const url = `${GEO_API_URL}/${ip}/json/`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const city = data.city || null;

    if (!city || typeof city !== "string" || city.trim().length === 0) {
      return null;
    }

    return city.trim();
  } catch (err) {
    console.error("Geo IP lookup failed:", err.message);
    return null;
  }
}
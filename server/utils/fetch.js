import fetch from "node-fetch";

export async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);

    if (!res.ok) {
      console.error(`Fetch error: HTTP ${res.status}`);
      return null;
    }

    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      return await res.json();
    }

    const text = await res.text();

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (err) {
    console.error("Fetch error:", err.message);
    return null;
  }
}

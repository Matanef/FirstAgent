import fs from "fs";

export function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn("JSON load failed:", err.message);
    return fallback;
  }
}

export function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("JSON save failed:", err.message);
  }
}

export function extractTopic(text) {
  return text
    .toLowerCase()
    .replace(
      /summarize|explain|please|check again|verify|according to.*|treat me like.*$/gi,
      ""
    )
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

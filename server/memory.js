import fs from "fs";
import path from "path";

export function loadJSON(filePath, defaultValue = {}) {
  try {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      return defaultValue;
    }

    const raw = fs.readFileSync(absolutePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error loading JSON:", err.message);
    return defaultValue;
  }
}

export function saveJSON(filePath, data) {
  try {
    const absolutePath = path.resolve(filePath);
    fs.writeFileSync(absolutePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving JSON:", err.message);
  }
}

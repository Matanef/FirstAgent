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


export function loadJSON(path, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

// NEW: update profile memory
export function updateProfileMemory(message) {
  const memory = loadJSON("./memory.json", { conversations: {}, profile: {} });

  const lower = message.toLowerCase();

  // Tone preferences
  if (lower.includes("be warmer") || lower.includes("sound warmer")) {
    memory.profile.tone = "warm";
  }
  if (lower.includes("be more detailed") || lower.includes("explain more")) {
    memory.profile.detail = "high";
  }
  if (lower.includes("short answers") || lower.includes("be brief")) {
    memory.profile.detail = "low";
  }

  // Name preference
  const nameMatch = message.match(/call me ([a-zA-Z]+)/i);
  if (nameMatch) {
    memory.profile.name = nameMatch[1];
  }

  // Math preferences
  if (lower.includes("explain the math") || lower.includes("show steps")) {
    memory.profile.math_steps = true;
  }
  if (lower.includes("no steps") || lower.includes("just the answer")) {
    memory.profile.math_steps = false;
  }

  saveJSON("./memory.json", memory);
}


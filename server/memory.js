// server/memory.js

import fs from "fs";
import path from "path";

/**
 * Load JSON from disk safely.
 */
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

/**
 * Save JSON to disk safely.
 */
export function saveJSON(filePath, data) {
  try {
    const absolutePath = path.resolve(filePath);
    fs.writeFileSync(absolutePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving JSON:", err.message);
  }
}

/**
 * Update long-term user profile memory.
 */
export function updateProfileMemory(message) {
  const memory = loadJSON("./memory.json", {
    conversations: {},
    profile: {},
    meta: {}
  });

  memory.profile ??= {};
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

  // Formatting preferences
  if (lower.includes("i prefer tables")) {
    memory.profile.format = "table";
  }
  if (lower.includes("i prefer bullet points") || lower.includes("i prefer bullets")) {
    memory.profile.format = "bullets";
  }

  saveJSON("./memory.json", memory);
}
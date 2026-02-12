import fs from "fs";

export function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export class Memory {
  constructor() {
    this.steps = [];
  }

  add(step) {
    this.steps.push(step);
  }

  getState() {
    return this.steps;
  }
}

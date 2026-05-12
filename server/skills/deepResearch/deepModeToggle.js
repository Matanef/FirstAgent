// server/skills/deepResearch/deepModeToggle.js
// Runtime toggle for deep-read mode. Persists to data/deep-mode.json so the
// user can change it from the chat window without editing .env or restarting.
//
// Resolution policy (highest priority first):
//   1. CONFIG.DEEP_MODE / process.env.DEEP_MODE = "true" | "false"  (escape hatch)
//   2. data/deep-mode.json { override: "on" | "off" }               (chat command)
//   3. Otherwise → tier-based default ("research"/"thesis" → ON, others → OFF)
//
// Used by: server/skills/deepResearch/articleHarvester.js (isDeepMode helper).

import fs from "fs/promises";
import path from "path";
import { CONFIG, PROJECT_ROOT } from "../../utils/config.js";

const TOOL_NAME = "deepModeToggle";
const STATE_FILE = path.resolve(PROJECT_ROOT, "data", "deep-mode.json");
const CACHE_TTL_MS = 5_000; // re-read at most every 5s

let _cache = null;
let _cacheAt = 0;

async function readState() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    _cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    _cache = {};
  }
  _cacheAt = Date.now();
  return _cache;
}

async function writeState(next) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  _cache = next;
  _cacheAt = Date.now();
}

/**
 * Get the current override: "on" | "off" | "auto".
 * "auto" means use tier-based default (no override active).
 */
export async function getOverride() {
  // Env var beats file
  const envFlag = String(CONFIG?.DEEP_MODE ?? process.env.DEEP_MODE ?? "").toLowerCase();
  if (envFlag === "true")  return "on";
  if (envFlag === "false") return "off";

  const state = await readState();
  const v = String(state.override || "auto").toLowerCase();
  if (v === "on" || v === "off" || v === "auto") return v;
  return "auto";
}

/**
 * Set the override. `value` must be one of: "on", "off", "auto".
 */
export async function setOverride(value) {
  const v = String(value || "").toLowerCase();
  if (!["on", "off", "auto"].includes(v)) {
    throw new Error(`Invalid deep-mode override: "${value}" (expected on/off/auto)`);
  }
  const next = {
    override: v,
    setAt: new Date().toISOString()
  };
  await writeState(next);
  return next;
}

/**
 * Get a small status object for display.
 */
export async function getStatus() {
  const envFlag = String(CONFIG?.DEEP_MODE ?? process.env.DEEP_MODE ?? "").toLowerCase();
  const envForced = envFlag === "true" || envFlag === "false";
  const state = await readState();
  return {
    override: await getOverride(),
    envForced,
    envValue: envForced ? envFlag : null,
    setAt: state.setAt || null
  };
}

/**
 * Resolve effective deep-mode for a given tier.
 *  - explicit override "on"  → true
 *  - explicit override "off" → false
 *  - "auto" → research/thesis = true; others = false
 */
export async function isDeepModeForTier(tier) {
  const ov = await getOverride();
  if (ov === "on")  return true;
  if (ov === "off") return false;
  // Phase 20N — thesis-deep inherits thesis's deep-read default
  return tier === "research" || tier === "thesis" || tier === "thesis-deep";
}

/**
 * Parse a chat message and decide intent.
 * Returns one of: "on" | "off" | "auto" | "status" | null (no match).
 */
function parseIntent(text) {
  const lower = String(text || "").toLowerCase();
  // Status query
  if (/\b(deep[\s-]?(mode|read))\b.*\b(status|state|current)\b/.test(lower)) return "status";
  if (/\b(is|what'?s|whats?)\s+(?:the\s+)?deep[\s-]?(mode|read)/.test(lower)) return "status";
  // Auto/reset
  if (/\b(deep[\s-]?(mode|read))\b.*\b(auto|reset|default)\b/.test(lower)) return "auto";
  // On
  if (/\b(deep[\s-]?(mode|read))\b.*\b(on|enable|activate|turn\s+on|start)\b/.test(lower)) return "on";
  if (/\b(enable|turn\s+on|activate|start)\b.*\b(deep[\s-]?(mode|read))\b/.test(lower)) return "on";
  // Off
  if (/\b(deep[\s-]?(mode|read))\b.*\b(off|disable|deactivate|turn\s+off|stop)\b/.test(lower)) return "off";
  if (/\b(disable|turn\s+off|deactivate|stop)\b.*\b(deep[\s-]?(mode|read))\b/.test(lower)) return "off";
  return null;
}

/**
 * Tool entry point. Conforms to the standard tool contract:
 *   { tool, success, final, data: { text, preformatted } } | { ..., error }
 */
export async function deepModeToggle(request) {
  const text = typeof request === "string" ? request : (request?.text || "");
  const intent = parseIntent(text);

  // Status query (or unrecognized — show status as a helpful default)
  if (intent === "status" || intent === null) {
    const s = await getStatus();
    let line;
    if (s.envForced) {
      line = `🔒 Deep-read mode: **FORCED ${s.envValue.toUpperCase()}** via DEEP_MODE in server/.env (chat toggle is overridden by env)`;
    } else if (s.override === "on") {
      line = `✅ Deep-read mode: **ON** for all tiers (last toggled ${s.setAt || "?"})`;
    } else if (s.override === "off") {
      line = `⏸ Deep-read mode: **OFF** for all tiers (last toggled ${s.setAt || "?"})`;
    } else {
      line = `🔄 Deep-read mode: **AUTO** — ON for research/thesis, OFF for article/indepth (default)`;
    }
    return {
      tool: TOOL_NAME,
      success: true,
      final: true,
      data: {
        text: line + "\n\n" +
              "Commands: `deep mode on` • `deep mode off` • `deep mode auto` • `deep mode status`",
        preformatted: true
      }
    };
  }

  // Refuse to set if env-forced
  const status = await getStatus();
  if (status.envForced) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Cannot toggle deep-mode from chat: DEEP_MODE=${status.envValue} is set in server/.env. Remove it from .env first, then restart.`
    };
  }

  try {
    const next = await setOverride(intent);
    let msg;
    switch (intent) {
      case "on":
        msg = "✅ Deep-read mode **ON** for all research tiers.\n\nThe agent will now read full PDFs and pick a relevant middle section per paper, in addition to abstract + conclusion. Research runs will be slower (~20-45s extra) but with richer source content.";
        break;
      case "off":
        msg = "⏸ Deep-read mode **OFF** for all tiers.\n\nThe agent will only use abstracts + conclusions. Faster runs, but no middle-section evidence.";
        break;
      case "auto":
        msg = "🔄 Deep-read mode reset to **AUTO** (tier-based default).\n\n• `research` and `thesis` tiers → ON\n• `article` and `indepth` tiers → OFF";
        break;
    }
    return {
      tool: TOOL_NAME,
      success: true,
      final: true,
      data: {
        text: msg + `\n\n_(updated ${next.setAt})_`,
        preformatted: true
      }
    };
  } catch (err) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Failed to update deep-mode: ${err.message}`
    };
  }
}

// For testing
export const _internals = { parseIntent, readState, writeState };

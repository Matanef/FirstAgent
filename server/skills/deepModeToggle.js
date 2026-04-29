// server/skills/deepModeToggle.js
// Thin re-export shim for the deep-read-mode runtime toggle.
// Implementation lives in server/skills/deepResearch/deepModeToggle.js.
// This shim sits in skills/ root so loadSkills() picks up the ROUTING export.

export { deepModeToggle } from "./deepResearch/deepModeToggle.js";

// Self-registered routing rule — high priority so chat commands like
// "deep mode on" are intercepted BEFORE deepResearch's "research..." rule
// would catch them.
export const ROUTING = {
  tool: "deepModeToggle",
  priority: 85, // higher than deepResearch (72) so "enable deep mode" doesn't trigger research
  match: (lower) =>
    // Any sentence containing "deep mode" or "deep read" PLUS a control verb/state
    /\b(deep[\s-]?(?:mode|read))\b.*\b(on|off|auto|reset|default|status|state|current|enable|disable|activate|deactivate|toggle|turn\s+on|turn\s+off|start|stop)\b/i.test(lower) ||
    /\b(enable|disable|activate|deactivate|turn\s+on|turn\s+off|start|stop)\b.*\b(deep[\s-]?(?:mode|read))\b/i.test(lower) ||
    /\b(is|what'?s|whats?)\s+(?:the\s+)?deep[\s-]?(?:mode|read)/i.test(lower),
  description: "Deep-read mode toggle — runtime control of full-PDF reading"
};

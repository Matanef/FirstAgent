// server/skills/loreResearcher.js
// Thin re-export shim. All implementation lives in server/skills/loreResearcher/.
// Kept here so the MANIFEST.json allowlist entry ("loreResearcher.js") stays valid.

import { hasCompoundIntent } from "../routing/helpers.js";

// Re-export the main function from the module index
export { loreResearcher } from "./loreResearcher/index.js";

// Self-registered routing rule — picked up by loadSkills() in executor.js
export const ROUTING = {
  tool: "loreResearcher",
  priority: 95, 
  // Trigger when the user explicitly asks for lore research or the tool by name
  match: (lower) => /\b(loreresearcher|research\s+lore|canon\s+appearance|physical\s+characteristics)\b/i.test(lower),
  guard: (lower) => hasCompoundIntent(lower), 
  description: "A research tool that fetches accurate pop-culture lore, physical descriptions, and settings to build detailed image prompts. Use this BEFORE imageGen to ensure canon accuracy."
};
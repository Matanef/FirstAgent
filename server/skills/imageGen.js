// server/skills/imageGen.js
// Thin re-export shim. All implementation lives in server/skills/imageGen/.
// Kept here so the MANIFEST.json allowlist entry ("imageGen.js") stays valid.

// server/skills/imageGen.js
import { isImageGenerationIntent } from "../routing/helpers.js";

export { imageGen } from "./imageGen/index.js";

export const ROUTING = {
  tool: "imageGen",
  priority: 10, // <--- MOVED TO VIP TIER. Evaluated before sports/shopping.
  // Explicitly trigger if the user says "imagegen" OR if it matches standard drawing intents
  match: (lower) => /\b(imagegen|draw|generate\s+an\s+image|create\s+an\s+image|render)\b/i.test(lower) || isImageGenerationIntent(lower),
  guard: (lower) => /\b(and\s+(email|mail|whatsapp|send|message))\b/i.test(lower),
  description: "AI Image Generator. Use this to draw, create, or render pictures and photos via Replicate API."
};
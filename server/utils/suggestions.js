// server/utils/suggestions.js
// Proactive suggestion engine — suggests follow-up actions after tool execution
// Disabled by default, enable via user preference: preferences.enableSuggestions = true

import { getMemory } from "../memory.js";

// ============================================================
// SUGGESTION RULES (tool → suggestions mapping)
// ============================================================

const SUGGESTION_RULES = {
  weather: [
    { condition: null, text: "Would you like the forecast for tomorrow too?" },
    { condition: (result) => result.data?.temp < 5, text: "It's cold! Want me to check if you need an umbrella?" }
  ],
  email: [
    { condition: (result) => result.data?.mode === "draft", text: null }, // Draft has its own "send it" prompt
    { condition: (result) => result.data?.messageId, text: "Want me to set a reminder to follow up?" },
    { condition: (result) => result.data?.mode === "browse", text: "Want me to read any of these emails in detail?" }
  ],
  sports: [
    { condition: (result) => result.data?.type === "fixtures", text: "Want to see the current standings?" },
    { condition: (result) => result.data?.type === "standings", text: "Want to see upcoming fixtures for any team?" },
    { condition: (result) => result.data?.type === "results", text: "Want to see the league standings?" }
  ],
  finance: [
    { condition: null, text: "Want me to check the fundamentals or recent news for this stock?" }
  ],
  search: [
    { condition: null, text: "Want me to search for more details on any of these results?" }
  ],
  news: [
    { condition: null, text: "Want me to find more details on any of these stories?" }
  ],
  tasks: [
    { condition: null, text: "Want me to add a new task or mark any as complete?" }
  ],
  calculator: [
    { condition: (result) => result.data?.result && typeof result.data.result === "string", text: "Want me to solve for a specific value?" }
  ],
  moltbook: [
    { condition: (result) => result.data?.action === "register", text: "Share the claim URL with your human to activate your account!" },
    { condition: (result) => result.data?.action === "feed", text: "Want to upvote or comment on any post?" }
  ]
};

// ============================================================
// SUGGESTION GENERATION
// ============================================================

/**
 * Generate a follow-up suggestion based on the tool result.
 * Returns null if suggestions are disabled or no relevant suggestion exists.
 */
export async function generateSuggestion(tool, result) {
  // Check if suggestions are enabled
  const memory = await getMemory();
  const prefs = memory.profile?.preferences || {};
  if (!prefs.enableSuggestions) return null;

  const rules = SUGGESTION_RULES[tool];
  if (!rules) return null;

  for (const rule of rules) {
    if (rule.condition === null || rule.condition(result)) {
      if (rule.text) {
        return {
          type: "suggestion",
          text: `\n\n💡 *${rule.text}*`,
          tool
        };
      }
    }
  }

  return null;
}

/**
 * Append suggestion to a reply string if applicable.
 */
export async function appendSuggestion(reply, tool, result) {
  const suggestion = await generateSuggestion(tool, result);
  if (suggestion) {
    return reply + suggestion.text;
  }
  return reply;
}

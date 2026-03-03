// server/utils/styleEngine.js
// Conversational Style Engine — adapts response style to user preferences
// Reads style preferences from memory.profile.preferences
// Tracks satisfaction signals to auto-adjust

import { getMemory, withMemoryLock, saveJSON, MEMORY_FILE } from "../memory.js";

// ============================================================
// STYLE PROFILES
// ============================================================

const STYLE_PRESETS = {
  formal: {
    label: "Formal",
    instructions: "Use professional, formal language. Avoid slang and contractions. Be thorough and precise.",
    lengthMultiplier: 1.3
  },
  casual: {
    label: "Casual",
    instructions: "Be conversational and friendly. Use natural, relaxed language. Contractions are fine.",
    lengthMultiplier: 1.0
  },
  brief: {
    label: "Brief",
    instructions: "Be extremely concise. Use bullet points. Skip pleasantries. Get straight to the answer.",
    lengthMultiplier: 0.5
  },
  detailed: {
    label: "Detailed",
    instructions: "Provide comprehensive, thorough answers. Include examples, context, and explanations. Be educational.",
    lengthMultiplier: 1.8
  },
  technical: {
    label: "Technical",
    instructions: "Use technical terminology. Include code examples where relevant. Be precise with specifications.",
    lengthMultiplier: 1.4
  },
  friendly: {
    label: "Friendly",
    instructions: "Be warm and encouraging. Use positive language. Add personality and light humor where appropriate.",
    lengthMultiplier: 1.1
  }
};

// ============================================================
// STYLE RETRIEVAL
// ============================================================

/**
 * Get the current user's style preferences.
 */
export async function getStylePreferences() {
  const memory = await getMemory();
  const profile = memory.profile || {};
  const preferences = profile.preferences || {};

  return {
    style: preferences.style || profile.tone || "casual",
    verbosity: preferences.verbosity || "normal", // brief, normal, detailed
    useEmoji: preferences.useEmoji !== false, // default true
    useMarkdown: preferences.useMarkdown !== false, // default true
    language: preferences.language || "en",
    customInstructions: preferences.customInstructions || null
  };
}

/**
 * Build style instructions for the LLM prompt.
 */
export async function buildStyleInstructions() {
  const prefs = await getStylePreferences();
  const preset = STYLE_PRESETS[prefs.style] || STYLE_PRESETS.casual;

  let instructions = `Style: ${preset.label}. ${preset.instructions}\n`;

  if (prefs.verbosity === "brief") {
    instructions += "Keep responses very short (1-3 sentences max). Use bullet points.\n";
  } else if (prefs.verbosity === "detailed") {
    instructions += "Provide detailed, comprehensive responses with examples.\n";
  }

  if (!prefs.useEmoji) {
    instructions += "Do NOT use emoji in responses.\n";
  }

  if (prefs.customInstructions) {
    instructions += `Custom user instructions: ${prefs.customInstructions}\n`;
  }

  return instructions;
}

// ============================================================
// SATISFACTION TRACKING
// ============================================================

/**
 * Track user satisfaction signals from their messages.
 * Call this with each user message to detect satisfaction/dissatisfaction.
 */
export function detectSatisfaction(userMessage) {
  const lower = (userMessage || "").toLowerCase();

  // Positive signals
  if (/\b(thanks|thank you|perfect|great|awesome|excellent|that's exactly|love it)\b/i.test(lower)) {
    return { signal: "satisfied", confidence: 0.8 };
  }

  // Negative signals (re-asking, frustration)
  if (/\b(wrong|incorrect|that's not|I asked for|try again|no,? I|not what|I meant|ugh|frustrat)\b/i.test(lower)) {
    return { signal: "dissatisfied", confidence: 0.8 };
  }

  // Re-asking (same question phrased differently) — moderate dissatisfaction
  if (/\b(I said|like I said|as I mentioned|I already)\b/i.test(lower)) {
    return { signal: "dissatisfied", confidence: 0.6 };
  }

  // Brevity request
  if (/\b(shorter|briefer|just tell me|too long|tl;?dr|be brief|cut to the chase)\b/i.test(lower)) {
    return { signal: "too_verbose", confidence: 0.9 };
  }

  // More detail request
  if (/\b(more detail|elaborate|explain more|can you expand|tell me more|go deeper)\b/i.test(lower)) {
    return { signal: "too_brief", confidence: 0.9 };
  }

  return { signal: "neutral", confidence: 0.5 };
}

/**
 * Update style preferences based on satisfaction signals.
 */
export async function updatePreferencesFromFeedback(signal) {
  if (signal === "neutral") return;

  await withMemoryLock(async () => {
    const mem = await getMemory();
    mem.profile = mem.profile || {};
    mem.profile.preferences = mem.profile.preferences || {};
    const prefs = mem.profile.preferences;

    // Track satisfaction history
    prefs.satisfactionHistory = prefs.satisfactionHistory || [];
    prefs.satisfactionHistory.push({
      signal,
      timestamp: new Date().toISOString()
    });

    // Keep only last 20 signals
    if (prefs.satisfactionHistory.length > 20) {
      prefs.satisfactionHistory = prefs.satisfactionHistory.slice(-20);
    }

    // Auto-adjust verbosity based on recent signals
    if (signal === "too_verbose") {
      prefs.verbosity = "brief";
      console.log("[styleEngine] Auto-adjusting: verbosity → brief");
    } else if (signal === "too_brief") {
      prefs.verbosity = "detailed";
      console.log("[styleEngine] Auto-adjusting: verbosity → detailed");
    }

    mem.meta = mem.meta || {};
    mem.meta.lastUpdated = new Date().toISOString();
    await saveJSON(MEMORY_FILE, mem);
  });
}

// ============================================================
// PREFERENCE EXTRACTION FROM MESSAGES
// ============================================================

/**
 * Extract implicit style preferences from user messages.
 * Call this during message processing to learn preferences.
 */
export function extractPreferences(userMessage) {
  const lower = (userMessage || "").toLowerCase();
  const prefs = {};

  // Explicit style requests
  if (/\b(be|talk|respond)\s+(more\s+)?(formal|professional)\b/i.test(lower)) prefs.style = "formal";
  if (/\b(be|talk|respond)\s+(more\s+)?(casual|relaxed|friendly)\b/i.test(lower)) prefs.style = "casual";
  if (/\b(be|talk|respond)\s+(more\s+)?(brief|concise|short)\b/i.test(lower)) prefs.verbosity = "brief";
  if (/\b(be|talk|respond)\s+(more\s+)?(detailed|thorough|comprehensive)\b/i.test(lower)) prefs.verbosity = "detailed";
  if (/\b(be|talk|respond)\s+(more\s+)?(technical)\b/i.test(lower)) prefs.style = "technical";

  // Emoji preferences
  if (/\b(no\s+emoji|stop\s+(using\s+)?emoji|without\s+emoji)\b/i.test(lower)) prefs.useEmoji = false;
  if (/\b(use\s+emoji|add\s+emoji|more\s+emoji)\b/i.test(lower)) prefs.useEmoji = true;

  return Object.keys(prefs).length > 0 ? prefs : null;
}

/**
 * Apply extracted preferences to memory.
 */
export async function applyExtractedPreferences(prefs) {
  if (!prefs) return;

  await withMemoryLock(async () => {
    const mem = await getMemory();
    mem.profile = mem.profile || {};
    mem.profile.preferences = mem.profile.preferences || {};

    Object.assign(mem.profile.preferences, prefs);
    console.log("[styleEngine] Applied preferences:", prefs);

    mem.meta = mem.meta || {};
    mem.meta.lastUpdated = new Date().toISOString();
    await saveJSON(MEMORY_FILE, mem);
  });
}

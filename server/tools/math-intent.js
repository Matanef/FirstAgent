// server/tools/math-intent.js

/**
 * Detect whether a user message contains math,
 * and classify the type of math so the planner
 * can route it to the correct tool.
 */

function detectMathType(text) {
  const trimmed = text.trim();

  // Pure arithmetic: 2+2, 5 * 7, 10 / 3, etc.
  if (/^[0-9\.\s\+\-\*\/\(\)]+$/.test(trimmed)) {
    return { isMath: true, type: "arithmetic", expression: trimmed };
  }

  // Algebra: x + 2 = 5, solve for x, etc.
  if (/[a-zA-Z]/.test(trimmed) && /=/.test(trimmed)) {
    return { isMath: true, type: "algebra", expression: trimmed };
  }

  // Trigonometry: sin(), cos(), tan(), radians, degrees
  if (/sin|cos|tan|cot|sec|csc/i.test(trimmed)) {
    return { isMath: true, type: "trig", expression: trimmed };
  }

  // Symbolic math: integrals, derivatives, limits
  if (/∫|integral|derivative|d\/dx|limit/i.test(trimmed)) {
    return { isMath: true, type: "symbolic", expression: trimmed };
  }

  // Word problems that contain numbers and math verbs
  if (
    /\d/.test(trimmed) &&
    /(total|difference|sum|product|increase|decrease|split|share|ratio)/i.test(trimmed)
  ) {
    return { isMath: true, type: "word-problem", expression: trimmed };
  }

  // Not math
  return { isMath: false, type: null, expression: null };
}

export async function mathIntent(message) {
  try {
    const result = detectMathType(message);

    return {
      tool: "math-intent",
      success: true,
      final: true,
      data: result
    };
  } catch (err) {
    return {
      tool: "math-intent",
      success: false,
      final: true,
      error: err.message
    };
  }
}
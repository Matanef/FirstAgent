// server/tools/calculator.js

// Very small safe math evaluator
// Supports: + - * / ( ) and decimals

function sanitizeExpression(input) {
  // Extract first math-like sequence
  const match = input.match(/[-+*/().\d\s]+/);
  if (!match) return null;

  const expr = match[0];

  // Allow only valid characters
  if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;

  return expr;
}

function evaluateExpression(expr) {
  try {
    // Use Function constructor instead of eval
    // Still controlled because we sanitized strictly
    const result = Function(`"use strict"; return (${expr})`)();

    if (typeof result !== "number" || !isFinite(result)) {
      return { error: "Invalid calculation result" };
    }

    return { result };
  } catch {
    return { error: "Invalid mathematical expression" };
  }
}

export function calculator(message) {
  const expr = sanitizeExpression(message);

  if (!expr) {
    return { error: "No valid math expression found" };
  }

  return evaluateExpression(expr);
}

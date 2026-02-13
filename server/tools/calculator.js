// server/tools/calculator.js
// Deterministic safe calculator tool
// Structured return system

function sanitizeExpression(input) {
  const match = input.match(/[-+*/().\d\s]+/);
  if (!match) return null;

  const expr = match[0];

  if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;

  return expr;
}

function evaluateExpression(expr) {
  try {
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
    return {
      tool: "calculator",
      success: false,
      final: true,
      error: "No valid math expression found"
    };
  }

  const evaluation = evaluateExpression(expr);

  if (evaluation.error) {
    return {
      tool: "calculator",
      success: false,
      final: true,
      error: evaluation.error
    };
  }

  return {
    tool: "calculator",
    success: true,
    final: true,
    data: {
      expression: expr,
      result: evaluation.result
    }
  };
}

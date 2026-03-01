// server/tools/calculator.js
// Scientific + symbolic + numeric hybrid calculator
// Fully aligned with executor + summarizer + planner

import { Parser } from "expr-eval";
import nerdamer from "nerdamer";
import "nerdamer/Algebra.js";
import "nerdamer/Solve.js";

// ------------------------------------------------------------
// Utility helpers
// ------------------------------------------------------------

function extractEquationLine(message) {
  if (!message || typeof message !== "string") return null;

  const lines = message
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const eqLine = lines.find(l => l.includes("="));
  if (eqLine) return eqLine;

  if (message.includes("=")) return message.trim();

  return null;
}

function insertImplicitMultiplication(expr) {
  let out = expr;
  out = out.replace(/(\d)([a-zA-Z(])/g, "$1*$2");
  out = out.replace(/(\))(\d|[a-zA-Z])/g, "$1*$2");
  out = out.replace(/([a-zA-Z])(\()/g, "$1*$2");
  return out;
}

function sanitizeExpression(raw) {
  if (!raw) return null;
  let expr = raw.replace(/[^0-9+\-*/^().,a-zA-Z\s%=]/g, "");
  expr = expr.replace(/\s+/g, " ").trim();
  return expr || null;
}

function detectVariable(expr) {
  const functions = new Set([
    "sin","cos","tan","asin","acos","atan",
    "sqrt","abs","log","ln","round","floor","ceil","pow",
    "pi","e"
  ]);

  const vars = new Set();
  const regex = /[a-zA-Z_]\w*/g;
  let match;

  while ((match = regex.exec(expr)) !== null) {
    const name = match[0];
    if (!functions.has(name.toLowerCase())) {
      vars.add(name);
    }
  }

  return vars.size === 1 ? [...vars][0] : null;
}

// ------------------------------------------------------------
// Expression evaluation
// ------------------------------------------------------------

function buildEvalEnv() {
  const toRad = deg => (deg * Math.PI) / 180;
  const toDeg = rad => (rad * 180) / Math.PI;

  return {
    sin: d => Math.sin(toRad(d)),
    cos: d => Math.cos(toRad(d)),
    tan: d => Math.tan(toRad(d)),
    asin: x => toDeg(Math.asin(x)),
    acos: x => toDeg(Math.acos(x)),
    atan: x => toDeg(Math.atan(x)),
    sqrt: Math.sqrt,
    abs: Math.abs,
    log: x => Math.log10(x),
    ln: Math.log,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    pow: Math.pow,
    pi: Math.PI,
    e: Math.E
  };
}

function normalizeExpression(expr) {
  return expr.replace(/\bpi\b/gi, "pi").replace(/\be\b/gi, "e");
}

function evaluateExpression(expr) {
  try {
    const env = buildEvalEnv();
    const parser = new Parser();
    const parsed = parser.parse(normalizeExpression(expr));
    const result = parsed.evaluate(env);

    if (typeof result !== "number" || !isFinite(result)) {
      return { error: "Invalid calculation result" };
    }

    return { result };
  } catch {
    return { error: "Invalid mathematical expression" };
  }
}

function extractExpression(input) {
  if (!input || typeof input !== "string") return null;

  if (/^\s*(pi|e)\s*$/i.test(input)) return input.trim();

  const funcMatch = input.match(
    /(sin|cos|tan|asin|acos|atan|sqrt|abs|log|ln|round|floor|ceil|pow)\s*\([^()]+\)/i
  );
  if (funcMatch) return funcMatch[0];

  const parenMatch = input.match(/\([^()]+\)[0-9+\-*/^().\s%]*/);
  if (parenMatch) return parenMatch[0];

  // Variable expressions: 2x/7, 3x+5, x^2-4 (includes letters mixed with numbers and operators)
  const varExprMatch = input.match(/\d*[a-zA-Z][\w]*(?:\s*[+\-*/^%]\s*[\d]*[a-zA-Z\d][\w]*)*(?:\s*[+\-*/^%]\s*\d+)*/);
  if (varExprMatch && /\d/.test(varExprMatch[0]) && /[a-zA-Z]/.test(varExprMatch[0])) {
    return varExprMatch[0].trim();
  }

  const arithMatch = input.match(/[0-9]+(?:\s*[\+\-\*\/%^]\s*[0-9]+)+/);
  if (arithMatch) return arithMatch[0];

  const fallback = input.match(/[0-9+\-*/^().\s%pie]+/i);
  if (fallback && /\d/.test(fallback[0])) return fallback[0];

  return null;
}

function buildTextOutput(expr, result) {
  const trigMatch = expr.match(/^\s*(sin|cos|tan)\s*\(\s*([^)]+)\s*\)\s*$/i);
  if (trigMatch) {
    const arg = trigMatch[2];
    try {
      const env = buildEvalEnv();
      const parser = new Parser();
      const argVal = parser.parse(normalizeExpression(arg)).evaluate(env);
      const rad = (argVal * Math.PI) / 180;
      return `The value of ${expr} is ${result}. The angle is ${argVal}° (${rad} rad).`;
    } catch {}
  }

  return `The result of ${expr} is ${result}.`;
}

// ------------------------------------------------------------
// Numeric fallback solving
// ------------------------------------------------------------

function solveEquationNumeric(equation, variable) {
  try {
    const [leftRaw, rightRaw] = equation.split("=").map(s => s.trim());
    const left = sanitizeExpression(leftRaw);
    const right = sanitizeExpression(rightRaw);
    if (!left || !right) return null;

    const expr = `${left}-(${right})`;
    const parser = new Parser();
    const compiled = parser.parse(normalizeExpression(insertImplicitMultiplication(expr)));
    const envBase = buildEvalEnv();

    const f = x => {
      const env = { ...envBase, [variable]: x };
      const val = compiled.evaluate(env);
      return typeof val === "number" ? val : NaN;
    };

    let low = -1e6, high = 1e6;
    let fLow = f(low), fHigh = f(high);

    if (!isFinite(fLow) || !isFinite(fHigh)) return null;
    if (fLow === 0) return low;
    if (fHigh === 0) return high;

    if (fLow * fHigh > 0) {
      low = -1e3;
      high = 1e3;
      fLow = f(low);
      fHigh = f(high);
      if (fLow * fHigh > 0) return null;
    }

    for (let i = 0; i < 100; i++) {
      const mid = (low + high) / 2;
      const fMid = f(mid);
      if (Math.abs(fMid) < 1e-9) return mid;
      if (fLow * fMid < 0) {
        high = mid;
        fHigh = fMid;
      } else {
        low = mid;
        fLow = fMid;
      }
    }

    return (low + high) / 2;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Symbolic + numeric fallback equation solving
// ------------------------------------------------------------

function solveEquation(message) {
  const eqLine = extractEquationLine(message);
  if (!eqLine) return null;

  let equation = sanitizeExpression(eqLine);
  if (!equation || !equation.includes("=")) return null;

  equation = insertImplicitMultiplication(equation);

  const variable = detectVariable(equation);
  if (!variable) return null;

  // 1️⃣ Symbolic solving
  try {
    const solutions = nerdamer.solve(equation, variable).toArray();
    if (solutions && solutions.length > 0) {
      const solExpr = solutions[0].toString();

      let numeric = null;
      try {
        const parser = new Parser();
        numeric = parser
          .parse(normalizeExpression(insertImplicitMultiplication(solExpr)))
          .evaluate(buildEvalEnv());
        if (!isFinite(numeric)) numeric = null;
      } catch {
        numeric = null;
      }

      return { variable, solution: solExpr, numeric };
    }
  } catch {}

  // 2️⃣ Numeric fallback
  const numeric = solveEquationNumeric(equation, variable);
  if (numeric !== null && isFinite(numeric)) {
    return { variable, solution: null, numeric };
  }

  return null;
}

// ------------------------------------------------------------
// Main calculator tool
// ------------------------------------------------------------

export function calculator(message) {
  // 0️⃣ Equation solving
  if (message.includes("=")) {
    const eqResult = solveEquation(message);
    if (eqResult) {
      const { variable, solution, numeric } = eqResult;

      let text;
      if (numeric !== null && solution) {
        text = `Solving the equation ${message.trim()} for ${variable} gives ${variable} = ${numeric} (exact: ${solution}).`;
      } else if (numeric !== null) {
        text = `Solving the equation ${message.trim()} for ${variable} gives approximately ${variable} = ${numeric}.`;
      } else {
        text = `Solving the equation ${message.trim()} for ${variable} gives ${variable} = ${solution}.`;
      }

      return {
        tool: "calculator",
        success: true,
        final: true,
        data: {
          expression: message.trim(),
          result: numeric ?? solution,
          text
        }
      };
    }
  }

  // 1️⃣ Normal expression evaluation
  const rawExpr = extractExpression(message);
  if (!rawExpr) {
    return {
      tool: "calculator",
      success: false,
      final: true,
      error: "No valid math expression found"
    };
  }

  const expr = sanitizeExpression(rawExpr);
  if (!expr) {
    return {
      tool: "calculator",
      success: false,
      final: true,
      error: "No valid math expression found"
    };
  }

  // 2️⃣ Check if expression contains variables (e.g. "2x/7") — cannot evaluate numerically
  const variable = detectVariable(expr);
  if (variable) {
    // Try symbolic simplification with nerdamer
    try {
      const withMul = insertImplicitMultiplication(expr);
      const simplified = nerdamer(withMul).toString();
      return {
        tool: "calculator",
        success: true,
        final: true,
        data: {
          expression: expr,
          result: simplified,
          text: `The expression **${expr}** simplifies to **${simplified}**.\n\nTo solve for ${variable}, provide an equation like: \`${expr} = <value>\``
        }
      };
    } catch {
      return {
        tool: "calculator",
        success: true,
        final: true,
        data: {
          expression: expr,
          result: null,
          text: `The expression **${expr}** contains variable '${variable}' and cannot be evaluated to a number.\n\nTo solve for ${variable}, provide an equation like: \`${expr} = <value>\``
        }
      };
    }
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

  const text = buildTextOutput(expr, evaluation.result);

  return {
    tool: "calculator",
    success: true,
    final: true,
    data: {
      expression: expr,
      result: evaluation.result,
      text
    }
  };
}
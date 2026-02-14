// server/tools/calculator.js
// Scientific calculator using expr-eval
// Supports: +, -, *, /, %, ^, parentheses, negatives
// Functions: sin, cos, tan, asin, acos, atan, sqrt, abs, log, ln, round, floor, ceil, pow
// Constants: pi, e
// Trig uses DEGREES by default; for simple trig calls, output also shows radian equivalent.

import { Parser } from "expr-eval";

function extractExpression(input) {
  if (!input || typeof input !== "string") return null;

  // Allow standalone constants
  if (/^\s*(pi|e)\s*$/i.test(input)) return input.trim();

  // 1) Function-style expression: sin(30), sqrt(9), etc.
  const funcMatch = input.match(
    /(sin|cos|tan|asin|acos|atan|sqrt|abs|log|ln|round|floor|ceil|pow)\s*\([^()]+\)/i
  );
  if (funcMatch) return funcMatch[0];

  // 2) Parentheses expressions: (2+2)*3, (1+2)/(3-4)
  const parenMatch = input.match(/\([^()]+\)[0-9+\-*/^().\s%]*/);
  if (parenMatch) return parenMatch[0];

  // 3) Arithmetic expressions: 29/4, 2+2*3, 2^8
  const arithMatch = input.match(/[0-9]+(?:\s*[\+\-\*\/%^]\s*[0-9]+)+/);
  if (arithMatch) return arithMatch[0];

  // 4) Fallback: whole input looks mathy AND contains at least one digit
  const fallback = input.match(/[0-9+\-*/^().\s%pie]+/i);
  if (fallback && /\d/.test(fallback[0])) return fallback[0];

  return null;
}

function sanitizeExpression(raw) {
  if (!raw) return null;
  let expr = raw.replace(/[^0-9+\-*/^().,a-zA-Z\s%]/g, "");
  expr = expr.replace(/\s+/g, " ").trim();
  if (!expr) return null;
  return expr;
}

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad) {
  return (rad * 180) / Math.PI;
}

function buildEvalEnv() {
  // expr-eval uses radians by default, so we wrap to use degrees for trig
  const sin = (deg) => Math.sin(toRadians(deg));
  const cos = (deg) => Math.cos(toRadians(deg));
  const tan = (deg) => Math.tan(toRadians(deg));

  const asin = (x) => toDegrees(Math.asin(x));
  const acos = (x) => toDegrees(Math.acos(x));
  const atan = (x) => toDegrees(Math.atan(x));

  const sqrt = Math.sqrt;
  const abs = Math.abs;
  const log = (x) => Math.log10(x);
  const ln = (x) => Math.log(x);
  const round = Math.round;
  const floor = Math.floor;
  const ceil = Math.ceil;
  const pow = Math.pow;

  const pi = Math.PI;
  const e = Math.E;

  return {
    sin,
    cos,
    tan,
    asin,
    acos,
    atan,
    sqrt,
    abs,
    log,
    ln,
    round,
    floor,
    ceil,
    pow,
    pi,
    e
  };
}

function normalizeExpression(expr) {
  let normalized = expr;
  normalized = normalized.replace(/\^/g, "^"); // expr-eval uses ^ already
  normalized = normalized.replace(/\bpi\b/gi, "pi");
  normalized = normalized.replace(/\be\b/gi, "e");
  return normalized;
}

function evaluateExpression(expr) {
  try {
    const env = buildEvalEnv();
    const normalized = normalizeExpression(expr);
    const parser = new Parser({
      operators: {
        // allow all standard operators
        add: true,
        subtract: true,
        multiply: true,
        divide: true,
        modulus: true,
        power: true,
        factorial: false
      }
    });

    const parsed = parser.parse(normalized);
    const result = parsed.evaluate(env);

    if (typeof result !== "number" || !isFinite(result)) {
      return { error: "Invalid calculation result" };
    }

    return { result };
  } catch {
    return { error: "Invalid mathematical expression" };
  }
}

function buildTextOutput(expr, result) {
  const trigMatch = expr.match(/^\s*(sin|cos|tan)\s*\(\s*([^\)]+)\s*\)\s*$/i);
  if (trigMatch) {
    const argRaw = trigMatch[2];
    try {
      const env = buildEvalEnv();
      const parser = new Parser();
      const argVal = parser.parse(normalizeExpression(argRaw)).evaluate(env);
      if (typeof argVal === "number" && isFinite(argVal)) {
        const rad = toRadians(argVal);
        return `${expr} = ${result}\nArgument: ${argVal}° (${rad} rad)`;
      }
    } catch {
      // fall through
    }
  }

  const invTrigMatch = expr.match(/^\s*(asin|acos|atan)\s*\(\s*([^\)]+)\s*\)\s*$/i);
  if (invTrigMatch) {
    const resDeg = result;
    const resRad = toRadians(result);
    return `${expr} = ${resDeg}° (${resRad} rad)`;
  }

  return `${expr} = ${result}`;
}

export function calculator(message) {
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
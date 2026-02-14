export function shouldUseCalculator(message) {
  if (!message || typeof message !== "string") return false;

  const lower = message.toLowerCase();

  // 1. Natural-language math triggers
  const mathPhrases = [
    "how much is",
    "calculate",
    "what is",
    "what's",
    "solve",
    "evaluate",
    "compute",
    "give me the result",
    "find the value",
    "result of",
    "equals",
    "="
  ];
  if (mathPhrases.some(p => lower.includes(p))) return true;

  // 2. Contains a math operator
  if (/[+\-*/^%=]/.test(message)) return true;

  // 3. Contains parentheses (likely math)
  if (/\([^()]+\)/.test(message)) return true;

  // 4. Contains a number + function
  if (/(sin|cos|tan|asin|acos|atan|sqrt|log|ln)\s*\(/i.test(message)) return true;

  // 5. Looks like a standalone constant
  if (/^\s*(pi|e)\s*$/i.test(message)) return true;

  // 6. Looks like a numeric expression
  if (/\d/.test(message)) return true;

  return false;
}
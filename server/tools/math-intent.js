export function shouldUseCalculator(message) {
  if (!message || typeof message !== "string") return false;

  const lower = message.toLowerCase().trim();

  // 0️⃣ Conversational follow-ups should NOT trigger calculator
  if (/^(so|ok|right|then|and|but)\b/.test(lower)) return false;
  if (/^(is it|is that|so it's|so it is|so x|so y|so the result)/.test(lower)) return false;

  // If message ends with a question but contains no operators, skip calculator
  if (/\?$/.test(lower) && !/[+\-*/^()=]/.test(lower)) return false;

  // 1️⃣ Natural-language math triggers
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
    "equals"
  ];
  if (mathPhrases.some(p => lower.includes(p))) return true;

  // 2️⃣ Contains an equation
  if (/=/.test(message)) return true;

  // 3️⃣ Contains a math operator
  if (/[+\-*/^%]/.test(message)) return true;

  // 4️⃣ Contains parentheses (likely math)
  if (/\([^()]+\)/.test(message)) return true;

  // 5️⃣ Contains a number + function
  if (/(sin|cos|tan|asin|acos|atan|sqrt|log|ln)\s*\(/i.test(message)) return true;

  // 6️⃣ Standalone constants
  if (/^\s*(pi|e)\s*$/i.test(message)) return true;

  // 7️⃣ Pure numbers should NOT trigger calculator
  if (/^\d+(\.\d+)?$/.test(lower)) return false;

  return false;
}
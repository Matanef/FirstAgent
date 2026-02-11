export function plan(message) {
  if (/^[0-9+\-*/().\s]+$/.test(message)) return "calculator";
  if (/summarize|explain/i.test(message)) return "summarize";
  if (/\b(who|what|when|where|why|how|top|list)\b/i.test(message)) return "search";
  return "llm";
}

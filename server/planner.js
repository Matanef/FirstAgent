export function plan(message) {
  const msg = message.toLowerCase();

  // Calculator
  if (/^[0-9+\-*/().\s]+$/.test(message)) {
    return "calculator";
  }

  // Finance keywords
  if (
    /\bstock|market|market cap|nasdaq|dow|s&p|shares|trading|etf|portfolio|earnings|analysis\b/i.test(
      msg
    )
  ) {
    return "finance";
  }

  // Search-type
  if (/\b(top|list|who|what|when|where|why|how|history|explain)\b/i.test(msg)) {
    return "search";
  }

  return "llm";
}

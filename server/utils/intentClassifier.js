// server/utils/intentClassifier.js
// Intent classifier: determines whether a user message is "chat" (conversational)
// or "task" (requires tool execution). Uses rule-based patterns with LLM fallback.

/**
 * Chat mode patterns — conversational, reflective, meta-questions
 * These should NOT trigger any tools; handled by chatAgent
 */
const CHAT_PATTERNS = [
  /\bdo you (like|think|feel|want|prefer|believe|enjoy|mind|care)\b/i,
  /\bhow (are|do|have) you\b/i,
  /\bwhat do you think\b/i,
  /\btell me about yourself\b/i,
  /\bdo you (remember|recall|know who)\b/i,
  /\bwhat'?s your (opinion|view|take|name|favorite)\b/i,
  /\bhow do you feel about\b/i,
  /\blet'?s\s+(talk|chat|discuss|have a conversation)\b/i,
  /\btalk\s+(a\s+bit\s+)?about\s+(?:the\s+)?(?:situation|things|it|this|that|life|stuff)\b/i,
  /\bI'?m (curious|wondering)\s+(about you|if you|what you)\b/i,
  /\bwhat (are|were) you (thinking|doing|working on)\b/i,
  /\bare you (happy|sad|tired|bored|excited|sentient|alive|conscious)\b/i,
  /\bwho (are|made|created) you\b/i,
  /\bwhat (can you|are you capable of)\b/i,
  /\b(thanks?|thank you|good job|well done|nice work|great job)\b/i,
  /\b(hello|hey|hi|good morning|good evening|good night|good afternoon)\s*[!?.]*$/i,
  /\bhow was your (day|night|weekend)\b/i,
  /\bdo you have (feelings|emotions|consciousness|a soul)\b/i,
  /\bwhat makes you (different|special|unique)\b/i,
  /\bcan you (learn|grow|evolve|change)\b/i,
  /\bwhat have you learned\b/i,
  /\bdo you like your (new )?improvements\b/i,
  /\bhow do you see yourself\b/i,
  /\bwhat is your purpose\b/i,
  /\bwhat would you like to\b/i,
  /\bwhat do you want to\s+(talk|chat|discuss|do)\b/i,
  /\b(so\s+)?what('?s| is) (on your mind|up|new|going on)\b/i,
  /\bhow('?s| is) (it going|everything|life|things)\b/i,
  /\b(nice|good) to (talk|chat|meet|see) you\b/i,
  /\btalk about\s+(something|anything)\b/i,
  /\bwhat should we (talk|chat|discuss) about\b/i,
  /\b(bored|lonely|just\s+chatting|just\s+talking)\b/i,
];

/**
 * Task mode patterns — commands, tool keywords, explicit actions
 * These require tool execution; handled by taskAgent
 */
const TASK_PATTERNS = [
  // Explicit commands
  /\b(search|find|look\s+up|google|fetch|get|check|show|list|display|browse)\s+/i,
  /\b(send|compose|write|draft|reply)\s+(an?\s+)?email\b/i,
  /\b(create|add|schedule|book|set\s+up|make)\s+(an?\s+)?(event|meeting|appointment|task|reminder)\b/i,
  /\b(review|analyze|audit|inspect)\s+(the\s+|my\s+|this\s+)?(code|file|project)\b/i,
  /\b(improve|evolve|self[- ]?evolve|self[- ]?improve|upgrade)\b/i,
  /\b(weather|forecast|temperature)\s*(in|for|at|today|tomorrow|this\s+week)?\b/i,
  /\b(stock|share|ticker|price\s+of|market)\b/i,
  /\b(news|headlines?|articles?)\b/i,
  /\b(sport|score|match|fixture|standings?|nba|nfl|premier\s+league)\b/i,
  /\b(moltbook|heartbeat|submolt)\b/i,
  /\b(github|trending|repos?|repository)\b/i,
  /\b(calculate|compute|solve|math|equation)\b/i,
  /\b(translate|convert|transform)\b/i,
  /\b(download|upload|install|npm)\b/i,
  /\b(run|execute|start|stop)\s+(the\s+)?(workflow|briefing|market\s+check)\b/i,
  /\b(delete|remove|cancel)\b/i,
  // File paths
  /[a-z]:[\\/]/i,
  /\.{0,2}\/[\w.-]+\/[\w.-]+/,
  // Math expressions
  /\d\s*[+\-*/^]\s*\d/,
];

/**
 * Classify user intent as "chat" or "task"
 * @param {string} message - The user's message
 * @param {Array} recentHistory - Last 5 conversation turns [{role, content, mode}]
 * @returns {{ mode: "chat"|"task", confidence: number, reason: string }}
 */
export function classifyIntent(message, recentHistory = []) {
  if (!message || typeof message !== "string") {
    return { mode: "task", confidence: 0.5, reason: "empty_message" };
  }

  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // Very short messages in conversational context are likely chat
  if (trimmed.length < 15) {
    // Greetings
    if (/^(hi|hey|hello|yo|sup|howdy|hola|good\s+(morning|evening|night|afternoon))[!?.\s]*$/i.test(trimmed)) {
      return { mode: "chat", confidence: 0.95, reason: "greeting" };
    }
    // Thank you
    if (/^(thanks?|thank\s+you|ty|thx|cheers|appreciate\s+it)[!?.\s]*$/i.test(trimmed)) {
      return { mode: "chat", confidence: 0.9, reason: "gratitude" };
    }
    // Yes/no responses in chat context
    if (/^(yes|no|yeah|nah|sure|ok|okay|yep|nope)[!?.\s]*$/i.test(trimmed)) {
      const lastMode = recentHistory.length > 0 ? recentHistory[recentHistory.length - 1]?.mode : null;
      return { mode: lastMode || "chat", confidence: 0.7, reason: "short_response_context" };
    }
  }

  // Check task patterns first (higher priority — actions should always be caught)
  let taskScore = 0;
  let taskReasons = [];
  for (const pattern of TASK_PATTERNS) {
    if (pattern.test(lower)) {
      taskScore++;
      taskReasons.push(pattern.source.substring(0, 30));
    }
  }

  // Check chat patterns
  let chatScore = 0;
  let chatReasons = [];
  for (const pattern of CHAT_PATTERNS) {
    if (pattern.test(lower)) {
      chatScore++;
      chatReasons.push(pattern.source.substring(0, 30));
    }
  }

  // If in a chat conversation and no strong task signals, continue chatting
  const recentChatCount = recentHistory.filter(h => h.mode === "chat").length;
  if (recentChatCount >= 3 && taskScore === 0) {
    chatScore += 2; // Boost chat likelihood in ongoing conversation
  }

  // Decision
  if (taskScore > 0 && chatScore === 0) {
    return { mode: "task", confidence: Math.min(0.95, 0.7 + taskScore * 0.1), reason: `task_patterns: ${taskReasons.join(", ")}` };
  }
  if (chatScore > 0 && taskScore === 0) {
    return { mode: "chat", confidence: Math.min(0.95, 0.7 + chatScore * 0.1), reason: `chat_patterns: ${chatReasons.join(", ")}` };
  }
  if (taskScore > chatScore) {
    return { mode: "task", confidence: 0.6 + (taskScore - chatScore) * 0.1, reason: `mixed_task_dominant` };
  }
  if (chatScore > taskScore) {
    return { mode: "chat", confidence: 0.6 + (chatScore - taskScore) * 0.1, reason: `mixed_chat_dominant` };
  }

  // Ambiguous — default to task (user expects actions)
  return { mode: "task", confidence: 0.5, reason: "ambiguous_default_task" };
}

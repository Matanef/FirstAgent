// server/utils/intentClassifier.js
// Intent classifier: determines whether a user message is "chat" (conversational)
// or "task" (requires tool execution). Uses rule-based patterns with LLM fallback.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDraft } from "./emailDrafts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOLS_DIR = path.resolve(__dirname, "..", "tools");

// Dynamically load all tool names so we never have to hardcode them
let DYNAMIC_TOOLS = [];
try {
  // Reads all filenames in the tools folder (e.g. "pikudTracker.js" -> "pikudtracker")
  if (fs.existsSync(TOOLS_DIR)) {
    DYNAMIC_TOOLS = fs.readdirSync(TOOLS_DIR)
      .filter(file => file.endsWith(".js") && file !== "llm.js") // Ignore the sterile llm tool
      .map(file => file.replace(".js", "").toLowerCase());
  }
  
  // You can optionally add a few permanent split-word aliases here just in case
  DYNAMIC_TOOLS.push("pikud", "moltbook", "spotify"); 
} catch (e) {
  console.warn("[intentClassifier] Could not dynamically load tools list:", e.message);
}
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
  /\bwhat(?:'?s|\s+is) your (opinion|view|take|thought|name|favorite)\b/i,
  /\byour (opinion|view|take|thoughts?)\s+(on|about|regarding)\b/i,
  /\bhow do you feel about\b/i,
  /\blet'?s\s+(talk|chat|discuss|have a conversation)\b/i,
  /\btalk\s+(a\s+bit\s+)?about\s+(?:the\s+)?(?:situation|things|it|this|that|life|stuff)\b/i,
  /\bI'?m (curious|wondering)\s+(about you|if you|what you)\b/i,
  /\bwhat (are|were) you (thinking|doing|working on)\b/i,
  /\bare you (happy|sad|tired|bored|excited|sentient|alive|conscious)\b/i,
  /\bwho (are|made|created) you\b/i,
  /\bwhat (can you|are you capable of)\b/i,
  /\b(thanks?|thank you|good job|well done|nice work|great job)\b/i,
  // Greeting must appear near start of message — avoids matching "hi" inside commands like "send msg saying hi"
  /^[\s]*(?:oh\s+|so\s+)?(hello|hey|hi|good morning|good evening|good night|good afternoon)(\s+(man|dude|pal|friend|buddy|bro|mate|fam|homie|guys?|there|everyone|all))?\b/i,
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
  // Conversational continuations — signals the user wants to keep chatting
  /\b(i'?m here to|just here to|came to)\s+(chat|talk|hang|chill|converse)/i,
  /\bnot\s+(specifically|really|particularly)\b/i,
  /\bjust\s+(wanted|want|wanna)\s+to\s+(chat|talk|say|ask)/i,
  /\bnothing\s+(specific|particular|special|in\s+mind)\b/i,
  /\bjust\s+(checking\s+in|saying\s+hi|dropping\s+by|hanging(\s+out)?)\b/i,
  /\bno\s+(task|request|question)s?\s*(right now|at the moment|really|today)?\b/i,
  /\bwhat('?s| is) (your|the)\s+(vibe|mood|energy)\b/i,
  /\bhow('?s|.s) your (day|night|evening|morning)\b/i,
  /\btell me (something|a story|a joke|more)\b/i,
  /\b(anyway|anyhow|so+),?\s*(what|how|where|who)/i,
  /\bI (think|believe|feel|wonder|guess|suppose)\b/i,
  /\bthat('?s| is) (interesting|cool|funny|weird|crazy|wild|true|fair)\b/i,
  /\byeah\b.*\b(but|though|right|exactly|totally|agree)\b/i,
  /\bwhat about you\b/i,
  /\byou (know|think|agree|reckon)\b/i,
  // Requests to converse — "can we speak/talk/chat", "let's just talk", "I need to talk"
  /\bcan we\s+(just\s+)?(speak|talk|chat|converse|hang)\b/i,
  /\bI\s+(need|want|wanna)\s+to\s+(talk|vent|speak|chat)\b/i,
  /\blet me\s+(tell|share|talk|vent)\b/i,
  // Personal sharing / venting — emotional content, life events, distress
  /\b(as you know|you know that)\b.*\b(i am|i'm|i live|i have|my)\b/i,
  /\b(today was|today is|yesterday was)\s+(a\s+)?(tiring|hard|rough|tough|bad|terrible|awful|scary|stressful|exhausting|long|crazy|intense|horrible|devastating)\b/i,
  /\b(i'?m?\s+(so\s+)?(tired|exhausted|scared|sad|angry|frustrated|stressed|upset|worried|anxious|depressed|devastated|shaken))\b/i,
  /\b(missiles?|rockets?|bombs?|bombing|shelling|shrapnel|war|attack|shelter|sirens?|alarms?|earthquake|flood|fire|accident|died|killed|death|funeral|injured|wounded|casualt(?:y|ies)|devastation|destruction|destroyed|explosion|impact\s+sites?|evacuation|displaced|refugees?|cluster\s+(?:bomb|missile|munition))\b/i,
];

/**
 * Task mode patterns — commands, tool keywords, explicit actions
 * These require tool execution; handled by taskAgent
 */
const TASK_PATTERNS = [
  // Explicit commands (Added run, call, execute, trigger, play)
  /\b(search|find|look\s+up|google|fetch|get|check|show|list|display|browse|run|call|execute|start|trigger|play)\b/i,
  // Fixed plural support for messages and emails
  /\b(send|compose|write|draft|reply)\s+(an?\s+)?(emails?|messages?|whatsapp|texts?|sms|dms?)\b/i,
  // Natural language "send [person/relation] a [adjective] message" — recipient between verb and noun
  // Note: \b doesn't work with Hebrew chars, so Hebrew verbs use (?:^|\s) anchoring
  /\b(send)\s+.{1,50}\b(message|mail|email|text)\b/i,
  /(?:^|\s)(שלח|תשלח|שלחי)\s+.{1,50}(הודעה|מייל|מסרון)/i,
  // "send a message to [person]" / "message [person]"
  /\b(send)\s+(a\s+)?(message|text)\s+(to)\s+/i,
  /(?:^|\s)(שלח|תשלח|שלחי)\s+.{0,10}(הודעה|מסרון)\s+(ל)/i,
  // Family relation as send target — "send my mom", "שלח לאמא"
  /\b(send)\s+(my\s+|to\s+my\s+)?(mom|dad|mother|father|brother|sister)\b/i,
  /(?:^|\s)(שלח|תשלח|שלחי)\s+(ל)?(אמא|אימא|אבא|אחי|אחות)/i,
  /\b(whatsapp|וואטסאפ|ווטסאפ)\b/i,
  // Memory/identity queries — must be task, not chat
  /\bwhat\s+do\s+you\s+(know|remember)\s+(about\s+me|about\s+my)\b/i,
  /\bwho\s+am\s+i\b/i,
  /\bmy\s+(contacts?|preferences|location|profile|email|phone)\b/i,
  /\b(create|add|schedule|book|set\s+up|make)\s+(an?\s+)?(event|meeting|appointment|task|reminder)\b/i,
  /\b(add|remove|delete|set)\s+(an?\s+)?(alias|nickname|aka|contact)\b/i,
  /\b(review|analyze|audit|inspect)\s+(the\s+|my\s+|this\s+)?(code|file|project)\b/i,
  /\b(rewrite|edit|correct|proofread|modify|update)\s+(the\s+|my\s+|this\s+)?(file|document|text|guide|code|script)\b/i,
  /\b(rewrite|edit|correct|proofread)\s+\w+\.\w{1,5}\b/i,
  /\b(fix|correct)\s+(the\s+)?(grammar|spelling|syntax|typos?)\b/i,
  /\b(improve|evolve|self[- ]?evolve|self[- ]?improve|upgrade)\b/i,
  /\b(weather|forecast|temperature)\s*(in|for|at|today|tomorrow|this\s+week)?\b/i,
  // Finance — "share" alone is too ambiguous (common verb); require stock-specific context
  /\b(stock|ticker)\b/i,
  /\bshares?\s+(of|in|at|price|market|stock)\b/i,
  /\bstock\s+(market|price|ticker|chart)\b/i,
  /\bprice\s+of\s+\w+/i,
  /(?<!\bon\s+the\s+)(?<!\bin\s+the\s+)\b(news|headlines?|articles?)\b/i,
  /\b(sport|score|match|fixture|standings?|nba|nfl|premier\s+league)\b/i,
  /\b(moltbook|heartbeat|submolt)\b/i,
  /\b(github|trending|repos?|repository)\b/i,
  /\b(calculate|compute|solve|math|equation)\b/i,
  /\b(translate|convert|transform)\b/i,
  // upload/download — require a file-type object so "upload a photo for the park" (feature
  // description) doesn't fire; "install" and "npm" remain unconditional (always technical)
  /\b(upload|download)\s+(the\s+|a\s+|my\s+|this\s+)?(file|document|image|photo|video|pdf|csv|zip|backup|attachment|dataset|package)\b/i,
  /\b(install|npm)\b/i,
  /\b(run|execute|start|stop)\s+(the\s+)?(workflow|briefing|market\s+check)\b/i,
  // delete/remove/cancel — require a task-specific object so "remove that idea" doesn't fire
  /\b(delete|remove)\s+(the\s+|this\s+|a\s+|my\s+)?(event|meeting|appointment|task|reminder|file|note|record|entry|email|message|contact|alarm|workflow|schedule|item|row|column)\b/i,
  /\b(cancel)\s+(the\s+|this\s+|a\s+|my\s+)?(event|meeting|appointment|task|order|booking|subscription|workflow|schedule|job|reminder)\b/i,
  // File paths
  /[a-z]:[\\/]/i,
  /\.{0,2}\/[\w.-]+\/[\w.-]+/,
  // Math expressions — treat + * / ^ as unambiguous; treat - carefully to avoid matching
  // range notation like "3-4 prompts", "1-2 days", "100-200 items".
  // Use full-number boundaries (lookbehind + lookahead) so "0-2" inside "100-200 items"
  // doesn't sneak through, and reject if the result is followed by a word character.
  /\d\s*[+*/^]\s*\d/,
  /(?<!\d)\d+\s*-\s*\d+(?!\d)(?!\s*[a-zA-Z])/,
];

/**
 * Classify user intent as "chat" or "task"
 * @param {string} message - The user's message
 * @param {Array} recentHistory - Last 5 conversation turns [{role, content, mode}]
 * @param {Array} fileIds - IDs of files attached via drag-and-drop
 * @returns {{ mode: "chat"|"task", confidence: number, reason: string }}
 */
export function classifyIntent(message, recentHistory = [], fileIds = []) {
  if (!message || typeof message !== "string") {
    return { mode: "task", confidence: 0.5, reason: "empty_message" };
  }

  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // ── STRICT OBSIDIAN OVERRIDE ─────────────────────────────────
  // Bypasses all chat logic and momentum for Obsidian-specific commands
  if (/\b(obsidian|stub notes?|vault|dataview|canvas)\b/i.test(lower)) {
    return { mode: "task", confidence: 1.0, reason: "explicit_obsidian_override" };
  }

  // ── STRICT SELF-IMPROVEMENT INTROSPECTION OVERRIDE ───────────
  // "what have you improved lately?", "how accurate is your routing?", "what issues have you detected?" —
  // must reach selfImprovement. Without this, the chat classifier's personal-question patterns score
  // these as chat (0.8) and the planner's technical override never runs.
  if (
    /\b(what\s+have\s+you\s+improved|what\s+did\s+you\s+improve|have\s+you\s+(improved|changed|updated)\s+recently|improved\s+lately|what\s+(changes?|updates?)\s+(have\s+you|did\s+you)\s+made?|recently\s+(improved|changed|updated))\b/i.test(lower) ||
    /\b(how\s+accurate|what\s+is\s+your\s+accuracy|accuracy\s+of\s+your|routing\s+accuracy|your\s+routing\s+accuracy|how\s+well\s+do\s+you\s+route|what\s+issues?\s+(have\s+you|did\s+you)\s+detect)\b/i.test(lower) ||
    /\b(selfimprovement|self.improvement|self.evolve|selfevolve)\b/i.test(lower)
  ) {
    return { mode: "task", confidence: 0.95, reason: "introspection_selfimprove" };
  }

// ── STRICT CODE-INTROSPECTION OVERRIDE ───────────────────────
  // "where/how do I (set|configure|change|...) the X in the Y" — questions ABOUT our own code.
  // Without this override, such queries score zero on task/chat patterns and stick to chat mode
  // during an active conversation, losing the planner's codeRag routing entirely.
  if (
    /\b(where|how)\b.*?\b(do\s+(i|we)|can\s+(i|we)|to)\s+(set|configure|change|update|find|modify|edit|adjust|tweak|override)\b/i.test(lower) &&
    /\b(skill|tool|module|agent|pipeline|planner|executor|tier|prompt|config|setting|variable|function|class|route|router|manifest|budget|threshold|timeout|param(?:eter)?|synthesizer|harvester|analyzer|writer|bootstrapper|matcher|extractor|detector|codebase|repo|repository)\b/i.test(lower)
  ) {
    return { mode: "task", confidence: 0.95, reason: "explicit_code_introspection_override" };
  }

  // ── STATE-AWARE ROUTING ──────────────────────────────────────
  // Check for pending conversational states BEFORE anything else.
  // "send it", "cancel", "confirm" etc. must route to task when a draft is pending.
  const lastTool = recentHistory.length > 0 ? recentHistory[recentHistory.length - 1]?.tool : null;
  const lastContent = recentHistory.length > 0 ? (recentHistory[recentHistory.length - 1]?.content || "") : "";
  const hasPendingEmailContext = lastTool === "email" || /say\s+["']?send it["']?\s+to\s+confirm/i.test(lastContent);

  if (hasPendingEmailContext) {
    // Route send/cancel/confirm/yes/no to task when email draft is pending
    if (/^(send(\s+it)?|yes[,.]?\s*send(\s+it)?|confirm|yes|sure|go\s+ahead|do\s+it)[!?.\s]*$/i.test(trimmed)) {
      return { mode: "task", confidence: 0.99, reason: "pending_email_confirm" };
    }
    if (/^(cancel|discard|don'?t\s+send|abort|no|nah|never\s*mind|nevermind)[!?.\s]*$/i.test(trimmed)) {
      return { mode: "task", confidence: 0.99, reason: "pending_email_cancel" };
    }
  }

  // Initialize scores BEFORE any code that uses them
  let taskScore = 0;
  let taskReasons = [];

  // Very short messages in conversational context are likely chat
  if (trimmed.length < 25) {
    // Greetings
    if (/^(hi|hey|hello|yo|sup|howdy|hola|good\s+(morning|evening|night|afternoon))\b(\s+(man|dude|pal|friend|buddy|bro|mate|fam|homie|guys?|there|everyone|all))?[!?.\s]*$/i.test(trimmed)) {
      return { mode: "chat", confidence: 0.95, reason: "greeting" };
    }
    // Thank you
    if (/^(thanks?|thank\s+you|ty|thx|cheers|appreciate\s+it)[!?.\s]*$/i.test(trimmed)) {
      return { mode: "chat", confidence: 0.9, reason: "gratitude" };
    }
    // Yes/no responses in chat context (only when NO pending state)
    if (/^(yes|no|yeah|nah|sure|ok|okay|yep|nope)[!?.\s]*$/i.test(trimmed)) {
      const lastMode = recentHistory.length > 0 ? recentHistory[recentHistory.length - 1]?.mode : null;
      return { mode: lastMode || "chat", confidence: 0.7, reason: "short_response_context" };
    }
    // Dynamic tool name override for short messages
    for (const tool of DYNAMIC_TOOLS) {
      if (lower.includes(tool)) {
        taskScore += 5;
        taskReasons.push(`explicit_tool:${tool}`);
      }
    }
  }

  // Explicit tool name override (runs for ALL message lengths)
  const EXPLICIT_TOOLS = ["pikud", "tracker", "spotify", "moltbook", "github", "sandbox", "alarm", "scheduler", "weather", "email", "news", "finance", "sports", "selfimprovement", "selfevolve", "deepresearch"];
  for (const tool of EXPLICIT_TOOLS) {
    if (lower.includes(tool)) {
      taskScore += 5;
      taskReasons.push(`explicit_tool:${tool}`);
    }
  }

  // File attachments — if the user dragged files in, they want something DONE with them
  if (fileIds && fileIds.length > 0) {
    taskScore += 2;
    taskReasons.push(`attached_files:${fileIds.length}`);
  }

  // Check task patterns
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

  // CONFLICT RESOLUTION: If task keywords are present alongside emotional/war keywords,
  // the user is asking for information ABOUT the topic, not venting.
  // e.g. "news about the war" = task (fetch news), NOT chat (emotional support about war)
  if (taskScore > 0 && chatScore > 0 && taskReasons.some(r => r.includes("explicit_tool"))) {
    chatScore = Math.max(0, chatScore - taskScore); // Suppress chat when explicit tools detected
  }

  // If in a chat conversation and no strong task signals, continue chatting
  // BUT: apply time decay — if the last message was 5+ min ago, user may have switched context
  const recentChatCount = recentHistory.filter(h => h.mode === "chat").length;
  const lastTurn = recentHistory.length > 0 ? recentHistory[recentHistory.length - 1] : null;
  const lastTurnWasChat = lastTurn?.mode === "chat";

  // Time decay: reduce chat stickiness if the conversation has gone quiet
  const lastTurnAge = lastTurn?.timestamp
    ? (Date.now() - new Date(lastTurn.timestamp).getTime()) / 60000 // minutes
    : Infinity;
  const isRecentConversation = lastTurnAge < 5; // last message was <5 min ago

  if (taskScore === 0 && chatScore > 0 && lastTurnWasChat && isRecentConversation) {
    chatScore += 1; // Mild boost — actively chatting and this message also has chat patterns
  } else if (taskScore === 0 && chatScore === 0 && recentChatCount >= 3 && isRecentConversation) {
    chatScore += 1; // Ambiguous message during active chat — slight lean toward chat
  }

  // RESILIENCE GUARD: A single weak task-pattern match during active chat is not enough to
  // hijack the conversation (1 match → 0.8 conf — too aggressive).
  // Bump chatScore so the ambiguous tie-break logic can resolve it instead.
  // NOT extended to taskScore=2: two legitimate patterns firing = real task intent.
  // Explicit tool names (+5 each) and file attachments are always trustworthy — excluded.
  if (
    taskScore === 1 && chatScore === 0 &&
    lastTurnWasChat && isRecentConversation &&
    !taskReasons.some(r => r.startsWith("explicit_tool") || r.startsWith("attached_files"))
  ) {
    chatScore += 1; // Treat as ambiguous — let tie-break decide
    chatReasons.push("weak_task_in_active_chat");
  }
  // When scores are tied AND we're in active chat, boost chat.
  // The user is sharing/conversing — a casual "news" mention shouldn't override distress signals.
  if (taskScore > 0 && chatScore > 0 && taskScore === chatScore && lastTurnWasChat && isRecentConversation) {
    chatScore += 1; // Tie-break toward chat when actively conversing
  }
  // NOTE: No boost if conversation is stale (>5 min) — user may have switched context

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

  // Ambiguous — but if we're in an active chat conversation, continue chatting
  // rather than routing to taskAgent which has no personality/context
  if (lastTurnWasChat && isRecentConversation) {
    return { mode: "chat", confidence: 0.55, reason: "ambiguous_but_active_chat" };
  }

  // Default to task (user expects actions)
  return { mode: "task", confidence: 0.5, reason: "ambiguous_default_task" };
}

/**
 * Async wrapper around classifyIntent that consults the routing table for
 * high-confidence tool matches. If a rule with priority ≥ 70 fires, it
 * overrides a weak chat classification so the planner handles the message
 * instead of keeping it inside chatAgent.
 *
 * Threshold rationale:
 *   Priority ≥ 70 → Tier 3+ (email, weather, calendar, x, finance, sports,
 *     youtube, news, memory, code tools) — specific enough to trust over chat.
 *   Priority < 70 → broad catch-alls (search, llm fallback) — too noisy to
 *     override chat, would swallow real conversational turns.
 *
 * Uses dynamic import to avoid circular dep at module load time.
 *
 * @param {string} message
 * @param {Array}  recentHistory
 * @param {Array}  fileIds
 * @returns {Promise<{ mode: "chat"|"task", confidence: number, reason: string }>}
 */
export async function classifyIntentWithRoutingOverride(message, recentHistory = [], fileIds = []) {
  const result = classifyIntent(message, recentHistory, fileIds);

  // Only challenge weak chat classifications — high-confidence chat and all
  // task classifications pass straight through.
  if (result.mode !== "chat" || result.confidence >= 0.9) return result;

  try {
    const { evaluateRoutingTable } = await import("../routing/index.js");
    const lower   = (message || "").trim().toLowerCase();
    const trimmed = (message || "").trim();
    const routingMatch = await evaluateRoutingTable(lower, trimmed, {});

    if (routingMatch?.[0]?.priority >= 70) {
      const tool = routingMatch[0].tool;
      console.log(`[intentClassifier] Routing override: "${tool}" (priority ${routingMatch[0].priority}) beats chat (${result.confidence.toFixed(2)})`);
      return { mode: "task", confidence: 0.85, reason: `routing_table_override_${tool}` };
    }
  } catch (e) {
    // routing module not yet loaded or import failed — fall back to original result
    console.warn("[intentClassifier] Routing override check failed:", e.message);
  }

  return result;
}

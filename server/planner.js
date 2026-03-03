// server/planner.js
// COMPLETE MULTI-STEP PLANNER (patched): diagnostic routing, tool availability checks,
// safe improvement plans (no calls to missing tools), and clearer certainty logging.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { llm } from "./tools/llm.js";
import { getMemory } from "./memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// UTIL: list available tools (reads server/tools/*.js)
// ============================================================
function listAvailableTools(toolsDir = path.resolve(__dirname, "tools")) {
  // Filenames to exclude: test files, backups, duplicates, index, and non-tool utilities
  const EXCLUDE = new Set([
    "index.js", "llm.js",  // infrastructure, not user-facing tools
    "calculator.test.js",  // test file
    "math-intent.js",      // test utility
    "email1.js", "email2backup.js", "emailConfirm.js", // backups/duplicates
  ]);

  try {
    const files = fs.readdirSync(toolsDir, { withFileTypes: true });
    return files
      .filter(f => f.isFile() && f.name.endsWith(".js") && !f.name.includes(".backup") && !EXCLUDE.has(f.name))
      .map(f => f.name.replace(/\.js$/, ""));
  } catch (e) {
    console.warn("[planner] listAvailableTools failed:", e?.message || e);
    return [];
  }
}

// ============================================================
// IMPROVEMENT REQUEST DETECTION
// ============================================================

/**
 * Detect improvement/self-improvement requests
 * These require a multi-step sequence: githubTrending → review → applyPatch (or llm fallback)
 */
function isImprovementRequest(message) {
  const lower = (message || "").toLowerCase();

  const patterns = [
    /improve.*(?:tool|code|file)/i,
    /suggest.*improvement/i,
    /review.*and.*(?:improve|suggest|patch|commit)/i,
    /scan.*trending.*and.*(?:improve|review|suggest)/i,
    /self[- ]?improve/i,
    /patch.*(?:tool|code)/i,
    /enhance.*(?:based on|against)/i,
    /commit[- ]?able.*improvement/i,
    /trending.*patterns.*review/i
  ];

  return patterns.some(p => p.test(lower));
}

/**
 * Extract target file from improvement request
 */
function extractImprovementTarget(message) {
  const lower = (message || "").toLowerCase();

  // Match "our X tool" or "the X tool"
  const toolMatch = message.match(/(?:our|the)\s+([a-z]+)\s+tool/i);
  if (toolMatch) {
    return `${toolMatch[1]}.js`;
  }

  // Match specific tool names
  const tools = ['email', 'file', 'search', 'news', 'weather', 'finance', 'github', 'review', 'calculator'];
  for (const tool of tools) {
    if (lower.includes(tool)) {
      return `${tool}.js`;
    }
  }

  return 'email.js'; // Default fallback
}

/**
 * Generate safe improvement steps, avoiding missing tools by using llm fallbacks.
 * availableTools: array of tool names (without .js)
 */
function generateImprovementSteps(message, availableTools = []) {
  const target = extractImprovementTarget(message);
  const baseName = target.replace('.js', '');

  // Extract search query for githubTrending
  let searchQuery = `${baseName} patterns best practices`;
  const trendingMatch = message.match(/trending.*for\s+([^,]+?)(?:\s+patterns|\s+and|,|$)/i);
  if (trendingMatch) {
    searchQuery = trendingMatch[1].trim();
  }

  console.log(`📋 Generating safe improvement sequence:`);
  console.log(`   Target: ${target}`);
  console.log(`   Search: ${searchQuery}`);

  const plan = [];

  const substitutions = [];

  // Step 1: githubTrending (safe if available, otherwise llm fallback)
  if (availableTools.includes('githubTrending')) {
    plan.push({ tool: 'githubTrending', input: searchQuery, context: {}, reasoning: 'Search trending repositories for patterns' });
  } else {
    plan.push({ tool: 'llm', input: `Search summary: list best practices for ${baseName} patterns.`, context: {}, reasoning: 'fallback_githubTrending' });
    substitutions.push('githubTrending → llm (not available)');
  }

  // Step 2: review (safe if available, otherwise llm fallback)
  if (availableTools.includes('review')) {
    plan.push({ tool: 'review', input: target, context: {}, reasoning: `Review current ${target} implementation` });
  } else {
    plan.push({ tool: 'llm', input: `Review summary: analyze ${target} and list issues and improvement suggestions.`, context: {}, reasoning: 'fallback_review' });
    substitutions.push('review → llm (not available)');
  }

  // Step 3: applyPatch (only if available) else produce patch text via llm
  if (availableTools.includes('applyPatch')) {
    plan.push({ tool: 'applyPatch', input: target, context: { targetFile: target }, reasoning: `Apply improvements to ${target} based on review and patterns` });
  } else {
    plan.push({ tool: 'llm', input: `Propose a patch (diff) for ${target} that implements the suggested improvements from the review.`, context: {}, reasoning: 'generate_patch_text' });
    substitutions.push('applyPatch → llm (not available)');
  }

  // Steps 4-5: gitLocal status + add (no commit - unreliable due to staging issues)
  if (availableTools.includes('gitLocal')) {
    plan.push({ tool: 'gitLocal', input: 'status', context: {}, reasoning: 'Check git status after changes' });
    plan.push({ tool: 'gitLocal', input: `add ${target}`, context: {}, reasoning: `Stage ${target} for commit` });
  } else {
    plan.push({ tool: 'llm', input: `Provide git commands to check status and stage ${target}`, context: {}, reasoning: 'git_instructions_fallback' });
    substitutions.push('gitLocal → llm (not available)');
  }

  if (substitutions.length > 0) {
    console.log(`⚠️ Tool substitutions: ${substitutions.join(', ')}`);
  }

  return plan;
}

// ============================================================
// CERTAINTY LAYER HELPERS
// ============================================================

function isMathExpression(msg) {
  const trimmed = (msg || "").trim();
  // Guard: URLs and domain-like strings are NOT math (the / in URLs triggers math regex)
  if (/https?:\/\/|www\.|[a-z0-9-]+\.(com|org|net|io|dev|co)\b/i.test(trimmed)) return false;
  // Guard: file paths are not math (the / in paths triggers math regex)
  if (/\b\w+\/\w+\.\w{1,5}\b/.test(trimmed)) return false;
  if (!/[0-9]/.test(trimmed)) return false;
  if (/[+\-*/^=()]/.test(trimmed)) return true;
  return /^\s*[\d\.\,\s()+\-*/^=]+$/.test(trimmed);
}

function isSimpleDateTime(msg) {
  const lower = (msg || "").toLowerCase().trim();
  return (
    /^what('?s| is) (the )?(date|time|day)/.test(lower) ||
    /^(date|time|day|month|year) (today|now)/.test(lower)
  );
}

function hasExplicitFilePath(text) {
  if (!text) return false;
  // Absolute paths: D:/..., C:\...
  if (/[a-z]:[\\/]/i.test(text)) return true;
  // Relative paths with directory separator + extension: server/planner.js, ./utils/config.js
  if (/(?:^|\s)\.{0,2}\/?\w[\w.-]*\/[\w.-]+\.\w{1,5}\b/.test(text)) return true;
  // GUARD: If text contains a URL or domain, it's NOT a file path
  if (/https?:\/\//i.test(text)) return false;
  if (/\b[a-z0-9-]+\.(com|org|net|io|dev|co|app|gov|edu)\b/i.test(text)) return false;
  // Absolute paths: D:/..., C:\...
  if (/[a-z]:[\\/]/i.test(text)) return true;
  // Relative paths with file extensions: server/planner.js, ./utils/config.js, ../dir/file.py
  if (/(?:^|\s)\.{0,2}\/?[\w][\w.-]*\/[\w][\w.-]*\.\w{1,5}\b/.test(text)) return true;
  // Direct filename with common code extensions: planner.js, config.json (but not single words like "apple.com")
  if (/\b[\w-]+\.(js|ts|py|json|md|txt|html|css|jsx|tsx|java|go|rs|sh|yml|yaml|toml|xml|sql|rb|mjs|cjs)\b/i.test(text)) return true;
  return false;
}

function isSendItCommand(text) {
  const trimmed = (text || "").trim().toLowerCase();
  return (
    trimmed === "send it" ||
    trimmed === "send" ||
    trimmed === "yes send it" ||
    trimmed === "yes, send it" ||
    trimmed === "send the email" ||
    trimmed === "confirm" ||
    (trimmed === "yes" && (text || "").length < 10)
  );
}

function isCancelCommand(text) {
  const trimmed = (text || "").trim().toLowerCase();
  return (
    trimmed === "cancel" ||
    trimmed === "discard" ||
    trimmed === "don't send" ||
    trimmed === "dont send" ||
    trimmed === "never mind" ||
    trimmed === "nevermind" ||
    trimmed === "abort"
  );
}

function isMemoryWriteCommand(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return /^remember\s+(my\s+|that\s+|the\s+)?/i.test(lower);
}

const WEATHER_KEYWORDS = [
  "weather", "forecast", "temperature", "temp", "rain", "raining",
  "snow", "snowing", "humidity", "wind", "windy", "sunny", "cloudy"
];

const FORGET_SYNONYMS = ["forget", "forgot", "remove", "clear", "delete"];

function containsKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(k => new RegExp(`\\b${k}\\b`, "i").test(lower));
}

function locationWithForgetLike(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\blocation\b/.test(lower)) return false;
  return FORGET_SYNONYMS.some(s => lower.includes(s));
}

function hereIndicatesWeather(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\bhere\b/.test(lower)) return false;
  return containsKeyword(lower, WEATHER_KEYWORDS);
}

function extractCity(message) {
  // Strip trailing punctuation before matching
  const lower = (message || "").toLowerCase().trim().replace(/[?.!,;:]+$/, '');
  // Strip temporal words from the end before extracting city
  const cleaned = lower.replace(/\s+(today|tonight|tomorrow|this\s+week|this\s+weekend|next\s+week|right\s+now|currently|later|soon)\s*$/i, '');
  const inMatch = cleaned.match(/\bin\s+([a-zA-Z\s\-]+)$/);
  if (inMatch) return formatCity(inMatch[1]);
  const forMatch = cleaned.match(/\bfor\s+([a-zA-Z\s\-]+)$/);
  if (forMatch) return formatCity(forMatch[1]);
  return null;
}

function formatCity(city) {
  return city.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ============================================================
// DIAGNOSTIC / ACCURACY DETECTION
// ============================================================

/**
 * Return a deterministic routing decision for diagnostic/meta questions
 * (routing, accuracy, reliability, explain planner, debug, why did you choose).
 * Returns an array of tool steps or null if no match.
 */
function checkDiagnosticQuestion(message) {
  if (!message) return null;
  const lower = message.toLowerCase().trim();

  // GUARD: if message contains a file path, it's NOT a diagnostic question
  // (e.g., "Read D:/local-llm-ui/server/planner.js" should NOT match "planner")
  if (hasExplicitFilePath(message)) return null;

  // common diagnostic patterns
  const diagPatterns = [
    /\bhow (accurate|reliable|precise)\b/,
    /\b(routing|route|router|planner|classifier|intent|intentions|tool selection)\b/,
    /\b(routing accuracy|accuracy of the routing|how accurate is your routing|how accurate is your planner)\b/,
    /\bwhy did you choose\b/,
    /\bexplain (your|the) (routing|planner|decision|choice)\b/,
    /\bcan you check your routing\b/,
    /\bdebug (the )?(planner|routing)\b/
  ];

  if (diagPatterns.some(rx => rx.test(lower))) {
    // Route accuracy/reliability/performance questions to selfImprovement
    // (selfImprovement can report on telemetry and routing performance)
    if (/\b(accurate|reliable|precise|accuracy|reliability|performance|improve|self[- ]?improve|suggest improvement|how can you improve)\b/.test(lower)) {
      return [{ tool: "selfImprovement", input: message, context: {}, reasoning: "certainty_diagnostic_self_improve" }];
    }
    return [{ tool: "llm", input: `Explain planner routing and accuracy for: ${message}`, context: {}, reasoning: "certainty_diagnostic_explain" }];
  }

  return null;
}

// ============================================================
// LLM CLASSIFIER (For single-step plans)
// ============================================================

function extractContextSignals(message) {
  const lower = (message || "").toLowerCase();
  const signals = [];

  if (hasExplicitFilePath(message)) signals.push("CONTAINS_FILE_PATH");
  if (/\b(github|repo|repository)\b/i.test(message)) signals.push("MENTIONS_GITHUB");
  if (/\b(trending|popular|top)\b/i.test(lower)) signals.push("MENTIONS_TRENDING");
  if (/\b(stock|share|ticker)\b/i.test(lower)) signals.push("MENTIONS_FINANCE");
  if (containsKeyword(lower, WEATHER_KEYWORDS)) signals.push("MENTIONS_WEATHER");
  if (/\b(news|headline|article)\b/i.test(lower)) signals.push("MENTIONS_NEWS");
  if (/\b(email|mail)\b/i.test(lower)) signals.push("MENTIONS_EMAIL");
  if (/\b(review|inspect|examine)\b/i.test(lower)) signals.push("MENTIONS_REVIEW");
  if (/\b(improve|improvement|patch)\b/i.test(lower)) signals.push("MENTIONS_SELF_IMPROVEMENT");

  return signals;
}

async function detectIntentWithLLM(message, contextSignals, availableTools = []) {
  const signalText = contextSignals.length > 0
    ? `\nCONTEXT SIGNALS: ${contextSignals.join(", ")}`
    : "";

  const toolsListText = availableTools.length > 0 ? `\nAVAILABLE TOOLS: ${availableTools.join(", ")}` : "";

  const prompt = `You are an intent classifier for an AI agent. Classify the user's message into ONE tool.
${toolsListText}

USER MESSAGE:
"${message}"
${signalText}

EXAMPLES (correct routing):
- "hey, how do you feel?" → llm
- "what's 15% of 230?" → calculator
- "weather in Paris" → weather
- "latest news about AI" → news
- "search for React tutorials" → search
- "look up the history of the Eiffel Tower" → search
- "who was Albert Einstein?" → search
- "find information about quantum computing" → search
- "email John saying meeting at 3pm" → email
- "list repos" → github
- "list D:/projects" → file
- "trending repos" → githubTrending
- "review server/planner.js" → review
- "remember my name is Alex" → memorytool
- "remember my email is alex@test.com" → memorytool
- "login to moltbook" → moltbook
- "browse example.com" → webBrowser
- "git status" → gitLocal
- "find duplicate files in D:/test" → duplicateScanner
- "how accurate is your routing?" → selfImprovement
- "what can you do?" → llm
- "tell me a joke" → llm
- "analyze the sentiment of this text" → nlp_tool
- "youtube tutorials about node.js" → youtube
- "store my moltbook password" → moltbook
- "add task: review pull request by Friday" → tasks
- "write a hello world script to D:/test.js" → fileWrite
- "create a config file at D:/app/config.json" → fileWrite
- "what events do I have today" → calendar
- "schedule a meeting tomorrow at 3pm" → calendar
- "load document D:/report.txt" → documentQA
- "ask about the project timeline from the docs" → documentQA
- "show my contacts" → contacts
- "what's John's phone number" → contacts
- "run the morning briefing workflow" → workflow
- "list available workflows" → workflow

NEGATIVE EXAMPLES (common mistakes to avoid):
- "how are you" → llm (NOT selfImprovement, NOT weather)
- "what's the weather" → weather (NOT follow-up from previous tool)
- "how accurate is your routing" → selfImprovement (NOT calculator, NOT llm)
- "what's the weather like" → weather (NOT llm)
- "tell me about stocks" → finance (NOT search)
- "what do you know about me" → memorytool (NOT search)
- "schedule a task every hour" → scheduler (NOT tasks)
- "look up the history of X" → search (NOT webBrowser — no specific website)
- "add task: review pull request" → tasks (NOT github — "task" takes priority)
- "write a script to D:/test.js" → fileWrite (NOT file — write intent)

RULES:
1. Casual conversation, greetings, opinions, explanations → llm
2. "list repos" → github (NOT file)
3. "list D:/..." → file
4. NEVER use nlp_tool unless explicitly asked for "sentiment" or "analyze text"
5. "moltbook" → moltbook
6. "browse/visit [website]" → webBrowser
7. "store/save password/credentials" → moltbook or webBrowser (NOT memorytool)
8. "look up / find information about / history of / who is" → search (NOT webBrowser)
9. "write/create [content] to [path]" → fileWrite (NOT file)
10. "add task / todo / reminder" → tasks (NOT github, even if "pull request" mentioned)
11. "how accurate/reliable is your routing" → selfImprovement (NOT llm)
12. When unsure, return "llm" (the safest fallback)

Respond with ONLY the tool name (one word, no explanation).`;

  try {
    const response = await llm(prompt);
    if (!response.success || !response.data?.text) {
      return { intent: "llm", reason: "fallback" };
    }

    const text = response.data.text.trim().toLowerCase();
    const intent = text.split("|")[0].trim().replace(/[^a-z_]/g, "");

    console.log("🧠 LLM classified:", intent);

    return { intent, reason: "llm_classified", context: {} };
  } catch (err) {
    console.error("LLM intent error:", err.message);
    return { intent: "llm", reason: "error_fallback" };
  }
}

// ============================================================
// MULTI-TURN CONTEXT: Follow-up detection
// ============================================================

/**
 * Detect follow-up questions and inherit tool from previous turn.
 * E.g., "what about Paris?" after a weather query → route to weather.
 *
 * CRITICAL GUARD: The new message must NOT clearly belong to a DIFFERENT tool.
 * Without this, "what's the weather?" after a finance query inherits finance.
 */
async function checkFollowUpContext(message, conversationId) {
  if (!conversationId) return null;
  const lower = message.toLowerCase().trim();

  // Only trigger on explicit follow-up signals — NOT just short messages.
  // Short messages like "what's the weather?" are clearly new intents, not follow-ups.
  const hasFollowUpSignal = /\b(what about|how about|and\s+(also|now)|do the same|same for|now try|another|instead|more about|tell me more|any more|and in|and for)\b/i.test(lower);

  if (!hasFollowUpSignal) return null;

  // GUARD: If the message has clear keywords for a DIFFERENT domain, it's a new intent
  const domainPatterns = {
    weather: /\b(weather|forecast|temperature|rain|snow|humidity|wind|sunny|cloudy)\b/i,
    finance: /\b(stock|share|price|ticker|market|portfolio|invest|dividend|earnings|trading)\b/i,
    news: /\b(news|headline|article|breaking)\b/i,
    sports: /\b(score|match|game|league|team|player|football|soccer|standings?|fixture)\b/i,
    search: /\b(search|look\s+up|find\s+info|history\s+of|who\s+(is|was))\b/i,
    email: /\b(email|mail|inbox|send)\b/i,
    calculator: /\b(calculate|compute|solve)\b/i,
  };

  try {
    const memory = await getMemory();
    const conversation = memory.conversations?.[conversationId] || [];
    if (conversation.length < 2) return null;

    // Find the last assistant message that used a specific tool
    const lastToolMessage = [...conversation]
      .reverse()
      .find(m => m.role === 'assistant' && m.tool && m.tool !== 'llm');

    if (!lastToolMessage) return null;

    const prevTool = lastToolMessage.tool;

    // Only route follow-ups for tools where it makes sense
    const followUpTools = ['weather', 'search', 'news', 'finance', 'sports', 'file'];
    if (!followUpTools.includes(prevTool)) return null;

    // CRITICAL: Check if message has keywords for a DIFFERENT domain → new intent, not follow-up
    for (const [domain, pattern] of Object.entries(domainPatterns)) {
      if (domain !== prevTool && pattern.test(lower)) {
        console.log(`[planner] Follow-up BLOCKED: message has "${domain}" keywords, not inheriting "${prevTool}"`);
        return null;
      }
    }

    console.log(`[planner] Follow-up detected: "${message}" → inheriting tool "${prevTool}" from conversation`);
    return {
      tool: prevTool,
      input: message,
      context: { followUp: true, previousTool: prevTool },
      reasoning: "context_follow_up"
    };
  } catch (err) {
    console.warn("[planner] Follow-up check failed:", err.message);
    return null;
  }
}

// ============================================================
// TOOL CHAINING: Detect multi-intent queries
// ============================================================

/**
 * Detect if a query contains multiple intents that should be chained
 * E.g., "search for X and email me the results", "check weather and also the news"
 */
function detectChainedIntents(message) {
  const lower = (message || "").toLowerCase();

  // Patterns that indicate multi-step requests
  const chainPatterns = [
    // "X and then Y", "X then Y"
    /(.+?)\s+(?:and\s+)?then\s+(.+)/i,
    // "X and also Y"
    /(.+?)\s+and\s+also\s+(.+)/i,
    // "X and email/send me the results"
    /(.+?)\s+and\s+(email|send|mail)\s+(?:me\s+)?(?:the\s+)?(?:results?|findings?|info|information|summary|details)/i,
    // "after X, Y" / "after X do Y"
    /after\s+(.+?),?\s+(?:do\s+|please\s+)?(.+)/i,
    // "X, then Y"
    /(.+?),\s+then\s+(.+)/i,
  ];

  for (const pattern of chainPatterns) {
    const match = message.match(pattern);
    if (match) {
      return {
        isChained: true,
        parts: [match[1].trim(), match[2].trim()],
      };
    }
  }

  // Check for comma-separated intents with different tool domains
  const parts = message.split(/\s*(?:,\s*and\s+|,\s+and\s+|,\s+)\s*/).filter(Boolean);
  if (parts.length >= 2) {
    // Check if parts target different tools
    const toolsForParts = parts.map(p => inferToolForChain(p.toLowerCase()));
    const uniqueTools = new Set(toolsForParts);
    if (uniqueTools.size >= 2) {
      return { isChained: true, parts };
    }
  }

  return { isChained: false };
}

/**
 * Quick tool inference for chain detection (lighter than full routing)
 */
function inferToolForChain(text) {
  if (/\b(weather|forecast|temperature)\b/.test(text)) return "weather";
  if (/\b(email|mail|inbox|send)\b/.test(text)) return "email";
  if (/\b(news|headline|article)\b/.test(text)) return "news";
  if (/\b(stock|finance|market|price|ticker)\b/.test(text)) return "finance";
  if (/\b(search|find|look\s+up|research)\b/.test(text)) return "search";
  if (/\b(sport|score|match|league|team)\b/.test(text)) return "sports";
  if (/\b(calendar|event|meeting|schedule)\b/.test(text)) return "calendar";
  if (/\b(git|commit|branch|status)\b/.test(text)) return "gitLocal";
  if (/\b(review|inspect|examine)\b/.test(text)) return "review";
  if (/\b(file|read|write|create)\b/.test(text)) return "file";
  if (/\b(moltbook|post|social)\b/.test(text)) return "moltbook";
  if (/\b(task|todo|reminder)\b/.test(text)) return "tasks";
  if (/\b(remember|memory|who am i)\b/.test(text)) return "memorytool";
  if (/\b(calculate|compute|math|solve)\b/.test(text)) return "calculator";
  return "llm";
}

// ============================================================
// LONG-HORIZON TASK PLANNING
// ============================================================

/**
 * Detect complex requests that need decomposition into sub-tasks
 */
function isComplexPlanningRequest(message) {
  const lower = (message || "").toLowerCase();

  const complexPatterns = [
    /\b(plan|design|build|implement|create|develop)\s+(a|an|the)\s+(full|complete|entire|comprehensive)\b/i,
    /\b(step[\s-]by[\s-]step|multi[\s-]?step|workflow|pipeline|process)\b/i,
    /\b(research|analyze|compare)\s+.+\s+and\s+(write|create|draft|prepare)\b/i,
    /\b(set\s+up|configure|deploy|migrate)\s+.+\s+(from|to|with)\b/i,
  ];

  return complexPatterns.some(p => p.test(lower));
}

/**
 * Decompose a complex request into ordered sub-tasks using LLM
 */
async function decomposeComplexTask(message, availableTools) {
  const toolList = availableTools.join(", ");

  const prompt = `You are a task planning agent. Break this complex request into 2-5 sequential steps.

Available tools: ${toolList}

REQUEST: "${message}"

For each step, specify:
1. The tool to use
2. The specific input/query for that tool
3. Whether it depends on a previous step's output

Format each step as:
STEP: tool_name | input text | depends_on: none/step_N

Be practical — only create steps for things the available tools can actually do.`;

  try {
    const response = await llm(prompt);
    const text = response?.data?.text || "";
    const steps = [];

    const lines = text.split("\n").filter(l => /^STEP:/i.test(l.trim()));

    for (const line of lines) {
      const parts = line.replace(/^STEP:\s*/i, "").split("|").map(s => s.trim());
      if (parts.length >= 2) {
        const tool = parts[0].replace(/[^a-zA-Z_]/g, "");
        const input = parts[1];
        const dependency = parts[2]?.match(/step_?(\d+)/i)?.[1];

        // Validate tool exists
        const actualTool = availableTools.find(t => t.toLowerCase() === tool.toLowerCase());

        steps.push({
          tool: actualTool || "llm",
          input,
          context: dependency ? { dependsOn: parseInt(dependency) } : {},
          reasoning: `complex_plan_step_${steps.length + 1}`,
        });
      }
    }

    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

// ============================================================
// MAIN PLAN FUNCTION - Returns ARRAY of steps
// ============================================================

export async function plan({ message, chatContext = {} }) {
  const trimmed = (message || "").trim();
  const lower = trimmed.toLowerCase();

  console.log("🧠 Planning steps for:", trimmed);

  // Compute available tools once per plan
  const availableTools = listAvailableTools();
  console.log("[planner] availableTools:", availableTools.join(", "));

  // ──────────────────────────────────────────────────────────
  // MULTI-TURN: Check for follow-up context from previous messages
  // ──────────────────────────────────────────────────────────
  if (chatContext.conversationId) {
    const followUp = await checkFollowUpContext(trimmed, chatContext.conversationId);
    if (followUp) {
      return [followUp];
    }
  }

  // ──────────────────────────────────────────────────────────
  // TOOL CHAINING: detect multi-intent queries ("X and then Y")
  // ──────────────────────────────────────────────────────────
  const chainResult = detectChainedIntents(trimmed);
  if (chainResult.isChained && chainResult.parts.length >= 2) {
    console.log(`[planner] Detected chained intents: ${chainResult.parts.length} parts`);
    const chainSteps = [];
    for (const part of chainResult.parts) {
      const tool = inferToolForChain(part.toLowerCase());
      chainSteps.push({
        tool,
        input: part,
        context: chainSteps.length > 0 ? { chainedFrom: chainSteps.length - 1, useChainContext: true } : {},
        reasoning: `chained_step_${chainSteps.length + 1}`,
      });
    }
    console.log("[planner] Chain plan:", chainSteps.map(s => s.tool).join(" -> "));
    return chainSteps;
  }

  // ──────────────────────────────────────────────────────────
  // COMPLEX TASK DECOMPOSITION: multi-step planning for complex requests
  // ──────────────────────────────────────────────────────────
  if (isComplexPlanningRequest(trimmed)) {
    console.log("[planner] Detected complex planning request, decomposing...");
    const complexSteps = await decomposeComplexTask(trimmed, availableTools);
    if (complexSteps && complexSteps.length > 1) {
      console.log("[planner] Complex plan:", complexSteps.map(s => s.tool).join(" -> "));
      return complexSteps;
    }
    // If decomposition failed, fall through to normal routing
  }

  // ──────────────────────────────────────────────────────────
  // FILE REVIEW: route to fileReview when files are attached
  // ──────────────────────────────────────────────────────────
  if (chatContext.fileIds && chatContext.fileIds.length > 0) {
    console.log(`[planner] certainty branch: fileReview (${chatContext.fileIds.length} files)`);
    return [{ tool: "fileReview", input: trimmed, context: { fileIds: chatContext.fileIds }, reasoning: "certainty_file_review" }];
  }

  // ──────────────────────────────────────────────────────────
  // DUPLICATE SCANNER: detect duplicate scan requests
  // ──────────────────────────────────────────────────────────
  if (/\b(duplicate|duplication|find\s+duplicate|scan\s+duplicate|duplicate\s+file)/i.test(lower)) {
    console.log("[planner] certainty branch: duplicateScanner");
    // Parse any context from the natural language
    const dupContext = {};
    const pathMatch = trimmed.match(/(?:in|under|at|from)\s+([a-zA-Z]:[\\\/][^\s,]+|[.\/][^\s,]+)/i);
    if (pathMatch) dupContext.path = pathMatch[1];
    const typeMatch = lower.match(/(?:that are|type)\s+(\.\w+|\w+)\s+files?/);
    if (typeMatch) dupContext.type = typeMatch[1];
    const extMatch = lower.match(/\.(txt|js|jsx|ts|tsx|json|css|md|py|html|xml|csv)\b/);
    if (!dupContext.type && extMatch) dupContext.type = extMatch[0];
    const nameMatch = trimmed.match(/(?:named?|called)\s+["']?([^"'\s,]+)["']?/i);
    if (nameMatch) dupContext.name = nameMatch[1];

    return [{ tool: "duplicateScanner", input: trimmed, context: dupContext, reasoning: "certainty_duplicate_scan" }];
  }

  // ──────────────────────────────────────────────────────────
  // FILE WRITE INTENT: "write/create X to [path]" → fileWrite
  // Must come before generic file path check to avoid routing to read-only file tool
  // ──────────────────────────────────────────────────────────
  if (/\b(write|create|generate|save|make)\b/i.test(lower) && hasExplicitFilePath(trimmed) &&
      !/\b(email|mail|moltbook)\b/i.test(lower)) {
    // Match absolute paths (D:/...) or relative paths (server/file.js, ./utils/config.js)
    const filePathMatch = trimmed.match(/([a-zA-Z]:[\\/][^\s,;!?"']+)/) ||
                          trimmed.match(/(\.{0,2}\/?[\w][\w.\/-]*\.\w{1,5})\b/);
    if (filePathMatch) {
      console.log("[planner] certainty branch: fileWrite (write intent + path)");
      return [{ tool: "fileWrite", input: trimmed, context: { targetPath: filePathMatch[1] }, reasoning: "certainty_file_write" }];
    }
  }

  // ──────────────────────────────────────────────────────────
  // REVIEW/INSPECT + FILE PATH: "review server/planner.js" → review tool
  // Must come before generic file path check to avoid routing to read-only file tool
  // ──────────────────────────────────────────────────────────
  if (/\b(review|inspect|examine|audit|analyze)\b/i.test(lower) && hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: review (file path detected)");
    return [{ tool: "review", input: trimmed, context: {}, reasoning: "certainty_review_filepath" }];
  }

  // ──────────────────────────────────────────────────────────
  // EXPLICIT FILE PATH: route file paths to file tool (read/browse)
  // Must come before diagnostic to prevent "Read D:/server/planner.js" → diagnostic
  // ──────────────────────────────────────────────────────────
  if (hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: file_path");
    return [{ tool: "file", input: trimmed, context: {}, reasoning: "certainty_file_path" }];
  }

  // ──────────────────────────────────────────────────────────
  // DIAGNOSTIC: handle meta/routing/accuracy questions
  // (now safe — file paths already handled above)
  // ──────────────────────────────────────────────────────────
  const diagnosticDecision = checkDiagnosticQuestion(trimmed);
  if (diagnosticDecision) {
    console.log("[planner] certainty branch: diagnostic ->", diagnosticDecision[0].tool);
    return diagnosticDecision;
  }

  // ──────────────────────────────────────────────────────────
  // MULTI-STEP: Improvement Requests (safe plan)
  // ──────────────────────────────────────────────────────────
  if (isImprovementRequest(trimmed)) {
    console.log(`🎯 Detected improvement request - generating 5-step sequence`);
    const planSteps = generateImprovementSteps(trimmed, availableTools);
    console.log("[planner] improvement plan steps:", planSteps.map(s => s.tool).join(" -> "));
    return planSteps;
  }

  // ──────────────────────────────────────────────────────────
  // SINGLE-STEP: Certainty Layer (deterministic short commands)
  // ──────────────────────────────────────────────────────────

  // URL/Web browsing (MUST come before math — URLs contain / which triggers isMathExpression)
  if (/\b(browse|navigate|visit|go\s+to|open)\b/i.test(lower) && /\b[a-z0-9-]+\.(?:com|org|net|io|dev|app|co)\b/i.test(lower) &&
      !/\bmoltbook\b/i.test(lower)) {
    console.log("[planner] certainty branch: webBrowser");
    return [{ tool: "webBrowser", input: trimmed, context: {}, reasoning: "certainty_web_browse" }];
  }

  // Raw URL detection → webDownload (fetch and read/follow)
  if (/https?:\/\/\S+/i.test(trimmed) && !/\bmoltbook\b/i.test(lower)) {
    console.log("[planner] certainty branch: url_detected");
    return [{ tool: "webDownload", input: trimmed, context: {}, reasoning: "certainty_url" }];
  }

  // Domain-like string without browse verb but with "read", "fetch", "check" → webDownload
  if (/\b(read|fetch|check|get)\b/i.test(lower) && /\b[a-z0-9-]+\.(?:com|org|net|io|dev|app|co)\b/i.test(lower) &&
      !/\bmoltbook\b/i.test(lower) && !hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: webDownload (domain + read verb)");
    return [{ tool: "webDownload", input: trimmed, context: {}, reasoning: "certainty_web_read" }];
  }

  // Math
  if (isMathExpression(trimmed)) {
    console.log("[planner] certainty branch: math");
    return [{ tool: "calculator", input: trimmed, context: {}, reasoning: "certainty_math" }];
  }

  // DateTime
  if (isSimpleDateTime(trimmed)) {
    console.log("[planner] certainty branch: datetime");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_datetime" }];
  }

  // Email confirmation
  if (isSendItCommand(lower)) {
    console.log("[planner] certainty branch: email_confirm");
    return [{ tool: "email_confirm", input: trimmed, context: { action: "send_confirmed", sessionId: chatContext?.sessionId || "default" }, reasoning: "certainty_email_confirm" }];
  }

  // Cancel / discard
  if (isCancelCommand(lower)) {
    console.log("[planner] certainty branch: cancel");
    return [{ tool: "email_confirm", input: trimmed, context: { action: "cancel", sessionId: chatContext?.sessionId || "default" }, reasoning: "certainty_cancel" }];
  }

  // Memory write ("remember my email is X", "remember that X")
  if (isMemoryWriteCommand(lower)) {
    console.log("[planner] certainty branch: memory_write");
    return [{ tool: "memorytool", input: trimmed, context: {}, reasoning: "certainty_memory_write" }];
  }

  // Forget location
  if (locationWithForgetLike(lower)) {
    console.log("[planner] certainty branch: forget_location");
    return [{ tool: "memorytool", input: trimmed, context: { raw: "forget_location" }, reasoning: "certainty_forget_location" }];
  }

  // Weather here
  if (hereIndicatesWeather(lower)) {
    console.log("[planner] certainty branch: here_weather");
    return [{ tool: "weather", input: trimmed, context: { city: "__USE_GEOLOCATION__" }, reasoning: "certainty_here_weather" }];
  }

  // Weather with city (or from memory)
  if (containsKeyword(lower, WEATHER_KEYWORDS)) {
    let extracted = extractCity(trimmed);
    // If no city extracted, check memory for saved location
    if (!extracted) {
      try {
        const memory = await getMemory();
        const profile = memory.profile || {};
        const savedLocation = profile.location || profile.city || null;
        if (savedLocation) {
          extracted = formatCity(savedLocation);
          console.log(`[planner] Using saved location from memory: ${extracted}`);
        }
      } catch (e) {
        console.warn("[planner] Could not read memory for location:", e.message);
      }
    }
    const context = extracted ? { city: extracted } : {};
    console.log("[planner] certainty branch: weather, city:", extracted || "none");
    return [{ tool: "weather", input: trimmed, context, reasoning: "certainty_weather" }];
  }

  // News keywords (before file path and sports to avoid misroute)
  if ((/\b(latest|recent|breaking|today'?s)?\s*(news|headlines?|articles?)\b/i.test(lower) ||
       /\bwhat'?s\s+(happening|going\s+on|new)\b/i.test(lower)) &&
      !hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: news");
    return [{ tool: "news", input: trimmed, context: {}, reasoning: "certainty_news" }];
  }

  // ──────────────────────────────────────────────────────────
  // CREDENTIAL SAFETY GUARD: prevent passwords from going to memory tool
  // ──────────────────────────────────────────────────────────
  if (/\b(remember|save|store)\b/i.test(lower) && /\b(password|credential|login)\b/i.test(lower)) {
    if (/\bmoltbook\b/i.test(lower)) {
      console.log("[planner] certainty branch: moltbook credential store (safety guard)");
      return [{ tool: "moltbook", input: trimmed, context: { action: "storeCredentials" }, reasoning: "certainty_credential_store" }];
    }
    // For other sites, route to webBrowser credential storage
    console.log("[planner] certainty branch: webBrowser credential store (safety guard)");
    const domainMatch = lower.match(/\b([a-z0-9-]+\.(?:com|org|net|io|dev|app|co))\b/);
    return [{ tool: "webBrowser", input: trimmed, context: { action: "setCredentials", service: domainMatch?.[1] || "default" }, reasoning: "certainty_credential_store" }];
  }

  // ──────────────────────────────────────────────────────────
  // MOLTBOOK: skill.md / registration flow
  // "Read https://www.moltbook.com/skill.md and follow the instructions to join Moltbook"
  // ──────────────────────────────────────────────────────────
  if (/moltbook\.com\/skill\.md/i.test(lower) || (/\bmoltbook\b/i.test(lower) && /\b(follow.*instructions?|join|register|sign\s*up|create\s+account|open.*account)\b/i.test(lower))) {
    console.log("[planner] certainty branch: moltbook register (skill.md flow)");
    return [{ tool: "moltbook", input: trimmed, context: { action: "register" }, reasoning: "certainty_moltbook_register" }];
  }

  // MOLTBOOK: Multi-step registration + verification
  if (/\bmoltbook\b/i.test(lower) && /\b(register|sign\s*up)\b/i.test(lower) && /\b(verify|verification|confirm)\b/i.test(lower)) {
    console.log("[planner] certainty branch: moltbook register + verify (multi-step)");
    return [
      { tool: "moltbook", input: trimmed, context: { action: "register" }, reasoning: "moltbook_register" },
      { tool: "moltbook", input: "check status", context: { action: "status" }, reasoning: "moltbook_verify_status" }
    ];
  }

  // MOLTBOOK: Single-action detection
  if (/\bmoltbook\b/i.test(lower)) {
    console.log("[planner] certainty branch: moltbook");
    const context = {};
    if (/\b(register|sign\s*up|create\s+account|join)\b/i.test(lower)) context.action = "register";
    else if (/\b(log\s*in|sign\s*in)\b/i.test(lower)) context.action = "login";
    else if (/\b(log\s*out|sign\s*out)\b/i.test(lower)) context.action = "logout";
    else if (/\b(profile|my\s+account|settings|about\s+me)\b/i.test(lower)) context.action = "profile";
    else if (/\b(search|find|look\s+for)\b/i.test(lower)) context.action = "search";
    else if (/\b(post|publish|share|write)\b/i.test(lower)) context.action = "post";
    else if (/\b(feed|browse|timeline|home)\b/i.test(lower)) context.action = "feed";
    else if (/\b(follow|subscribe)\b/i.test(lower)) context.action = "follow";
    else if (/\b(communities?|submolt)\b/i.test(lower)) context.action = "communities";
    else if (/\b(heartbeat|check\s*in)\b/i.test(lower)) context.action = "heartbeat";
    else if (/\b(status|session|check)\b/i.test(lower)) context.action = "status";
    else context.action = "feed";
    else if (/\b(post|publish|share)\b/i.test(lower) && !/\bprofile\b/i.test(lower)) context.action = "post";
    else if (/\b(comment|reply)\b/i.test(lower)) context.action = "comment";
    else if (/\b(upvote|downvote|vote|like)\b/i.test(lower)) context.action = "vote";
    else if (/\b(feed|timeline|what's\s+new|browse\s+posts)\b/i.test(lower)) context.action = "feed";
    else if (/\b(follow|unfollow)\b/i.test(lower)) context.action = "follow";
    else if (/\b(submolt|communit)/i.test(lower)) context.action = "submolts";
    else if (/\b(status|session|check)\b/i.test(lower)) context.action = "status";
    else if (/\b(verify|verification|claim)\b/i.test(lower)) context.action = "verify";
    else context.action = "browse";
    return [{ tool: "moltbook", input: trimmed, context, reasoning: "certainty_moltbook" }];
  }

  // NOTE: Web browsing + URL detection moved ABOVE math check to prevent
  // URLs (which contain /) from triggering isMathExpression()

  // NOTE: Explicit file path check moved ABOVE diagnostic section

  // ──────────────────────────────────────────────────────────
  // TOOL-SPECIFIC KEYWORD CLUSTERS (prevents LLM misclassification)
  // ──────────────────────────────────────────────────────────

  // Meta-conversation: "how do you work", "what is your logic", "what can you do"
  if (/\b(how do you (work|think|decide|choose)|what is your (logic|process|architecture)|what can you do|what tools|list.*tools|your capabilities)\b/i.test(lower)) {
    console.log("[planner] certainty branch: meta_conversation");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_meta_conversation" }];
  }

  // LLM-directed tasks: summarize, explain, rewrite, translate, write, compose
  if (/^(summarize|explain|rewrite|translate|write|compose|paraphrase|elaborate|simplify|rephrase)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed) && !/\b(email|mail)\b/i.test(lower)) {
    console.log("[planner] certainty branch: llm_text_task");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_llm_text_task" }];
  }

  // Greetings & casual conversation: "hello", "hey", "how are you", "thanks"
  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|thanks|thank\s+you|how are you|how do you feel|what's up|howdy|yo)\b/i.test(lower) && lower.length < 60) {
    console.log("[planner] certainty branch: casual_conversation");
    return [{ tool: "llm", input: trimmed, context: {}, reasoning: "certainty_casual" }];
  }

  // Email keywords: compose, browse/read, or draft
  if (/\b(email|e-mail|mail|inbox|send\s+to|draft\s+(an?\s+)?(email|message|letter))\b/i.test(lower) &&
  // Contacts keywords: "my contacts", "add contact", "John's phone", "contact list"
  if (/\b(contacts?|address\s*book|phone\s*book)\b/i.test(lower) &&
      (/\b(list|show|add|update|delete|remove|find|search|look\s+up)\b/i.test(lower) ||
       /\b(phone|number|email|address)\b/i.test(lower)) &&
      !/\b(email|mail|send|draft)\b/i.test(lower)) {
    console.log("[planner] certainty branch: contacts");
    return [{ tool: "contacts", input: trimmed, context: {}, reasoning: "certainty_contacts" }];
  }

  // Contact lookup patterns: "John's phone number", "what's mom's email"
  if (/(['']s\s+(?:phone|email|number|address))\b/i.test(lower) &&
      !/\b(moltbook|weather|news)\b/i.test(lower)) {
    console.log("[planner] certainty branch: contacts (possessive lookup)");
    return [{ tool: "contacts", input: trimmed, context: {}, reasoning: "certainty_contacts_lookup" }];
  }

  // Email browsing: "check my emails", "go over my inbox", "read my emails", "list unread emails"
  if (/\b(check|go\s+over|browse|list|show|read)\s+(my\s+)?(emails?|inbox|mail)\b/i.test(lower) &&
      !/\b(send|draft|compose|write)\b/i.test(lower) &&
      !isSendItCommand(lower)) {
    console.log("[planner] certainty branch: email_browse");
    return [{ tool: "email", input: trimmed, context: { action: "browse" }, reasoning: "certainty_email_browse" }];
  }

  // Email keywords: "email", "mail", "send to", "draft"
  if (/\b(email|e-mail|mail|send\s+to|draft\s+(an?\s+)?(email|message|letter))\b/i.test(lower) &&
      !isSendItCommand(lower)) {
    const emailContext = {};
    if (/\b(check|read|browse|inbox|list|show|go\s+over|latest|recent|unread)\b/i.test(lower)) {
      emailContext.action = "browse";
    } else if (/\b(delete|trash|remove)\b/i.test(lower)) {
      emailContext.action = "delete";
    } else if (/\b(attachment|download)\b/i.test(lower)) {
      emailContext.action = "downloadAttachment";
    }
    console.log("[planner] certainty branch: email" + (emailContext.action ? ` (${emailContext.action})` : ""));
    return [{ tool: "email", input: trimmed, context: emailContext, reasoning: "certainty_email" }];
  }

  // NLP / text analysis keywords
  if (/\b(sentiment|analyze\s+text|text\s+analysis|classify\s+text|extract\s+entities|named\s+entities|NER)\b/i.test(lower)) {
    console.log("[planner] certainty branch: nlp_tool");
    return [{ tool: "nlp_tool", input: trimmed, context: {}, reasoning: "certainty_nlp" }];
  }

  // Calculator keywords (beyond math expressions)
  if (/\b(calculate|compute|solve|what\s+is\s+\d|how\s+much\s+is|convert\s+\d|percentage\s+of)\b/i.test(lower)) {
    console.log("[planner] certainty branch: calculator");
    return [{ tool: "calculator", input: trimmed, context: {}, reasoning: "certainty_calculator_keyword" }];
  }

  // Code review keywords — expanded to catch "tool", "implementation", "flow", "logic"
  // Must come BEFORE finance/sports/github to prevent "examine the search tool" → search
  if (/\b(review|inspect|examine|audit|analyze)\s+(this\s+)?(code|file|function|module|script|tool|implementation|flow|logic)\b/i.test(lower) ||
      (/\b(review|inspect|examine|audit|analyze)\b/i.test(lower) && hasExplicitFilePath(trimmed))) {
    console.log("[planner] certainty branch: review");
    return [{ tool: "review", input: trimmed, context: {}, reasoning: "certainty_review" }];
  }

  // Finance keywords — with company name → ticker resolution
  const FINANCE_COMPANIES = /\b(tesla|apple|google|alphabet|amazon|microsoft|meta|nvidia|amd|intel|netflix|disney|boeing|ford|paypal|uber|spotify|shopify)\b/i;
  const FINANCE_INTENT = /\b(doing|price|worth|trading|performance|value|stock|share|market|up|down|earnings|revenue)\b/i;
  if (/\b(stock|share\s+price|ticker|market|portfolio|invest|dividend|earnings|S&P\s*500|nasdaq|dow\s+jones|trading|IPO)\b/i.test(lower) ||
      (FINANCE_COMPANIES.test(lower) && FINANCE_INTENT.test(lower))) {
  // Finance keywords + well-known company/ticker names with financial intent
  const FINANCE_COMPANIES = [
    'tesla', 'apple', 'google', 'alphabet', 'amazon', 'microsoft', 'meta',
    'nvidia', 'amd', 'intel', 'netflix', 'disney', 'boeing', 'ford', 'uber',
    'spotify', 'paypal', 'shopify', 'coinbase', 'robinhood', 'palantir',
    'tsla', 'aapl', 'googl', 'amzn', 'msft', 'nvda', 'nflx', 'intc', 'amd'
  ];
  const hasFinanceKeyword = /\b(stock|share\s+price|ticker|market|portfolio|invest|dividend|earnings|S&P|nasdaq|dow\s+jones|trading|IPO|market\s+cap|bull|bear)\b/i.test(lower);
  const hasCompanyWithFinanceIntent = FINANCE_COMPANIES.some(c => new RegExp(`\\b${c}\\b`, 'i').test(lower)) &&
    /\b(doing|price|worth|trading|performance|value|stock|share|market|up|down|buy|sell|earnings|rally|drop|crash|surge)\b/i.test(lower);
  if (hasFinanceKeyword || hasCompanyWithFinanceIntent) {
    console.log("[planner] certainty branch: finance");
    return [{ tool: "finance", input: trimmed, context: {}, reasoning: "certainty_finance" }];
  }

  // Financial fundamentals — must come AFTER general finance
  if (/\b(fundamentals?|P\/E|balance\s*sheet|income\s+statement|cash\s*flow|market\s*cap|quarterly|annual\s+report)\b/i.test(lower) ||
      (FINANCE_COMPANIES.test(lower) && /\b(fundamentals?|financials?|report|analysis)\b/i.test(lower))) {
    console.log("[planner] certainty branch: financeFundamentals");
    return [{ tool: "financeFundamentals", input: trimmed, context: {}, reasoning: "certainty_fundamentals" }];
  }

  // Sports keywords
  if (/\b(score|match|game|league|team|player|football|soccer|basketball|nba|nfl|premier\s+league|champion)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed)) {
  // Sports keywords + team names
  const SPORTS_TEAMS = [
    'arsenal', 'chelsea', 'liverpool', 'tottenham', 'spurs', 'man city', 'man united',
    'barcelona', 'real madrid', 'juventus', 'bayern', 'psg', 'inter milan', 'napoli',
    'dortmund', 'newcastle', 'aston villa', 'brighton', 'west ham', 'crystal palace',
    'everton', 'wolves', 'fulham', 'brentford', 'bournemouth', 'nottingham forest'
  ];
  const hasSportsKeyword = /\b(score|match|game|league|team|player|football|soccer|basketball|nba|nfl|premier\s+league|champion|fixture|standings?|table|la\s+liga|serie\s+a|bundesliga|ligue\s+1|eredivisie|live\s+score|top\s+scor|golden\s+boot)\b/i.test(lower);
  const hasTeamWithSportsIntent = SPORTS_TEAMS.some(t => lower.includes(t)) &&
    /\b(play|score|match|win|lose|drew|beat|next|result|standing|fixture|league|live|vs|against)\b/i.test(lower);
  if ((hasSportsKeyword || hasTeamWithSportsIntent) && !hasExplicitFilePath(trimmed)) {
    console.log("[planner] certainty branch: sports");
    return [{ tool: "sports", input: trimmed, context: {}, reasoning: "certainty_sports" }];
  }

  // Calendar keywords
  if (/\b(calendar|my\s+events?|schedule|meeting|appointment|free\s+time|availability|busy)\b/i.test(lower) &&
      !/\b(moltbook|sports?|league)\b/i.test(lower)) {
    console.log("[planner] certainty branch: calendar");
    const context = {};
    if (/\b(create|add|schedule|set\s+up|book|make)\b/i.test(lower)) context.action = "create";
    else if (/\b(free|busy|available|availability)\b/i.test(lower)) context.action = "freebusy";
    else context.action = "list";
    return [{ tool: "calendar", input: trimmed, context, reasoning: "certainty_calendar" }];
  }

  // Document QA keywords
  if (/\b(document|knowledge\s+base|ingest|index\s+(a\s+)?file)\b/i.test(lower) &&
      /\b(ask|question|load|ingest|index|search|query|find\s+in)\b/i.test(lower)) {
    console.log("[planner] certainty branch: documentQA");
    return [{ tool: "documentQA", input: trimmed, context: {}, reasoning: "certainty_document_qa" }];
  }

  // Workflow keywords
  if (/\b(workflow|morning\s+briefing|daily\s+routine|run\s+(the\s+)?workflow|execute\s+workflow)\b/i.test(lower)) {
    console.log("[planner] certainty branch: workflow");
    return [{ tool: "workflow", input: trimmed, context: {}, reasoning: "certainty_workflow" }];
  }

  // YouTube keywords
  if (/\b(youtube|video|watch|tutorial\s+video|how\s+to\s+video)\b/i.test(lower)) {
    console.log("[planner] certainty branch: youtube");
    return [{ tool: "youtube", input: trimmed, context: {}, reasoning: "certainty_youtube" }];
  }

  // GitHub Trending — must come BEFORE general github
  if (/\b(trending|popular|top)\b/i.test(lower) && /\b(repo|repository|github|project|open\s*source)\b/i.test(lower)) {
    console.log("[planner] certainty branch: githubTrending");
    return [{ tool: "githubTrending", input: trimmed, context: {}, reasoning: "certainty_github_trending" }];
  }

  // GitHub keywords
  // Task management keywords (BEFORE github to prevent "add task: review pull request" misroute)
  if (/\b(todo|task|reminder|schedule|add\s+task|my\s+tasks|to-do|checklist)\b/i.test(lower)) {
    console.log("[planner] certainty branch: tasks");
    return [{ tool: "tasks", input: trimmed, context: {}, reasoning: "certainty_tasks" }];
  }

  // GitHub keywords (with task guard — skip if message is task-related)
  if (/\b(github|repo|repository|pull\s+request|issue|commit|branch|merge|fork)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed) &&
      !/\b(todo|task|add\s+task|my\s+tasks|to-do|checklist)\b/i.test(lower)) {
    console.log("[planner] certainty branch: github");
    return [{ tool: "github", input: trimmed, context: {}, reasoning: "certainty_github" }];
  }

  // Git local keywords
  if (/\b(git\s+(status|log|diff|add|commit|branch|checkout|stash|push|pull|reset))\b/i.test(lower)) {
    console.log("[planner] certainty branch: gitLocal");
    return [{ tool: "gitLocal", input: trimmed, context: {}, reasoning: "certainty_git_local" }];
  }

  // Package manager keywords
  if (/\b(npm\s+(install|uninstall|list|remove|update)|install\s+package|uninstall\s+package|list\s+packages|package\s+manager)\b/i.test(lower)) {
    const pkgContext = {};
    if (/\binstall\b/i.test(lower)) pkgContext.action = "install";
    else if (/\buninstall|remove\b/i.test(lower)) pkgContext.action = "uninstall";
    else if (/\blist|show|installed\b/i.test(lower)) pkgContext.action = "list";
    else if (/\bupdate\b/i.test(lower)) pkgContext.action = "update";
    const pkgMatch = trimmed.match(/(?:install|uninstall|remove|update)\s+([@a-z0-9\/-]+)/i);
    if (pkgMatch) pkgContext.package = pkgMatch[1];
    console.log("[planner] certainty branch: packageManager");
    return [{ tool: "packageManager", input: trimmed, context: pkgContext, reasoning: "certainty_package_manager" }];
  }

  // Shopping keywords
  if (/\b(buy|shop|price|product|amazon|order|purchase|deal|discount|coupon)\b/i.test(lower) &&
      !/\b(stock|share|invest)\b/i.test(lower)) {
    console.log("[planner] certainty branch: shopping");
    return [{ tool: "shopping", input: trimmed, context: {}, reasoning: "certainty_shopping" }];
  }

  // Scheduler / recurring tasks / workflows
  // Must come BEFORE task management to prevent "schedule X every Y" → tasks
  if (/\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate|workflow|set\s+up\s+a?\s*recurring|remind\s+me\s+(to|about)\s+.+\s+(every|at\s+\d|in\s+\d))\b/i.test(lower) &&
      !/\b(add\s+task|my\s+tasks|todo|to-do|checklist)\b/i.test(lower)) {
    console.log("[planner] certainty branch: scheduler");
    const schedContext = {};
    if (/\b(list|show|view|my)\s*(schedule|recurring)/i.test(lower)) schedContext.action = "list";
    else if (/\b(cancel|stop|remove|delete)\s*(schedule|timer|recurring)/i.test(lower)) schedContext.action = "cancel";
    else if (/\b(pause|disable)\b/i.test(lower)) schedContext.action = "pause";
    else if (/\b(resume|enable)\b/i.test(lower)) schedContext.action = "resume";
    return [{ tool: "scheduler", input: trimmed, context: schedContext, reasoning: "certainty_scheduler" }];
  }

  // Task management keywords
  if (/\b(todo|task|reminder|add\s+task|my\s+tasks|to-do|checklist)\b/i.test(lower)) {
    console.log("[planner] certainty branch: tasks");
    return [{ tool: "tasks", input: trimmed, context: {}, reasoning: "certainty_tasks" }];
  // NOTE: Task management keywords moved ABOVE github section

  // Search / knowledge queries: "look up X", "find information about X", "history of X", "who was X"
  if (/\b(look\s+up|search\s+for|find\s+(information|info|details)\s+(about|on|for)|history\s+of|who\s+(is|was|are|were)\s+\w+|what\s+(is|was)\s+the\s+history|tell\s+me\s+about)\b/i.test(lower) &&
      !hasExplicitFilePath(trimmed) &&
      !/\b(moltbook|browse|visit|go\s+to)\b/i.test(lower) &&
      !/\b[a-z0-9-]+\.(?:com|org|net|io|dev|app|co)\b/i.test(lower)) {
    console.log("[planner] certainty branch: search (knowledge query)");
    return [{ tool: "search", input: trimmed, context: {}, reasoning: "certainty_search_knowledge" }];
  }

  // Memory read keywords (what do you know about me, my name, etc.)
  if (/\b(what do you (know|remember)|my\s+(name|email|location|contacts?|preferences?)|who\s+am\s+i)\b/i.test(lower) &&
      !/\b(password|credential)\b/i.test(lower)) {
    console.log("[planner] certainty branch: memory_read");
    return [{ tool: "memorytool", input: trimmed, context: {}, reasoning: "certainty_memory_read" }];
  }

  // Self-improvement keywords — expanded patterns
  if (/\b(self[- ]?improv|what have you improved|your accuracy|your performance|weekly report|telemetry|misrouting|what issues|performance report|diagnose|diagnostic report|how well are you doing)\b/i.test(lower)) {
    console.log("[planner] certainty branch: selfImprovement");
    return [{ tool: "selfImprovement", input: trimmed, context: {}, reasoning: "certainty_self_improvement" }];
  }

  // ──────────────────────────────────────────────────────────
  // SINGLE-STEP: LLM Classifier (fallback — only reached for truly ambiguous queries)
  // ──────────────────────────────────────────────────────────

  const contextSignals = extractContextSignals(trimmed);
  console.log("🧠 Context signals:", contextSignals);

  const detection = await detectIntentWithLLM(trimmed, contextSignals, availableTools);
  console.log("🎯 LLM classified:", detection.intent);

  // Normalize tool name: case-insensitive match against all available tools
  // Also handle special aliases (nlp_tool, etc.)
  const aliasMap = {
    'nlptool': 'nlp_tool',
    'nlp': 'nlp_tool',
    'memory': 'memorytool',
    'memorytool': 'memorytool',
    'lotr': 'lotrJokes',
    'lotrjokes': 'lotrJokes',
    'webbrowser': 'webBrowser',
    'web_browser': 'webBrowser',
    'web': 'webBrowser',
    'filewrite': 'fileWrite',
    'file_write': 'fileWrite',
    'writefile': 'fileWrite',
    'write': 'fileWrite',
    'contact': 'contacts',
    'addressbook': 'contacts',
    'documentqa': 'documentQA',
    'document_qa': 'documentQA',
    'doc_qa': 'documentQA',
    'workflowtool': 'workflow',
  };

  let rawIntent = (detection.intent || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");

  // Step 1: Check alias map first
  let tool = aliasMap[rawIntent] || null;

  // Step 2: Case-insensitive match against available tools
  if (!tool) {
    tool = availableTools.find(t => t.toLowerCase() === rawIntent) || null;
  }

  // Step 3: Partial match — LLM sometimes truncates (e.g. "githubtrendin" for "githubTrending")
  if (!tool) {
    tool = availableTools.find(t => t.toLowerCase().startsWith(rawIntent) && rawIntent.length >= 4) || null;
    if (tool) {
      console.log(`[planner] Partial match: "${rawIntent}" → "${tool}"`);
    }
  }

  // Step 4: Fallback to llm if no match found
  if (!tool) {
    console.warn(`[planner] LLM chose unrecognized tool "${rawIntent}". Substituting llm fallback.`);
    return [{
      tool: "llm",
      input: `Fallback: the requested tool "${rawIntent}" is not available. Please handle the user's request: ${trimmed}`,
      context: {},
      reasoning: `fallback_unavailable_${rawIntent}`
    }];
  }

  // Step 5: Verify tool exists in registry
  if (!availableTools.includes(tool)) {
    console.warn(`[planner] Resolved tool "${tool}" not in available tools. Substituting llm fallback.`);
    return [{
      tool: "llm",
      input: `Fallback: the resolved tool "${tool}" is not available. Please handle the user's request: ${trimmed}`,
      context: {},
      reasoning: `fallback_unavailable_${tool}`
    }];
  }

  console.log(`[planner] Tool resolved: "${rawIntent}" → "${tool}"`);
  return [{
    tool,
    input: trimmed,
    context: detection.context || {},
    reasoning: detection.reason
  }];
}
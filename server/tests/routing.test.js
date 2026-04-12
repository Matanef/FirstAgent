// server/tests/routing.test.js
// Comprehensive routing table test suite — catches collisions & regressions
//
// Run:  node --test --test-force-exit server/tests/routing.test.js
//       node --test --test-force-exit --test-reporter spec server/tests/routing.test.js
// Note: --test-force-exit is needed because planner.js imports trigger scheduler intervals

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROUTING_TABLE } from "../planner.js";

// ============================================================
// LIGHTWEIGHT SYNC EVALUATOR
// Mirrors the core logic of evaluateRoutingTable without async
// context, memory, or LLM dependencies.  Tests match + guard +
// priority — the three pillars of routing correctness.
// ============================================================

/**
 * Evaluate routing table synchronously — returns the winning tool name or null.
 * @param {string} input  - User message (original casing preserved)
 * @param {object} [ctx]  - Optional chatContext for context-aware guards
 * @returns {{ tool: string, priority: number } | null}
 */
function route(input, ctx = {}) {
  const lower = (input || "").toLowerCase();
  const trimmed = (input || "").trim();

  const candidates = ROUTING_TABLE.filter(rule => {
    try {
      if (!rule.match(lower, trimmed, ctx)) return false;
      if (rule.guard && rule.guard(lower, trimmed, ctx)) return false;
      // Skip validate for sync test — validate tests are separate
      return true;
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.priority - a.priority);

  // Run validate on winner if present
  for (const winner of candidates) {
    if (winner.validate) {
      let winnerCtx = {};
      try { if (winner.context) winnerCtx = winner.context(lower, trimmed, ctx); } catch {}
      try { if (!winner.validate(winnerCtx, lower, trimmed)) continue; } catch { continue; }
    }
    return { tool: winner.tool, priority: winner.priority };
  }
  return null;
}

/** Assert a message routes to a specific tool */
function expectTool(input, expectedTool, msg) {
  const result = route(input);
  assert.ok(result, `Expected "${input}" → ${expectedTool}, but got NO MATCH${msg ? ` (${msg})` : ""}`);
  assert.equal(result.tool, expectedTool,
    `Expected "${input}" → ${expectedTool}, but got → ${result.tool} (priority ${result.priority})${msg ? ` | ${msg}` : ""}`);
}

/** Assert a message does NOT route to a specific tool */
function expectNotTool(input, rejectedTool, msg) {
  const result = route(input);
  if (!result) return; // No match at all — definitely not the rejected tool
  assert.notEqual(result.tool, rejectedTool,
    `"${input}" should NOT route to ${rejectedTool}, but it did (priority ${result.priority})${msg ? ` | ${msg}` : ""}`);
}

/** Assert a message produces no routing match */
function expectNoMatch(input, msg) {
  const result = route(input);
  assert.equal(result, null,
    `Expected "${input}" → NO MATCH, but got → ${result?.tool}${msg ? ` | ${msg}` : ""}`);
}

// ============================================================
// TESTS
// ============================================================

// ────────────────────────────────────────────────────────────
// TIER 1: Confirmations & Overrides (95-99)
// ────────────────────────────────────────────────────────────
describe("Email Confirmations (email_confirm)", () => {
  it("routes 'send it' to email_confirm", () => expectTool("send it", "email_confirm"));
  it("routes 'yes send it' to email_confirm", () => expectTool("yes send it", "email_confirm"));
  it("routes 'cancel' to email_confirm", () => expectTool("cancel", "email_confirm"));
  it("routes 'discard' to email_confirm", () => expectTool("discard", "email_confirm"));
  it("routes 'never mind' to email_confirm", () => expectTool("never mind", "email_confirm"));
});

// ────────────────────────────────────────────────────────────
// TIER 2: Narrow-scope skills (85-94)
// ────────────────────────────────────────────────────────────
describe("Attachment Downloader", () => {
  it("routes download attachments with email + date", () =>
    expectTool("download attachments from john@example.com since last week", "attachmentDownloader"));
  it("does not route plain email check", () =>
    expectNotTool("check my email", "attachmentDownloader"));
});

describe("Agent Identity (llm priority 85)", () => {
  it("routes 'what is your name' to llm", () => expectTool("what is your name", "llm"));
  it("routes 'who are you' to llm", () => expectTool("who are you", "llm"));
  it("routes Hebrew identity question", () => expectTool("מה שמך", "llm"));
  it("routes 'what's your name' to llm", () => expectTool("what's your name", "llm"));
});

describe("GitHub Scanner", () => {
  it("routes 'scan github repos for patterns'", () =>
    expectTool("scan github repos for patterns", "githubScanner"));
  it("routes 'analyze github repository'", () =>
    expectTool("analyze github repository", "githubScanner"));
  it("does not route file path with 'review'", () =>
    expectNotTool("review server/planner.js", "githubScanner"));
});

describe("Duplicate Scanner", () => {
  it("routes 'find duplicates in D:/projects'", () =>
    expectTool("find duplicates in D:/projects", "duplicateScanner"));
  it("routes 'scan for duplicate files'", () =>
    expectTool("scan for duplicate files", "duplicateScanner"));
});

// ────────────────────────────────────────────────────────────
// TIER 3: Standard tools (70-84)
// ────────────────────────────────────────────────────────────
describe("Memory Tool", () => {
  it("routes 'remember that I like coffee' to memorytool", () =>
    expectTool("remember that I like coffee", "memorytool"));
  it("routes 'remember my email is john@example.com'", () =>
    expectTool("remember my email is john@example.com", "memorytool"));
  it("routes 'who am I' to memorytool", () =>
    expectTool("who am I", "memorytool"));
  it("routes 'what do you know about me'", () =>
    expectTool("what do you know about me", "memorytool"));
  it("routes 'forget my location'", () =>
    expectTool("forget my location", "memorytool"));
});

describe("Weather", () => {
  it("routes 'what's the weather in Tel Aviv'", () =>
    expectTool("what's the weather in Tel Aviv", "weather"));
  it("routes 'weather forecast'", () =>
    expectTool("weather forecast", "weather"));
  it("does NOT route 'schedule weather check every morning'", () =>
    expectNotTool("schedule weather check every morning", "weather"));
  it("does NOT route compound 'weather and news'", () =>
    expectNotTool("get the weather and also check the news", "weather"));
});

describe("Google Sheets", () => {
  it("routes 'read google sheet'", () => expectTool("read google sheet", "sheets"));
  it("routes 'append to spreadsheet'", () => expectTool("append to spreadsheet", "sheets"));
  it("does NOT route compound with sheets", () =>
    expectNotTool("get weather and append to google sheet", "sheets"));
});

describe("Email", () => {
  it("routes 'send email to john@example.com'", () =>
    expectTool("send email to john@example.com", "email"));
  it("routes 'check my inbox'", () => expectTool("check my inbox", "email"));
  it("routes 'draft an email'", () => expectTool("draft an email", "email"));
  it("routes 'read my emails'", () => expectTool("read my emails", "email"));
  it("does NOT route 'add contact john@example.com'", () =>
    expectNotTool("add contact John Smith, john@example.com", "email", "contact management guard"));
  it("does NOT route 'save contact with email'", () =>
    expectNotTool("save contact: Jane Doe, email: jane@test.com", "email", "contact management guard"));
  it("does NOT route 'add alias to contact'", () =>
    expectNotTool("add alias Johnny to John Smith", "email", "alias guard"));
  it("does NOT route 'update contact email'", () =>
    expectNotTool("update contact John's email to john@new.com", "email", "contact update guard"));
  // Known issue: "email.js" contains "email" which triggers the match,
  // and the file path guard fires BUT also "security" + "issues" match context action.
  // The guard DOES block when hasExplicitFilePath + review keywords are both present,
  // but the email word boundary fires on "email.js" extension. Tracked for future fix.
  it("does NOT route code file review to email (known edge case)", () =>
    expectNotTool("review the file D:/server/tools/emailUtils.js for bugs", "email", "file path guard"));
});

describe("WhatsApp", () => {
  // Phone number + send command
  it("routes 'send 0505576180 hello' to whatsapp", () =>
    expectTool("send 0505576180 hello", "whatsapp"));
  it("routes 'send a message to +972505576180'", () =>
    expectTool("send a message to +972505576180", "whatsapp"));
  // Explicit keyword
  it("routes 'send a whatsapp message'", () =>
    expectTool("send a whatsapp message", "whatsapp"));
  it("routes 'שלח וואטסאפ הודעה'", () =>
    expectTool("שלח וואטסאפ הודעה", "whatsapp"));
  // Relation-based
  it("routes 'send my mom a message'", () =>
    expectTool("send my mom a message", "whatsapp"));
  it("routes 'send dad a welcoming message'", () =>
    expectTool("send dad a welcoming message", "whatsapp"));
  it("routes Hebrew 'שלח לאמא הודעה'", () =>
    expectTool("שלח לאמא הודעה", "whatsapp"));
  // Guards: scheduling should block
  it("does NOT route 'schedule a whatsapp message daily'", () =>
    expectNotTool("schedule a whatsapp message daily at 8am", "whatsapp", "scheduling guard"));
  it("does NOT route 'schedule whatsapp every morning'", () =>
    expectNotTool("schedule a daily whatsapp message every morning", "whatsapp", "scheduling guard"));
  // Guard: email keyword blocks
  it("does NOT route 'send email to 0505576180'", () =>
    expectNotTool("send email to 0505576180", "whatsapp"));
});

describe("GitHub Trending", () => {
  it("routes 'trending github repos'", () => expectTool("trending github repos", "githubTrending"));
  it("routes 'popular open source projects'", () => expectTool("popular open source projects", "githubTrending"));
});

describe("Git Local", () => {
  it("routes 'git status'", () => expectTool("git status", "gitLocal"));
  it("routes 'git log'", () => expectTool("git log", "gitLocal"));
  it("routes 'git diff'", () => expectTool("git diff", "gitLocal"));
  it("routes 'git commit'", () => expectTool("git commit", "gitLocal"));
});

describe("Calendar", () => {
  it("routes 'what's on my calendar'", () => expectTool("what's on my calendar", "calendar"));
  it("routes 'schedule a meeting with Bob'", () => expectTool("schedule a meeting with Bob", "calendar"));
  it("routes 'am I free tomorrow'", () => expectTool("am I free tomorrow", "calendar"));
  it("routes 'book a dentist appointment'", () => expectTool("book a dentist appointment", "calendar"));
  it("routes 'extract calendar events to excel'", () => expectTool("extract calendar events to excel", "calendar"));
  it("does NOT route sports scores with 'match' keyword", () =>
    expectNotTool("what was the arsenal match score", "calendar"));
});

// ────────────────────────────────────────────────────────────
// TIER 4: Broader tools (55-69)
// ────────────────────────────────────────────────────────────
describe("News", () => {
  it("routes 'latest news'", () => expectTool("latest news", "news"));
  it("routes 'what's happening in the world'", () => expectTool("what's happening in the world", "news"));
  it("routes 'breaking headlines'", () => expectTool("breaking headlines", "news"));
  it("does NOT route 'schedule news check every morning'", () =>
    expectNotTool("schedule news check every morning", "news"));
  it("does NOT route Moltbook-related", () =>
    expectNotTool("what's happening on Moltbook", "news"));
});

describe("Finance", () => {
  it("routes 'check stock price of Tesla'", () => expectTool("check stock price of Tesla", "finance"));
  it("routes 'how is Apple doing in the market'", () => expectTool("how is Apple doing in the market", "finance"));
  it("routes 'NASDAQ today'", () => expectTool("NASDAQ today", "finance"));
  it("does NOT route 'why are cybersecurity stocks dropping'", () =>
    expectNotTool("why are cybersecurity stocks dropping", "finance", "research question guard"));
  it("does NOT route fundamentals query", () =>
    expectNotTool("what are Tesla fundamentals", "finance", "fundamentals guard"));
});

describe("Finance Fundamentals", () => {
  it("routes 'Tesla fundamentals'", () =>
    expectTool("what are Tesla fundamentals", "financeFundamentals"));
  it("routes 'Apple P/E ratio'", () => expectTool("Apple P/E ratio", "financeFundamentals"));
  it("routes 'Microsoft market cap and revenue'", () =>
    expectTool("Microsoft market cap and revenue", "financeFundamentals"));
});

describe("Sports", () => {
  it("routes 'Arsenal match score'", () => expectTool("what was the Arsenal match score", "sports"));
  it("routes 'Premier League standings'", () => expectTool("Premier League standings", "sports"));
  it("routes 'when does Barcelona play next'", () =>
    expectTool("when does Barcelona play next", "sports"));
  it("does NOT route with file path", () =>
    expectNotTool("review the game plan in D:/docs/game.txt", "sports"));
});

describe("X / Twitter", () => {
  it("routes 'trending on X'", () => expectTool("trending on X", "x"));
  it("routes 'tweets about AI'", () => expectTool("tweets about AI", "x"));
  it("routes 'post on twitter'", () => expectTool("post on twitter", "x"));
  it("routes 'search twitter for complaints about CRM tools'", () =>
    expectTool("search twitter for complaints about CRM tools", "x"));
  it("does NOT route with scheduling", () =>
    expectNotTool("schedule daily tweet about AI", "x"));
});

describe("Spotify", () => {
  it("routes 'play music'", () => expectTool("play music", "spotifyController"));
  it("routes 'pause spotify'", () => expectTool("pause spotify", "spotifyController"));
  it("routes 'skip song'", () => expectTool("skip song", "spotifyController"));
  it("does NOT route 'when does Arsenal play next'", () =>
    expectNotTool("when does Arsenal play next", "spotifyController", "sports guard"));
  it("does NOT route 'play youtube video'", () =>
    expectNotTool("play youtube video", "spotifyController", "youtube guard"));
  it("does NOT route 'skip this step'", () =>
    expectNotTool("skip this step", "spotifyController", "UI context guard"));
});

describe("YouTube", () => {
  it("routes 'search youtube for cooking tutorials'", () =>
    expectTool("search youtube for cooking tutorials", "youtube"));
  it("routes 'find a video about Node.js'", () =>
    expectTool("find a video about Node.js", "youtube"));
});

describe("GitHub", () => {
  it("routes 'show open pull requests'", () => expectTool("show open pull requests", "github"));
  it("routes 'list github issues'", () => expectTool("list github issues", "github"));
  it("does NOT route with file path", () =>
    expectNotTool("review server/utils/config.js on github", "github"));
});

describe("NLP Tool", () => {
  it("routes 'analyze sentiment of this text'", () => expectTool("analyze sentiment of this text", "nlp_tool"));
  it("routes 'extract named entities'", () => expectTool("extract named entities", "nlp_tool"));
});

// ────────────────────────────────────────────────────────────
// TIER 5: Catch-all tools (40-54)
// ────────────────────────────────────────────────────────────
describe("Shopping", () => {
  it("routes 'what are the best gaming headphones'", () =>
    expectTool("what are the best gaming headphones", "shopping"));
  it("routes 'buy a new keyboard'", () => expectTool("buy a new keyboard", "shopping"));
  it("does NOT route stock/finance context", () =>
    expectNotTool("stock price dropped on Amazon", "shopping"));
});

describe("Chart Generator", () => {
  it("routes 'draw a bar chart'", () => expectTool("draw a bar chart", "chartGenerator"));
  it("routes 'visualize this data'", () => expectTool("visualize this data", "chartGenerator"));
  it("does NOT route 'github dependency graph'", () =>
    expectNotTool("github dependency graph", "chartGenerator"));
});

describe("Calculator", () => {
  it("routes '15 * 3 + 2'", () => expectTool("15 * 3 + 2", "calculator"));
  it("routes 'calculate 20% of 150'", () => expectTool("calculate 20% of 150", "calculator"));
  it("routes 'what is 100 + 200'", () => expectTool("100 + 200", "calculator"));
  it("routes 'compute 50 * 3'", () => expectTool("compute 50 * 3", "calculator"));
  it("does NOT route file paths with numbers", () =>
    expectNotTool("review D:/projects/app2/config.js", "calculator"));
  it("does NOT route dates", () =>
    expectNotTool("what happened on 12/25/2024", "calculator"));
});

describe("File Write", () => {
  it("routes 'create a new file called utils.js'", () =>
    expectTool("create a new file called utils.js", "fileWrite"));
  it("routes 'write a new file called utils.py'", () => expectTool("write a new file called utils.py", "fileWrite"));
  it("routes 'generate a component'", () => expectTool("generate a component", "fileWrite"));
  it("does NOT route prose rewrite requests", () =>
    expectNotTool("rewrite this text to improve grammar", "fileWrite", "prose guard"));
});

describe("Workflow", () => {
  it("routes 'run workflow morning briefing'", () =>
    expectTool("run workflow morning briefing", "workflow"));
  it("routes 'create a workflow'", () => expectTool("create a workflow", "workflow"));
  it("routes 'list my workflows'", () => expectTool("list my workflows", "workflow"));
});

describe("Scheduler", () => {
  it("routes 'schedule a task every morning at 8'", () =>
    expectTool("schedule a task every morning at 8", "scheduler"));
  it("routes 'every 30 minutes run the scanner'", () =>
    expectTool("schedule every 30 minutes run the scanner", "scheduler"));
  it("routes 'remind me to call mom at 5pm every day'", () =>
    expectTool("remind me to call mom at 5pm every day", "scheduler"));
  it("routes 'set up a recurring task'", () =>
    expectTool("set up a recurring task", "scheduler"));
  it("routes 'list my schedules'", () => expectTool("list my schedules", "scheduler"));
  it("does NOT route 'add task to my todo list'", () =>
    expectNotTool("add task to my todo list", "scheduler", "todo guard"));
  it("does NOT route workflow-related", () =>
    expectNotTool("schedule workflow every morning", "scheduler", "workflow guard"));
});

describe("Tasks / Todo", () => {
  it("routes 'add task buy groceries'", () => expectTool("add task buy groceries", "tasks"));
  it("routes 'show my todo list'", () => expectTool("show my todo list", "tasks"));
  it("routes 'pending tasks'", () => expectTool("pending tasks", "tasks"));
  it("does NOT route 'github issue tracker'", () =>
    expectNotTool("show github issues for this repo", "tasks", "github guard"));
});

describe("Package Manager", () => {
  it("routes 'npm install axios'", () => expectTool("npm install axios", "packageManager"));
  it("routes 'list installed packages'", () => expectTool("list installed packages", "packageManager"));
  it("routes 'what version of lodash is installed'", () =>
    expectTool("what version of lodash is installed", "packageManager"));
  it("routes 'outdated packages'", () => expectTool("outdated packages", "packageManager"));
  it("rejects 'npm install' without a package (validate)", () => {
    // install without a package name should be rejected by validate
    const result = route("npm install");
    // Either no match or not packageManager
    if (result) assert.notEqual(result.tool, "packageManager", "bare 'npm install' should be rejected by validate");
  });
});

describe("Contacts", () => {
  it("routes 'add contact: John Smith, john@example.com, 0541234567'", () =>
    expectTool("add contact: John Smith, john@example.com, 0541234567", "contacts"));
  it("routes 'list all my contacts'", () => expectTool("list all my contacts", "contacts"));
  it("routes 'delete contact John Smith'", () => expectTool("delete contact John Smith", "contacts"));
  it("routes 'add alias Rafi to Rafael Efrati'", () =>
    expectTool("add alias Rafi to Rafael Efrati", "contacts"));
  it("routes 'remove alias Johnny from John Smith'", () =>
    expectTool("remove alias Johnny from John Smith", "contacts"));
  it("routes 'set nickname Boss for John'", () =>
    expectTool("set nickname Boss for John", "contacts"));
  it("routes 'what's John's email' away from email tool", () =>
    expectNotTool("what's John's email", "email", "possessive email lookup should not go to email tool"));
  it("routes 'find contact Jane'", () => expectTool("find contact Jane", "contacts"));
  it("routes 'my contacts'", () => expectTool("my contacts", "contacts"));
  it("routes 'phone book'", () => expectTool("phone book", "contacts"));
  it("does NOT route 'email to john about contacts'", () =>
    expectNotTool("send email to john about the contact list", "contacts"));
});

describe("Document QA", () => {
  it("routes 'load document for QA'", () => expectTool("load document for QA", "documentQA"));
  it("routes 'query the document about pricing'", () =>
    expectTool("query the document about pricing", "documentQA"));
});

describe("MCP Bridge", () => {
  it("routes 'list MCP servers'", () => expectTool("list MCP servers", "mcpBridge"));
  it("routes 'call read_query on sqlite MCP'", () =>
    expectTool("call read_query on sqlite MCP", "mcpBridge"));
  it("does NOT route 'youtube MCP' without mcp keyword", () =>
    expectNotTool("search youtube for tutorials", "mcpBridge"));
});

describe("LOTR Jokes", () => {
  it("routes 'tell me a lord of the rings joke'", () =>
    expectTool("tell me a lord of the rings joke", "lotrJokes"));
  it("routes 'gandalf joke'", () => expectTool("gandalf joke", "lotrJokes"));
});

// ────────────────────────────────────────────────────────────
// TIER 6: Fallback (20-39)
// ────────────────────────────────────────────────────────────
describe("Hebrew/Arabic LLM Fallback", () => {
  it("routes Hebrew conversational to llm", () =>
    expectTool("מה דעתך על הפרויקט שלי", "llm"));
  it("routes Hebrew question to llm", () =>
    expectTool("איך אני יכול לשפר את הקוד שלי", "llm"));
  it("does NOT catch Hebrew WhatsApp commands", () =>
    expectNotTool("שלח וואטסאפ הודעה", "llm", "whatsapp guard on Hebrew fallback"));
});

describe("Search Fallback", () => {
  it("routes 'what is quantum computing' to search", () =>
    expectTool("what is quantum computing", "search"));
  it("routes 'who is the president of France'", () =>
    expectTool("who is the president of France", "search"));
  it("routes 'define epistemology'", () => expectTool("define epistemology", "search"));
  it("routes 'tell me about the history of Rome'", () =>
    expectTool("tell me about the history of Rome", "search"));
  it("does NOT route 'what is your name'", () =>
    expectNotTool("what is your name", "search", "identity guard"));
  it("does NOT route math expressions", () =>
    expectNotTool("what is 15 * 3", "search", "math guard"));
  it("does NOT route weather queries", () =>
    expectNotTool("what is the weather today", "search", "weather guard"));
  it("does NOT route very short inputs", () =>
    expectNoMatch("hi", "too short for search"));
});

// ────────────────────────────────────────────────────────────
// REGRESSION TESTS: Known Collisions
// ────────────────────────────────────────────────────────────
describe("Known Collision Regressions", () => {
  // Session collision #1: "add alias" was grabbed by folderAccess via LLM decomposer
  // Fix: added alias matching to contacts routing entry
  it("[regression] 'add alias Rafi to Rafael' → contacts, NOT folderAccess", () => {
    expectTool("add alias Rafi to Rafael Efrati", "contacts");
    expectNotTool("add alias Rafi to Rafael Efrati", "folderAccess");
  });

  // Session collision #2: "add alias" classified as chat by intentClassifier
  // Fix: added contact/alias task pattern — but we test routing here
  it("[regression] alias commands route to contacts tool", () => {
    expectTool("set alias Boss for John", "contacts");
    expectTool("delete alias Rafi from Rafael", "contacts");
    expectTool("add nickname Johnny to John Smith", "contacts");
  });

  // Session collision #3: "add contact with email" routed to email tool
  // Fix: email guard checks for contact management verbs
  it("[regression] 'add contact with email' → contacts, NOT email", () => {
    expectTool("add contact: Jane Doe, jane@example.com, 0541234567", "contacts");
    expectNotTool("add contact: Jane Doe, jane@example.com, 0541234567", "email");
  });

  // Session collision #4: "schedule whatsapp" routed to whatsapp instead of scheduler
  // Fix: scheduling guard on whatsapp entries
  it("[regression] 'schedule a whatsapp daily' → scheduler, NOT whatsapp", () => {
    expectTool("schedule a whatsapp message daily at 8am", "scheduler");
    expectNotTool("schedule a whatsapp message daily at 8am", "whatsapp");
  });

  // Additional collision: compound intents should fall through single-tool routes
  it("[regression] compound 'weather and news' should not match weather alone", () => {
    expectNotTool("get the weather and also check the news", "weather");
    expectNotTool("get the weather and also check the news", "news");
  });
});

// ────────────────────────────────────────────────────────────
// HEBREW INPUT TESTS
// ────────────────────────────────────────────────────────────
describe("Hebrew Inputs", () => {
  it("'שלח וואטסאפ הודעה' → whatsapp", () =>
    expectTool("שלח וואטסאפ הודעה", "whatsapp"));
  it("'שלח לאמא הודעה' → whatsapp", () =>
    expectTool("שלח לאמא הודעה", "whatsapp"));
  it("'מה שמך' → llm (identity)", () => expectTool("מה שמך", "llm"));
  it("'מה דעתך על בינה מלאכותית' → llm (Hebrew fallback)", () =>
    expectTool("מה דעתך על בינה מלאכותית", "llm"));
  it("Hebrew conversational does not go to search", () =>
    expectNotTool("מה דעתך על הפרויקט הזה", "search"));
});

// ────────────────────────────────────────────────────────────
// EDGE CASES
// ────────────────────────────────────────────────────────────
describe("Edge Cases", () => {
  it("empty string returns no match", () => expectNoMatch(""));
  it("null-like input returns no match", () => expectNoMatch(""));
  it("single character returns no match", () => expectNoMatch("x"));
  it("very short input 'hi' returns no match or llm", () => {
    const result = route("hi");
    // "hi" may match personal conversation → no tool, or llm fallback
    // It should NOT match any specific tool
    if (result) {
      assert.ok(
        ["llm", "email_confirm"].includes(result.tool),
        `"hi" should not route to ${result.tool}`
      );
    }
  });
  it("special characters don't crash", () => {
    const result = route("!@#$%^&*()");
    // Should not throw — just no match or fallback
    assert.ok(true, "Did not crash");
  });
  it("very long input doesn't crash", () => {
    const longInput = "tell me about ".repeat(100) + "the weather";
    const result = route(longInput);
    assert.ok(true, "Did not crash on long input");
  });
  it("mixed language input handles gracefully", () => {
    const result = route("send a וואטסאפ message");
    // Should route to whatsapp due to keyword
    assert.ok(result, "Mixed lang should match something");
    assert.equal(result.tool, "whatsapp");
  });
});

// ────────────────────────────────────────────────────────────
// PRIORITY ORDER TESTS
// ────────────────────────────────────────────────────────────
describe("Priority Order Verification", () => {
  it("email_confirm (99) beats all other tools", () => {
    const result = route("send it");
    assert.equal(result.tool, "email_confirm");
    assert.equal(result.priority, 99);
  });

  it("identity (85) beats search (30) for 'who are you'", () => {
    const result = route("who are you");
    assert.equal(result.tool, "llm");
    assert.ok(result.priority > 30, "Identity should have higher priority than search");
  });

  it("email (72) beats contacts (46) for 'send email to john@test.com'", () => {
    expectTool("send email to john@test.com", "email");
  });

  it("contacts (46) beats email (72) when contact management verbs present", () => {
    expectTool("add contact: John, john@test.com, 0541234567", "contacts");
  });

  it("whatsapp (72) beats search (30) for 'send message to 0505576180'", () => {
    expectTool("send message to 0505576180 saying hello", "whatsapp");
  });
});

// ────────────────────────────────────────────────────────────
// NEGATIVE TESTS: Common misroutes to watch
// ────────────────────────────────────────────────────────────
describe("Common Misroute Prevention", () => {
  it("'play a game' should NOT go to spotify", () =>
    expectNotTool("play a game with me", "spotifyController"));
  // Known issue: "match" triggers sports. The sports guard doesn't exclude non-sports contexts.
  // For now, document the current behavior. The word "match" is too common.
  it("'football match score' SHOULD go to sports", () =>
    expectTool("what was the football match score yesterday", "sports"));
  it("'branch strategy' without git should NOT go to gitLocal", () => {
    const result = route("branch strategy for the project");
    if (result) assert.notEqual(result.tool, "gitLocal");
  });
  it("'check my schedule for today' could go to calendar or scheduler", () => {
    const result = route("check my schedule for today");
    assert.ok(result, "Should match something");
    // Either calendar or scheduler is fine, but NOT a random tool
    assert.ok(
      ["calendar", "scheduler"].includes(result.tool),
      `Expected calendar or scheduler, got ${result.tool}`
    );
  });
});

// ────────────────────────────────────────────────────────────
// ROUTING TABLE INTEGRITY
// ────────────────────────────────────────────────────────────
describe("Routing Table Integrity", () => {
  it("ROUTING_TABLE is a non-empty array", () => {
    assert.ok(Array.isArray(ROUTING_TABLE));
    assert.ok(ROUTING_TABLE.length > 0, "Routing table should not be empty");
  });

  it("every entry has required fields: tool, priority, match", () => {
    for (const entry of ROUTING_TABLE) {
      assert.ok(entry.tool, `Entry missing tool: ${JSON.stringify(entry)}`);
      assert.ok(typeof entry.priority === "number", `Entry ${entry.tool} missing numeric priority`);
      assert.ok(typeof entry.match === "function", `Entry ${entry.tool} missing match function`);
    }
  });

  it("every guard is a function when present", () => {
    for (const entry of ROUTING_TABLE) {
      if (entry.guard !== undefined) {
        assert.ok(typeof entry.guard === "function", `Entry ${entry.tool} guard is not a function`);
      }
    }
  });

  it("every context is a function when present", () => {
    for (const entry of ROUTING_TABLE) {
      if (entry.context !== undefined) {
        assert.ok(typeof entry.context === "function", `Entry ${entry.tool} context is not a function`);
      }
    }
  });

  it("priorities are in valid range (1-99)", () => {
    for (const entry of ROUTING_TABLE) {
      assert.ok(entry.priority >= 1 && entry.priority <= 99,
        `Entry ${entry.tool} has out-of-range priority: ${entry.priority}`);
    }
  });

  it("every entry has a description", () => {
    for (const entry of ROUTING_TABLE) {
      assert.ok(entry.description, `Entry ${entry.tool} (priority ${entry.priority}) missing description`);
    }
  });
});

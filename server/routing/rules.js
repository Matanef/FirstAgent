// server/routing/rules.js
// Declarative routing table — the single source of truth for which tool handles
// which message. To add a new tool rule, add an entry here only.
//
// HOW TO ADD A NEW TOOL:
//   1. Add a rule object to ROUTING_TABLE below
//   2. Set a priority number (see guide)
//   3. Define match() — returns true if this tool should handle the message
//   4. Optionally define guard() — returns true to BLOCK this tool (e.g., compound intent)
//   5. Optionally define context() — returns the context object for the tool
//
// PRIORITY GUIDE:
//   95-99  Confirmations & overrides (send-it, cancel, file attachments)
//   85-94  Narrow-scope skills that beat broader tools
//   70-84  Standard tools with distinctive patterns (email, weather, calendar, sheets)
//   55-69  Broader tools (finance, sports, youtube, news)
//   40-54  Generic catch-alls (calculator, file, review)
//   20-39  Fallback routing (search, llm for general knowledge)
//
// The system evaluates ALL rules, picks the highest-priority match that
// passes its guard. No more "move this block above that block" surgery.

import {
  FINANCE_COMPANIES, FINANCE_INTENT, FINANCE_RESEARCH_QUESTION,
  WEATHER_KEYWORDS, FORGET_SYNONYMS,
  isMathExpression, isPersonalConversation, isSimpleDateTime,
  isProseIntent, hasExplicitFilePath, hasCompoundIntent,
  isSendItCommand, isCancelCommand, isMemoryWriteCommand,
  containsKeyword, locationWithForgetLike, hereIndicatesWeather,
  extractCity, formatCity
} from "./helpers.js";

export const ROUTING_TABLE = [
  // ── TIER 1: Confirmations & overrides (95-99) ──────────────
  {
    tool: "email_confirm",
    priority: 99,
    match: (lower) => isSendItCommand(lower),
    context: (lower, trimmed, ctx) => ({ action: "send_confirmed", sessionId: ctx?.sessionId || "default" }),
    description: "Confirm and send email draft"
  },
  {
    tool: "email_confirm",
    priority: 98,
    match: (lower) => isCancelCommand(lower),
    context: (lower, trimmed, ctx) => ({ action: "cancel", sessionId: ctx?.sessionId || "default" }),
    description: "Cancel/discard email draft"
  },

  // ── TIER 2: Narrow-scope skills (85-94) ────────────────────
  {
    tool: "attachmentDownloader",
    priority: 92,
    match: (lower, trimmed) =>
      /\b(download|save|fetch|get)\b/i.test(lower) &&
      /\battachments?\b/i.test(lower) &&
      /[\w.+-]+@[\w.-]+\.\w{2,}/.test(trimmed) &&
      /\b(since|between|after|before|from\s+\d|starting)\b/i.test(lower),
    description: "Download email attachments by sender and date range"
  },
  {
    tool: "llm",
    priority: 85,
    match: (lower) =>
      /\b(what('s| is) your name|who are you|what are you|your identity|tell me about yourself)\b/i.test(lower) ||
      /^(איך קוראים לך|מה השם שלך|מה שמך|מי את|מי אתה)/i.test(lower) ||
      /^\(system:\s*the user asked about your identity/i.test(lower),
    description: "Agent identity questions"
  },
  {
    tool: "moltbook",
    priority: 84,
    match: (lower) =>
      /\bmoltbook\b/i.test(lower) ||
      /\/api\/v\d\/agents?\b/i.test(lower) ||
      /\bsetup[- ]?owner[- ]?email\b/i.test(lower) ||
      // Allows approving/rejecting DMs without explicitly typing "moltbook"
      /\b(dm\s+request|approve\s+dm|reject\s+dm|check\s+dms|my\s+dms)\b/i.test(lower),
    guard: (lower) =>
      /\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate)\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(register|sign\s*up|create\s+account)\b/i.test(lower)) ctx.action = "register";
      else if (/\b(log\s*in|sign\s*in)\b/i.test(lower)) ctx.action = "login";
      else if (/\b(log\s*out|sign\s*out)\b/i.test(lower)) ctx.action = "logout";
      else if (/\b(dm\s+request|pending\s+request|approve\s+dm|reject\s+dm)\b/i.test(lower)) ctx.action = "dm_requests";
      else if (/\b(inbox|messages|conversations|my\s+dms|check\s+dms)\b/i.test(lower)) ctx.action = "dm_inbox";
      else if (/\b(dm|direct\s+message|private\s+message|send\s+dm|send\s+message)\b/i.test(lower)) ctx.action = "dm";
      else if (/\b(update\s+profile|change\s+description|edit\s+profile)\b/i.test(lower)) ctx.action = "updateProfile";
      else if (/\b(view\s+profile|profile\s+of|who\s+is|agent\s+profile)\b/i.test(lower)) ctx.action = "viewProfile";
      else if (/\b(my\s+(\w+\s+)?profile|my\s+account|show\s+profile)\b/i.test(lower)) ctx.action = "profile";
      else if (/\b(comments?\s+(on|for|about)|show\s+comments|read\s+comments|get\s+comments|view\s+comments|moltbook\s+comments)\b/i.test(lower)) ctx.action = "getComments";
      else if (/\b(comment|reply)\b/i.test(lower) && !/\bpost\b/i.test(lower)) ctx.action = "comment";
      else if (/\b(delete\s+post|remove\s+post)\b/i.test(lower)) ctx.action = "deletePost";
      else if (/\b(read\s+post|show\s+post|get\s+post|view\s+post)\b/i.test(lower)) ctx.action = "getPost";
      else if (/\b(post|publish|share|write)\b/i.test(lower)) ctx.action = "post";
      else if (/\b(upvote|downvote|vote)\b/i.test(lower)) ctx.action = "vote";
      else if (/\b(unfollow|unsubscribe)\b/i.test(lower)) ctx.action = "unfollow";
      else if (/\b(subscribe\s+to|join\s+submolt|join\s+community)\b/i.test(lower)) ctx.action = "subscribe";
      else if (/\b(follow)\b/i.test(lower)) ctx.action = "follow";
      else if (/\b(allow|unlock|approve|increase|raise).*(communit|submolt|more\s+communit)/i.test(lower)) ctx.action = "unlockCommunities";
      else if (/\b(create\s+submolt|create\s+community|new\s+submolt)\b/i.test(lower)) ctx.action = "createSubmolt";
      else if (/\b(submolt\s+feed|community\s+feed)\b/i.test(lower)) ctx.action = "submoltFeed";
      else if (/\b(communities?|submolts?)\b/i.test(lower)) ctx.action = "communities";
      else if (/\b(sentiment|mood|vibes?|pulse|atmosphere)\b/i.test(lower)) ctx.action = "sentiment";
      else if (/\b(search|find|look\s+for)\b/i.test(lower)) ctx.action = "search";
      else if (/\b(notification|read\s+all|mark\s+read|clear\s+notification)\b/i.test(lower)) ctx.action = "notifications";
      else if (/\b(home|dashboard)\b/i.test(lower)) ctx.action = "home";
      else if (/\b(feed|browse|timeline)\b/i.test(lower)) ctx.action = "feed";
      else if (/\b(heartbeat|check\s*in|routine|engage)\b/i.test(lower)) ctx.action = "heartbeat";
      else if (/\b(status|session|check)\b/i.test(lower)) ctx.action = "status";
      else if (/\b(set\s*up|setup|configure)\b/i.test(lower) && /\bemail\b/i.test(lower)) ctx.action = "setupEmail";
      else if (/\bsetup[- ]?owner[- ]?email\b/i.test(lower)) ctx.action = "setupEmail";
      else ctx.action = "feed";
      return ctx;
    },
    description: "Moltbook operations and interactions"
  },
  {
    tool: "systemMonitor",
    priority: 90,
    match: (lower) =>
      /\b(system\s+health(\s+check)?|health\s+check|server\s+status|server\s+health|cpu\s+usage|memory\s+usage|disk\s+usage|process\s+monitor|system\s+monitor|system\s+performance|pm2\s+status|resource\s+usage|system\s+resources?)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    description: "System health, CPU/memory/disk monitoring, server/PM2 status"
  },
  {
    tool: "githubScanner",
    priority: 88,
    match: (lower, trimmed) =>
      /\b(scan\s+github|github\s+scan|analyze\s+github|discover\s+tool|find\s+new\s+tool|github\s+intelligence|repo\s+scan|scan\s+repos?\s+for|github\s+pattern)\b/i.test(lower) ||
      (/\b(scan|analyze|check|review)\b/i.test(lower) && /\b(github|repositor(?:y|ies))\b/i.test(lower) && !hasExplicitFilePath(trimmed)),
    context: (lower) => {
      if (/\btrending|popular|hot\b/i.test(lower)) return { action: "trending" };
      if (/\bdiscover|find/i.test(lower)) return { action: "discover" };
      if (/\bpattern|practice/i.test(lower)) return { action: "patterns" };
      return { action: "scan" };
    },
    description: "Scan GitHub repos for patterns, tool discovery, AI analysis"
  },
  {
    tool: "duplicateScanner",
    priority: 86,
    match: (lower) => /\b(duplicates?|duplication|find\s+duplicates?|scan\s+duplicates?|duplicate\s+files?)\b/i.test(lower),
    context: (lower, trimmed) => {
      const ctx = {};
      const pathMatch = trimmed.match(/(?:in|under|at|from)\s+([a-zA-Z]:[\\\/][^\s,]+|[.\/][^\s,]+)/i);
      if (pathMatch) ctx.path = pathMatch[1];
      const typeMatch = lower.match(/(?:that are|type)\s+(\.\w+|\w+)\s+files?/);
      if (typeMatch) ctx.type = typeMatch[1];
      const extMatch = lower.match(/\.(txt|js|jsx|ts|tsx|json|css|md|py|html|xml|csv)\b/);
      if (!ctx.type && extMatch) ctx.type = extMatch[0];
      const nameMatch = trimmed.match(/(?:named?|called)\s+["']?([^"'\s,]+)["']?/i);
      if (nameMatch) ctx.name = nameMatch[1];
      return ctx;
    },
    description: "Find duplicate files in a directory"
  },

  // ── TIER 3: Standard tools with distinctive patterns (70-84) ──
  {
    tool: "memorytool",
    priority: 82,
    match: (lower) => isMemoryWriteCommand(lower),
    description: "Remember/save user info to memory"
  },
  {
    tool: "memorytool",
    priority: 81,
    match: (lower) => locationWithForgetLike(lower),
    context: () => ({ raw: "forget_location" }),
    description: "Forget saved location from memory"
  },
  {
    tool: "weather",
    priority: 78,
    match: (lower) => hereIndicatesWeather(lower),
    context: () => ({ city: "__USE_GEOLOCATION__" }),
    description: "Weather for current location (geolocation)"
  },
  {
    tool: "weather",
    priority: 75,
    match: (lower) => containsKeyword(lower, WEATHER_KEYWORDS),
    guard: (lower) =>
      /\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate)\b/i.test(lower) ||
      hasCompoundIntent(lower),
    // NOTE: city extraction + memory lookup requires async — handled by wrapper in evaluateRoutingTable
    contextAsync: true,
    description: "Weather forecast with city detection"
  },
  {
    tool: "projectSnapshot",
    priority: 75,
    match: (lower) => /\b(snapshot|show context|file snapshot|project snapshot)\b/i.test(lower),
    description: "Triggers compressed context snapshot generation"
  },
  // ── selfImprovement: diagnostics & introspection (78) ─────────
  {
    tool: "selfImprovement",
    priority: 78,
    match: (lower) =>
      /\b(how\s+accurate|routing\s+accuracy|your\s+accuracy|success\s+rate|routing\s+report|tool\s+usage\s+stats?)\b/i.test(lower) ||
      /\b(what\s+issues?\s+(have\s+you|did\s+you)\s+detect|detected\s+issues?|routing\s+issues?)\b/i.test(lower) ||
      /\b(how\s+(good|well)\s+(is\s+your|do\s+you|are\s+you)\s+routing|how\s+are\s+you\s+routing)\b/i.test(lower) ||
      /\b(how\s+can\s+you\s+improve|improve\s+your\s+(tool\s+selection|routing|accuracy|decisions?|classification))\b/i.test(lower) ||
      /\b(selfimprovement|self.improvement)\b/i.test(lower),
    description: "Routing accuracy diagnostics and self-improvement reports"
  },
  {
    tool: "sheets",
    priority: 75,
    match: (lower) => /\b(google\s*sheet|spreadsheet|sheet\s*id|batch\s*append)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    context: (lower, trimmed) => {
      const ctx = {};
      if (/\b(read|get|fetch|show|view)\b/i.test(lower)) ctx.action = "read";
      else if (/\b(clear|wipe|empty)\b/i.test(lower)) ctx.action = "clear";
      else ctx.action = "append";
      const sheetIdMatch = lower.match(/(?:sheet\s*id\s*|spreadsheets\/d\/)([a-zA-Z0-9_-]{20,60})/i) || trimmed.match(/\b([a-zA-Z0-9_-]{25,60})\b/);
      if (sheetIdMatch) ctx.spreadsheetId = sheetIdMatch[1];
      return ctx;
    },
    description: "Google Sheets read/append/clear"
  },
  {
    tool: "email",
    priority: 72,
    match: (lower) =>
      /\b(emails?|e-mails?|mails?|inbox|send\s+to|draft\s+(an?\s+)?(emails?|messages?|letters?))\b/i.test(lower),
    guard: (lower, trimmed) =>
      (/\b(download|save|fetch|get)\b/i.test(lower) && /\battachments?\b/i.test(lower) && /\b(since|between|after|before|starting)\b/i.test(lower)) || // attachment download
      isSendItCommand(lower) ||
      hasCompoundIntent(lower) ||
      /\/api\/v\d\/agents?\b/i.test(lower) ||
      (/\b(set\s*up|setup|configure)\b/i.test(lower) && /\b(moltbook|owner[- ]?email)\b/i.test(lower)) ||
      // Guard: "add contact ... email: X" is contact management, not email composition
      (/\b(add|save|update|edit|remove|delete)\s+(an?\s+)?(contact|alias|nickname)\b/i.test(lower)) ||
      // Guard: "inspect/review email.js" is a code review, not email composition
      (hasExplicitFilePath(trimmed || lower) && /\b(inspect|review|audit|check|security|analyz|vulnerabilit|bug|issue|improv)\b/i.test(lower)) ||
      // Guard: "what's John's email?" is a contact lookup, not email composition
      /\b\w+'s\s+(email|phone|number)\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(check|read|browse|inbox|list|show|go\s+over|latest|recent|unread)\b/i.test(lower)) ctx.action = "browse";
      else if (/\b(delete|trash|remove)\b/i.test(lower)) ctx.action = "delete";
      else if (/\b(attachment|download)\b/i.test(lower)) ctx.action = "downloadAttachment";
      return ctx;
    },
    description: "Email compose, browse, or delete"
  },
  {
    tool: "whatsapp",
    priority: 72,
    match: (lower, trimmed) =>
      /\bsend\b/i.test(lower) &&
      /(?:\+?\d[\d\s\-()]{6,18}\d)/.test(trimmed) &&
      !/\b(email|e-mail|mail)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower) || /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower),
    description: "WhatsApp — phone number detected with send command"
  },
  {
    tool: "whatsapp",
    priority: 70,
    match: (lower) =>
      (/\b(whatsapp)\b/i.test(lower) || /(?:^|\s)(ווטסאפ|וואטסאפ)(?:\s|$)/.test(lower)) &&
      (/\b(send|bulk|mass|message)\b/i.test(lower) || /(?:^|\s)(שלח|תשלח|שלחי|קבוצת|הודעה)(?:\s|$)/.test(lower)),
    guard: (lower) => hasCompoundIntent(lower) || /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower),
    description: "WhatsApp — explicit keyword with send intent"
  },
  {
    tool: "whatsapp",
    priority: 68,
    match: (lower) =>
      // "send my mom/dad a message", "send shirly a welcoming message"
      (/\b(send)\s+(my\s+|to\s+my\s+)?(mom|dad|mother|father|brother|sister)\b/i.test(lower) ||
       /(?:^|\s)(שלח|תשלח|שלחי)\s+(ל)?(אמא|אימא|אבא|אחי|אחות)/i.test(lower) ||
       /\b(send)\s+\w+\s+a\s+\w+\s+message\b/i.test(lower)) &&
      !/\b(email|e-mail|mail)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower) || /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower),
    description: "WhatsApp — send message to person/relation by name"
  },
  {
    tool: "githubTrending",
    priority: 74,
    match: (lower) =>
      /\b(trending|popular|top)\b/i.test(lower) &&
      /\b(repo|repository|github|project|open\s*source)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    description: "Trending GitHub repositories"
  },
  {
    tool: "gitLocal",
    priority: 73,
    match: (lower) => /\b(git\s+(status|log|diff|add|commit|branch|checkout|stash|push|pull|reset))\b/i.test(lower),
    description: "Local git commands (status, log, diff, etc.)"
  },
  {
    tool: "calendar",
    priority: 71,
    match: (lower, trimmed) =>
      (/\b(extract|export|excel|xlsx|spreadsheet)\b/i.test(lower) ||
       /(?:חלץ|ייצא|אקסל|סרוק|לאקסל|ייצוא)/u.test(trimmed)) &&
      /\b(calendar|events?|לוח|אירוע|יומן)\b/iu.test(trimmed),
    context: () => ({ action: "extract" }),
    description: "Calendar extract/export to spreadsheet"
  },
  {
    tool: "calendar",
    priority: 70,
    match: (lower) =>
      /\b(calendar|meeting|appointment|schedule\s+(a|an|the)|set\s+(a|an)\s+(meeting|call|event|appointment)|add\s+to\s+(my\s+)?calendar|my\s+calendar|book\s+(a|an)\s+(room|meeting|call|appointment|dentist|doctor)|what\s+events?\b|my\s+events|am\s+i\s+(free|busy|available)|free\s+(time|slot|tomorrow|today|this)|availab(le|ility)\s+(today|tomorrow|this|next))\b/i.test(lower),
    guard: (lower) =>
      /\b(score|match|game|league|football|soccer|basketball|nba|nfl|sports?\s+events?)\b/i.test(lower) ||
      // Guard: recurring/automation keywords → scheduler, not calendar
      /\b(every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate)\b/i.test(lower) ||
      // Guard: "schedule a task/whatsapp/email" is not a calendar event
      /\bschedule\s+(a\s+)?(task|whatsapp|message|email|check|report|scan)\b/i.test(lower),
    description: "Calendar — meetings, events, availability"
  },

  // ── Obsidian Knowledge OS ──────────────────────────────────
  {
    tool: "obsidianWriter",
    priority: 74,
    match: (lower) =>
      /\b(obsidian|vault)\b/i.test(lower) ||
      (/\b(create|write|make|new)\b/i.test(lower) && /\b(note|canvas)\b/i.test(lower)) ||
      /\b(populate|fill|reap|clean|prune|delete)\s+(\w+\s+)?(stubs?|empty\s+notes?)\b/i.test(lower) ||
      /\b(append\s+to\s+note|read\s+note|list\s+notes?)\b/i.test(lower),
    guard: (lower) =>
      !hasCompoundIntent(lower) ? false :
      // Allow compound if BOTH parts involve obsidian
      /\b(obsidian|vault|note|canvas)\b/i.test(lower) ? false : true,
    description: "Obsidian vault — create/edit notes, canvas, stubs"
  },
  // gitPulse and deepResearch routing rules are self-registered by their skill
  // files (server/skills/gitPulse.js, server/skills/deepResearch.js) via the
  // ROUTING export — picked up by loadSkills() in executor.js (Phase 2).

  // ── TIER 4: Broader tools (55-69) ─────────────────────────
  {
    tool: "news",
    priority: 65,
    match: (lower) =>
      /\b(latest|recent|breaking|today'?s)?\s*(news|headlines?|articles?)\b/i.test(lower) ||
      /\bwhat'?s\s+(happening|going\s+on|new)\b/i.test(lower),
    guard: (lower, trimmed) =>
      hasExplicitFilePath(trimmed) ||
      /\bmoltbook\b/i.test(lower) ||
      hasCompoundIntent(lower) ||
      /\b(try\s+again|the\s+purpose|more\s+.{0,20}\s+like|give\s+(your\s*self|me)|as\s+a\s+.{0,30}\s+reporter|style|idea|concept|theme|approach|username|name\s+(your|the)|rename|rebrand)\b/i.test(lower) ||
      /\b(schedule|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily|weekly|recurring|cron|automate)\b/i.test(lower) ||
      isPersonalConversation(lower, trimmed),
    description: "News and headlines"
  },
  {
    tool: "finance",
    priority: 63,
    match: (lower, trimmed) =>
      (/\b(stocks?|share\s+price|ticker|market|portfolio|invest|dividend|earnings|S&P\s*500|nasdaq|dow\s+jones|trading|IPO|stock\s+price)\b/i.test(lower) ||
       (FINANCE_COMPANIES.test(lower) && FINANCE_INTENT.test(lower))),
    guard: (lower) =>
      hasCompoundIntent(lower) || FINANCE_RESEARCH_QUESTION.test(lower) ||
      // Yield to financeFundamentals for fundamentals-specific queries
      /\b(fundamentals?|P\/E|p\/e|pe\s+ratio|balance\s*sheet|income\s+statement|cash\s*flow|market\s*cap|revenue|quarterly|annual\s+report)\b/i.test(lower),
    context: (lower, trimmed) => {
      // Research questions without specific company → route to search instead
      const hasSpecificCompany = FINANCE_COMPANIES.test(lower) || /\b[A-Z]{2,5}\b/.test(trimmed);
      const isExplanatoryQ = /\b(why|what\s+caused|what\s+happened|reason)\b/i.test(lower);
      if (isExplanatoryQ && !hasSpecificCompany) return { __redirectTool: "search" };
      return {};
    },
    description: "Stock prices, market data, ticker lookups"
  },
  {
    tool: "financeFundamentals",
    priority: 62,
    match: (lower) =>
      /\b(fundamentals?|P\/E|pe\s+ratio|balance\s*sheet|income\s+statement|cash\s*flow|market\s*cap|quarterly|annual\s+report|revenue|earnings|eps|dividend\s+yield|beta)\b/i.test(lower) ||
      (FINANCE_COMPANIES.test(lower) && /\b(fundamentals?|financials?|report|analysis|revenue|earnings|market\s*cap)\b/i.test(lower)),
    description: "Financial fundamentals, P/E ratios, balance sheets, market cap, revenue"
  },
  {
    tool: "sports",
    priority: 60,
    match: (lower) =>
      /\b(score|match|game|league|team|player|football|soccer|basketball|nba|nfl|premier\s+league|champion|fixture|standings?|table)\b/i.test(lower) ||
      (/\b(play\s+next|next\s+(match|game|fixture)|when\s+does?\s+\w+\s+play)\b/i.test(lower) && /\b(arsenal|chelsea|liverpool|tottenham|spurs|manchester|man\s+(utd?|city)|barcelona|real\s+madrid|juventus|bayern|lakers|celtics|warriors|yankees|cowboys|patriots)\b/i.test(lower)),
    guard: (lower, trimmed) =>
      hasExplicitFilePath(trimmed) ||
      /\b(meeting|calendar|appointment|set\s+a|book\s+a|with\s+the\s+team)\b/i.test(lower) ||
      hasCompoundIntent(lower),
    description: "Sports scores, matches, leagues, fixtures"
  },
  {
    tool: "x",
    priority: 60,
    match: (lower) =>
      /\b(tweet|twitter|trending\s+on\s+x|x\s+trends?|twitter\s+trends?|tweets?\s+(about|from|by)|top\s+tweets?|x\s+posts?|complaint|pain\s*point|post\s+(on|to)\s+(x|twitter))\b/i.test(lower) ||
      // Also catch: "analyze tweets sentiment about X", "tweet sentiment", "100 tweets about X"
      (/\b(tweet|twitter)\b/i.test(lower) && /\b(sentiment|analyze|analysis|opinion|mood)\b/i.test(lower)),
    guard: (lower, trimmed) => {
      const isScheduling = /\b(schedules?|recurring|cron|hourly|daily|weekly|every\s+\d)\b/i.test(lower);
      const isMultiToolChain = /\b(google\s*sheet|spreadsheet|append|aggregate|categorize\s+.*(save|write|sheet)|save\s+to\s+(sheet|sheets))\b/i.test(lower);
      const isMetaQ = /\b(why\s+did\s+you|what\s+tool|which\s+tool|how\s+does\s+(this|the)\s+tool|explain\s+(this|the)\s+tool)\b/i.test(lower);
      return isScheduling || isMultiToolChain || isMetaQ || hasCompoundIntent(lower) || isPersonalConversation(lower, trimmed);
    },
    context: (lower) => {
      const ctx = {};
      if (/\b(trends?|trending|popular|hot)\b/i.test(lower)) ctx.action = "trends";
      else if (/\b(sentiment|analyze|analysis|opinion|mood)\b/i.test(lower)) ctx.action = "analyze";
      else if (/\b(post|publish|compose)\s+(on|to)\s+(x|twitter)\b/i.test(lower)) ctx.action = "post";
      else if (/\b(complaint|pain\s*point|frustrat|looking\s+for\s+(a\s+)?better|advanced\s+search)\b/i.test(lower)) ctx.action = "leadgen";
      else ctx.action = "search";
      const countryMatch = lower.match(/\bin\s+(?:the\s+)?(israel|uk|united\s+kingdom|britain|us|usa|united\s+states|america|canada|brazil|mexico|france|germany|spain|italy|netherlands|sweden|turkey|russia|japan|india|australia|south\s+korea|korea|singapore|indonesia|philippines|thailand|south\s+africa|nigeria|egypt|kenya|jerusalem|tel\s*aviv)\b/i);
      if (countryMatch) ctx.country = countryMatch[1].toLowerCase().replace(/\s+/g, " ");
      else if (/\b(israel|jerusalem|tel\s*aviv|ישראל)\b/i.test(lower)) ctx.country = "israel";
      return ctx;
    },
    description: "X/Twitter — trends, search, post, lead gen, sentiment"
  },
  {
    tool: "spotifyController",
    priority: 58,
    match: (lower) => /\b(play|pause|skip|previous|spotify|music|song|track)\b/i.test(lower),
    guard: (lower) =>
      hasCompoundIntent(lower) ||
      // Guard: sports context — "when does Arsenal play next" is NOT spotify
      /\b(arsenal|chelsea|liverpool|tottenham|spurs|manchester|man\s+(utd?|city)|barcelona|real\s+madrid|juventus|bayern|lakers|celtics|warriors|yankees|cowboys|patriots|score|match|game|league|fixture|standings?|nba|nfl|premier\s+league)\b/i.test(lower) ||
      // Guard: tech/UI/chat/video context — "previous prompt", "play youtube video", "skip this step"
      /\b(prompt|message|input|terminal|button|feature|step|youtube|video|movie)\b/i.test(lower),
    description: "Spotify playback control"
  },
  {
    tool: "youtube",
    priority: 57,
    match: (lower) => /\b(youtube|video|watch|tutorial\s+video|how\s+to\s+video)\b/i.test(lower),
    guard: (lower) => hasCompoundIntent(lower),
    description: "YouTube video search"
  },
  {
    tool: "github",
    priority: 56,
    match: (lower) =>
      /\b(github|repo|repository|pull\s+requests?|PR|commit|merge|fork)\b/i.test(lower) ||
      (/\b(issues?|branch)\b/i.test(lower) && /\b(github|repo|pr|open|close|assign|label|milestone|merge|checkout)\b/i.test(lower)),
    guard: (lower, trimmed) => hasExplicitFilePath(trimmed) || hasCompoundIntent(lower),
    description: "GitHub repos, issues, PRs, commits"
  },
  {
    tool: "nlp_tool",
    priority: 55,
    match: (lower) => /\b(sentiment|analyze\s+text|text\s+analysis|classify\s+text|extract\s+entities|named\s+entities|NER)\b/i.test(lower),
    // Guard: if "tweet" or "twitter" is mentioned, defer to x tool (higher priority, real data)
    guard: (lower) => hasCompoundIntent(lower) || /\b(tweet|twitter|x\s+posts?)\b/i.test(lower),
    description: "NLP text analysis, sentiment, entity extraction"
  },

  // ── TIER 5: Catch-all tools (40-54) ───────────────────────
  {
    tool: "shopping",
    priority: 54,
    match: (lower) =>
      /\b(buy|shop|price|product|amazon|order|purchase|deal|discount|coupon)\b/i.test(lower) ||
      (/\b(best|top|cheapest|affordable)\s+\w+\s*(for|under|around|headphone|keyboard|laptop|phone|tablet|monitor|mouse|chair|camera|speaker|earbuds)\b/i.test(lower)) ||
      (/\bwhat\s+are\s+the\s+best\s+\w+/i.test(lower) && /\b(wireless|bluetooth|gaming|mechanical|ergonomic|portable|budget)\b/i.test(lower)),
    guard: (lower) =>
      /\b(stock|share|invest|market|ticker|cybersecurity|crypto|bitcoin|earnings)\b/i.test(lower) ||
      /\bprice\s*(drop|drops|dropped|crash|fell|decline|surge|rally|increase|decrease)\b/i.test(lower) ||
      // Guard: "add task buy groceries" is a todo, not a shopping request
      /\b(add\s+task|todo|to-do|task\s+list|reminder|checklist)\b/i.test(lower),
    description: "Shopping — product search, price comparisons, deals"
  },
  {
    tool: "chartGenerator",
    priority: 53,
    match: (lower) => /\b(chart|graph|plot|visualize|diagram|draw\s+a?\s*(bar|line|pie|scatter))\b/i.test(lower),
    guard: (lower) => /\b(github|dependency|project)\b/i.test(lower),
    description: "Chart/graph generation and visualization"
  },
  {
    tool: "calculator",
    priority: 52,
    match: (lower) => isMathExpression(lower),
    description: "Math expression evaluation"
  },
  {
    tool: "calculator",
    priority: 51,
    match: (lower) => /\b(calculate|compute|solve|what\s+is\s+\d|how\s+much\s+is|convert\s+\d|percentage\s+of)\b/i.test(lower),
    description: "Calculator — explicit keywords"
  },
  {
    tool: "fileWrite",
    priority: 49,
    match: (lower, trimmed) =>
      /\b(write|create|generate|make)\s+(a\s+)?(new\s+)?(file|script|module|component|document|code|program|class|function)\b/i.test(lower) ||
      /\b(save\s+to|write\s+to|create\s+file|new\s+file)\b/i.test(lower) ||
      (/\b(write|create|generate)\b/i.test(lower) && hasExplicitFilePath(trimmed)),
    guard: (lower) =>
      hasCompoundIntent(lower) ||
      // Exclude prose editing requests — those need the certainty branch for chunked mode
      (isProseIntent(lower) && /\b(rewrite|correct|edit|improve|translate|proofread|fix|grammar|copywrite)\b/i.test(lower)),
    description: "File write/create — generate new files"
  },
  {
    tool: "llm",
    priority: 48,
    match: (lower) => isSimpleDateTime(lower),
    description: "Date/time questions"
  },
  {
    tool: "workflow",
    priority: 47,
    match: (lower) =>
      /\b(run|execute|start|create|list|show|delete|remove)\s+(the\s+)?(a\s+)?(my\s+)?workflow/i.test(lower) ||
      /\bworkflow\s+(named?|called)\b/i.test(lower) ||
      /\b(morning\s+briefing|market\s+check|code\s+review\s+cycle)\b/i.test(lower),
    description: "Workflow management — run, create, list saved workflows"
  },
  {
    tool: "scheduler",
    priority: 47,
    match: (lower) =>
      /\b(schedules?|every\s+\d+\s*(min|hour|day|sec)|every\s+(morning|evening|night)|hourly|daily\s+at|weekly|recurring|cron|automate|set\s+up\s+a?\s*recurring|remind\s+me\s+(to|about)\s+.+\s+(every|at\s+\d|in\s+\d))\b/i.test(lower),
    guard: (lower) =>
      /\b(add\s+task|my\s+tasks|todo|to-do|checklist)\b/i.test(lower) ||
      /\b(performance\s+report|weekly\s+report|generate\s+.*report|summary\s+report|diagnostic\s+report)\b/i.test(lower) ||
      /\bworkflow\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(list|show|view|my)\s*(schedules?|recurring)/i.test(lower)) ctx.action = "list";
      else if (/\b(cancel|stop|remove|delete)\s*(schedules?|timer|recurring)/i.test(lower)) ctx.action = "cancel";
      else if (/\b(pause|disable)\b/i.test(lower)) ctx.action = "pause";
      else if (/\b(resume|enable)\b/i.test(lower)) ctx.action = "resume";
      return ctx;
    },
    description: "Scheduler — recurring tasks, cron jobs, automation"
  },
  {
    tool: "tasks",
    priority: 46,
    match: (lower) => /\b(todo|task|reminder|add\s+task|my\s+tasks|to-do|checklist|pending\s+tasks|task\s+list|show\s+tasks)\b/i.test(lower),
    guard: (lower) => /\b(github|repo|commit|issue|pull\s+request)\b/i.test(lower),
    description: "Task and todo management"
  },
  {
    tool: "packageManager",
    priority: 50,
    match: (lower) =>
      /\b(npm\s+(install|uninstall|list|remove|update|info|outdated)|install\s+(package|[@a-z][\w\/-]*)|uninstall\s+(package|[@a-z][\w\/-]*)|remove\s+(the\s+)?(unused\s+)?package|list\s+(\w+\s+)?packages|update\s+(all\s+)?packages|package\s+manager|what\s+version\s+of\b|which\s+packages|installed\s+packages|outdated\s+packages|is\s+[@a-z][\w\/-]*\s+installed)\b/i.test(lower),
    guard: (lower) => /\b(amazon|buy|shop|order)\b/i.test(lower),
    context: (lower, trimmed) => {
      const ctx = {};
      if (/\binstall\b/i.test(lower) && !/\binstalled\b/i.test(lower)) ctx.action = "install";
      else if (/\buninstall|remove\b/i.test(lower)) ctx.action = "uninstall";
      else if (/\boutdated\b/i.test(lower)) ctx.action = "outdated";
      else if (/\bupdate\b/i.test(lower)) ctx.action = "update";
      else ctx.action = "list";
      const actionMatch = trimmed.match(/(?:install|uninstall|remove|update)\s+([@a-z][\w\/-]*)/i);
      if (actionMatch) { ctx.package = actionMatch[1]; return ctx; }
      const versionMatch = trimmed.match(/(?:what\s+version\s+(?:of\s+)?|check\s+)([@a-z][\w\/-]*)/i);
      if (versionMatch) { ctx.package = versionMatch[1]; return ctx; }
      const isMatch = trimmed.match(/\bis\s+([@a-z][\w\/-]*)\s+installed\b/i);
      if (isMatch) { ctx.package = isMatch[1]; return ctx; }
      const ofMatch = trimmed.match(/version\s+of\s+([@a-z][\w\/-]*)/i);
      if (ofMatch) { ctx.package = ofMatch[1]; return ctx; }
      return ctx;
    },
    validate: (ctx) => {
      const PACKAGE_STOPWORDS = new Set([
        "the", "a", "an", "all", "my", "our", "installed", "available", "used",
        "packages", "package", "version", "versions", "latest", "current",
        "outdated", "updated", "listed", "check", "checked"
      ]);
      if (ctx.package && PACKAGE_STOPWORDS.has(ctx.package.toLowerCase())) {
        ctx.package = undefined;
      }
      if ((ctx.action === "install" || ctx.action === "uninstall") && !ctx.package) return false;
      return true;
    },
    description: "NPM package management — install, uninstall, list, update, version queries"
  },
  {
    tool: "contacts",
    priority: 46,
    match: (lower) =>
      /\b(contacts?|address\s*book|phone\s*(number|book)|my\s+contacts|add\s+contact|find\s+contact|who\s+is\s+\w+'\s*s?\s*(number|email|phone))\b/i.test(lower) ||
      /\b(add|remove|delete|set)\s+(an?\s+)?(alias|nickname|aka)\b/i.test(lower),
    guard: (lower) => /\b(github|email\s+(to|about|regarding))\b/i.test(lower),
    description: "Contacts management"
  },
  {
    tool: "documentQA",
    priority: 45,
    match: (lower) => /\b(load\s+document|index\s+(this\s+)?document|knowledge\s+base|query\s+(the\s+)?document|ask\s+(the\s+)?document|document\s+qa|search\s+(in|within)\s+(the\s+)?document)\b/i.test(lower),
    description: "Document QA — load and query knowledge base"
  },
  {
    tool: "mcpBridge",
    priority: 44,
    match: (lower) =>
      /\b(mcp|sqlite|postgres)\b/i.test(lower) &&
      /\b(list|show|call|run|use|ask|connect|disconnect|close|tools?|servers?|bridge)\b/i.test(lower),
    guard: (lower) => /\b(github|youtube)\b/i.test(lower) && !/\bmcp\b/i.test(lower),
    context: (lower) => {
      const ctx = {};
      if (/\b(list|show|what|which|available)\b/i.test(lower) && /\bservers?\b/i.test(lower)) ctx.action = "list_servers";
      else if (/\b(list|show|what|which)\b/i.test(lower) && /\btools?\b/i.test(lower)) ctx.action = "list_tools";
      else if (/\b(disconnect|close|stop|kill)\b/i.test(lower)) ctx.action = "disconnect";
      else if (/\b(call|run|execute|use|invoke|ask)\b/i.test(lower)) ctx.action = "call_tool";
      const serverMatch = lower.match(/\b(sqlite|github|postgres|youtube)\b/i);
      if (serverMatch) ctx.server = serverMatch[1].toLowerCase();
      if (ctx.action === "call_tool") {
        const toolMatch = lower.match(/\b(?:call|run|execute|use|invoke)\s+(\w+)/i);
        if (toolMatch) ctx.toolName = toolMatch[1];
      }
      return ctx;
    },
    description: "MCP Bridge — Model Context Protocol server interactions"
  },
  {
    tool: "memorytool",
    priority: 42,
    match: (lower) =>
      /\b(what do you (know|remember)|my\s+(name|email|location|contacts?|preferences?)|who\s+am\s+i)\b/i.test(lower),
    guard: (lower) => /\b(password|credential)\b/i.test(lower),
    description: "Memory read — recall stored user info"
  },
  {
    tool: "lotrJokes",
    priority: 40,
    match: (lower) =>
      /\b(lotr|lord\s+of\s+the\s+rings?|hobbit|gandalf|frodo|aragorn|sauron|mordor)\b/i.test(lower) &&
      /\b(joke|funny|humor|laugh|tell\s+me)\b/i.test(lower),
    description: "Lord of the Rings jokes"
  },

  // ── TIER 6: Fallback (20-39) ──────────────────────────────
  {
    tool: "llm",
    priority: 35,
    match: (lower, trimmed) => {
      // Hebrew/Arabic conversational catch-all: if the text is predominantly non-Latin,
      // route to llm instead of letting the tiny intent decomposer (which can't read Hebrew) hallucinate.
      // Only fires when NO higher-priority tool matched.
      // 🚀 NEW: Catch short Hebrew affirmations like "כן", "אוקיי", "סבבה"
      const shortAffirmation = /^(כן|סבבה|אוקיי|טוב|מעולה|אוקי|נכון)$/.test(trimmed);

      const hebrew = (trimmed.match(/[\u0590-\u05FF]/g) || []).length;
      const latin = (trimmed.match(/[a-zA-Z]/g) || []).length;

      return shortAffirmation || ((hebrew > 1) && (hebrew > latin));
    },
    guard: (lower) =>
      // Don't catch tool-specific Hebrew commands (whatsapp, send, etc.) — those have dedicated routes
      // Note: \b doesn't work with Hebrew chars, so use lookahead/behind or just substring match
      /\b(whatsapp)\b/i.test(lower) || /(וואטסאפ|ווטסאפ)/.test(lower) ||
      /(^|\s)(שלח|תשלח|שלחי)(\s|$)/.test(lower),
    description: "Hebrew conversational catch-all"
  },
  {
    tool: "search",
    priority: 30,
    match: (lower) =>
      /\b(what is|what are|who is|who was|who were|when did|where is|how many|how does|why do|why did|why are|why is|define|meaning of|history of|tell\s+me\s+about|explain\s+\w+|search\s+for(?!\s+\w+\s+on\s+(?:x|twitter)))\b/i.test(lower) ||
      // Match "[country/entity] head of state/president/prime minister" patterns (no question word needed)
      /\b(head\s+of\s+state|president\s+of|prime\s+minister\s+of|chancellor\s+of|king\s+of|queen\s+of)\b/i.test(lower) ||
      /\w+('s|s)\s+(president|prime\s+minister|ruler|head\s+of\s+state|chancellor|king|queen)\b/i.test(lower),
    guard: (lower, trimmed) =>
      isMathExpression(trimmed) || hasExplicitFilePath(trimmed) ||
      hasCompoundIntent(lower) ||
      /\b(weather|email|task|todo|file|github|score|game|match|league|calendar|meeting)\b/i.test(lower) ||
      /\b(your\s+name|who\s+are\s+you|what\s+are\s+you|your\s+identity)\b/i.test(lower) ||
      /\b(your\s+(opinion|view|take|thoughts?)|what\s+do\s+you\s+think|do\s+you\s+(like|think|feel|believe))\b/i.test(lower) ||
      /^(איך קוראים לך|מה השם שלך|מה שמך|מי את|מי אתה)/i.test(lower) ||
      lower.length <= 10,
    description: "General knowledge — search fallback"
  },
];

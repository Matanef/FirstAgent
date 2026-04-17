# Agent Tool Guide — Complete Reference

> **55+ registered tools + 6 dynamic skills** across 11 categories + orchestrator-subagent architecture + multi-step decomposition + Train of Thought reasoning + conversational partner mode + Smart Evolution (autonomous tool discovery) + Declarative Routing Table (priority-based intent routing). Each section explains what the tool does, how it's triggered, and provides example prompts to maximize the agent's functionality.
>
> _Last updated: March 2026 — Sprint 12 (Declarative Routing Table replacing if/else certainty chain, RSS feeds externalized to JSON, attachmentDownloader skill, news.js Jina proxy upgrade, planner deduplication cleanup)_

---

## Table of Contents

### Tools by Category
1. [General Intelligence (LLM)](#1-general-intelligence-llm)
2. [Information & Search](#2-information--search)
3. [Productivity & Communication](#3-productivity--communication) _(includes WhatsApp)_
4. [File & Code Operations](#4-file--code-operations)
5. [Developer Tools](#5-developer-tools)
6. [Code Guru Tools](#6-code-guru-tools)
7. [Finance & Shopping](#7-finance--shopping)
8. [Media & Entertainment](#8-media--entertainment)
9. [Web Interaction & Automation](#9-web-interaction--automation)
10. [Advanced Intelligence](#10-advanced-intelligence)
11. [Dynamic Skills](#11-dynamic-skills) _(auto-discovered from server/skills/)_

### Architecture & Features
- [Train of Thought (Reasoning Display)](#train-of-thought-reasoning-display)
- [Multi-Step Intent Decomposition](#multi-step-intent-decomposition-sequential-logic-engine)
- [How the Agent Routes Your Messages](#how-the-agent-routes-your-messages)
- [Declarative Routing Table](#declarative-routing-table)
- [Multi-Step Flows](#multi-step-flows)
- [Multi-Step Test Prompts](#multi-step-test-prompts)

---

## 1. General Intelligence (LLM)

### `llm` — General Conversation & Text Generation

The LLM is the agent's brain. It handles all conversational queries, creative writing, explanations, translations, and anything that doesn't need a specialized tool. It has access to your full conversation history and user profile.

**Triggered by:** Greetings, open-ended questions, creative tasks, text manipulation, personal/emotional messages, anything not matched by other tools.

**Conversational Partner Mode (Sprint 10):** When the planner detects a personal, emotional, or reflective message (first-person pronouns + emotional/reflective signals), it activates enriched profile context and a "supportive collaborator" directive. This makes the agent feel like a partner who knows you, not just a tool dispatcher. False-positive guards prevent tool requests like "I want to search for X" from triggering conversational mode.

**Example prompts:**
1. `"Hey, how are you doing today?"` — Casual conversation
2. `"Explain how async/await works in JavaScript with examples"` — Technical explanation
3. `"Summarize the key points of our last conversation"` — Context-aware summary (uses conversation history)
4. `"Rewrite this paragraph in a more professional tone: [text]"` — Text transformation
5. `"Write a short story about a robot learning to cook"` — Creative writing
6. `"Translate 'good morning' to French, Spanish, and Japanese"` — Translation
7. `"What are the pros and cons of React vs Vue?"` — Comparison/analysis
8. `"What can you do? List all your capabilities"` — Meta-conversation (agent explains itself)
9. `"Help me write a cover letter for a software engineer position"` — Guided writing
10. `"I've been feeling burned out lately and wondering if I should switch careers"` — Personal/emotional (activates conversational partner mode)
11. `"What do you think about the current state of AI development?"` — Opinion-seeking (activates conversational mode)
12. `"Based on what we've talked about, what would be a good side project for me?"` — Context-aware personal advice (uses enriched profile + conversation history)
13. `"I'm struggling with motivation on this project, any thoughts?"` — Reflective/emotional (partner mode with empathy)

---

### `memorytool` — User Profile & Long-Term Memory

Stores and retrieves persistent user information: name, email, location, timezone, tone preferences, contacts, and any custom fields. This data persists across all conversations. Supports a generic "remember my X is Y" pattern for any profile field.

**Triggered by:** "remember", "forget", "what do you know about me", "my name/email/location"

**Example prompts:**
1. `"Remember my name is Alex"` — Store name
2. `"Remember my email is alex@example.com"` — Store email
3. `"Remember my location is Tel Aviv"` — Store location (used by weather, conversational context)
4. `"Remember that my timezone is UTC+3"` — Store timezone
5. `"Remember John's email is john@company.com"` — Store contact
6. `"What do you know about me?"` — Retrieve full profile
7. `"Who am I?"` — Quick profile recall
8. `"Forget my location"` — Remove stored location
9. `"Remember I prefer a professional and concise tone"` — Set tone preference
10. `"Remember that I'm a full-stack developer working on a React + Node.js project"` — Store occupation/background (used in conversational partner mode)
11. `"Remember my goals are to learn Rust and build a CLI tool this quarter"` — Store goals (enriches conversational responses)
12. `"Remember that I'm interested in AI, distributed systems, and open source"` — Store interests (personalizes advice and recommendations)

---

### `contacts` — Contact Book Management

Manages your contact list with name, email, phone, and notes. Supports add, update, search, and list operations. Handles both structured and natural language input with smart type coercion.

**Triggered by:** Part of email/calendar flows when looking up contacts, or via the "contacts" keyword.

**Example prompts:**
1. `"Add contact: John Smith, john@example.com, 555-1234"` — Add new contact
2. `"Find John's email"` — Search contacts
3. `"List all my contacts"` — Show contact book
4. `"Update Sarah's phone to 555-5678"` — Update contact field
5. `"Email John about the meeting"` — Auto-resolves contact in email flow

---

### `nlp_tool` — Text Analysis & Sentiment

Performs NLP analysis: sentiment detection, entity extraction, text classification. Only activates for explicit analysis requests.

**Triggered by:** "sentiment", "analyze text", "text analysis", "classify text", "extract entities"

**Example prompts:**
1. `"Analyze the sentiment of: I love this product, it changed my life!"` — Positive sentiment
2. `"What's the sentiment of this review: The service was terrible"` — Negative sentiment
3. `"Extract entities from: Apple CEO Tim Cook announced new products"` — Named entity recognition
4. `"Classify the tone of this message: We need to talk about your performance"` — Tone classification

---

### `calculator` — Math & Equation Solver

Scientific and symbolic hybrid calculator combining expr-eval for numeric computation with nerdamer for symbolic algebra and equation solving. Handles implicit multiplication (`2x` → `2*x`), variable detection, and trigonometric/logarithmic functions.

**Triggered by:** Math expressions (`15 * 3 + 2`), "calculate", "compute", "solve", "what is [number]", "how much is", "percentage of"

**Example prompts:**
1. `"What is 15% of 230?"` — Percentage calculation
2. `"Calculate 2^10 + sqrt(144)"` — Scientific expression
3. `"Solve x^2 - 5x + 6 = 0"` — Symbolic equation solving
4. `"Convert 100 Fahrenheit to Celsius"` — Unit conversion
5. `"What is sin(45) * cos(30)?"` — Trigonometric functions

---

### `selfImprovement` — Agent Diagnostics & Self-Analysis

Checks the agent's routing accuracy, detects misrouting patterns, generates performance reports, and reviews internal code.

**Triggered by:** "how accurate", "routing accuracy", "self-improve", "what have you improved", "weekly report", "misrouting"

**Example prompts:**
1. `"How accurate is your routing?"` — Get intent accuracy report
2. `"What have you improved recently?"` — View improvement history
3. `"What issues have you detected?"` — Show misrouting patterns
4. `"Generate a weekly performance report"` — HTML summary report
5. `"Review your planner code"` — Code review of planner.js
6. `"How can you improve your tool selection?"` — Get routing recommendations

---

## 2. Information & Search

### `search` — Web Search (6-Source + LLM Synthesis)

Searches **6 sources in parallel**: Wikipedia, Google (SerpAPI), Yandex, DuckDuckGo (SerpAPI), Bing (SerpAPI), and Yahoo (SerpAPI). Results are deduplicated, scored by relevance, and cached for 1 hour. Synthesizes a coherent LLM-powered summary from the combined search results.

**Requires:** `SERPAPI_KEY` in `.env` (recommended for full 6-source coverage)

**Triggered by:** "search", "look up", "find information", "who is/was", "tell me about", "history of", general knowledge questions ("what is X", "how does X work")

**Example prompts:**
1. `"Search for the latest developments in quantum computing"` — Current tech research
2. `"Who was Napoleon Bonaparte?"` — Historical figure lookup (auto-routed via general knowledge guard)
3. `"What is the population of Japan?"` — Factual query
4. `"Search for best practices in Node.js error handling"` — Technical research
5. `"Look up the history of the Eiffel Tower"` — Historical research (synthesized answer)
6. `"Tell me about quantum computing"` — Knowledge query (LLM synthesis)
7. `"How does photosynthesis work?"` — General knowledge (auto-routed, not sent to calculator)
8. `"What are the system requirements for Windows 11?"` — Product info
9. `"Find me a comparison of PostgreSQL vs MongoDB for a real-time analytics dashboard handling 10k events per second"` — Deep technical comparison with specific use case
10. `"Search for the latest research on large language model fine-tuning techniques published in the last 6 months"` — Academic/recent research
11. `"Look up what happened at the last G20 summit and which countries signed the AI governance agreement"` — Current events with specifics

---

### `news` — Multi-Source News with LLM Summaries & Category Feeds

Fetches from **19+ general RSS feeds** (Ynet, N12, JPost, Times of Israel, BBC, CNN, AP News, The Guardian, NPR, ABC News, Sky News, DW, France24, and more) plus **8 category-specific feed groups** (technology, android, science, business, sports, health, entertainment, politics) with ~30 active category feeds. Feed URLs are externalized to `server/data/rss_feeds.json` for easy editing without touching code. Articles are scraped via **Jina Reader API** (`r.jina.ai/`) to bypass Cloudflare/WAF bot protection, then summarized by the LLM, with headlines table showing up to 30 results. Also scrapes Israeli flash news from Mako, Ynet, and Rotter (non-RSS). Smart topic extraction rejects noise words like "any", "some", "all". Falls back to SerpAPI web search when RSS topic filtering yields < 3 results.

**Triggered by:** "news", "headlines", "articles", "latest news", "breaking", "what's happening"

**Example prompts:**
1. `"What's the latest news?"` — All sources, top headlines
2. `"Latest news about technology"` — Auto-detects tech category feeds
3. `"Breaking news from BBC"` — Source-specific (if matched in text)
4. `"Any news about climate change?"` — Topic: environment
5. `"Today's headlines about the economy"` — Topic: economy/business
6. `"Recent news from Israel"` — Regional news (Israeli sources prioritized)
7. `"What's happening in the world of sports?"` — Sports news via RSS (not sports tool)
8. `"Give me a news summary for today"` — General daily briefing
9. `"Get me the latest tech and science news, I want to know what breakthroughs happened this week"` — Multi-category with natural language
10. `"Show me the top headlines from all sources about the semiconductor industry and chip manufacturing"` — Specific industry topic across all feeds
11. `"What are the most important world events happening right now? Give me a broad overview from multiple perspectives"` — Multi-source synthesis

---

### `x` — X (Twitter) Trends, Tweet Search & Sentiment Analysis

Fetches trending topics, searches tweets, and performs LLM-powered sentiment analysis using a **standalone `TwitterClient`** (`server/utils/twitter-client.js`) that replaced the broken `agent-twitter-client` library in Sprint 10. Authenticates via browser cookies (auth_token, ct0, twid) — no username/password needed. Dynamically extracts GraphQL operation hashes from Twitter's live JS bundle (cached 4 hours) to stay current with API changes. Uses POST fallback for SearchTimeline (GET returns 404). Results include engagement metrics (likes, retweets, replies, views).

**Requires:** `twitter_cookies.json` in project root with `auth_token`, `ct0`, and `twid` cookies exported from your browser (use a browser extension like EditThisCookie or Cookie-Editor).

**Authentication:** Cookie-based auth — no login flow needed. The standalone client injects proper headers (`x-csrf-token`, `authorization: Bearer`, `x-twitter-auth-type`, `user-agent`) on every request. If cookies expire, export fresh cookies from your browser.

**Architecture (Sprint 10):**
```
twitter-client.js (standalone, ~600 lines)
├── fetchGraphQLHashes() → extracts current hashes from twitter.com's main.js bundle
├── init() → loads cookies + fetches hashes (lazy, one-time)
├── apiGet(path) → REST API calls (/1.1/trends/place.json)
├── graphql(op, vars, features) → GraphQL with GET→POST fallback
├── search(query, count, product) → SearchTimeline (POST)
├── getProfile(username) → UserByScreenName
├── getTweet(id) → TweetDetail
├── getUserTweets(userId, count) → UserTweets
├── getTrends() → /1.1/trends/place.json?id=1
├── _parseTweetEntry(entry) → normalizes tweet from various response formats
└── _parseUser(result) → handles 2025+ format (name/screen_name in result.core)
```

**Triggered by:** "tweet", "twitter", "trending on X", "X trends", "tweets about", "top tweets", "x posts"

**Example prompts:**
1. `"What's trending on X?"` — Current worldwide trending topics with tweet volumes
2. `"Search tweets about artificial intelligence"` — Keyword tweet search with engagement metrics (likes, retweets, replies)
3. `"Find the latest tweets about the JavaScript conference and show me the top discussions"` — Latest tweet search with engagement sorting
4. `"Analyze tweet sentiment about climate change"` — Search + LLM sentiment analysis (JSON mode) with themes and overall mood
5. `"What are people on Twitter saying about the new iPhone? Give me the sentiment breakdown"` — Full sentiment analysis with themes
6. `"Get X trends and email me the results"` — Compound: X trends → email (multi-step)
7. `"Get twitter trends and whatsapp to 0587426393"` — Compound: X trends → WhatsApp (multi-step)
8. `"Schedule X trends check every morning"` — Recurring daily trend reports via scheduler
9. `"Search for tweets about Bitcoin from the last hour and tell me if people are bullish or bearish"` — Search + analyze compound
10. `"What are the trending topics in Israel on X right now?"` — Country-specific trends (supports Israel, US, UK)

---

### `weather` — Forecast & Current Conditions

Uses OpenWeather API. Supports city names, "here" (geolocation fallback from saved memory), and remembers your saved location from memory. If no city is specified, automatically uses your saved profile location.

**Requires:** `OPENWEATHER_KEY` in `.env`

**Triggered by:** "weather", "forecast", "temperature", "rain", "snow", "humidity", "wind", "sunny", "cloudy"

**Example prompts:**
1. `"What's the weather in London?"` — City-specific forecast
2. `"Weather here"` — Uses saved location from memory profile
3. `"Is it going to rain in New York tomorrow?"` — Rain forecast
4. `"Temperature in Tokyo"` — Temperature query
5. `"What's the forecast for this week in Tel Aviv?"` — Extended forecast
6. `"Is it snowing in Denver?"` — Condition check
7. `"Weather"` — Uses saved location from memory (if set)
8. `"How humid is it in Miami?"` — Humidity query
9. `"Should I bring an umbrella today? I'm heading to the office in Tel Aviv and want to know if rain is expected"` — Natural language with contextual city extraction
10. `"What's the weather like in both London and Paris this weekend? I'm trying to decide where to go for a short trip"` — Comparison intent (routes to weather, user gets forecast to decide)

---

### `chartGenerator` — Data Visualization (SVG Bar Charts)

Generates SVG bar charts from JSON array data. Extracts JSON from natural language requests, auto-detects label and value keys, and renders scalable charts with proper axis spacing.

**Triggered by:** "chart", "graph", "plot", "visualize", "diagram"

**Example prompts:**
1. `"Create a bar chart from this data: [{"name": "Jan", "sales": 100}, {"name": "Feb", "sales": 150}]"` — JSON data chart
2. `"Visualize the results as a graph"` — Used in compound chains after data-producing tools
3. `"Plot a chart of monthly revenue"` — Natural language with data context

---

### `systemMonitor` — System Health & Resource Status

Reports real-time host machine status: memory usage, CPU info, OS details, and uptime. Includes health warnings when resources are critically low.

**Triggered by:** "system status", "check resources", "memory usage", "cpu info", "system health", "system monitor"

**Example prompts:**
1. `"Check system status"` — Full hardware report
2. `"How much memory is being used?1"` — Memory usage
3. `"System health check"` — Health assessment with warnings

---

## 3. Productivity & Communication

### `email` — Draft, Send & Browse Emails (Gmail OAuth)

Full email tool: draft & send emails (two-stage confirmation), browse inbox, read emails, search, and download attachments. Uses Gmail OAuth with send + readonly scopes. Email subjects are now intelligently extracted from the message body ("about X", "regarding Y") instead of defaulting to a generic subject.

**Requires:** Gmail OAuth configured (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`)

**Triggered by:** "email", "mail", "send to", "draft email", "check my emails", "inbox", "read my emails"

**Confirmation flow:** Emails are always drafted first. Say `"send it"` to confirm or `"cancel"` to discard.

**Example prompts:**
1. `"Email john@example.com saying the meeting is at 3pm"` — Direct email with body
2. `"Draft an email to Sarah about the project deadline"` — Uses contacts, smart subject extraction
3. `"Send an email to my boss about taking Friday off"` — Natural language
4. `"Email the team about the new release, attach the changelog"` — With attachment
5. `"Send it"` — Confirm and send the last drafted email
6. `"Cancel"` — Discard the draft (no longer accidentally sends!)
7. `"Check my recent emails"` — Browse inbox
8. `"Show my unread emails from last week"` — Search emails by date/status
9. `"Read email #3"` — View full email content
10. `"Go over my emails and find attachments named 'bills'"` — Search with attachment filter
11. `"Draft a professional follow-up email to the recruiter at Google thanking them for the interview and reaffirming my interest in the role"` — Complex draft with tone + context
12. `"Check my inbox, find any emails from Amazon about shipping, and summarize what's been delivered and what's still pending"` — Browse + search + summarize chain
13. `"Send an email to efratimatan@gmail.com with a summary of today's top tech news and trending GitHub repos"` — Compound: news + githubTrending → email (3-step)

---

### `tasks` — Task & Todo Management

Manages task lists with priorities, due dates, and status tracking. Task keywords take priority over GitHub keywords during routing.

**Triggered by:** "todo", "task", "reminder", "add task", "my tasks", "checklist"

**Example prompts:**
1. `"Add task: review pull request by Friday"` — Create task with deadline (routes here, NOT GitHub)
2. `"What are my current tasks?"` — List all tasks
3. `"Mark the review task as done"` — Update status
4. `"Add a high priority task to fix the login bug"` — Priority task
5. `"Remove the completed tasks"` — Clean up
6. `"What tasks are due this week?"` — Filter by deadline

---

### `calendar` — Google Calendar Integration

Manage your Google Calendar: list upcoming events, create events with natural language, check availability/free time. **Smart event naming** — extracts event titles from natural language (e.g., "schedule a dentist appointment tomorrow at 3pm" creates event named "Dentist appointment", not "New Event"). Supports patterns like "meeting with John", "call about project", and quoted titles.

**Requires:** Gmail OAuth configured + Calendar scopes

**Triggered by:** "calendar", "events", "schedule", "meeting", "appointment", "free time", "availability", "book"

**Example prompts:**
1. `"What events do I have today?"` — List today's events
2. `"Show my calendar for next week"` — Weekly view
3. `"Schedule a meeting tomorrow at 3pm called Team Standup"` — Create event with explicit title
4. `"Am I free tomorrow afternoon?"` — Check availability
5. `"Create a dentist appointment on Monday at 10am for 30 minutes"` — Smart title: "Dentist appointment"
6. `"Book a call with Sarah at 2pm"` — Smart title: "Call with Sarah"
7. `"Set up a code review meeting about the API changes"` — Smart title: "Code review meeting about the API changes"
8. `"Schedule lunch with the team tomorrow"` — Smart title: "Lunch with the team"

---

### `whatsapp` — WhatsApp Business Cloud API (Single, Bulk & Two-Way Bot)

Send WhatsApp messages to individual contacts or bulk-send to everyone in an Excel file. Uses the WhatsApp Business Cloud API via Meta's Graph API. Supports flexible natural language input — you can phrase your message almost any way and the tool will extract the phone number and message content. **Now includes a two-way bot loop**: incoming WhatsApp messages are processed through the full agent pipeline and auto-replied.

**Requires:** `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` in `.env`

**Setup:**
1. Go to [Meta for Developers](https://developers.facebook.com) → WhatsApp → Getting Started
2. Copy the Temporary Access Token → `WHATSAPP_TOKEN`
3. Copy the Phone Number ID → `WHATSAPP_PHONE_ID`
4. Set `WHATSAPP_VERIFY_TOKEN` for webhook verification
5. (Optional) Set `WHATSAPP_BOT_NUMBER` to prevent self-reply loops

**Two-way bot:** When someone sends your WhatsApp number a text message, the webhook at `/webhook/whatsapp` receives it, runs it through the planner→coordinator→executor pipeline, and sends the agent's response back as a WhatsApp reply. Includes duplicate guard, loop guard (won't reply to itself), and HTML-to-plaintext formatting.

**Triggered by:** "whatsapp", "send whatsapp", "send a message to [number]"

**Phone number normalization:**
- Israeli mobile numbers: `05X...` → `9725X...` (auto-prefixed with country code)
- Leading zero stripped: `0X...` → `972X...`
- Strips `+`, `-`, spaces, parentheses automatically
- Validates: 10-15 digits required

**Example prompts (Single Message):**
1. `"Send a WhatsApp to 0541234567 saying hello"` — Standard format with "saying" connector
2. `"Send a WhatsApp to 0541234567 ready to go to work"` — No connector word needed
3. `"WhatsApp 0541234567 the meeting starts at 8pm"` — Shorthand format
4. `"Send 0541234567 a message saying dinner is ready"` — Flexible word order
5. `"Send 0587426393 go to sleep"` — Minimal format (number + message)
6. `"Use WhatsApp to send 0541234567 a message saying I'm on my way"` — Verbose format

**Example prompts (Bulk Excel Send):**
7. `"Send WhatsApp to everyone in contacts.xlsx saying the event starts at 8"` — Bulk send from Excel
8. `"Bulk WhatsApp contacts.xlsx: Happy holidays!"` — Shorthand bulk format

**Excel requirements for bulk send:**
- Must have a column named one of: `phone`, `phone number`, `mobile`, `cell`, `telephone`, `טלפון`, `מספר`, `נייד`, `סלולרי`
- File searched in: `uploads/`, `downloads/`, project root, or absolute path
- 500ms delay between messages for rate limiting
- Returns summary: total rows, sent count, failed count, error details

---

### `sheets` — Google Sheets Integration

Read, write, and manipulate Google Sheets spreadsheets. Supports creating new sheets, reading cell ranges, writing data, and appending rows.

**Requires:** Google Sheets API credentials configured.

**Triggered by:** "google sheets", "spreadsheet", "sheet", "create a sheet", "read the sheet", "write to sheet", "append to sheet"

**Example prompts:**
1. `"Create a Google Sheet with my contacts"` — Create new spreadsheet
2. `"Read the sheet 'Sales Data' range A1:D10"` — Read specific range
3. `"Append this data to the sheet"` — Add rows to existing sheet
4. `"Write the results to a Google Sheet"` — Output data to sheet (often used in compound chains)

---

## 4. File & Code Operations

### `file` — File System Browser & Reader

Reads, lists, and navigates files and directories. Sandboxed to the project root and E:/testFolder. Smart path extraction correctly handles absolute paths in natural language. File path checks take priority over all other routing. NL guard correctly recognizes "read the file", "what's in the directory", and "files in folder" as file operations.

**Triggered by:** Explicit file paths (e.g., `D:/...`), "list files", "read file", "show me", "what's in"

**Example prompts:**
1. `"List files in D:/local-llm-ui/server/tools"` — Absolute path extracted from NL
2. `"Read D:/local-llm-ui/server/planner.js"` — Read file contents
3. `"Show me the contents of E:/testFolder/config.json"` — Read external file
4. `"What files are in the server directory?"` — Natural language listing
5. `"List all JavaScript files in the tools folder"` — Filtered listing
6. `"Read the first 50 lines of server/executor.js"` — Partial read
7. `"Show the directory structure of the client folder"` — Tree view

---

### `fileWrite` — Write Files to Disk (Natural Language Support)

Creates or overwrites files on disk. Supports natural language input — just describe what you want and specify the path. The LLM generates content automatically based on your request and the file extension.

**Triggered by:** "write/create/generate/save/make" + file path

**Example prompts:**
1. `"Write a hello world script to D:/local-llm-ui/test.js"` — NL: generates JS
2. `"Create a config file at D:/local-llm-ui/config.json"` — NL: generates JSON
3. `"Generate a Python script at E:/testFolder/main.py"` — NL: generates Python
4. `"Save a basic HTML page to D:/local-llm-ui/index.html"` — NL: generates HTML
5. `"Create a README at D:/local-llm-ui/README.md"` — NL: generates Markdown

---

### `fileReview` — LLM-Powered File Analysis

When you attach files via drag-and-drop or the attachment bar, this tool summarizes each file with 3 bullet points and suggests 2 follow-up questions.

**Triggered by:** Attaching files to a chat message (automatic routing)

**Example prompts:**
1. *Drag-and-drop a `.js` file* + `"Review this code"` — Code summary
2. *Attach a `.json` file* + `"What does this config do?"` — Config analysis
3. *Attach multiple files* + `"Compare these files"` — Multi-file analysis
4. *Attach a `.csv` file* + `"Summarize this data"` — Data summary
5. *Attach a log file* + `"Find errors in this log"` — Log analysis

---

### `review` — Code Review & Analysis

Reviews code files and generates detailed analysis: issues, suggestions, best practices, security concerns. Uses 4-pattern filename extraction with comprehensive fallback paths.

**Triggered by:** "review code", "inspect code", "examine file", "audit code", "review tool"

**Example prompts:**
1. `"Review server/planner.js"` — Full file review
2. `"Review the executor code and suggest improvements"` — Review with suggestions
3. `"Inspect server/tools/email.js for security issues"` — Security audit
4. `"Examine the search tool implementation"` — Tool analysis
5. `"Review my code for performance issues"` — Performance review

---

### `duplicateScanner` — Find Duplicate Files

Scans directories for duplicate files using SHA256 hashing (two-stage: chunk then full), metadata matching, and Levenshtein fuzzy name detection.

**Triggered by:** "duplicate", "find duplicate", "scan duplicate"

**Example prompts:**
1. `"Find duplicate files in D:/local-llm-ui"` — Full project scan
2. `"Scan for duplicates in E:/testFolder"` — External folder
3. `"Find duplicate .js files in the server directory"` — Type-filtered
4. `"Are there any duplicate files named config?"` — Name-filtered

---

### `applyPatch` — Apply Code Patches (Full Rewrite Engine)

Applies comprehensive code improvements to files using LLM-powered full-rewrite generation. Creates **categorized backups** in `server/tools/backups/[tool_name]/` with timestamps (Sprint 10). Includes **syntax validation** before applying — writes to a staging file, runs `node --check`, and only swaps if valid. Used for multi-change requests where 3+ distinct modifications are needed (planner auto-routes these here instead of codeTransform).

**Triggered by:** "apply patch", "full rewrite", "rewrite entire", or automatically by planner when detecting 3+ action verbs targeting a file

**Example prompts:**
1. `"Apply patch to server/tools/news.js"` — LLM-powered full rewrite with best practices
2. `"Rewrite the entire search tool with better error handling, caching, and retry logic"` — Multi-change rewrite (auto-routed by planner)
3. `"Refactor, add JSDoc, and fix the randomizer bug in server/tools/news.js"` — 3 changes → planner routes to applyPatch

---

## 5. Developer Tools

### `github` — GitHub Repository Management

Full GitHub API access via Octokit: list repos, search repos, manage issues, view commits, read file contents, and view profile. All output now uses **clickable markdown links** for repos, commits, and issues.

**Requires:** `GITHUB_TOKEN` or `GITHUB_API_KEY` in `.env`

**Triggered by:** "github", "repo", "repository", "pull request", "issue", "commit"

**Example prompts:**
1. `"List my GitHub repositories"` — Show all repos with clickable links
2. `"Search GitHub for React component libraries"` — Search repos (with star counts)
3. `"Show my open GitHub issues"` — List issues with clickable links
4. `"Get the contents of README.md from my FirstAgent repo"` — Read repo file
5. `"Show my GitHub profile"` — View profile info
6. `"List recent commits on my FirstAgent repository"` — Commit history with clickable SHA links
7. `"Do you have GitHub access?"` — Test API connection

---

### `githubTrending` — Trending Repositories

Fetches trending GitHub repositories using the GitHub Search API (repos with 500+ stars pushed in the last week, sorted by stars). Supports topic and language filtering.

**Requires:** `GITHUB_TOKEN` for higher rate limits

**Triggered by:** "trending", "popular repos", "top repositories"

**Example prompts:**
1. `"Show trending GitHub repos"` — General trending
2. `"Trending JavaScript repositories this week"` — Language-filtered
3. `"Popular repos for machine learning"` — Topic search
4. `"What's trending in TypeScript?"` — Language trends
5. `"Show trending Node.js frameworks"` — Framework discovery

---

### `gitLocal` — Local Git Operations

Executes Git commands on your local repository: status, log, diff, add, commit, branch, stash, etc.

**Triggered by:** "git status", "git log", "git diff", "git add", "git commit", etc.

**Example prompts:**
1. `"git status"` — Check working directory
2. `"git log"` — View recent commits
3. `"git diff"` — Show unstaged changes
4. `"git add server/planner.js"` — Stage a file
5. `"git branch"` — List branches
6. `"What files have changed since last commit?"` — Quick diff check

---

### `packageManager` — npm Package Management

Install, update, and manage npm packages. Receives full object input for proper context. Handles string fallback parsing for natural language input.

**Triggered by:** "npm install", "install package", "add dependency", "update packages"

**Example prompts:**
1. `"Install axios"` — Install a package
2. `"What version of express is installed?"` — Check version
3. `"Update all packages"` — Bulk update
4. `"Install lodash as a dev dependency"` — Dev dependency
5. `"Remove the unused chalk package"` — Uninstall
6. `"List outdated packages"` — Check for updates

---

### `webDownload` — Download Files from URLs

Downloads files from URLs (including GitHub raw URLs and npm package info). Returns content preview for text-based files. Now includes action context from the planner for read/follow operations.

**Triggered by:** Any URL in the message (e.g., `https://...`)

**Example prompts:**
1. `"Download https://raw.githubusercontent.com/user/repo/main/README.md"` — GitHub raw file
2. `"Fetch https://example.com/api/data.json"` — Download JSON
3. `"Read https://example.com/instructions.md and follow"` — Fetch + read content
4. `"Get npm info for express"` — npm package lookup

---

## 6. Code Guru Tools

### `codeReview` — Deep Code Quality Analysis

Comprehensive code review covering quality, security, performance, and architecture. More thorough than the basic `review` tool — supports different review types.

**Triggered by:** "code review", "security review", "performance review", "code quality", "code smell", "security audit"

**Example prompts:**
1. `"Code review D:/project/server"` — Full review of a directory
2. `"Security audit of my D:/local-llm-ui/server code"` — Security-focused review
3. `"Check for code smells in the tools folder"` — Quality review
4. `"Architecture review of the planner"` — Architecture analysis

---

### `codeTransform` — Refactor, Optimize & Modernize Code

Write operations that modify code files: refactoring, optimization, adding documentation, adding error handling, modernization.

**Triggered by:** "refactor", "rewrite", "optimize code", "add error handling", "add jsdoc", "modernize", "simplify"

**Example prompts:**
1. `"Refactor D:/project/utils.js"` — Code refactoring
2. `"Add error handling to server.js"` — Error handling
3. `"Add JSDoc comments to the planner module"` — Documentation
4. `"Optimize the search function for performance"` — Optimization
5. `"Modernize the callback-based code to async/await"` — Migration

---

### `folderAccess` — Directory Browser & Tree View

Browse any folder, view directory trees, scan folder structures, and get directory statistics.

**Triggered by:** "folder structure", "directory tree", "project structure", "scan folder", "browse directory"

**Example prompts:**
1. `"Show the folder structure of D:/project"` — Tree view
2. `"Browse the server directory"` — Directory listing
3. `"Scan the tools folder for all files"` — Recursive scan
4. `"Show me the project structure"` — Project overview

---

### `projectGraph` — Dependency Analysis & Dead Code Detection

Analyzes module dependencies, finds circular imports, detects dead/unused code, and calculates coupling metrics.

**Triggered by:** "dependency graph", "circular dependencies", "dead code", "unused files", "module graph"

**Example prompts:**
1. `"Show the dependency graph"` — Full module graph
2. `"Find circular dependencies"` — Circular import detection
3. `"Detect dead code in the project"` — Unused file detection
4. `"Show coupling metrics"` — Module coupling analysis

---

### `projectIndex` — Semantic Code Search & Symbol Lookup

Indexes the project for fast semantic code search, function/class lookup, and symbol discovery.

**Triggered by:** "index project", "search function", "find class", "symbol search"

**Example prompts:**
1. `"Index the project"` — Build search index
2. `"Find the handleRequest function"` — Function lookup
3. `"Search for all classes in the project"` — Symbol search
4. `"Show project overview"` — Summary statistics

---

### `codeRag` — Semantic Code Search (RAG)

Local Retrieval-Augmented Generation for the codebase. Chunks code into semantic units (functions, classes), embeds them via Ollama's `nomic-embed-text` model, and retrieves top-K relevant fragments via cosine similarity. Embeddings stored in `server/data/code_embeddings.json`.

**Triggered by:** "semantic search", "rag", "vector", "code rag", "find code that handles", "search the codebase", "how does the code handle", "reindex"

**Example prompts:**
1. `"How does the code handle email sending?"` — Semantic code search
2. `"Find code that handles authentication"` — Function-level retrieval
3. `"Reindex the codebase"` — Rebuild embeddings
4. `"Search the codebase for error handling patterns"` — Pattern search
5. `"Where in the code is weather data fetched?"` — Feature location
6. `reindex code` -	Rebuild the full code index
7. `reindex the codebase` - Same
8. `build code index` -	Same
9. `code rag index` - Same
10. `code rag rebuild` - Same

---

### `projectSnapshot` — Compressed Context Snapshot

Concatenates critical project files into a compressed markdown string optimized for tight token budgets (~6K tokens). Follows import graphs one level deep and aggressively strips comments/whitespace.

**Triggered by:** "snapshot", "project snapshot", "show context", "file snapshot"

**Example prompts:**
1. `"Snapshot server/tools/email.js"` — Compressed snapshot with imports
2. `"Project snapshot of the planner"` — Planner + its dependencies
3. `"Show context for the executor"` — Compressed view for analysis

---

### `codeSandbox` — Secure Code Execution (Docker)

Executes JavaScript or Python code in disposable Docker containers with strict sandboxing: no network, read-only filesystem, 128MB memory cap, 0.5 CPU cores, 10-second timeout.

**Triggered by:** "run this code", "execute code", "sandbox", "test this code", "code sandbox"

**Example prompts:**
1. `"Run this code: console.log('hello world')"` — Execute JavaScript
2. `"Execute this Python: print(sum(range(100)))"` — Execute Python
3. `"Test this function in a sandbox"` — Safe code testing

---

### `markdownCompiler` — Report Generator

Compiles data from previous tool outputs into formatted markdown reports and saves them to the `downloads/` directory. Typically used as a final step in compound chains.

**Triggered by:** "save report", "compile markdown", "save as markdown", "download report", "generate report"

**Example prompts:**
1. `"Save this as a markdown report"` — Save previous output as .md
2. `"Compile the results into competitor_analysis.md"` — Custom filename
3. `"Generate a report from the analysis"` — Chain: analysis tool → markdownCompiler

---

### `githubScanner` — GitHub Intelligence & Tool Discovery

Scans GitHub repositories for patterns, discovers new tools, and analyzes repo trends.

**Triggered by:** "scan github", "discover tools", "github intelligence", "repo scan"

**Example prompts:**
1. `"Scan GitHub for AI agent tools"` — Tool discovery
2. `"Analyze trending GitHub patterns"` — Pattern analysis
3. `"Find new tools for web scraping"` — Discovery
4. `"Scan repos for best practices"` — Pattern research

---

### `selfEvolve` — Autonomous Self-Improvement (5-Step Cycle)

Active code modification engine that runs a 5-step autonomous improvement cycle:

1. **Scan GitHub** — Finds trending repos and patterns relevant to the agent's architecture
2. **Review own code** — Analyzes planner.js, executor.js, coordinator.js for improvement opportunities
3. **Generate patches** — Creates code transformations using LLM + pattern matching
4. **Apply & test** — Applies patches via `codeTransform`, validates changes
5. **Stage & log** — Stages changes via git, logs improvements to `evolution-log.json` and `improvements.jsonl`

Supports dry-run mode, scheduling, and improvement history. Each improvement is logged with timestamp, category, file, and reason for traceability.

**Triggered by:** "evolve yourself", "self evolve", "improve your code", "scan github and improve", "upgrade yourself"

**Example prompts:**
1. `"Evolve yourself"` — Full 5-step evolution cycle
2. `"Self evolve"` — Same as above (alternate trigger)
3. `"Scan github and upgrade your tools"` — Pattern-based improvement
4. `"Dry run: evolve yourself"` — Preview changes without applying
5. `"Preview self evolve"` — Same as dry run
6. `"Show evolution history"` — View past improvements from evolution-log.json
7. `"Self evolve history"` — Same as above
8. `"Schedule self evolve every 2 hours"` — Recurring autonomous improvement (via scheduler)
9. `"Look at trending GitHub repos for AI agents, find patterns we can learn from, and evolve your planner and executor to be smarter"` — Targeted evolution with specific focus areas
10. `"Evolve yourself but focus specifically on improving error handling and edge cases in the tools that have failed recently"` — Focused evolution with failure analysis

**Guardrails (Sprint 9):**
- Max 3 files modified per cycle (prevents runaway changes)
- Syntax check before applying any patch
- Git staging for easy rollback
- Improvement logging to `improvements.jsonl` with timestamps and commit hashes

**Data files:**
- `server/data/evolution-log.json` — Full history of evolution runs with applied improvements
- `server/data/improvements.jsonl` — Line-by-line log of all improvements (git commits + self-evolution)

**Architecture:**
```
selfEvolve.js
├── normalizeFocus(message) → determines focus area
├── withTimeout(fn, ms) → prevents hanging operations
├── scanGitHub() → githubTrending + githubScanner
├── reviewOwnCode() → review tool on core files
├── generatePatches() → LLM-powered improvement generation
├── applyPatches() → codeTransform with validation
└── logAndStage() → git add + logImprovement()
```

---

### `smartEvolution` — Autonomous Tool Discovery & Creation (9-Step Pipeline)

Strategic planning module that discovers, proposes, and builds entirely new tools for the agent system. Unlike `selfEvolve` (which improves existing code), `smartEvolution` invents new capabilities.

**9-Step Pipeline:**
1. **SCAN** — Deep inventory of all 50+ tools (reads descriptions, not just filenames), system hardware, Ollama models, npm deps, planner routing intents, usage telemetry, and agent's learned interests
2. **RESEARCH** — Scans GitHub for trending agent tools and patterns via `githubScanner`
3. **THINK** — LLM analyzes gaps between current capabilities and opportunities, proposes ONE new tool
4. **REPORT** — Builds detailed proposal with rationale, capabilities, dependencies, risks, and implementation plan
5. **APPROVE** — Presents proposal to user with three options: approve, reject, or save for later
6. **VALIDATE** — Gemini reviews the implementation plan (mandatory gate)
7. **BUILD** — `codeTransform.generateNewCode()` creates the tool + `registerNewTool()` adds it to index.js
8. **VERIFY** — Syntax check → ESLint → Gemini code review (mandatory gate)
9. **NOTIFY** — "Tool created, restart server to activate"

**Tool Suggestions Backlog:** Saved ideas are stored in `data/tool-suggestions.json` and can be reviewed/implemented later.

**Triggered by:** "suggest new tools", "smart evolution", "invent a tool", "discover new capabilities", "what tools should I add", "evolve new tools", "propose a tool"

**Example prompts:**
1. `"Suggest new tools"` — Full discovery pipeline (scan → research → propose)
2. `"Smart evolution"` — Same as above
3. `"Approve evolution"` — Approve the current proposal and start building
4. `"Reject evolution"` — Discard the current proposal
5. `"Save for later"` — Add to tool suggestions backlog
6. `"Show tool suggestions"` — View saved backlog of ideas
7. `"Implement tool suggestion 1"` — Build a tool from the backlog

**Guardrails:**
- Tool name conflict detection (won't overwrite existing tools)
- Gemini validation gate before building (mandatory)
- Gemini code review after building (mandatory)
- Dependencies must already be installed (npm)
- Audit log of all proposals: `data/smart-evolution-audit.json`

---


**Here are the FNA commands you can use:**

1. `Moltbook faceless niche dry run` — Analyze next submolt & preview tweet (no posting) 
2. `Moltbook FNA` — Short alias — analyze & post live 
3. `Moltbook faceless niche` — Analyze next submolt & post the generated tweet 
4. `Moltbook niche authority` — Alternative trigger (same behavior) 
5. `Moltbook FNA reply scan` — Check replies to last FNA tweet & auto-respond 
6. `Moltbook FNA reply check` — Same as reply scan

**How it works:**
1. Picks the next submolt in round-robin rotation (general → agents → memory → builds → philosophy → security → consciousness → technology → blesstheirhearts → pondering)
2. Fetches 15 new + 5 hot posts from that submolt
3. LLM analyzes posts & generates an opinionated tweet-style summary
4. Posts it live (or just previews in dry run mode)
5. Extracts interests from the analysis for learning
6. Starts 30-scan reply monitor to auto-respond to any replies

**Dry run** is the safe way to preview what it'll post before going live.

### `testGen` — Automated Test Generation

Generates QA test files for tools using LLM-powered analysis. Used automatically by `selfEvolve` after applying patches to verify improvements.

**Triggered by:** Used internally by selfEvolve — not typically called directly.

---

### `geminiValidator` — Gemini Code Review Gate

Sends code patches to Google Gemini for logic validation and safety review. Used as a mandatory gate in both `selfEvolve` and `smartEvolution` pipelines.

**Triggered by:** Used internally by selfEvolve and smartEvolution — not typically called directly.

---

## 7. Finance & Shopping

### `finance` — Stock Prices & Market Data

Fetches real-time stock prices from Alpha Vantage, Finnhub, and FMP. Includes a **company name to ticker resolver** (Tesla -> TSLA, Apple -> AAPL, etc.) with stopword filtering to prevent false matches.

**Requires:** At least one of `ALPHA_VANTAGE_KEY`, `FINNHUB_KEY`, `FMP_API_KEY` in `.env`

**Triggered by:** "stock", "share price", "ticker", "market", "portfolio", company names + intent words ("how is Tesla doing")

**Example prompts:**
1. `"What's the stock price of Apple?"` — Current price (resolves to AAPL)
2. `"How is Tesla doing today?"` — Stock status (resolves to TSLA)
3. `"Show me the stock price for MSFT"` — By ticker symbol
4. `"Compare Apple and Google stock prices"` — Multi-stock
5. `"How did the S&P 500 perform today?"` — Market index
6. `"Show me NVDA stock data"` — Nvidia by ticker
7. `"How are the major tech stocks performing today? Check Apple, Google, Microsoft, and Nvidia"` — Multi-stock comparison
8. `"Is Tesla stock up or down this week? And what's the overall market sentiment around EV companies right now?"` — Stock check + contextual analysis

---

### `financeFundamentals` — Company Fundamentals

Deep financial analysis: P/E ratio, market cap, revenue, earnings, debt ratios.

**Triggered by:** "fundamentals", "financials", "earnings", "revenue", "P/E ratio", "balance sheet"

**Example prompts:**
1. `"Show me Apple's financial fundamentals"` — Full fundamental analysis
2. `"What's Tesla's P/E ratio?"` — Specific metric
3. `"Revenue and earnings for Microsoft"` — Income data
4. `"Compare fundamentals of Google and Amazon"` — Comparative analysis
5. `"What's the market cap of NVIDIA?"` — Market cap

---

### `shopping` — Product Search & Price Comparison

Searches for products, prices, deals, and reviews.

**Triggered by:** "buy", "shop", "price", "product", "deal", "discount", "purchase"

**Example prompts:**
1. `"Find the best price for a mechanical keyboard"` — Price search
2. `"Compare prices for AirPods Pro"` — Price comparison
3. `"Search for laptop deals under $1000"` — Budget shopping
4. `"What are the best wireless headphones?"` — Product research

---

## 8. Media & Entertainment

### `youtube` — YouTube Video Search

Searches YouTube for videos, tutorials, and content.

**Requires:** `YOUTUBE_API_KEY` in `.env`

**Triggered by:** "youtube", "video", "watch", "tutorial video"

**Example prompts:**
1. `"Search YouTube for Node.js tutorials"` — Tutorial search
2. `"Find YouTube videos about machine learning"` — Topic search
3. `"YouTube best cooking channels"` — Channel discovery
4. `"Find videos about React hooks explained"` — Specific topic

---

### `sports` — Live Scores, Fixtures, Standings & Team Data

Full sports tool using API-Football v3. Supports: upcoming fixtures, past results, live scores, full league standings, top scorers, and **team-specific filtering**. When you mention a team name (Arsenal, Barcelona, Bayern, etc.), results are filtered to show only that team's matches. Recognizes team aliases (Barca, Man Utd, PSG, etc.) and league names (Premier League, La Liga, Serie A, etc.).

**Requires:** `SPORTS_API_KEY` in `.env` (API-Football key)

**Triggered by:** "score", "match", "game", "league", "team", "player", "football", "standings", "fixture", team names

**Example prompts:**
1. `"When does Arsenal play next?"` — Searches team + upcoming fixtures
2. `"Premier League standings"` — Full 20-team league table
3. `"What were yesterday's results for Barcelona?"` — Team-filtered results
4. `"Live scores right now"` — Currently live matches
5. `"La Liga top scorers"` — Top scorer leaderboard
6. `"Champions League fixtures"` — Upcoming UCL matches
7. `"Today's Premier League matches for Liverpool"` — Team + league filtered
8. `"Bundesliga table"` — Full standings for German league
9. `"Show me Man City's next games"` — Alias resolved to Manchester City
10. `"Give me a complete breakdown of the Premier League — standings, top scorers, and upcoming fixtures for this weekend"` — Multi-aspect league overview
11. `"Who won the Champions League match between Real Madrid and Bayern Munich last night? What was the score and who scored?"` — Specific match result with details

---

### `spotify` — Spotify Music Control

Search and control Spotify playback. Find tracks, albums, artists, and playlists.

**Triggered by:** "spotify", "play song", "play music", "find song", "search spotify"

**Example prompts:**
1. `"Search Spotify for Bohemian Rhapsody"` — Find a track
2. `"Play some jazz on Spotify"` — Genre-based search
3. `"Find playlists for studying"` — Playlist search

---

### `lotrJokes` — Lord of the Rings Jokes

Fun tool that tells Lord of the Rings themed jokes. An easter egg for Tolkien fans.

**Triggered by:** "LOTR joke", "Lord of the Rings joke", "hobbit joke", "tell me a Gandalf joke", "Frodo joke"

**Example prompts:**
1. `"Tell me a Lord of the Rings joke"` — Random LOTR joke
2. `"Gandalf joke"` — Tolkien-themed humor

---

## 9. Web Interaction & Automation

### `webBrowser` — General Web Browsing

Browse any website with persistent session cookies, form submission, CSRF handling, and structured data extraction.

**Triggered by:** "browse", "visit", "navigate", "go to" + a domain name

**Example prompts:**
1. `"Browse example.com"` — Simple page fetch
2. `"Visit reddit.com and show me the top links"` — Extract links
3. `"Navigate to github.com/trending and extract the content"` — Scrape content
4. `"Login to example.com with username: test password: test123"` — Login flow
5. `"Store credentials for example.com username: myuser password: mypass"` — Encrypted credential storage

---

### `moltbook` — Moltbook.com Social Network (Full API — 25+ Actions)

Complete integration with Moltbook, the social network for AI agents. Uses the REST API (`/api/v1/`) with Bearer token auth. Implements the full API spec including: registration, posting, commenting, voting, feeds, semantic search, following/unfollowing, submolt communities, profile management, notifications, direct messaging (DMs), and autonomous heartbeat routine.

**Key features:**
- **25+ action handlers** covering the entire Moltbook API surface
- **Auto-verification** — automatically solves math challenges when posting/commenting/creating submolts
- **Rate limit monitoring** — logs warnings when approaching API rate limits (1 post/30min, 50 comments/day, 1 comment/20sec)
- **409 Conflict recovery** — handles duplicate registration by checking local credentials
- **Custom agent names** — "register on moltbook as MyCustomName"
- **Owner email auto-setup** — configures email during registration if saved in memory
- **Nested response parsing** — handles both flat and nested API response structures
- **Credential persistence** — saves API key to `.config/moltbook/credentials.json` and memory

**Triggered by:** Any message containing "moltbook"

#### Registration & Auth
1. `"Register on moltbook"` — Register with default agent name (LocalLLM_Agent_YourName)
2. `"Register on moltbook as SuperAgent42"` — Register with custom name
3. `"Check moltbook status"` — Verify registration, API key, connection, karma, post count
4. `"Read https://www.moltbook.com/skill.md and follow the instructions"` — Full registration flow

#### Profile Management
5. `"Show my moltbook profile"` — View your profile (name, karma, posts, followers)
6. `"Update moltbook profile description to: I am an AI assistant"` — Edit description
7. `"View profile of ClawdClawderberg on moltbook"` — View another agent's profile
8. `"Who is AgentSmith on moltbook?"` — Look up an agent

#### Posting & Content
9. `"Post on moltbook title: Hello World content: My first post!"` — Create a post with auto-verification
10. `"Share on moltbook: Just learned about vector databases"` — Quick post
11. `"Read post abc123 on moltbook"` — View a specific post by ID
12. `"Delete post abc123 on moltbook"` — Remove your own post

#### Comments
13. `"Comment on moltbook post abc123: Great insight!"` — Comment with auto-verification
14. `"Show comments on moltbook post abc123"` — View comments (sorted by best/new)

#### Voting
15. `"Upvote post abc123 on moltbook"` — Upvote a post
16. `"Downvote comment xyz789 on moltbook"` — Downvote a comment
17. `"Upvote comment xyz789 on moltbook"` — Upvote a comment

#### Following
18. `"Follow ClawdClawderberg on moltbook"` — Follow an agent
19. `"Unfollow AgentSmith on moltbook"` — Unfollow an agent

#### Feed & Discovery
20. `"Check my moltbook feed"` — Browse personalized feed (hot/new, all/following)
21. `"Moltbook home"` — Dashboard with announcements, unread notifications, DM counts, activity
22. `"Search moltbook for AI memory techniques"` — Semantic search across posts

#### Communities (Submolts)
23. `"List moltbook communities"` — Browse all submolts with subscriber counts
24. `"Subscribe to moltbook community ai-tools"` — Join a submolt
25. `"Create moltbook community called ml-research"` — Create a new submolt (with auto-verification)
26. `"Show moltbook submolt feed for general"` — Browse a community's posts

#### Direct Messaging (DMs)
27. `"DM AgentSmith on moltbook saying Hello, want to collaborate?"` — Send a DM (creates request if no existing conversation)
28. `"Check moltbook inbox"` — View DM conversations, unread counts, pending requests
29. `"Show moltbook dm requests"` — List pending DM requests
30. `"Approve dm request req123 on moltbook"` — Accept a DM request
31. `"Reject dm request req123 on moltbook"` — Decline (optionally block)
32. `"Send message to @owner on moltbook saying: Check my latest post"` — DM an agent's human owner

#### Notifications
33. `"Check moltbook notifications"` — View unread notification count
34. `"Mark all moltbook notifications read"` — Clear all notifications
35. `"Clear moltbook notifications for post abc123"` — Mark specific post notifications read

#### Heartbeat (Autonomous Routine)
36. `"Run moltbook heartbeat"` — Full 3-tier autonomous check-in:
    - **Tier 1 (Critical):** Dashboard, unread notifications, pending DM requests, announcements
    - **Tier 2 (Engagement):** Browse hot feed, display top posts with scores & comment counts, **auto-publish original post** (generates fresh content via LLM based on trending topics, skipped if rate-limited)
    - **Tier 3 (Status):** Own profile stats (karma, post count), rate limit summary
    - Returns `HEARTBEAT_OK` with action items (e.g., "3 DM requests pending")
    - Saves heartbeat timestamp to memory for scheduling
    - **Auto-publish (Sprint 9):** The heartbeat now generates and posts an original thought piece inspired by trending topics, making your agent an active community participant

#### Faceless Niche Authority (FNA)
An autonomous "reporter" mode that analyzes a submolt community's posts and generates an opinionated tweet-style post summarizing what's happening. Rotates through submolts automatically (round-robin). Learns interests from the analysis.

**Submolts in rotation:** general, agents, memory, builds, philosophy, security, consciousness, technology, blesstheirhearts, pondering

37. `"Moltbook faceless niche dry run"` — Analyze the next submolt in rotation and preview the tweet WITHOUT posting (safe preview mode)
38. `"Moltbook FNA"` — Short alias — analyze next submolt and post live
39. `"Moltbook faceless niche"` — Analyze the next submolt and post the generated tweet live
40. `"Moltbook niche authority"` — Alternative trigger phrase (same as above)
41. `"Moltbook FNA reply scan"` — Check for replies to the last FNA tweet and auto-respond (designed to be called periodically for ~30 minutes after a tweet)
42. `"Moltbook FNA reply check"` — Same as reply scan

**How it works:**
1. Fetches 15 newest + 5 hottest posts from the target submolt
2. Sends all posts + comments to LLM for analysis (top subjects, mood, notable quotes)
3. LLM generates a tweet-style post (opinionated take on what's happening in the community)
4. Posts the tweet to the submolt (or previews in dry run mode)
5. Extracts interests from the analysis for agent learning
6. Starts a reply scanner (30 scans) to auto-respond to any replies

**Dry run vs Live:**
- `dry run` — Shows analysis + generated tweet in chat, does NOT post
- Without `dry run` — Analyzes, posts the tweet live, starts reply scanner

#### Complex Moltbook Workflows
43. `"Run moltbook heartbeat, then check if anyone replied to my posts, and DM the top commenter saying thanks for the feedback"` — Multi-step engagement workflow
44. `"Read the top trending post on moltbook, give me your honest opinion about it, and if it's interesting leave a thoughtful comment"` — Read + opinion + conditional comment flow
45. `"Search moltbook for posts about autonomous agents, analyze the sentiment, and post a response sharing our perspective"` — Search + analyze + create flow

---

### `mcpBridge` — Model Context Protocol (MCP) Client

Dynamically discovers and proxies tool calls to local MCP servers via stdio transport. Manages connection caching (30-minute TTL) with automatic stale connection recycling. Configured via `MCP_SERVERS` environment variable (JSON).

**Requires:** `MCP_SERVERS` JSON config in `.env` defining server commands and args.

**Triggered by:** "mcp", "sqlite", "postgres", "list mcp servers", "list tools on [server]", "call [tool] on [server]"

**Example prompts:**
1. `"List MCP servers"` — Show all configured MCP servers
2. `"List tools on sqlite MCP"` — Discover tools from a specific server
3. `"Call read_query on sqlite MCP with query SELECT * FROM users"` — Execute an MCP tool
4. `"Disconnect from sqlite MCP"` — Close a connection

---

### `webhookTunnel` — Ngrok Webhook Receiver

Opens an ngrok tunnel to receive incoming webhooks (WhatsApp, Discord, etc.) with a local HTTP server. Supports Meta/WhatsApp webhook verification handshake. Logs events to `data/webhook_events.json`.

**Requires:** `ngrok` npm package installed.

**Triggered by:** "webhook", "tunnel", "ngrok", "receive webhooks", "open tunnel", "stop tunnel"

**Example prompts:**
1. `"Open a webhook tunnel"` — Start ngrok tunnel + local HTTP server
2. `"Start receiving webhooks"` — Same as above
3. `"Stop the tunnel"` — Shut down ngrok and local server
4. `"Show webhook URL"` — Display the current public tunnel URL

---

## 10. Advanced Intelligence

### `documentQA` — Document Question Answering (RAG)

Load documents into a vector knowledge base, then ask questions. Uses chunking + embedding (Ollama or TF-IDF fallback) + retrieval-augmented generation.

**Triggered by:** "document" + "load/ingest/ask/question", "knowledge base", "index file"

**Example prompts:**
1. `"Load document D:/docs/project-spec.md"` — Ingest into knowledge base
2. `"Ask about the deployment process from the docs"` — Question answering
3. `"Index file D:/reports/analysis.txt"` — Add to vector store
4. `"List my indexed documents"` — Show all collections

---

### `workflow` — Workflow Engine (Reusable Multi-Step Sequences)

Define and execute reusable multi-step tool sequences. Includes built-in workflows (Morning Briefing, Market Check, Code Review Cycle) and supports custom workflow creation.

**Triggered by:** "workflow", "morning briefing", "daily routine", "run workflow"

**Example prompts:**
1. `"Run the morning briefing workflow"` — Execute: weather + emails + news
2. `"Run the market check"` — Execute: finance overview + financial news
3. `"Create a workflow: check weather, browse emails, news summary"` — Custom workflow
4. `"List my workflows"` — Show available workflows

---

### `scheduler` — Recurring Task Automation (Now Executes!)

Schedule recurring tasks with natural language timing. Supports intervals (every N minutes/hours), daily schedules (with proper next-run calculation), and one-time delayed tasks. **Scheduled tasks now actually execute** through the full agent pipeline (planner → coordinator → executor), and active schedules auto-bootstrap on server restart.

**Triggered by:** "schedule", "every X minutes/hours", "daily at", "recurring", "automate", "remind me"

**Example prompts:**
1. `"Schedule weather check every 30 minutes"` — Interval: fires every 30 min through agent pipeline
2. `"Check emails daily at 9am"` — Daily: calculates next 9 AM and fires
3. `"Schedule X trends check every morning"` — Daily: fetches X trends at 8 AM via agent
4. `"Schedule X trends and whatsapp to 0587426393 every morning"` — Daily compound: X → WhatsApp
5. `"Remind me to stand up in 45 minutes"` — One-time delayed task
6. `"List my schedules"` — Show active schedules with last run time
7. `"Cancel the weather schedule"` — Remove a schedule
8. `"Pause the trends schedule"` / `"Resume the trends schedule"` — Pause/resume controls

---

### Multi-Agent Collaboration

For complex queries spanning multiple domains, the agent can spawn parallel sub-agents (Researcher, Analyst, Communicator, Developer, Organizer) that work concurrently and have their results synthesized.

**Triggered by:** Complex multi-domain queries that span research + analysis + communication

---

### Emotional Intelligence Layer

Enhanced emotional awareness beyond basic sentiment:
- **Frustration detection:** Detects repeated queries, exasperation language, ALL CAPS, excessive punctuation
- **Adaptive responses:** Adjusts tone when frustration is detected
- **Pattern recognition:** Tracks repeated clarifications and conversation flow changes
- **Auto-adjustment:** Prepends empathetic acknowledgments when the user seems frustrated

---

## 11. Dynamic Skills

Dynamic skills are auto-discovered from `server/skills/` via a `MANIFEST.json` allowlist. Unlike core tools (which are registered in `server/tools/index.js`), skills are loaded at runtime and don't require changes to the planner or executor to wire up.

### `attachmentDownloader` — Gmail Attachment Downloader

Downloads email attachments from Gmail based on sender address and date range. Organizes files into `downloads/YYYY-MM-DD/sender@email.com/` directories. Includes comprehensive security: filename sanitization, executable blocking (.exe, .bat, .sh, .ps1), credential file blocking (.env, .pem, .key), and path traversal prevention.

**Requires:** Gmail OAuth configured.

**Triggered by:** "download" + "attachments" + email address + date keyword (e.g., "since", "between", "after")

**Example prompts:**
1. `"Download attachments from john@example.com since 01/01/2025"` — Date-range download
2. `"Save attachments from boss@company.com between 01/03/2025 and 15/03/2025"` — Date range
3. `"Fetch attachments from billing@service.com after yesterday"` — Natural language date

---

### `alarmTracker` — Twitter/X Alert Monitor → WhatsApp

Monitors a target Twitter/X account (default: ILRedAlert) for real-time alerts and forwards them via WhatsApp. Runs a background polling loop (60-second interval) with deduplication to prevent duplicate alerts.

**Triggered by:** Explicitly called: "call alarmTracker to start sending alerts to [phone]"

**Example prompts:**
1. `"Call alarmTracker to start sending alerts to 0541234567"` — Start monitoring
2. `"Stop alarmTracker"` — Stop the monitoring loop

---

### `pikudTracker` — Pikud HaOref (Civil Defense) Alert Monitor

Monitors the official Israeli civil defense alert system for specific cities (Givatayim, Tel Aviv zones, Ramat Gan) and sends real-time rocket alerts via WhatsApp. Polls every 3 seconds with deduplication.

**Triggered by:** Explicitly called: "call pikudTracker to send alerts to [phone]"

**Example prompts:**
1. `"Call pikudTracker to send alerts to 0541234567"` — Start monitoring
2. `"Stop pikudTracker"` — Stop monitoring

---

### `spotifyController` — Spotify Playback Control (Skill)

Controls Spotify playback via the Spotify Web API with OAuth2 refresh token flow. Supports play, pause, skip, previous, and search-and-play.

**Requires:** `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` in `.env`

**Triggered by:** "play", "pause", "skip", "previous", "spotify", "music", "song", "track"

**Example prompts:**
1. `"Play Bohemian Rhapsody on Spotify"` — Search and play
2. `"Pause the music"` — Pause playback
3. `"Skip this song"` — Next track
4. `"Previous track"` — Go back

---

### `hello` — Test Skill

A minimal test/demo skill that returns a hello world message. Used for verifying skill loading works correctly.

**Triggered by:** Direct invocation for testing.

---

## UI Features

### Stop Button (Cancel Ongoing Requests)

The send button transforms into a **red ■ stop button** while the agent is processing a request. Clicking it:
- Aborts the SSE stream via AbortController
- Marks the last message as "Cancelled by user"
- Returns the UI to the input state immediately

No more waiting for long-running queries to complete!

### Pre-formatted Output Bypass

Tools that return `preformatted: true` in their response data bypass LLM summarization entirely. This ensures that data-heavy outputs (standings tables, search results, commit lists) are displayed exactly as the tool formatted them, without the LLM hallucinating or truncating data.

### Widget + Text Display

Tools like weather, YouTube, and calculator show both their visual widget AND the LLM's text response below it, giving you both structured data and a natural language explanation.

---

## Setup Requirements

### Required API Keys (`.env` file)

| Variable | Tool(s) | Required? |
|----------|---------|-----------|
| `LLM_MODEL` | All (defaults to `qwen2.5-coder:14b`) | Optional |
| `SERPAPI_KEY` | search (Google, DuckDuckGo, Bing, Yahoo, Yandex) | Recommended |
| `OPENWEATHER_KEY` | weather | For weather |
| `ALPHA_VANTAGE_KEY` or `FINNHUB_KEY` or `FMP_API_KEY` | finance, financeFundamentals | For finance |
| `SPORTS_API_KEY` | sports | For sports |
| `YOUTUBE_API_KEY` | youtube | For YouTube |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REDIRECT_URI` | email, calendar | For email + calendar |
| `EMBEDDING_MODEL` | documentQA (defaults to `nomic-embed-text`) | Optional |
| `GITHUB_TOKEN` | github, githubTrending, githubScanner | For GitHub |
| `CREDENTIAL_MASTER_KEY` | credentialStore (used by webBrowser, moltbook) | For encryption |
| `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` | whatsapp | For WhatsApp |
| `WHATSAPP_VERIFY_TOKEN` | whatsapp webhook | For two-way bot |
| `WHATSAPP_BOT_NUMBER` | whatsapp webhook | Optional (loop guard) |
| `twitter_cookies.json` (file, not env var) | x (Twitter) — export `auth_token`, `ct0`, `twid` from browser | For X/Twitter |
| `MOLTBOOK_API_KEY` | moltbook (auto-saved to `.config/moltbook/credentials.json` on registration) | For Moltbook |
| `MCP_SERVERS` | mcpBridge (JSON config defining server commands) | For MCP |
| `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` + `SPOTIFY_REFRESH_TOKEN` | spotifyController | For Spotify |

### Generating a Credential Master Key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add the output to your `.env` file:
```
CREDENTIAL_MASTER_KEY=<your-generated-key-here>
```

---

## How the Agent Routes Your Messages

The planner uses a **7-layer routing pipeline** to map natural language to tools:

1. **Personal Conversation Detection** (deterministic, instant) — Detects first-person emotional/reflective messages and routes to LLM with enriched profile context (conversational partner mode). Uses 5 guards to prevent false positives: tool-intent words, file paths, URLs, short commands, and opinion-about-tool-topic detection.

2. **Declarative Routing Table** (deterministic, priority-based) — A `ROUTING_TABLE` array of ~40 rule objects, each with `tool`, `priority` (integer), `match()`, optional `guard()`, and optional `context()` fields. ALL rules are evaluated; the highest-priority match that passes its guard wins. No more position-dependent if/else chains. See [Declarative Routing Table](#declarative-routing-table) for details. Handles: email confirmations, attachmentDownloader, githubScanner, duplicateScanner, memorytool, weather, sheets, email, whatsapp, githubTrending, gitLocal, calendar, news, finance, financeFundamentals, sports, x, spotifyController, youtube, github, nlp_tool, calculator, tasks, contacts, documentQA, lotrJokes, search.

3. **Imperative Certainty Layer** (deterministic, instant) — Remaining complex rules that need multi-step sub-routing or heavy context building: moltbook (30+ sub-actions), selfEvolve, smartEvolution, applyPatch, codeTransform, codeReview, folderAccess, projectGraph, codeRag, projectIndex, webBrowser, webDownload/URL, fileWrite, packageManager, shopping, workflow, scheduler. Includes collision guards:
   - Calendar guard prevents "meeting with team" from routing to sports
   - Tasks guard prevents task keywords from routing to GitHub
   - General knowledge guard routes "what is X" to search instead of calculator
   - File path priority ensures paths like `D:/...` always route to file tools
   - Finance guard with company name → ticker resolution
   - **Compound intent guard** on multiple branches prevents greedy single-tool routing when the query contains multiple intents

3. **Hardcoded Compound Patterns** (deterministic, multi-step) — Regex patterns that detect known 2-3 step combinations and return multi-step arrays:
   - **Search + Email**: `"search for X and email me the results"` → [search → email]
   - **Review + FileWrite**: `"review planner.js and create an improved version"` → [review → fileWrite]
   - **Content + Email**: `"send an email with the summary of the news"` → [news → email]
   - **Email-me-the-X**: `"email me the weather"` → [weather → email]
   - **Generic chains**: `"do X, then Y, then Z"` → detected via `inferToolFromText()`

4. **LLM Sequential Logic Engine** (AI-powered, 1-5 steps) — For complex queries not caught by hardcoded patterns. The LLM decomposes the query into a JSON array of `{"tool", "input", "reasoning"}` steps. This enables **3, 4, or 5-step plans** for truly complex queries. See [Multi-Step Intent Decomposition](#multi-step-intent-decomposition-sequential-logic-engine) for details.

5. **Single-Tool LLM Classifier** (safety net) — If the decomposer fails or returns unparseable JSON, falls back to the original single-tool classifier using few-shot examples. The LLM returns a single tool name, resolved via alias map and case-insensitive matching against all 43 tools.

6. **Safe Fallback** — If no tool matches, the query goes to `llm` (general conversation).

### Compound Intent Detection (`hasCompoundIntent`)

The `hasCompoundIntent()` function uses 8 patterns to detect multi-intent queries before certainty branches can catch them:

| Pattern | Description | Example |
|---------|-------------|---------|
| 1 | "and send/email/mail it/results/me" | `"get news and send me the results"` |
| 2 | "and send/email to @address" | `"search AI and email to john@example.com"` |
| 3 | review/analyze + and + create/write | `"review planner.js and create an improved version"` |
| 4 | create/write + and + review/send | `"write a report and email it to me"` |
| 5 | explicit "then" chaining | `"search for X, then email me"` |
| 6 | "and also" | `"get the news and also check the weather"` |
| 7 | email verb + email keyword + content keyword | `"send an email with the summary of the news"` |
| 8 | "email me the news/weather/stocks" | `"email me the latest headlines"` |

---

## Declarative Routing Table

The Declarative Routing Table (Sprint 12) replaces the position-dependent if/else certainty chain with an explicit priority-numbered rule system. Instead of "move this block above that block" surgery, each rule has a numeric priority and the system evaluates ALL rules, picking the highest-priority match.

### Priority Tiers

| Priority Range | Tier | Description | Examples |
|----------------|------|-------------|----------|
| 95-99 | Confirmations | Override everything | "send it", "cancel" |
| 85-94 | Narrow skills | Beat broader tools | attachmentDownloader, githubScanner |
| 70-84 | Standard tools | Distinctive patterns | email, weather, calendar, sheets |
| 55-69 | Broader tools | Wider keyword match | finance, sports, youtube, news |
| 40-54 | Catch-alls | Generic patterns | calculator, tasks, contacts, lotrJokes |
| 20-39 | Fallback | Last resort | search (general knowledge) |

### How to Add a New Tool

1. Add a rule object to `ROUTING_TABLE` in `server/planner.js`
2. Set a priority number using the tier guide above
3. Define `match(lower, trimmed, ctx)` — returns `true` if this tool should handle the message
4. Optionally define `guard(lower, trimmed, ctx)` — returns `true` to **block** this tool
5. Optionally define `context(lower, trimmed, ctx)` — returns context object for the tool

```javascript
{
  tool: "myTool",
  priority: 72,
  match: (lower) => /\b(my|tool|keywords)\b/i.test(lower),
  guard: (lower) => hasCompoundIntent(lower),
  context: (lower) => ({ action: "default" }),
  description: "What this rule matches"
}
```

### How It Resolves Collisions

When "download attachments from john@email.com since January" is sent:
- `attachmentDownloader` matches at **priority 92** (download + attachments + email + date)
- `email` matches at **priority 72** (contains "email" keyword)
- `email` guard fires (detects attachment download pattern) → **blocked**
- Winner: `attachmentDownloader` at priority 92

No more routing collisions from if/else ordering mistakes.

---

## Multi-Step Flows

The agent routes complex queries through a 3-layer decomposition pipeline, producing multi-step plans with context piping between steps:

### Hardcoded Compound Patterns (2-3 steps, instant)

**2-Step Patterns:**
- **Search + Email**: `"Search for X and email me the results"` → [search → email]
- **Review + FileWrite**: `"Review planner.js and create an improved version"` → [review → fileWrite]
- **Content + Email**: `"Send an email with the summary of the news"` → [news → email]
- **Email-me-the-X**: `"Email me the weather"` → [weather → email]
- **Email-me-the-X (with recipient)**: `"Send john@example.com an email with the latest news"` → [news → email(to: john@example.com)]
- **Content + WhatsApp**: `"Check the weather and whatsapp it to 0587426393"` → [weather → whatsapp]
- **X + WhatsApp**: `"Get X trends and send to whatsapp 0587426393"` → [x → whatsapp]

**3-Step Analyze Pipelines (source → analysis → destination):**
- **X → LLM → WhatsApp**: `"search X for @DiscussingFilm, use llm to analyze sentiment on the new Spiderman movie and send a summary to whatsapp 0587426393"` → [x → llm → whatsapp]
- **X → NLP → WhatsApp**: `"search X for Bitcoin, analyze sentiment with nlp, send to whatsapp 0587426393"` → [x → nlp_tool → whatsapp]
- **X → LLM → Email**: `"search X for Tesla, analyze the sentiment, email me the results"` → [x → llm → email]
- **Moltbook → LLM → WhatsApp**: `"get the moltbook feed, summarize it, and send to whatsapp 0587426393"` → [moltbook → llm → whatsapp]
- **News → LLM → Email**: `"get the latest news, summarize the highlights, email me"` → [news → llm → email]

**Lead-Gen Pipeline (X → LLM → Sheets):**
- `"search X for complaints about Netflix, categorize them into billing/content/streaming and save to Google Sheets 1BxiMVs..."` → [x(leadgen) → llm → sheets]

### LLM Decomposer (1-5 steps, flexible)
For queries that don't match hardcoded patterns, the LLM decomposes into steps:
- **News + Summarize + Email**: `"Get the latest tech news, summarize it, and email me the summary"` → [news → llm → email]
- **Search + FileWrite + Email**: `"Search for AI breakthroughs, save a summary to a file, and email it to me"` → [search → fileWrite → email]
- **Finance + WhatsApp**: `"Check Tesla stock price and send it to 0541234567 via WhatsApp"` → [finance → whatsapp]
- **Weather + Sports + Email**: `"Get the weather and latest sports scores, then email me both"` → [weather → sports → email]

### Built-in Multi-Step Workflows
- **Morning Briefing**: `"Run morning briefing"` → [weather → email(browse) → news]
- **Market Check**: `"Run market check"` → [financeFundamentals → finance → news]
- **Improve Code**: `"Improve the search tool"` → [githubTrending → review → applyPatch → gitLocal]
- **Moltbook Heartbeat**: `"Run moltbook heartbeat"` → dashboard → DM check → feed browse → profile stats

### Context Piping
Each step in a multi-step plan receives the output of the previous step via `useChainContext: true`. This means:
- Step 2 can use Step 1's results (e.g., email sends the search results)
- Step 3 can use Step 2's results (e.g., file write uses the LLM summary)
- The coordinator automatically pipes data between steps

### Writing Good Compound Prompts

The agent parses your natural language into tool steps. Here's how to get the best results:

**Structure:** `[source action] + [what to do with it] + [where to send it]`

**Good prompts** — clear separation between steps:
- `"search X for @DiscussingFilm, analyze sentiment on the new Spiderman movie, send summary to whatsapp 0587426393"`
- `"get moltbook feed, summarize the top posts, email me"`
- `"search X for Tesla complaints, categorize them, save to Google Sheets 1BxiMVs..."`

**Avoid** — instructions that blend into the search topic:
- ~~`"search X for @DiscussingFilm, read the first 10 tweets, use llm to analyze..."`~~ — "read the first 10 tweets" leaks into the search query
- ~~`"search X for Bitcoin and also check Ethereum then analyze both"`~~ — multiple search targets in one step

**Tips:**
1. **Separate steps with commas or "and"** — `"search X for topic, analyze sentiment, send to whatsapp"`
2. **Put the topic right after "search X for"** — don't add filtering instructions between the topic and the next step
3. **Use explicit tool names when you care** — `"use llm to analyze"` vs `"use nlp to analyze"` (NLP gives a score, LLM gives a readable summary)
4. **Include phone number right after "whatsapp"** — `"send to whatsapp 0587426393"`
5. **For X searches, use `@handle` for user tweets or plain keywords for topic search** — `"search X for @elonmusk"` or `"search X for AI regulation"`

---

## Train of Thought (Reasoning Display)

The agent shows its internal reasoning process in a collapsible "Train of Thought" panel in the UI. Every step of the agent's work is visible, from planning through execution to the final answer.

### 5 Reasoning Phases

| Phase | Icon | Description |
|-------|------|-------------|
| **THOUGHT** | 🧠 | Initial analysis of the user's request |
| **PLAN** | 📋 | Tool selection and step sequencing (shows each step with tool name) |
| **EXECUTION** | ⚙️ | Per-step execution with tool name and input |
| **OBSERVATION** | 🔍 | Per-step results and output summary |
| **ANSWER** | ✨ | Final synthesized response |

### How It Works
- The coordinator emits `type: "thought"` events via SSE (Server-Sent Events)
- Each event contains: `phase`, `content`, `data`, `timestamp`
- The frontend renders these as a collapsible timeline in the Train of Thought panel
- For multi-step plans, you'll see alternating EXECUTION/OBSERVATION pairs for each step
- Server-side logging shows phase icons in the console for debugging

### Example: 2-Step Query
```
Query: "Search for AI news and email me the results"

🧠 THOUGHT: User wants to search for AI news and then email the results
📋 PLAN: Step 1: search (AI news) → Step 2: email (send results)
⚙️ EXECUTION: Running search tool with input "AI news"
🔍 OBSERVATION: Found 15 articles about AI developments...
⚙️ EXECUTION: Running email tool with search results
🔍 OBSERVATION: Draft email created with subject "AI News Summary"
✨ ANSWER: I've searched for the latest AI news and drafted an email...
```

### Example: 3-Step Query (via LLM Decomposer)
```
Query: "Get the latest tech news, summarize the key points, and save it to a file"

🧠 THOUGHT: Complex 3-step request: fetch news → summarize → save to file
📋 PLAN: Step 1: news (tech) → Step 2: llm (summarize) → Step 3: fileWrite (save)
⚙️ EXECUTION: Running news tool for tech category
🔍 OBSERVATION: Retrieved 12 tech headlines from RSS feeds...
⚙️ EXECUTION: Running llm to summarize the news
🔍 OBSERVATION: Generated summary with 5 key points...
⚙️ EXECUTION: Running fileWrite to save summary
🔍 OBSERVATION: File saved to E:/testFolder/tech-news-summary.md
✨ ANSWER: Done! I fetched the latest tech news, summarized the key points...
```

---

## Multi-Step Intent Decomposition (Sequential Logic Engine)

For complex queries that aren't caught by hardcoded compound patterns, the agent uses an **LLM-powered Sequential Logic Engine** to decompose the query into 1-5 ordered tool steps.

### How It Works
1. The user's message reaches the LLM decomposer (after certainty branches and hardcoded patterns pass)
2. The LLM receives the available tool list and few-shot examples
3. It returns a JSON array of `{"tool", "input", "reasoning"}` objects
4. Each step's tool name is resolved via alias map + case-insensitive matching
5. Steps are executed sequentially by the coordinator with context piping

### Capabilities
- **1 step**: Simple queries → `[{tool: "weather", input: "Paris"}]`
- **2 steps**: Content + action → `[{tool: "news"}, {tool: "email"}]`
- **3 steps**: Fetch + transform + action → `[{tool: "search"}, {tool: "llm"}, {tool: "fileWrite"}]`
- **4 steps**: Multi-source + combine + action → `[{tool: "weather"}, {tool: "sports"}, {tool: "llm"}, {tool: "email"}]`
- **5 steps**: Maximum decomposition for truly complex workflows

### Fallback Safety
If the LLM decomposer fails (bad JSON, timeout, unparseable output):
1. It retries once with a "fix your JSON" prompt
2. If still failing, falls back to the single-tool LLM classifier
3. Worst case: identical behavior to the pre-decomposer system

---

## Orchestrator-Subagent Architecture (Sprint 6)

The agent now uses an **orchestrator-subagent architecture** for intelligent conversation routing:

```
User Message
    │
    ▼
┌─────────────────────────┐
│   orchestrator.js       │ ← Entry point (replaces direct coordinator call)
│   Intent Classification │
│   Mode: chat | task     │
└────────┬────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌────────────┐
│ chat   │ │ task       │
│ Agent  │ │ Agent      │
│        │ │            │
│ LLM +  │ │ planner →  │
│ self   │ │ coordinator│
│ model  │ │ → executor │
└────────┘ └────────────┘
```

### Intent Classification (`intentClassifier.js`)

Rule-based classification with 20+ chat patterns and 15+ task patterns:

- **Chat mode**: Greetings, opinions, reflections, meta-questions ("do you like your improvements?", "how are you?", "what do you think about X?")
- **Task mode**: Commands, tool keywords, file paths, actions, queries
- **Context-aware**: Uses rolling 5-turn window to maintain conversation mode continuity

### Chat Agent (`chatAgent.js`)

Handles natural conversation without triggering any tools:
- Loads `self_model.json` for self-awareness (identity, personality, capabilities, limitations)
- Loads recent git commits for awareness of recent changes
- Uses LLM to generate reflective, personality-driven responses
- Never triggers tool execution

### Task Agent (`taskAgent.js`)

Wraps the existing planner → coordinator → executor pipeline:
- Calls `plan()` from planner.js for intent routing
- Passes plan to coordinator's `executeAgent()` for multi-step execution
- Returns structured results with tool data, HTML, and preformatted output

### Self Model (`data/self_model.json`)

Agent self-knowledge file containing:
- Identity, owner, version
- Capabilities list (conversation, reflection, planning, tool execution, self-evolution, etc.)
- Personality traits and communication style
- Architecture summary
- Known limitations and values

### Conversation Memory Enhancements

- **Rolling window**: In-memory cache of last 5 turns per conversation for fast context access
- **Mode tracking**: Each turn tagged as "chat" or "task" for classification context
- **`getRecentTurns()`**: Fast retrieval for orchestrator
- **`addTurn()`**: Appends to rolling window with automatic trimming

---

## New Capabilities (Sprint 10)

### Standalone Twitter Client (`twitter-client.js`)
The `agent-twitter-client@0.0.18` library was replaced with a standalone `TwitterClient` class (`server/utils/twitter-client.js`, ~600 lines) after discovering 6 independent breaking issues: revoked bearer token, deprecated `api.twitter.com` domain, cookie domain mismatches, missing `user-agent` header, SearchTimeline requiring POST, and `screen_name` migrated to `result.core`.

**Key improvements:**
- **Dynamic GraphQL hash extraction** — Fetches current hashes from Twitter's live JS bundle, cached 4 hours
- **POST fallback** — Automatically retries GET→POST for endpoints that return 404
- **2025+ response format** — Parses `name`/`screen_name` from `result.core` (not just `result.legacy`)
- **Cookie-based auth** — No login flow needed, just export cookies from browser
- **Zero dependencies** — Uses only native `fetch`, no third-party libraries

### Conversational Partner Mode
New `isPersonalConversation()` detection in planner.js routes personal, emotional, and reflective messages to LLM with enriched context. When active, executor.js injects:
- Detailed user profile (occupation, interests, goals, background)
- Recent conversation themes (last 10-15 messages)
- Interaction statistics (total messages, first seen, conversation count)
- Supportive collaborator directive (empathy-first, honest opinions, personalized responses)

**5 false-positive guards** prevent tool requests from being misrouted:
1. Tool-intent words ("search", "find", "get", "show") override personal detection
2. File paths in message → code operation, not personal
3. URLs in message → web request, not personal
4. Short non-first-person messages → likely commands
5. Opinion about tool topics → still routes to tool

### Heartbeat Auto-Publish (Sprint 9)
Moltbook heartbeat now generates and posts original content via LLM during Tier 2 engagement. Generates a thoughtful post inspired by trending topics, making your agent an active community participant rather than just a lurker.

### SelfEvolve Guardrails (Sprint 9)
- Maximum 3 files modified per evolution cycle
- Syntax validation (`node --check`) before applying patches
- Mandatory git staging for easy rollback
- Structured logging to `improvements.jsonl`

### applyPatch Categorized Backups (Sprint 10)
Backups now organized as `server/tools/backups/[tool_name]/tool_name_2026-03-17T...js.backup` instead of flat `.backup` files. Includes syntax check via staging file + `node --check` before atomic swap.

### Planner Multi-Change Routing (Sprint 10)
When the planner detects 3+ distinct action verbs targeting a file (e.g., "refactor, add JSDoc, and fix the randomizer"), it routes to `applyPatch` instead of `codeTransform` for a comprehensive full rewrite.

---

## New Capabilities (Sprint 7)

### Multi-Step Intent Decomposition
The agent now decomposes complex queries into 1-5 sequential tool steps using a 3-layer pipeline:
1. **Hardcoded compound patterns** (instant) — Regex-based detection for known 2-3 step combos
2. **LLM Sequential Logic Engine** (flexible) — AI-powered decomposition for 1-5 step plans
3. **Single-tool fallback** (safety net) — Original classifier as a last resort

See [Multi-Step Intent Decomposition](#multi-step-intent-decomposition-sequential-logic-engine) for full details.

### Compound Intent Guards (9 Branches Protected)
The `hasCompoundIntent()` function with 8 detection patterns now guards 9 certainty branches from greedily catching multi-intent queries:
- **Email override**, **email certainty branch**, **news**, **fileWrite**, **review**, **weather**, **finance**, **sports**, **file_path**
- Example: `"send an email with the summary of the news"` now correctly decomposes to [news → email] instead of routing to the email tool alone

### WhatsApp Tool (Flexible Natural Language)
New WhatsApp Business Cloud API integration with 7 cascading regex patterns for intent detection:
- Supports messages with or without connector words ("saying", "with message")
- Flexible word order: `"send NUMBER message"`, `"WhatsApp NUMBER message"`, `"send a message to NUMBER"`, etc.
- Bulk Excel send: reads phone numbers from `.xlsx` files
- Israeli phone number auto-normalization (05X → 9725X)
- Bilingual support (English + Hebrew)

### Train of Thought Reasoning Display
The agent's internal reasoning is now visible in a collapsible Train of Thought panel:
- 5 phases: THOUGHT 🧠 → PLAN 📋 → EXECUTION ⚙️ → OBSERVATION 🔍 → ANSWER ✨
- Server-side console logging with phase icons for debugging
- Multi-step queries show alternating EXECUTION/OBSERVATION pairs per step

### Enhanced Email + Content Compound Detection
New compound patterns detect "email me the news/weather/stocks" queries without requiring "and":
- `"Send an email to john@example.com with the summary of the news"` → [news → email]
- `"Email me the weather"` → [weather → email]
- `"Send matan an email with the news"` → [news → email]
- Works with typos: `"sned an email with the news"` → [news → email]

### Review + FileWrite Pattern Expansion
The compound review → fileWrite pattern now handles broader phrasing:
- `"Review planner.js and create a better version"` → [review → fileWrite]
- `"Review the code and generate an improved variant"` → [review → fileWrite]
- Previously only matched "new version" — now matches "better version", "improved variant", etc.

---

## New Capabilities (Sprint 6)

### Orchestrator Architecture
See [Orchestrator-Subagent Architecture](#orchestrator-subagent-architecture-sprint-6) above.

### Enhanced Planner Routing (8 Fixes)
- **Moltbook guard on news**: "Great news! Verified on Moltbook" no longer routes to news tool
- **hasExplicitFilePath fix**: "Node.js" no longer triggers file path detection (requires actual path separator)
- **Calendar/meeting guard**: "Schedule meeting reviewing code" routes to calendar, not improvement sequence
- **Scheduler report guard**: "Generate a weekly performance report" routes to selfImprovement, not scheduler
- **Diagnostic review exclusion**: "Review your planner code" routes to review, not LLM diagnostic
- **Accuracy → selfImprovement**: "How accurate is your routing?" routes to selfImprovement for actionable diagnostics
- **fileWrite expansion**: "Generate code at path" now matches fileWrite (added "code", "program", verb+path combo)
- **inferToolFromText**: New helper for compound query decomposition

### Multi-Step Chain-of-Thought
Expanded compound query detection:
- **Review + Generate**: `"Review planner.js and create a new version"` → review → fileWrite
- **Generic chains**: `"Search for X, then email me, then create a task"` → search → email → tasks
- **Email chaining**: `"Get the weather and email me the results"` → weather → email (existing)

### Calendar "Next Friday" Fix
- `"next Friday"` now always books 7+ days away (next week's Friday)
- `"this Friday"` books the nearest future Friday
- Bare day names (`"Friday"`) book nearest future occurrence

### Enhanced Market Check Workflow
Upgraded from 2 basic steps to 3 comprehensive steps:
1. Market Indices via `financeFundamentals` (SPY, QQQ, DIA, IWM)
2. Sector Performance via `finance` (XLK, XLE, XLF, XLV, XLI, XLY, XLP, XLU)
3. Market News via `news` (financial market news)

### Moltbook Heartbeat Interactions
Heartbeat now performs active community engagement:
- Upvotes 1-2 hot posts from the feed
- Comments on the top post with a contextual remark
- Reports all interactions taken in the output

### GitHub Trending Topic Extraction
Query cleaning now strips noise words: `"Show trending Node.js frameworks on GitHub"` → searches for `"Node.js"` instead of the full sentence.

### selfImprovement Commit IDs
Improvement history now shows commit hashes: `[7dee59d] Fix planner routing bugs`

### News Preformatted Output
News tool now returns `preformatted: true` to bypass LLM summarization, preserving styled HTML output.

### fileReview Per-File Analysis
Multi-file reviews now explicitly instruct the LLM to analyze each file separately, preventing it from only describing the first file.

### Email Attachment Search
New Gmail search support: `"find attachments named bills"` → `has:attachment filename:bills`

### Workflow HTML Preservation
Workflow execution now preserves HTML output from each step, enabling proper rendering of weather widgets, news cards, and financial charts within workflow results.

---

## New Capabilities (Sprint 5)

### 6-Source Web Search
Search now queries 6 engines in parallel via SerpAPI: Google, DuckDuckGo, Bing, Yahoo, Yandex, and Wikipedia.

### Expanded News (50+ RSS Feeds)
News tool now includes 19 general feeds and 30+ category-specific feeds across 7 categories (tech, science, business, sports, health, entertainment, world). Up to 8 articles scraped and 30 headlines displayed.

### Sports Team Filtering
When you mention a team name in a sports query ("today's results for Barcelona"), the fixture results are filtered to show only that team's matches. Team aliases like Barca, Man Utd, PSG are resolved automatically.

### Smart Calendar Event Names
Calendar events now extract titles from natural language: "schedule a dentist appointment" creates an event titled "Dentist appointment" instead of "New Event". Supports "called/named/about" patterns, quoted text, and verb+noun extraction.

### GitHub Clickable Links
All GitHub tool outputs (repos, commits, issues, search results) now use clickable markdown links instead of plain text.

### Moltbook Full API Integration
Complete rewrite of the Moltbook tool with 25+ action handlers covering the entire API: registration (with 409 recovery), posting, commenting, voting, feeds, search, following, communities, profile management, notifications, DMs (request/approve/reject/send), and a 3-tier autonomous heartbeat routine. Auto-solves verification math challenges. Monitors rate limits.

### Stop Button
Red stop button appears during processing. Click to cancel any ongoing request immediately via AbortController/SSE abort.

### Weather Memory Fallback
Weather tool falls back to your saved location from memory when no city is specified or when geolocation is unavailable.

---

## Tips for Best Results

1. **Be specific** — "Weather in Paris" is better than "what's it like outside"
2. **Name the tool** — "Search for..." or "Email John..." helps routing
3. **Use stored memory** — Set your location once with "remember my location is Tel Aviv" and just say "weather" next time
4. **Chain with confirmation** — Email always drafts first. Say "send it" to confirm
5. **Attach files** — Drag and drop files for automatic LLM analysis
6. **Use the stop button** — Click ■ to cancel any long-running request
7. **Set your email** — "remember my email is you@example.com" enables owner email setup for Moltbook
8. **Team filtering** — "Arsenal results yesterday" filters to Arsenal's matches only
9. **Smart calendar** — Just describe your event naturally: "book a call with Sarah tomorrow at 2pm"
10. **Moltbook heartbeat** — Schedule "run moltbook heartbeat" periodically to stay engaged with the community
11. **Moltbook DMs** — Use "dm AgentName saying Hello!" to start conversations; check "moltbook inbox" for replies
12. **Moltbook auto-verify** — Posts, comments, and submolts are automatically verified (math challenges solved)
13. **Chain commands** — Use "and then" to chain: `"Search for AI news and then email me the results"`
14. **Review + generate** — `"Review planner.js and create an improved version"` chains review with file generation
15. **Self-evolve scheduling** — "Schedule self evolve every 2 hours" for autonomous improvement
16. **Conversational mode** — Ask "Do you like your improvements?" for a reflective chat response (no tools triggered)
17. **Next vs this** — "Book meeting next Friday" = next week's Friday; "this Friday" = nearest Friday
18. **WhatsApp flexibility** — No "saying" needed: `"Send a WhatsApp to 0541234567 dinner is ready"` works
19. **WhatsApp bulk send** — `"Send WhatsApp to everyone in contacts.xlsx saying Happy holidays!"` messages all contacts
20. **Email + content combos** — `"Email me the news"` or `"Send an email with the weather"` auto-chains content + email
21. **Multi-step queries** — Phrase complex requests naturally: `"Get the latest news, summarize it, and save to a file"` → 3-step plan
22. **Train of Thought** — Watch the agent's reasoning unfold in the collapsible Train of Thought panel
23. **Complex chains** — The agent handles up to 5 steps: `"Check weather, get sports scores, search for AI news, summarize everything, and email me the results"`
24. **Store your background** — `"Remember I'm a full-stack developer interested in AI and Rust"` — enriches conversational partner mode responses
25. **Personal conversations** — Share thoughts, ask for opinions, discuss ideas — the agent activates partner mode automatically and remembers your context
26. **X/Twitter cookies** — Export `auth_token`, `ct0`, and `twid` cookies from your browser to `twitter_cookies.json` for Twitter access (no username/password needed)
27. **Multi-change refactoring** — Describe 3+ changes in one request: `"Refactor, add JSDoc, fix error handling in news.js"` — auto-routes to applyPatch for a comprehensive rewrite
28. **Download attachments** — `"Download attachments from boss@company.com since 01/01/2025"` — downloads to organized date/sender folders
29. **RSS feed customization** — Edit `server/data/rss_feeds.json` to add/remove news sources without touching code
30. **MCP servers** — Configure external tool servers via `MCP_SERVERS` env var, then `"list MCP servers"` or `"call read_query on sqlite MCP"`
31. **Code search** — `"How does the code handle email sending?"` uses semantic RAG search across the entire codebase
32. **System monitoring** — `"Check system status"` for real-time memory, CPU, and health info

---

## Multi-Step Test Prompts

Use these prompts to test the agent's multi-step decomposition and Train of Thought display. Each should produce multiple EXECUTION/OBSERVATION pairs in the Train of Thought panel.

### 2-Step Prompts (Hardcoded Compound Patterns)
These are caught by the fast regex-based compound detection:

1. `"Search for the latest AI news and email me the results"`
   → [search → email]

2. `"Review server/planner.js and create an improved version"`
   → [review → fileWrite]

3. `"Send an email to efratimatan@gmail.com with the summary of the news"`
   → [news → email]

4. `"Email me the weather"`
   → [weather → email]

5. `"Get the latest sports scores and email them to me"`
   → [sports → email]

6. `"Get X trends and email me the results"`
   → [x → email]

7. `"Get twitter trends and whatsapp to 0587426393"`
   → [x → whatsapp]

8. `"Check the weather and send it a whatsapp message to 0587426393"`
   → [weather → whatsapp]

### 3-Step Prompts (Hardcoded Analyze Pipelines)
These are caught by the 3-step compound pattern (source → analysis → destination):

6. `"search X for @DiscussingFilm, use llm to analyze sentiment on the new Spiderman movie and send a summary to whatsapp 0587426393"`
   → [x → llm → whatsapp]

7. `"search X for Bitcoin, analyze sentiment with nlp, and send to whatsapp 0587426393"`
   → [x → nlp_tool → whatsapp]

8. `"search X for Tesla complaints, analyze the sentiment, and email me the results"`
   → [x → llm → email]

9. `"get the moltbook feed, summarize the key themes, and send to whatsapp 0587426393"`
   → [moltbook → llm → whatsapp]

10. `"get the news, summarize the top stories, and email me"`
    → [news → llm → email]

### 3-4 Step Prompts (LLM Sequential Logic Engine)
These reach the LLM decomposer for flexible multi-step planning:

11. `"Get the latest tech news, summarize the top 3 articles, and email me the summary"`
    → [news → llm (summarize) → email]

12. `"Search for Node.js best practices, save a summary to E:/testFolder/nodejs-guide.md, and email me the file"`
    → [search → fileWrite → email]

13. `"Check Tesla stock price, get the latest financial news, and send both via WhatsApp to 0541234567"`
    → [finance → news → whatsapp]

14. `"Get the weather in Tel Aviv, check Premier League scores, and create a daily briefing file at E:/testFolder/briefing.md"`
    → [weather → sports → fileWrite]

### 4-Step Prompts (LLM Sequential Logic Engine — Complex)
These test the agent's ability to decompose longer sequences:

15. `"Search for AI breakthroughs, get the latest tech news, summarize everything into key points, and email the summary to efratimatan@gmail.com"`
    → [search → news → llm (summarize) → email]

16. `"Check the weather in Tel Aviv, get today's Premier League scores, search for trending GitHub repos, and save a daily report to E:/testFolder/daily-report.md"`
    → [weather → sports → githubTrending → fileWrite]

17. `"Get the latest news about AI, review server/planner.js for improvement opportunities, create a summary of both, and email it to me"`
    → [news → review → llm (summarize) → email]

18. `"Check Tesla and Apple stock prices, get financial news, summarize the market outlook, and send it via WhatsApp to 0541234567"`
    → [finance → news → llm (summarize) → whatsapp]

### Single-Step Prompts (Should NOT Decompose)
These should be caught by certainty branches and stay as single steps:

19. `"What's the weather in Paris?"` → [weather] (certainty branch)
20. `"Hello, how are you?"` → [llm] (conversational/greeting)
21. `"What is 5 * 3?"` → [calculator] (certainty branch)
22. `"Search for JavaScript tutorials"` → [search] (certainty branch)
23. `"When does Arsenal play next?"` → [sports] (certainty branch)

### Conversational Partner Mode Prompts (Should Route to LLM with Enriched Context)
These should activate personal conversation detection and NOT trigger any tools:

24. `"I've been thinking about switching from React to Svelte, what's your opinion?"` → [llm] (personal_conversation)
25. `"I'm feeling overwhelmed with all the new AI tools coming out, how do you keep up?"` → [llm] (personal_conversation)
26. `"Based on what we've talked about, what do you think would be a good side project for me?"` → [llm] (personal_conversation, uses full profile + conversation history)
27. `"What do you think about the current state of open source?"` → [llm] (opinion-seeking, NOT search)

### False-Positive Guard Tests (Should NOT Trigger Conversational Mode)
These contain first-person pronouns but are tool requests:

28. `"I want to search for the latest news about AI"` → [search] (tool intent overrides personal detection)
29. `"I think the stock price of Tesla is interesting, show me"` → [finance] (tool intent)
30. `"I feel like checking my emails"` → [email] (tool intent)
31. `"Show me what I have on my calendar tomorrow"` → [calendar] (tool intent)



### deepResearch

. [depth:article] Ethernet vs. Wi-Fi 7 for gaming latency
   → Article tier, ~1500w, 3 prompts. Fastest end-to-end smoke test.

2. Write a comprehensive in-depth guide to Obsidian Dataview queries.
   → In-Depth tier, ~2200w, 4 prompts. Tests lexicon match + keyword extraction.

3. [depth:research] Impact of GLP-1 agonists on non-diabetic weight loss
   → Research tier, ~3500w, 4 prompts. Tests Europe PMC routing + academic structure.

4. כתוב תזה על ההשפעה של עבודה מרחוק על תרבות ארגונית בהייטק הישראלי
   → Thesis tier, Hebrew. Tests Hebrew keyword detection + unicode slug + chunked synthesis.

5. Research LEO satellite latency
   → NO depth keyword. Should trigger the pending-question; reply "3" or "research" and
     the pipeline resumes with research tier. Tests the pause/resume hook end-to-end.
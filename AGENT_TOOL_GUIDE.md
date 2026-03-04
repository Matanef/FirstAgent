# Agent Tool Guide — Complete Reference

> **40 registered tools** across 10 categories. Each section explains what the tool does, how it's triggered, and provides example prompts to maximize the agent's functionality.
>
> _Last updated: March 2026 — Sprint 5 (remaining fixes + Moltbook improvements)_

---

## Table of Contents

1. [General Intelligence (LLM)](#1-general-intelligence-llm)
2. [Information & Search](#2-information--search)
3. [Productivity & Communication](#3-productivity--communication)
4. [File & Code Operations](#4-file--code-operations)
5. [Developer Tools](#5-developer-tools)
6. [Code Guru Tools](#6-code-guru-tools)
7. [Finance & Shopping](#7-finance--shopping)
8. [Media & Entertainment](#8-media--entertainment)
9. [Web Interaction & Automation](#9-web-interaction--automation)
10. [Advanced Intelligence](#10-advanced-intelligence)

---

## 1. General Intelligence (LLM)

### `llm` — General Conversation & Text Generation

The LLM is the agent's brain. It handles all conversational queries, creative writing, explanations, translations, and anything that doesn't need a specialized tool. It has access to your full conversation history and user profile.

**Triggered by:** Greetings, open-ended questions, creative tasks, text manipulation, anything not matched by other tools.

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

---

### `memorytool` — User Profile & Long-Term Memory

Stores and retrieves persistent user information: name, email, location, timezone, tone preferences, contacts, and any custom fields. This data persists across all conversations. Supports a generic "remember my X is Y" pattern for any profile field.

**Triggered by:** "remember", "forget", "what do you know about me", "my name/email/location"

**Example prompts:**
1. `"Remember my name is Alex"` — Store name
2. `"Remember my email is alex@example.com"` — Store email
3. `"Remember my location is Tel Aviv"` — Store location (used by weather)
4. `"Remember that my timezone is UTC+3"` — Store timezone
5. `"Remember John's email is john@company.com"` — Store contact
6. `"What do you know about me?"` — Retrieve full profile
7. `"Who am I?"` — Quick profile recall
8. `"Forget my location"` — Remove stored location
9. `"Remember I prefer a professional and concise tone"` — Set tone preference

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

---

### `news` — Multi-Source News with LLM Summaries & Category Feeds

Fetches from **19+ general RSS feeds** (Ynet, Kan, N12, JPost, Times of Israel, Haaretz, i24NEWS, BBC, CNN, Reuters, Al Jazeera, AP News, The Guardian, NPR, ABC News, NBC News, Sky News, DW, France24) plus **7 category-specific feed groups** (technology, science, business, sports, health, entertainment, world) with ~30 active category feeds. Feeds are fetched in parallel with timeouts. Articles are scraped (up to 8) and summarized by the LLM, with headlines table showing up to 30 results. Smart topic extraction rejects noise words like "any", "some", "all".

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

### `applyPatch` — Apply Code Patches

Applies code patches/diffs to files. Used in multi-step improvement flows after review.

**Triggered by:** Part of improvement pipeline (review -> applyPatch), or "apply patch", "patch file"

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
2. `"Security audit of my server code"` — Security-focused review
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

### `githubScanner` — GitHub Intelligence & Tool Discovery

Scans GitHub repositories for patterns, discovers new tools, and analyzes repo trends.

**Triggered by:** "scan github", "discover tools", "github intelligence", "repo scan"

**Example prompts:**
1. `"Scan GitHub for AI agent tools"` — Tool discovery
2. `"Analyze trending GitHub patterns"` — Pattern analysis
3. `"Find new tools for web scraping"` — Discovery
4. `"Scan repos for best practices"` — Pattern research

---

### `selfEvolve` — Autonomous Self-Improvement

Active code modification engine: scans GitHub for patterns, reviews own code, generates and applies patches, stages changes via git. Supports dry-run mode for safe previewing.

**Triggered by:** "evolve yourself", "improve your code", "scan github and improve", "upgrade yourself"

**Example prompts:**
1. `"Evolve yourself"` — Full evolution cycle
2. `"Improve your own code"` — Self-improvement
3. `"Scan github and upgrade your tools"` — Pattern-based improvement
4. `"Dry run: evolve yourself"` — Preview changes without applying
5. `"Show evolution history"` — View past improvements

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

---

### `lotrJokes` — Lord of the Rings Jokes

Fun tool that tells Lord of the Rings themed jokes.

**Triggered by:** "LOTR joke", "Lord of the Rings joke", "hobbit joke"

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
    - **Tier 2 (Engagement):** Browse hot feed, display top posts with scores & comment counts
    - **Tier 3 (Status):** Own profile stats (karma, post count), rate limit summary
    - Returns `HEARTBEAT_OK` with action items (e.g., "3 DM requests pending")
    - Saves heartbeat timestamp to memory for scheduling

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

### `scheduler` — Recurring Task Automation

Schedule recurring tasks with natural language timing. Supports intervals (every N minutes/hours), daily schedules, and weekly schedules.

**Triggered by:** "schedule", "every X minutes/hours", "daily at", "recurring", "automate"

**Example prompts:**
1. `"Schedule weather check every 30 minutes"` — Interval-based
2. `"Check emails daily at 9am"` — Daily schedule
3. `"Every Monday at 9:00, run the morning briefing"` — Weekly schedule
4. `"List my schedules"` — Show active schedules
5. `"Cancel the weather schedule"` — Remove a schedule

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
| `LLM_MODEL` | All (defaults to `llama3.2`) | Optional |
| `SERPAPI_KEY` | search (Google, DuckDuckGo, Bing, Yahoo, Yandex) | Recommended |
| `OPENWEATHER_KEY` | weather | For weather |
| `ALPHA_VANTAGE_KEY` or `FINNHUB_KEY` or `FMP_API_KEY` | finance, financeFundamentals | For finance |
| `SPORTS_API_KEY` | sports | For sports |
| `YOUTUBE_API_KEY` | youtube | For YouTube |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REDIRECT_URI` | email, calendar | For email + calendar |
| `EMBEDDING_MODEL` | documentQA (defaults to `nomic-embed-text`) | Optional |
| `GITHUB_TOKEN` | github, githubTrending, githubScanner | For GitHub |
| `CREDENTIAL_MASTER_KEY` | credentialStore (used by webBrowser, moltbook) | For encryption |
| `MOLTBOOK_API_KEY` | moltbook (auto-saved to `.config/moltbook/credentials.json` on registration) | For Moltbook |

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

1. **Certainty Layer** (deterministic, instant) — 45+ pattern-matching branches for keywords, file paths, URLs, tool-specific phrases. ~90% of messages are caught here. Includes guards to prevent common collisions:
   - Calendar guard prevents "meeting with team" from routing to sports
   - Tasks guard prevents task keywords from routing to GitHub
   - General knowledge guard routes "what is X" to search instead of calculator
   - File path priority ensures paths like `D:/...` always route to file tools
   - Finance guard with company name -> ticker resolution

2. **Tool-Specific Keyword Clusters** (deterministic) — Expanded pattern matching for email, finance, sports, YouTube, GitHub, git, code review, shopping, tasks, memory, NLP, selfImprovement, Code Guru tools.

3. **LLM Classifier** (AI-powered fallback) — For truly ambiguous queries, the local LLM classifies intent using few-shot examples and negative examples with 25+ example mappings.

4. **Case-Insensitive Resolution** — The LLM's output is matched case-insensitively against all 40 tools, with alias support and partial matching.

5. **Safe Fallback** — If no tool matches, the query goes to `llm` (general conversation).

---

## Multi-Step Flows

The agent can chain multiple tools for complex tasks:

- **Natural chaining**: `"Search for X and email me the results"` -> search -> email (automatic)
- **Register + Verify**: `"Register on moltbook"` -> moltbook(register) -> saves credentials + sets up email
- **Moltbook Heartbeat**: `"Run moltbook heartbeat"` -> /home (Tier 1) -> /dm/check (Tier 1) -> /feed (Tier 2) -> /agents/me (Tier 3) -> summary report
- **Moltbook Post + Verify**: `"Post on moltbook"` -> /posts (create) -> /verify (auto-solve math challenge) -> confirmed
- **Improve Code**: `"Improve the search tool"` -> githubTrending -> review -> applyPatch -> gitLocal
- **Morning Briefing**: `"Run morning briefing"` -> weather -> email(browse) -> news
- **Complex Planning**: Multi-intent queries auto-decomposed into ordered steps with dependency tracking

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

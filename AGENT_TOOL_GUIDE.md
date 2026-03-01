# Agent Tool Guide — Complete Reference

> 27 tools across 8 categories. Each section explains what the tool does, how it's triggered, and provides 6–9 example prompts to maximize the agent's functionality.

---

## Table of Contents

1. [General Intelligence (LLM)](#1-general-intelligence-llm)
2. [Information & Search](#2-information--search)
3. [Productivity & Communication](#3-productivity--communication)
4. [File & Code Operations](#4-file--code-operations)
5. [Developer Tools](#5-developer-tools)
6. [Finance & Shopping](#6-finance--shopping)
7. [Media & Entertainment](#7-media--entertainment)
8. [Web Interaction & Automation](#8-web-interaction--automation)

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

### `nlp_tool` — Text Analysis & Sentiment

Performs NLP analysis: sentiment detection, entity extraction, text classification. Only activates for explicit analysis requests.

**Triggered by:** "sentiment", "analyze text", "text analysis", "classify text", "extract entities"

**Example prompts:**
1. `"Analyze the sentiment of: I love this product, it changed my life!"` — Positive sentiment
2. `"What's the sentiment of this review: The service was terrible and the food was cold"` — Negative sentiment
3. `"Extract entities from: Apple CEO Tim Cook announced new products in Cupertino"` — Named entity recognition
4. `"Analyze the text: The quarterly results exceeded expectations by 20%"` — Business text analysis
5. `"Classify the tone of this message: We need to talk about your performance"` — Tone classification
6. `"Sentiment analysis on: meh, it was okay I guess"` — Neutral/mixed sentiment

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

### `search` — Web Search (Multi-Source + LLM Synthesis)

Searches Wikipedia, DuckDuckGo, Google (via SerpAPI), and Yandex in parallel. Results are deduplicated, scored by relevance, and cached for 1 hour. **Now synthesizes a coherent LLM-powered summary** from the combined search results, providing a unified answer rather than just raw links.

**Triggered by:** "search", "look up", "find information", "who is/was", "tell me about", "history of"

**Example prompts:**
1. `"Search for the latest developments in quantum computing"` — Current tech research
2. `"Who was Napoleon Bonaparte?"` — Historical figure lookup
3. `"What is the population of Japan?"` — Factual query
4. `"Search for best practices in Node.js error handling"` — Technical research
5. `"Look up the history of the Eiffel Tower"` — Historical research (synthesized answer)
6. `"Tell me about quantum computing"` — Knowledge query (LLM synthesis)
7. `"Find information about climate change"` — Topic research
8. `"What are the system requirements for Windows 11?"` — Product info

---

### `news` — Multi-Source News with LLM Summaries & Category Feeds

Fetches from 9+ RSS feeds (Ynet, Kan, N12, JPost, Times of Israel, BBC, CNN, Reuters, Al Jazeera). Supports **category-specific feeds** (technology, science, business, sports, health, entertainment) that are auto-detected from the query. Feeds are fetched in **parallel with timeouts** for fast responses. Articles are scraped and summarized by the LLM, with fallback to RSS descriptions when scraping fails.

**Triggered by:** "news", "headlines", "articles", "latest news", "breaking"

**Example prompts:**
1. `"What's the latest news?"` — All sources, top headlines
2. `"Latest news about technology"` — Topic-filtered news
3. `"Breaking news from BBC"` — Source-specific (if matched in text)
4. `"Any news about climate change?"` — Topic: environment
5. `"Today's headlines about the economy"` — Topic: economy
6. `"Recent news from Israel"` — Regional news (Israeli sources prioritized)
7. `"What's happening in the world of sports?"` — Topic: sports (via news, not sports tool)
8. `"Give me a news summary for today"` — General daily briefing

---

### `weather` — Forecast & Current Conditions

Uses OpenWeather API. Supports city names, "here" (geolocation), and remembers your saved location from memory.

**Triggered by:** "weather", "forecast", "temperature", "rain", "snow", "humidity", "wind", "sunny", "cloudy"

**Requires:** `OPENWEATHER_KEY` in `.env`

**Example prompts:**
1. `"What's the weather in London?"` — City-specific forecast
2. `"Weather here"` — Uses geolocation
3. `"Is it going to rain in New York tomorrow?"` — Rain forecast
4. `"Temperature in Tokyo"` — Temperature query
5. `"What's the forecast for this week in Tel Aviv?"` — Extended forecast
6. `"Is it snowing in Denver?"` — Condition check
7. `"Weather"` — Uses saved location from memory (if set)
8. `"How humid is it in Miami?"` — Humidity query

---

## 3. Productivity & Communication

### `email` — Draft, Send & Browse Emails (Gmail OAuth)

Full email tool: draft & send emails (two-stage confirmation), browse inbox, read emails, and download attachments. Uses Gmail OAuth with send + readonly scopes.

**Requires:** Gmail OAuth configured (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`)

**Triggered by:** "email", "mail", "send to", "draft email", "check my emails", "inbox", "read my emails"

**Example prompts:**
1. `"Email john@example.com saying the meeting is at 3pm"` — Direct email with body
2. `"Draft an email to Sarah about the project deadline"` — Uses contacts from memory
3. `"Send an email to my boss about taking Friday off"` — Natural language
4. `"Email the team about the new release, attach the changelog"` — With attachment
5. `"Send it"` — Confirm and send the last drafted email
6. `"Cancel"` — Discard the draft
7. `"Check my recent emails"` — Browse inbox (NEW)
8. `"Show my unread emails from last week"` — Search emails by date/status (NEW)
9. `"Read email #3"` — View full email content (NEW)
10. `"Go over my emails and find attachments named 'bills'"` — Search with attachment filter (NEW)

---

### `tasks` — Task & Todo Management

Manages task lists with priorities, due dates, and status tracking. **Note:** Task keywords (e.g., "todo", "task", "add task") take priority over github keywords during routing, so messages like "Add task: review pull request" correctly route to the tasks tool, not GitHub.

**Triggered by:** "todo", "task", "reminder", "add task", "my tasks", "checklist"

**Example prompts:**
1. `"Add task: review pull request by Friday"` — Create task with deadline (routes here, NOT github)
2. `"What are my current tasks?"` — List all tasks
3. `"Mark the review task as done"` — Update status
4. `"Add a high priority task to fix the login bug"` — Priority task
5. `"Remove the completed tasks"` — Clean up
6. `"What tasks are due this week?"` — Filter by deadline

---

## 4. File & Code Operations

### `file` — File System Browser & Reader

Reads, lists, and navigates files and directories. Sandboxed to the project root and E:/testFolder. **Smart path extraction** correctly handles absolute paths embedded in natural language (e.g., "List files in D:/local-llm-ui/server/tools" → extracts `D:/local-llm-ui/server/tools`). File path checks take priority over all other routing, so paths containing words like "planner" won't misroute.

**Triggered by:** Explicit file paths (e.g., `D:/...`), "list files", "read file", "show me"

**Example prompts:**
1. `"List files in D:/local-llm-ui/server/tools"` — Absolute path extracted from natural language
2. `"Read D:/local-llm-ui/server/planner.js"` — Read file contents (path priority over diagnostic)
3. `"Show me the contents of E:/testFolder/config.json"` — Read external file
4. `"What files are in the server directory?"` — Natural language listing
5. `"List all JavaScript files in the tools folder"` — Filtered listing
6. `"Read the first 50 lines of server/executor.js"` — Partial read
7. `"Show the directory structure of the client folder"` — Tree view

---

### `fileWrite` — Write Files to Disk (Natural Language Support)

Creates or overwrites files on disk. **Now supports natural language input** — just describe what you want and specify the path. The LLM generates the file content automatically based on your request and the file extension. Also accepts structured input `{ path, content }` for programmatic use.

**Triggered by:** "write/create/generate/save/make" + file path (e.g., `D:/...`), or as part of multi-step flows

**Example prompts:**
1. `"Write a hello world script to D:/local-llm-ui/test.js"` — NL: generates JS content
2. `"Create a config file at D:/local-llm-ui/config.json"` — NL: generates JSON config
3. `"Generate a Python script at E:/testFolder/main.py"` — NL: generates Python code
4. `"Save a basic HTML page to D:/local-llm-ui/index.html"` — NL: generates HTML
5. `"Create a README at D:/local-llm-ui/README.md"` — NL: generates Markdown
6. `"Write a bash script to E:/testFolder/setup.sh"` — NL: generates shell script

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
6. *Attach a `.md` file* + `"What are the key points?"` — Document summary

---

### `duplicateScanner` — Find Duplicate Files

Scans directories for duplicate files using SHA256 hashing (two-stage: chunk then full), metadata matching, and Levenshtein fuzzy name detection. Results appear in a scrollable panel.

**Triggered by:** "duplicate", "find duplicate", "scan duplicate"

**Example prompts:**
1. `"Find duplicate files in D:/local-llm-ui"` — Full project scan
2. `"Scan for duplicates in E:/testFolder"` — External folder
3. `"Find duplicate .js files in the server directory"` — Type-filtered
4. `"Are there any duplicate files named config?"` — Name-filtered
5. `"Find duplicate files in D:/local-llm-ui that are .json"` — Extension filter
6. `"Scan for duplicate files"` — Default path scan

---

### `review` — Code Review & Analysis

Reviews code files and generates detailed analysis: issues, suggestions, best practices, security concerns.

**Triggered by:** "review code", "inspect code", "examine file", "audit code"

**Example prompts:**
1. `"Review server/planner.js"` — Full file review
2. `"Review the executor code and suggest improvements"` — Review with suggestions
3. `"Inspect server/tools/email.js for security issues"` — Security audit
4. `"Examine the search tool implementation"` — Tool analysis
5. `"Review my code for performance issues"` — Performance review
6. `"Audit the authentication flow in the OAuth module"` — Specific concern
7. `"Review server/utils/httpClient.js and check error handling"` — Targeted review

---

### `applyPatch` — Apply Code Patches

Applies code patches/diffs to files. Used in multi-step improvement flows after review.

**Triggered by:** Part of improvement pipeline (review → applyPatch), or "apply patch", "patch file"

**Example prompts:**
1. `"Apply the suggested improvements to server/tools/email.js"` — Post-review patch
2. `"Patch the search tool with the recommended changes"` — Apply recommendations
3. *Typically used automatically in multi-step improvement flows*

---

## 5. Developer Tools

### `github` — GitHub Repository Management

Full GitHub API access via Octokit: list repos, search repos, manage issues, read file contents, view profile.

**Requires:** `GITHUB_TOKEN` or `GITHUB_API_KEY` in `.env`

**Triggered by:** "github", "repo", "repository", "pull request", "issue", "commit"

**Example prompts:**
1. `"List my GitHub repositories"` — Show all repos
2. `"Search GitHub for React component libraries"` — Search repos
3. `"Show my open GitHub issues"` — List issues
4. `"Get the contents of README.md from my FirstAgent repo"` — Read repo file
5. `"Show my GitHub profile"` — View profile info
6. `"What are the most starred repos for 'machine learning'?"` — Search by stars
7. `"List recent commits on my FirstAgent repository"` — Commit history

---

### `githubTrending` — Trending Repositories

Fetches trending GitHub repositories by topic, language, or time period. Used in improvement flows to discover best practices.

**Triggered by:** "trending", "popular repos", "top repositories"

**Example prompts:**
1. `"Show trending GitHub repos"` — General trending
2. `"Trending JavaScript repositories this week"` — Language-filtered
3. `"Popular repos for machine learning"` — Topic search
4. `"What's trending in TypeScript?"` — Language trends
5. `"Show trending Node.js frameworks"` — Framework discovery
6. `"Top repos for React best practices"` — Best practice research
7. `"Trending repos for API design patterns"` — Architecture research

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
6. `"git stash"` — Stash current changes
7. `"Show me the git log for the last 10 commits"` — Detailed history
8. `"What files have changed since last commit?"` — Quick diff check

---

### `packageManager` — npm Package Management

Install, update, and manage npm packages.

**Triggered by:** "npm install", "install package", "add dependency"

**Example prompts:**
1. `"Install axios"` — Install a package
2. `"What version of express is installed?"` — Check version
3. `"Update all packages"` — Bulk update
4. `"Install lodash as a dev dependency"` — Dev dependency
5. `"Remove the unused chalk package"` — Uninstall
6. `"List outdated packages"` — Check for updates

---

### `webDownload` — Download Files from URLs

Downloads files from URLs (including GitHub raw URLs and npm package info). Returns content for text files.

**Triggered by:** Any URL in the message (e.g., `https://...`)

**Example prompts:**
1. `"Download https://raw.githubusercontent.com/user/repo/main/README.md"` — GitHub raw file
2. `"Fetch https://example.com/api/data.json"` — Download JSON
3. `"Download the file at https://example.com/style.css"` — CSS download
4. `"Get npm info for express"` — npm package lookup
5. `"Download https://example.com/script.js and read it"` — Download + preview
6. `"Fetch and summarize https://example.com/article.html"` — Download + LLM summary

---

## 6. Finance & Shopping

### `finance` — Stock Prices & Market Data

Fetches real-time stock prices, market data, and company information from Alpha Vantage, Finnhub, and FMP.

**Requires:** At least one of `ALPHA_VANTAGE_KEY`, `FINNHUB_KEY`, `FMP_API_KEY` in `.env`

**Triggered by:** "stock", "share price", "ticker", "market", "portfolio", "invest", "S&P"

**Example prompts:**
1. `"What's the stock price of Apple?"` — Current price
2. `"How is Tesla doing today?"` — Stock status
3. `"Show me the stock price for MSFT"` — By ticker symbol
4. `"Compare Apple and Google stock prices"` — Multi-stock
5. `"How did the S&P 500 perform today?"` — Market index
6. `"What's the stock price of Amazon in the last week?"` — Historical
7. `"Show me NVDA stock data"` — Nvidia by ticker

---

### `financeFundamentals` — Company Fundamentals

Deep financial analysis: P/E ratio, market cap, revenue, earnings, debt ratios.

**Triggered by:** "fundamentals", "financials", "earnings", "revenue", "P/E ratio"

**Example prompts:**
1. `"Show me Apple's financial fundamentals"` — Full fundamental analysis
2. `"What's Tesla's P/E ratio?"` — Specific metric
3. `"Revenue and earnings for Microsoft"` — Income data
4. `"Compare fundamentals of Google and Amazon"` — Comparative analysis
5. `"What's the market cap of NVIDIA?"` — Market cap
6. `"Show me the debt-to-equity ratio for Meta"` — Balance sheet metric

---

### `shopping` — Product Search & Price Comparison

Searches for products, prices, deals, and reviews.

**Triggered by:** "buy", "shop", "price", "product", "deal", "discount", "purchase"

**Example prompts:**
1. `"Find the best price for a mechanical keyboard"` — Price search
2. `"Compare prices for AirPods Pro"` — Price comparison
3. `"Search for laptop deals under $1000"` — Budget shopping
4. `"What are the best wireless headphones?"` — Product research
5. `"Find deals on ergonomic office chairs"` — Deal hunting
6. `"Shop for a 27 inch 4K monitor"` — Specific product search

---

## 7. Media & Entertainment

### `youtube` — YouTube Video Search

Searches YouTube for videos, tutorials, and content.

**Requires:** `YOUTUBE_API_KEY` in `.env`

**Triggered by:** "youtube", "video", "watch", "tutorial video"

**Example prompts:**
1. `"Search YouTube for Node.js tutorials"` — Tutorial search
2. `"Find YouTube videos about machine learning"` — Topic search
3. `"YouTube best cooking channels"` — Channel discovery
4. `"Find videos about React hooks explained"` — Specific topic
5. `"Search YouTube for live coding sessions"` — Content type
6. `"YouTube tutorials about Docker for beginners"` — Skill level
7. `"Find the latest tech review videos"` — Recent content

---

### `sports` — Live Scores, Fixtures, Standings & Sports Data

Full sports tool using API-Football v3. Supports: upcoming fixtures, past results, live scores, full league standings, and top scorers. Returns pre-formatted markdown tables showing ALL data (not truncated). Recognizes team names (Arsenal, Barcelona, Bayern, etc.) and league names (Premier League, La Liga, Serie A, etc.).

**Requires:** `SPORTS_API_KEY` in `.env` (API-Football key)

**Triggered by:** "score", "match", "game", "league", "team", "player", "football", "standings", "fixture", "Premier League", team names (Arsenal, Chelsea, etc.)

**Example prompts:**
1. `"When does Arsenal play next?"` — Upcoming fixtures for a team
2. `"Premier League standings"` — Full 20-team league table
3. `"What were Liverpool's last 5 results?"` — Recent match results
4. `"Live scores right now"` — Currently live matches
5. `"La Liga top scorers"` — Top scorer leaderboard
6. `"Champions League fixtures"` — Upcoming UCL matches
7. `"Did Barcelona win their last game?"` — Recent result for team
8. `"Bundesliga table"` — Full standings for German league
9. `"When does Man City play next in the Premier League?"` — Team + league specific

---

### `lotrJokes` — Lord of the Rings Jokes

Fun tool that tells Lord of the Rings themed jokes.

**Triggered by:** "LOTR joke", "Lord of the Rings joke", "hobbit joke"

**Example prompts:**
1. `"Tell me a Lord of the Rings joke"` — Random LOTR joke
2. `"Give me a hobbit joke"` — Hobbit-themed
3. `"LOTR humor please"` — Fun request

---

## 8. Web Interaction & Automation

### `webBrowser` — General Web Browsing

Browse any website with persistent session cookies, form submission, CSRF handling, and structured data extraction. Each domain gets its own persistent session.

**Triggered by:** "browse", "visit", "navigate", "go to" + a domain name

**Example prompts:**
1. `"Browse example.com"` — Simple page fetch
2. `"Visit reddit.com and show me the top links"` — Extract links
3. `"Navigate to github.com/trending and extract the content"` — Scrape content
4. `"Go to news.ycombinator.com and show me the headlines"` — Extract text
5. `"Extract all forms from example.com/login"` — Form discovery
6. `"Login to example.com with username: test password: test123"` — Login flow
7. `"Store credentials for example.com username: myuser password: mypass"` — Encrypted credential storage
8. `"Submit form at example.com/contact with name: Alex email: alex@test.com"` — Form submission

---

### `moltbook` — Moltbook.com Social Network (REST API)

Full integration with Moltbook, the social network for AI agents. Uses the REST API documented in skill.md. Supports: registration, posting, commenting, voting, feeds, semantic search, following, submolt communities, and profile management. Authentication via API key (stored in encrypted credential store).

**Triggered by:** Any message containing "moltbook"

**Example prompts:**
1. `"Register on moltbook"` — Register via REST API, get API key + claim URL
2. `"Post on moltbook title: Hello World content: My first post!"` — Create a post
3. `"Check my moltbook feed"` — Browse personalized feed
4. `"Search moltbook for AI memory techniques"` — Semantic search
5. `"Upvote post abc123 on moltbook"` — Vote on a post
6. `"Comment on moltbook post abc123 saying Great insight!"` — Add a comment
7. `"Follow ClawdClawderberg on moltbook"` — Follow another agent
8. `"View my moltbook profile"` — See your profile and stats
9. `"List moltbook communities"` — Browse submolts
10. `"Store moltbook api_key: moltbook_xxx"` — Save API key securely

---

## Setup Requirements

### Required API Keys (`.env` file)

| Variable | Tool(s) | Required? |
|----------|---------|-----------|
| `LLM_MODEL` | All (defaults to `llama3.2`) | Optional |
| `SERPAPI_KEY` | search | Recommended |
| `OPENWEATHER_KEY` | weather | For weather |
| `ALPHA_VANTAGE_KEY` or `FINNHUB_KEY` | finance, financeFundamentals | For finance |
| `SPORTS_API_KEY` | sports | For sports |
| `YOUTUBE_API_KEY` | youtube | For YouTube |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REDIRECT_URI` | email, emailVerification | For email |
| `GITHUB_TOKEN` | github, githubTrending | For GitHub |
| `CREDENTIAL_MASTER_KEY` | credentialStore (used by webBrowser, moltbook) | For credential encryption |
| `MOLTBOOK_BASE_URL` | moltbook (defaults to `https://www.moltbook.com`) | Optional |
| `MOLTBOOK_API_KEY` | moltbook (or use credential store) | For Moltbook API |

### Generating a Credential Master Key

The `CREDENTIAL_MASTER_KEY` is a random secret string you create yourself. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add the output to your `.env` file:
```
CREDENTIAL_MASTER_KEY=<your-generated-key-here>
```

---

## How the Agent Routes Your Messages

1. **Certainty Layer** (deterministic, instant) — Pattern matching for keywords, file paths, URLs, tool-specific phrases. ~90% of messages are caught here.

2. **Tool-Specific Keyword Clusters** (deterministic) — Expanded pattern matching for email, finance, sports, YouTube, GitHub, git, code review, shopping, tasks, memory, NLP, selfImprovement.

3. **LLM Classifier** (AI-powered fallback) — For truly ambiguous queries, the LLM classifies intent using few-shot examples and negative examples.

4. **Case-Insensitive Resolution** — The LLM's output is matched case-insensitively against all available tools, with alias support and partial matching.

5. **Safe Fallback** — If no tool matches, the query goes to `llm` (general conversation) which can handle anything.

---

## New Capabilities (Phase 4)

### Persistent Conversation Memory
The agent automatically summarizes long conversations and stores summaries for cross-session context. When relevant, past conversation summaries are retrieved to provide context-aware responses. Stored in `memory.meta.conversationSummaries`.

### Conversational Style Engine
The agent learns and adapts to your preferred communication style:
- **Explicit style changes:** Say "be more formal" or "be brief" to change response style
- **Implicit learning:** The engine detects satisfaction signals (re-asking = dissatisfied, "thanks" = satisfied) and auto-adjusts verbosity
- **Style presets:** formal, casual, brief, detailed, technical, friendly
- **Preferences stored in:** `memory.profile.preferences`

### Self-Correction & Reflection
After generating a response, the coordinator checks for hallucinated placeholders (like `[Date]`, `[Opponent]`, `[Location]`) and replaces them with "data not available" notices. This prevents the LLM from inventing data the tool didn't provide.

### Proactive Suggestions
After completing a task, the agent can suggest relevant follow-up actions:
- Weather query: "Would you like the forecast for tomorrow?"
- Email sent: "Want me to set a reminder to follow up?"
- Sports fixtures: "Want to see the current standings?"
- **Disabled by default.** Enable with: "remember my preference enableSuggestions is true"

### Full Table Presentation
Sports standings, news, and financial data now show ALL results in markdown tables (not just top 4). The sports tool returns pre-formatted tables that bypass LLM summarization for accuracy.

---

## Multi-Step Flows

The agent can chain multiple tools for complex tasks:

- **Register + Verify**: `"Register on moltbook and verify my email"` → moltbook(register) → moltbook(verify_email) → moltbook(status)
- **Improve Code**: `"Improve the search tool based on trending patterns"` → githubTrending → review → applyPatch → gitLocal(status) → gitLocal(add)
- **Research + Email**: The planner can generate multi-step plans for complex requests.

---

## Tips for Best Results

1. **Be specific** — "Weather in Paris" is better than "what's it like outside"
2. **Name the tool** — "Search for..." or "Email John..." helps routing
3. **Use stored memory** — Set your location once with "remember my location is Tel Aviv" and just say "weather" next time
4. **Chain with confirmation** — Email always drafts first. Say "send it" to confirm.
5. **Attach files** — Drag and drop files for automatic LLM analysis
6. **Store credentials once** — "Store my moltbook credentials" encrypts them. Next time just say "login to moltbook"

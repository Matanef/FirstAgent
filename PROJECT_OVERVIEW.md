# Project Overview: local-llm-ui

> **A fully local AI agent** with 43 registered tools, multi-step reasoning, and a React 19 chat interface. Powered by Ollama (qwen2.5-coder:14b), the agent can search the web, send emails, manage files, review code, trade insights, post on Moltbook, send WhatsApp messages, fetch X/Twitter trends, schedule recurring tasks, and much more — all orchestrated through natural language.
>
> _Last updated: March 2026 — Sprint 8_

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Frontend (React 19 + Vite)](#frontend-react-19--vite)
3. [Backend (Express + Ollama)](#backend-express--ollama)
4. [Tool Categories (43 Tools)](#tool-categories-43-tools)
5. [Routing Pipeline (Planner)](#routing-pipeline-planner)
6. [Multi-Step Execution (Coordinator)](#multi-step-execution-coordinator)
7. [Key Utilities](#key-utilities)
8. [API Routes](#api-routes)
9. [Environment Variables](#environment-variables)
10. [Recent Sprints & Changelog](#recent-sprints--changelog)

---

## Architecture Overview

```
User (Browser)
  |
  |  SSE stream (Server-Sent Events)
  v
React 19 Chat UI (Vite + DOMPurify)
  |
  |  POST /chat  (JSON)
  v
Express Server (server/index.js)
  |
  v
Planner (server/planner.js)
  |  5-layer routing: certainty branches -> compound patterns -> LLM decomposer
  v
Coordinator (server/utils/coordinator.js)
  |  Executes multi-step plans sequentially, pipes context between steps
  v
Executor (server/executor.js)
  |  Dispatches to 43 registered tools, manages input/output contracts
  v
Tools (server/tools/*.js)
  |  Each tool returns { tool, success, final, data: { text, ... } }
  v
Ollama LLM (localhost:11434)
  |  qwen2.5-coder:14b (main), qwen2.5-coder:7b (fast review)
```

**Key design principles:**
- **Fully local**: No cloud LLM dependency. Ollama runs on the same machine.
- **SSE streaming**: Real-time token-by-token responses with 15s heartbeat to prevent timeouts.
- **Train of Thought**: Every multi-step plan shows THOUGHT / PLAN / EXECUTION / OBSERVATION / ANSWER phases in the UI.
- **Context piping**: Previous step outputs automatically flow to subsequent steps via `chainContext`.
- **Compound intent detection**: Regex guards on single-tool branches detect multi-tool queries and let them fall through to decomposition.

---

## Frontend (React 19 + Vite)

**Location:** `client/local-llm-ui/src/`

### Core Files
| File | Purpose |
|------|---------|
| `App.jsx` + `App.css` | Main chat UI: sidebar, conversation management, SSE message streaming, Train of Thought display |
| `CodeField.jsx` | Syntax-highlighted code editor/viewer |
| `MemoryPanel.jsx` | User profile and memory management panel |
| `ReviewPanel.jsx` | Code review results display |

### Components (`src/components/`)
| Component | Purpose |
|-----------|---------|
| `TrainOfThought.jsx` | Renders multi-step reasoning: PLAN, EXECUTION, OBSERVATION badges per step |
| `SmartContent.jsx` | Intelligent HTML/Markdown renderer with DOMPurify sanitization |
| `WeatherWidget.jsx` | Visual weather card with temperature, conditions, wind |
| `FundamentalsChart.jsx` | Financial data visualization charts |
| `YouTubeVideoGrid.jsx` | Grid display for YouTube search results |
| `WebBrowserPanel.jsx` | Embedded web browser interaction panel |
| `FileSystemBrowser.jsx` | File/folder tree browser |
| `FolderPicker.jsx` | Directory selection dialog |
| `FileAttachmentBar.jsx` | File upload/attachment UI |
| `FileUploadZone.jsx` | Drag-and-drop file upload area |
| `FileReviewPanel.jsx` | File review results display |
| `DuplicateScannerPopup.jsx` | Duplicate file detection popup |
| `DuplicateResultsPanel.jsx` | Duplicate scan results display |
| `CodeBlock.jsx` | Syntax-highlighted code blocks with copy button |

### UI Features
- **Multiple conversations** with sidebar, previews, and deletion
- **SSE streaming** with real-time token display and stop button
- **Train of Thought** panel showing multi-step reasoning live
- **Rich content rendering**: weather widgets, charts, video grids, code blocks
- **File operations**: upload, browse, drag-and-drop
- **Dark theme** with CSS custom properties

---

## Backend (Express + Ollama)

**Location:** `server/`

### Entry Point: `server/index.js`
Express server with CORS, JSON parsing (10MB limit), request logging with IP extraction. Mounts all route modules and starts on port 3000.

### Core Pipeline

| File | Role |
|------|------|
| `planner.js` | **Intent router** — 5-layer pipeline: certainty branches (45+ regex patterns with compound guards), hardcoded compound patterns, generic chain detection, LLM Sequential Logic Engine (JSON decomposer), single-tool LLM classifier fallback |
| `executor.js` | **Tool dispatcher** — Resolves tool names, passes full message objects (text + context) to tools in the "includes" list, extracts text-only for others. Special email handling. |
| `utils/coordinator.js` | **Multi-step orchestrator** — Executes step arrays sequentially, builds `enrichedContext` with chain context piping (`previousTool`, `previousOutput`, `previousSuccess`), dependency resolution, Train of Thought event emission |

### LLM Integration: `tools/llm.js`
- **Non-streaming**: `llm(prompt, { timeoutMs, model, format, options })` — supports `format: "json"` for structured output, `options: { num_predict }` for token control
- **Streaming**: `llmStream(prompt, onChunk, options)` — chunk-guarded with max chunks and timeout
- **Default model**: `qwen2.5-coder:14b` via Ollama at `localhost:11434/api/generate`

---

## Tool Categories (43 Tools)

All tools are registered in `server/tools/index.js` and exported as the `TOOLS` object. Each is an async function returning `{ tool, success, final, data }`.

### 1. General Intelligence
| Tool | File | Description |
|------|------|-------------|
| `llm` | `llm.js` | General conversation, explanations, creative writing, summarization |
| `memorytool` | `memoryTool.js` | Persistent user profile: name, email, location, contacts, preferences |
| `contacts` | `contacts.js` | Contact book management (add, update, search, list) |
| `nlp_tool` | `nlp.js` | Sentiment analysis, entity extraction, text classification |
| `selfImprovement` | `selfImprovement.js` | Routing accuracy diagnostics, performance reports |

### 2. Information & Search
| Tool | File | Description |
|------|------|-------------|
| `search` | `search.js` | 6-source parallel web search (Wikipedia, Google, Yandex, DuckDuckGo, Bing, Yahoo) with LLM synthesis |
| `news` | `news.js` | 19+ RSS feeds, 7 category groups, LLM article summaries |
| `weather` | `weather.js` | OpenWeather API: current + forecast by city or saved location |
| `x` | `x.js` | X/Twitter trends, tweet search, LLM sentiment analysis (via `agent-twitter-client`) |

### 3. Productivity & Communication
| Tool | File | Description |
|------|------|-------------|
| `email` | `email.js` | Gmail OAuth send/draft/read/search, chain context formatting per tool type |
| `tasks` | `tasks.js` | Todo/task/reminder management |
| `calendar` | `calendar.js` | Google Calendar integration, event extraction to Excel |
| `whatsapp` | `whatsapp.js` | WhatsApp Business Cloud API: single send, bulk Excel send, two-way bot loop |
| `scheduler` | `scheduler.js` | Recurring task automation (interval, daily, one-time) — now actually executes tasks through the full agent pipeline |
| `workflow` | `workflowTool.js` | Named workflow management (morning briefing, market check, etc.) |

### 4. File & Code Operations
| Tool | File | Description |
|------|------|-------------|
| `file` | `file.js` | Read/write/list files and folders |
| `fileWrite` | `fileWrite.js` | Create/write files with LLM-powered code generation ("Nuclear Option" extraction with `===CODE_START===`/`===CODE_END===` boundaries) |
| `fileReview` | `fileReview.js` | File content review and analysis |
| `review` | `review.js` | Code review with LLM analysis (supports Windows absolute paths, 30K char truncation) |
| `duplicateScanner` | `duplicateScanner.js` | Find duplicate files by content hash |
| `applyPatch` | `applyPatch.js` | Apply code patches/diffs to files |

### 5. Developer Tools
| Tool | File | Description |
|------|------|-------------|
| `github` | `github.js` | GitHub API: repos, issues, PRs, commits |
| `githubTrending` | `githubTrending.js` | Trending GitHub repositories |
| `gitLocal` | `gitLocal.js` | Local git operations (status, diff, commit, branch) |
| `packageManager` | `packageManager.js` | npm install/uninstall/update/list |
| `webDownload` | `webDownload.js` | Download files from URLs |

### 6. Code Guru Tools
| Tool | File | Description |
|------|------|-------------|
| `codeReview` | `codeReview.js` | Deep code review (security, performance, quality, architecture) using `qwen2.5-coder:7b` |
| `codeTransform` | `codeTransform.js` | Refactor, optimize, rewrite, add docs/types to code |
| `folderAccess` | `folderAccess.js` | Browse folders, directory trees, folder stats |
| `projectGraph` | `projectGraph.js` | Dependency graph, circular deps, dead code detection |
| `projectIndex` | `projectIndex.js` | Semantic code search, function/class lookup |
| `githubScanner` | `githubScanner.js` | Scan GitHub for patterns, tool discovery |
| `selfEvolve` | `selfEvolve.js` | Autonomous code improvement: scan GitHub + apply upgrades |

### 7. Finance & Shopping
| Tool | File | Description |
|------|------|-------------|
| `finance` | `finance.js` | Stock quotes, market data (Alpha Vantage, Finnhub, FMP) |
| `financeFundamentals` | `financeFundamentals.js` | P/E ratios, balance sheets, income statements |
| `shopping` | `shopping.js` | Product search, price comparison |

### 8. Media & Entertainment
| Tool | File | Description |
|------|------|-------------|
| `youtube` | `youtube.js` | YouTube video search with grid display |
| `sports` | `sports.js` | Live scores, fixtures, leagues (football, basketball, etc.) |
| `lotrJokes` | `lotrJokes.js` | Lord of the Rings themed jokes |

### 9. Web & Social
| Tool | File | Description |
|------|------|-------------|
| `webBrowser` | `webBrowser.js` | Headless browser: navigate, screenshot, interact with pages |
| `moltbook` | `moltbook.js` | Moltbook social platform: 25+ actions (post, heartbeat, DMs, communities) |

### 10. Advanced Intelligence
| Tool | File | Description |
|------|------|-------------|
| `documentQA` | `documentQA.js` | RAG-based document Q&A with vector embeddings |

---

## Routing Pipeline (Planner)

**File:** `server/planner.js` (~1400 lines)

The planner uses a 5-layer routing pipeline:

1. **Certainty Layer** — 45+ regex-based pattern branches. Each checks `!hasCompoundIntent()` guard before returning a single-tool step. Covers weather, email, whatsapp, X/Twitter, finance, sports, calendar, code review, scheduler, etc. ~90% of single-intent queries are caught here.

2. **Compound Pattern Layer** — Hardcoded regex patterns for common multi-step flows:
   - `review X and create improved version` → [review, fileWrite]
   - `X, then Y, then Z` → [inferredTool(X), inferredTool(Y), inferredTool(Z)]
   - `content + whatsapp to NUMBER` → [contentTool, whatsapp]
   - `content + email me` → [contentTool, email]
   - `email me the news/weather/X trends` → [contentTool, email]

3. **LLM Sequential Logic Engine** — `decomposeIntentWithLLM()`: Sends the query to the LLM with JSON mode, asking it to return `[{tool, input, reasoning}]` arrays. Validates with `tryParseStepsJSON()`, retries once on parse failure. **Chain Linking Logic** auto-detects codeReview→fileWrite sequences and staples `generateImproved: true`.

4. **Single-Tool LLM Classifier** — `detectIntentWithLLM()`: Safety net fallback. Returns one tool name.

5. **Ultimate Fallback** — `llm` tool for general conversation.

**Helper functions:**
- `hasCompoundIntent(text)` — 11 regex patterns detecting multi-tool queries
- `inferToolFromText(text)` — Maps step descriptions to tool names
- `resolveToolName(raw, available)` — Alias map + case-insensitive + partial matching
- `extractContextSignals(text)` — Detects file paths, finance keywords, weather terms, etc.

---

## Multi-Step Execution (Coordinator)

**File:** `server/utils/coordinator.js`

Orchestrates multi-step plans from the planner:
1. Iterates through step array sequentially
2. Builds `enrichedContext` per step: spreads step context, adds emotional tone, chain context from previous step
3. Creates `stepMessage = { text, context }` and calls `executor.execute()`
4. Emits Train of Thought SSE events: `thought`, `plan`, `execution`, `observation`, `answer`
5. Collects results into `stateGraph` array for audit and UI display

**Context piping:** When a step has `useChainContext: true` or `useLastResult: true`, the coordinator injects:
```javascript
enrichedContext.chainContext = {
  previousTool: prevStep.tool,
  previousOutput: prevStep.output,
  previousSuccess: prevStep.success
}
```

---

## Key Utilities

**Location:** `server/utils/`

| File | Purpose |
|------|---------|
| `config.js` | Environment variable management, API key warnings, CONFIG object with helper methods |
| `coordinator.js` | Multi-step orchestration (see above) |
| `conversationMemory.js` | Persistent conversation history storage |
| `credentialStore.js` | Encrypted credential storage (AES-256-GCM) |
| `cache.js` | General-purpose cache with TTL |
| `cacheReview.js` | Code review result caching |
| `fetch.js` | HTTP request helpers with timeout |
| `httpClient.js` | Advanced HTTP client |
| `googleOAuth.js` | Google OAuth2 flow for Gmail + Calendar |
| `emailDrafts.js` | Email draft persistence |
| `emailVerification.js` | Email address validation |
| `geo.js` | Geolocation utilities |
| `fileRegistry.js` | File tracking and metadata |
| `vectorStore.js` | Vector embeddings for document QA |
| `nlpUtils.js` | NLP helper functions |
| `intentClassifier.js` | Intent classification utilities |
| `agentPool.js` | Multi-agent task pool |
| `auditLog.js` | JSONL-based audit logging |
| `jsonlLogger.js` | Structured JSONL logger |
| `sessionManager.js` | Session state management |
| `scheduler.js` | Legacy scheduler utilities |
| `styleEngine.js` | Response styling/formatting |
| `suggestions.js` | Smart suggestion generation |
| `workflow.js` | Workflow execution engine |
| `uiUtils.js` | UI formatting helpers |
| `tradingview.js` | TradingView chart integration |
| `yahoo.js` | Yahoo Finance data fetching |

---

## API Routes

**Location:** `server/routes/`

| Route | File | Purpose |
|-------|------|---------|
| `POST /chat` | `chat.js` | Main SSE endpoint: planner → coordinator → executor pipeline with 15s heartbeat |
| `/api/conversations` | `conversations.js` | CRUD for conversation history |
| `/api/files` | `files.js` | File upload/download/list |
| `/api/review` | `review.js` | Code review API |
| `/api/duplicates` | `duplicates.js` | Duplicate file scanning |
| `/api/browse` | `browse.js` | File system browsing |
| `/oauth/callback` | `oauthCallback.js` | Google OAuth2 callback |
| `/webhook/whatsapp` | `whatsappWebhook.js` | WhatsApp two-way bot: receive → agent pipeline → auto-reply |

---

## Environment Variables

Key variables in `server/.env`:

| Variable | Purpose |
|----------|---------|
| `LLM_MODEL` | Ollama model (default: `qwen2.5-coder:14b`) |
| `LLM_API_URL` | Ollama endpoint (default: `http://localhost:11434/`) |
| `SERPAPI_KEY` | Web search (6-source) |
| `OPENWEATHER_KEY` | Weather API |
| `ALPHA_VANTAGE_KEY` / `FINNHUB_KEY` / `FMP_API_KEY` | Finance data |
| `SPORTS_API_KEY` | Sports scores |
| `YOUTUBE_API_KEY` | YouTube search |
| `GOOGLE_CLIENT_ID` + `SECRET` + `REDIRECT_URI` | Gmail + Calendar OAuth |
| `TWITTER_USERNAME` + `PASSWORD` + `EMAIL` | X/Twitter (agent-twitter-client) |
| `WHATSAPP_TOKEN` + `PHONE_ID` + `VERIFY_TOKEN` | WhatsApp Business API |
| `CREDENTIAL_MASTER_KEY` | AES-256 encryption for stored credentials |
| `GITHUB_TOKEN` | GitHub API access |

---

## Recent Sprints & Changelog

### Sprint 8 (Current)
- **X (Twitter) tool**: Trends, tweet search, LLM sentiment analysis via `agent-twitter-client`
- **Scheduler execution**: Scheduled tasks now actually run through the planner→coordinator pipeline
- **Two-way WhatsApp bot**: Incoming messages auto-processed and replied to
- **Compound routing for X**: X→email, X→whatsapp multi-step chains
- **Code review upgrades**: Switched to `qwen2.5-coder:7b` for fast reviews, increased timeouts, fixed fake success bug
- **fileWrite Nuclear Option**: `===CODE_START===`/`===CODE_END===` boundaries, `num_predict: 8192`, changelog extraction
- **Planner JSON mode**: `format: "json"` for structured LLM output, path sanitization, Chain Linking Logic

### Sprint 7
- **Multi-step intent decomposition** (Sequential Logic Engine): JSON-based LLM decomposer with retry
- **Compound intent guards**: `hasCompoundIntent()` on all certainty branches
- **WhatsApp flexible parsing**: 9+ intent patterns, no "saying" keyword required
- **Train of Thought display**: THOUGHT/PLAN/EXECUTION/OBSERVATION/ANSWER phases in UI
- **Email chain context piping**: Smart per-tool formatting (news headlines, weather reports)

### Sprint 6
- **Orchestrator-subagent architecture**: Chat vs task agents with agentPool
- **Code Guru tools**: codeReview, codeTransform, folderAccess, projectGraph, projectIndex, githubScanner, selfEvolve
- **Workflow engine**: Named workflows (morning briefing, market check)
- **Scheduler tool**: Recurring/one-time tasks with persistence

### Earlier Sprints
- **Sprint 5**: Moltbook integration (25+ actions), WhatsApp bulk Excel send
- **Sprint 4**: Gmail OAuth, Google Calendar, document QA with vector embeddings
- **Sprint 3**: News RSS (19+ feeds), sports, YouTube, financial fundamentals
- **Sprint 2**: Web browser, GitHub integration, git local, package manager
- **Sprint 1**: Core agent: calculator, finance, search, file, memory, LLM chat

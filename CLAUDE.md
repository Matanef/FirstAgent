# 🤖 CLAUDE.md - local-llm-ui Master Directives

## 🏗️ System Architecture & Orchestration
This is an advanced local AI agent ecosystem driven by a strict pipeline.
* **Orchestrator** (`server/agents/orchestrator.js`): Routes user messages to chatAgent or taskAgent.
* **Planner** (`server/planner.js`): Uses a Certainty Layer and an LLM Decomposer for dynamic, conversational multi-step intents.
* **Workflow Engine** (`server/utils/workflow.js`): Executes saved, reusable multi-step sequences. *Note: Workflows bypass the conversational planner and require specific syntax to trigger/create (e.g., "Create a workflow:", "Every morning:", etc.).*
* **Executor** (`server/executor.js`): Runs tools and pipes data between them.
* **Tools** (`server/tools/`): Atomic, single-purpose skills.

**CRITICAL RULE: NO MANAGER TOOLS.**
NEVER invent tools that act as "Orchestrators", "Pipelines", or "Managers". The `planner.js` and `workflow.js` already handle multi-tool chaining natively.

## 🧱 Tool Architecture & Isolation
**STRICT RULE:** All NEW tools must be completely isolated. They CANNOT import, invoke, or depend on other tools directly. 
**LEGACY EXCEPTIONS:** Existing tools (created prior to this rule) that currently import other tools are grandfathered in. Do not attempt to refactor or "fix" these legacy tools to separate them unless explicitly instructed by the user.

## 🚫 Anti-Hallucination Shield (Dependencies)
You are strictly confined to the existing package ecosystem. Even if you detect other packages installed in the environment (e.g., `xlsx`, `cheerio`, `natural` used by legacy tools), **YOU ARE FORBIDDEN FROM USING THEM IN NEW TOOLS.**
* **Environment:** Node.js with ES Modules (`import`/`export` ONLY).
* **Allowed npm Packages (STRICT):** `agent-twitter-client`, `axios`, `lodash`, `ngrok`. You may ONLY use these.
* **Node Built-ins:** `fs`, `fs/promises`, `path`, `crypto`, `child_process`, `os`, `url`.
* **Banned Behavior:** Do NOT use `node-fetch`, `natural`, `compromise`, `xlsx`, `cheerio`, or external LLM SDKs in any new files. Use native `fetch` or `axios` for HTTP requests.

## 🛠️ Tool Development Contract
Every file in `server/tools/` is an atomic skill. You MUST adhere to this exact signature:

**1. Exports**
The main function must be `export async function toolName(request)`.

**2. Input Handling**
`request` can be a string OR an object `{ text, context }`. Tools must parse this defensively (e.g., check `typeof`).

**3. Chain Context Integration**
If your tool analyzes text, always check for `context.chainContext.previousOutput` to process data passed from previous steps in the ToT planner or the workflow engine.

**4. Required Response Format (Success)**
Must return a flat object: `{ tool: "toolName", success: true, final: true, data: { text: "...", preformatted: true } }`

**5. Required Response Format (Error & Recovery)**
Must return a flat object: `{ tool: "toolName", success: false, final: true, error: "Action failed: [Specific Reason]" }`. 
*Do not crash the agent on expected tool failures; return the error gracefully so the planner can attempt a recovery or notify the user.*

## 🧠 Centralized LLM Usage
Never import API clients for LLMs. All AI generations inside tools MUST route through the central wrapper: `import { llm, llmStream } from "./llm.js";`

## 💾 Memory & Configuration
* **Config:** Import environment variables via `import { CONFIG } from "../utils/config.js";`
* **Memory:** Use `import { getMemory, saveJSON, MEMORY_FILE } from "../memory.js";`
* **Project Boundary:** File operations must resolve paths against `PROJECT_ROOT`.

## 🔒 Git Lock File Recovery
This repo uses multiple Claude worktrees that share `.git/`. This causes `index.lock` race conditions.
**When `git add` or `git commit` fails with "Unable to create index.lock":**
1. Try `powershell -Command "Remove-Item '.git/index.lock' -Force"` (PowerShell bypasses POSIX busy-file errors)
2. If that says "does not exist", the lock is ephemeral — retry the git command immediately after the PowerShell call in a single chained command
3. If it persists, stage files one at a time in a `for` loop: `for f in file1 file2; do git add "$f" 2>/dev/null; done` — some will succeed between lock windows
4. For any file that still fails, use the PowerShell-then-git pattern: `powershell -Command "Remove-Item '.git/index.lock' -Force; & git add <file>; Write-Host 'done'"`
5. **Never** kill the bash/node processes listed in `Get-Process` — they are the agent server and other Claude sessions

## 🎭 Persona & Context Injection
* **Agent Identity:** The agent's identity (Lanou) and worldview are managed dynamically via `server/personality.js`. 
* **NEVER HARDCODE PERSONAS:** Do not write prompts that start with "You are a helpful AI...".
* **Text Generation:** If you create a new tool that generates user-facing text (e.g., social posts, emails, creative writing), you MUST import and inject `getPersonalityContext()` or `getPersonalitySummary()` from `../personality.js` into the LLM prompt so the agent maintains its unified voice.
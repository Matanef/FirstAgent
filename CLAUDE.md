# 🤖 CLAUDE.md - Obsidian Knowledge OS & Agent Directives

## 🗺️ Codebase Geography (Token Saver Map)
Do not guess file paths. Use this map to navigate the architecture efficiently:
* **Agents & Context (`server/agents/`)**:
  * `chatAgent.js`: **Long-Term Memory Hub.** Builds the conversational prompt context. This is where VectorStore RAG retrieval (e.g., querying `research-{slug}-conclusions`) is injected to make the agent "remember" past research.
  * `taskAgent.js`: Execution loop for multi-step tool use.
  * `orchestrator.js`: The router. Handles `pendingQuestion` pauses and resumes.
* **Skills vs. Tools**:
  * `server/skills/`: **Complex, modular pipelines.** (e.g., `deepResearch/` package, `obsidianWriter.js`). Permitted to have sub-directories and multi-file architectures.
  * `server/tools/`: **Atomic, single-file skills.** (e.g., `calculator.js`, `weather.js`). Must remain isolated.
* **Core Utilities (`server/utils/`)**:
  * `vectorStore.js`: Handles Ollama-embeddings and file-backed vector retrieval.
  * `obsidianUtils.js`: Markdown, Frontmatter, and Vault I/O.
  * `conversationMemory.js`: Chat history and short-term conversational turns.
  * `writingRules.js` & `agent-constraints.json`: RAG formatting and academic linting rules.

## 🧠 Long-Term Learning Loop (RAG)
The agent integrates deep research into its continuous memory via the `chatAgent.js` context builder.
* **Collections:** Research is indexed in `server/utils/vectorStore.js` under deterministic names: `research-{slug}-conclusions` and `research-{slug}-p{N}-articles`.
* **Retrieval:** When formatting the context window in `chatAgent.js`, query the `vectorStore` to pull relevant insights from past research without re-fetching from the web.

## 🧱 Skill/Tool Development Contract
Every executable skill or tool MUST adhere to this exact signature:

**1. Exports & Input Handling**
```javascript
export async function toolName(request) {
  const text = typeof request === "string" ? request : (request?.text || "");
  const context = typeof request === "object" ? (request?.context || {}) : {};
  // ...
}

2. Required Output Format (Success)
Must return a flat object:
{ tool: "toolName", success: true, final: true, data: { text: "...", preformatted: true } }

3. Required Output Format (Error/Failure)
Do not crash the pipeline. Return graceful errors:
{ tool: "toolName", success: false, final: true, error: "Action failed: Specific Reason" }

4. Pending Questions (Asynchronous UX)
If a skill requires user input (e.g., depth selection), it must use server/utils/pendingQuestion.js to pause execution, returning { success: true, final: false, awaitingUser: true, data: { text: "..." } }.
🚫 Anti-Hallucination & Dependency Shield

You are strictly confined to the existing package ecosystem.
    Allowed External Packages (STRICT): agent-twitter-client, axios, lodash, ngrok.
    Node Built-ins: fs, fs/promises, path, crypto, child_process, os, url.
    Banned Behavior: NEVER import node-fetch, natural, compromise, xlsx, cheerio, or external LLM SDKs (OpenAI/Anthropic).
    Central LLM: All generation MUST route through import { llm } from "../tools/llm.js";

🔒 Windows/Git Lock File Recovery
This repo uses multiple Claude worktrees that share .git/, causing index.lock race conditions.
When git add or git commit fails with "Unable to create index.lock":

    Try powershell -Command "Remove-Item '.git/index.lock' -Force" (PowerShell bypasses POSIX busy-file errors).
    If it persists, stage files one at a time in a for loop: for f in file1 file2; do git add "$f" 2>/dev/null; done
    For stubborn files, chain it: powershell -Command "Remove-Item '.git/index.lock' -Force; & git add <file>"
    Never kill the bash/node processes in Get-Process — they are the agent server and other Claude sessions.

🔀 Pull Request Workflow (No gh CLI)
    Branch: git checkout -b <branch-name>
    Push: git push -u origin <branch-name>
    Output the exact PR URL: https://github.com/Matanef/FirstAgent/pull/new/<branch-name>
    Provide a markdown-formatted PR body (Summary & Test Plan) in the chat so the user can copy/paste it into GitHub.
    Return to main: git checkout main
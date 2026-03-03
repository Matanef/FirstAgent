// server/utils/agentPool.js
// Multi-Agent Collaboration — spawn parallel sub-agents for concurrent tasks
// Coordinator manages delegation, result aggregation, and context sharing

import { llm } from "../tools/llm.js";

// ============================================================
// AGENT TYPES
// ============================================================

const AGENT_ROLES = {
  researcher: {
    name: "Researcher",
    description: "Gathers information from search, web, and news tools",
    tools: ["search", "news", "webDownload", "webBrowser"],
    systemPrompt: "You are a research agent. Gather comprehensive information about the topic. Be thorough and cite sources.",
  },
  analyst: {
    name: "Analyst",
    description: "Analyzes data from finance, sports, and other structured sources",
    tools: ["finance", "financeFundamentals", "sports", "calculator"],
    systemPrompt: "You are a data analyst agent. Analyze numbers, trends, and patterns. Provide data-driven insights.",
  },
  communicator: {
    name: "Communicator",
    description: "Handles email, messaging, and social interactions",
    tools: ["email", "moltbook", "contacts"],
    systemPrompt: "You are a communication agent. Draft messages, manage emails, and handle social interactions professionally.",
  },
  developer: {
    name: "Developer",
    description: "Handles code review, git operations, and file management",
    tools: ["review", "gitLocal", "file", "fileWrite", "github"],
    systemPrompt: "You are a developer agent. Review code, manage git operations, and handle file operations efficiently.",
  },
  organizer: {
    name: "Organizer",
    description: "Manages tasks, calendar, and scheduling",
    tools: ["tasks", "calendar", "memorytool"],
    systemPrompt: "You are an organizer agent. Manage tasks, schedule events, and keep things organized.",
  },
};

// ============================================================
// AGENT EXECUTION
// ============================================================

/**
 * A lightweight agent that executes a single task with a specific role
 */
class SubAgent {
  constructor(role, id) {
    this.role = role;
    this.id = id;
    this.config = AGENT_ROLES[role] || AGENT_ROLES.researcher;
    this.status = "idle"; // idle, running, completed, failed
    this.result = null;
    this.startTime = null;
    this.endTime = null;
  }

  async execute(task, toolExecutor) {
    this.status = "running";
    this.startTime = Date.now();

    console.log(`[agentPool] Agent ${this.id} (${this.config.name}) starting: "${task}"`);

    try {
      // Determine which tool to use for this task
      const tool = this._selectTool(task);

      // Execute the tool
      const result = await toolExecutor(tool, task, {
        agentRole: this.role,
        agentId: this.id,
      });

      this.result = {
        success: result?.success ?? true,
        tool,
        output: result?.data?.text || result?.output || JSON.stringify(result?.data || {}).slice(0, 1000),
        data: result?.data,
      };
      this.status = "completed";
    } catch (err) {
      this.result = {
        success: false,
        error: err.message,
      };
      this.status = "failed";
    }

    this.endTime = Date.now();
    const elapsed = this.endTime - this.startTime;
    console.log(`[agentPool] Agent ${this.id} (${this.config.name}) ${this.status} in ${elapsed}ms`);

    return this.result;
  }

  _selectTool(task) {
    const lower = task.toLowerCase();

    // Match task to available tools for this role
    for (const tool of this.config.tools) {
      const patterns = {
        search: /\b(search|find|look\s+up|research)\b/,
        news: /\b(news|headlines?|articles?)\b/,
        webDownload: /\b(web|url|http|website|fetch)\b/,
        webBrowser: /\b(browse|visit|navigate)\b/,
        finance: /\b(stock|price|market|ticker|finance)\b/,
        financeFundamentals: /\b(fundamentals|earnings|revenue|balance\s+sheet)\b/,
        sports: /\b(score|match|game|league|team|fixture)\b/,
        calculator: /\b(calculate|compute|math|solve)\b/,
        email: /\b(email|mail|inbox|send)\b/,
        moltbook: /\b(moltbook|post|comment|social)\b/,
        contacts: /\b(contact|phone|address)\b/,
        review: /\b(review|inspect|examine|audit)\b/,
        gitLocal: /\b(git|commit|branch|status|diff)\b/,
        file: /\b(file|read|list|directory)\b/,
        fileWrite: /\b(write|create|save)\b/,
        github: /\b(github|repo|pull\s+request|issue)\b/,
        tasks: /\b(task|todo|reminder)\b/,
        calendar: /\b(calendar|event|meeting|schedule)\b/,
        memorytool: /\b(remember|memory|profile)\b/,
      };

      if (patterns[tool]?.test(lower)) {
        return tool;
      }
    }

    // Default to first tool in the role's list
    return this.config.tools[0];
  }

  toJSON() {
    return {
      id: this.id,
      role: this.role,
      name: this.config.name,
      status: this.status,
      result: this.result,
      elapsed: this.endTime && this.startTime ? this.endTime - this.startTime : null,
    };
  }
}

// ============================================================
// AGENT POOL
// ============================================================

let _agentCounter = 0;

/**
 * Determine which agent roles are needed for a multi-part request
 */
export function planAgents(query) {
  const lower = (query || "").toLowerCase();
  const needed = [];

  // Detect which domains the query spans
  if (/\b(search|find|look\s+up|research|web|information|learn|who|what|where|how)\b/.test(lower) &&
      !/\b(file|code|git)\b/.test(lower)) {
    needed.push("researcher");
  }
  if (/\b(stock|finance|market|price|trading|earnings|sports?|score|match|game)\b/.test(lower)) {
    needed.push("analyst");
  }
  if (/\b(email|mail|send|message|moltbook|post|contact)\b/.test(lower)) {
    needed.push("communicator");
  }
  if (/\b(code|git|review|file|commit|branch|repo)\b/.test(lower)) {
    needed.push("developer");
  }
  if (/\b(task|todo|calendar|schedule|event|meeting|remind|organize)\b/.test(lower)) {
    needed.push("organizer");
  }

  // If nothing matched, use researcher as default
  if (needed.length === 0) {
    needed.push("researcher");
  }

  return needed;
}

/**
 * Split a complex query into sub-tasks for different agents
 */
export async function decomposeTask(query, roles) {
  if (roles.length <= 1) {
    return [{ role: roles[0] || "researcher", task: query }];
  }

  // Use LLM to decompose the task
  const roleDescriptions = roles.map(r => `- ${r}: ${AGENT_ROLES[r]?.description || "general"}`).join("\n");

  const prompt = `Break this user request into sub-tasks for the following specialized agents:

${roleDescriptions}

USER REQUEST: "${query}"

For each agent, provide a clear, focused sub-task. Format your response as:
AGENT_ROLE: sub-task description

Only include agents that are actually needed. Be concise.`;

  try {
    const response = await llm(prompt);
    const text = response?.data?.text || "";

    const tasks = [];
    const lines = text.split("\n").filter(l => l.trim());

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)/);
      if (match) {
        const role = match[1].toLowerCase();
        if (roles.includes(role)) {
          tasks.push({ role, task: match[2].trim() });
        }
      }
    }

    // If parsing failed, give each role the full query
    if (tasks.length === 0) {
      return roles.map(role => ({ role, task: query }));
    }

    return tasks;
  } catch {
    return roles.map(role => ({ role, task: query }));
  }
}

/**
 * Execute multiple agents in parallel
 * @param {string} query - The user's request
 * @param {Function} toolExecutor - async function(tool, input, context)
 * @param {Function} onAgentUpdate - optional callback for real-time updates
 * @returns {Object} Combined results from all agents
 */
export async function executeParallel(query, toolExecutor, onAgentUpdate) {
  const roles = planAgents(query);

  console.log(`[agentPool] Planning ${roles.length} agent(s) for: "${query}"`);
  console.log(`[agentPool] Roles: ${roles.join(", ")}`);

  const subtasks = await decomposeTask(query, roles);

  // Create and execute agents in parallel
  const agents = subtasks.map(({ role, task }) => {
    const agent = new SubAgent(role, `agent_${++_agentCounter}`);
    return { agent, task };
  });

  if (onAgentUpdate) {
    for (const { agent } of agents) {
      onAgentUpdate({ type: "agent_start", agent: agent.toJSON() });
    }
  }

  // Execute all agents concurrently
  const promises = agents.map(async ({ agent, task }) => {
    const result = await agent.execute(task, toolExecutor);
    if (onAgentUpdate) {
      onAgentUpdate({ type: "agent_complete", agent: agent.toJSON() });
    }
    return agent;
  });

  const completedAgents = await Promise.all(promises);

  // Aggregate results
  const results = completedAgents.map(a => a.toJSON());
  const allSucceeded = results.every(r => r.result?.success);

  // Build combined summary
  const summaryParts = results.map(r => {
    const icon = r.result?.success ? "OK" : "FAILED";
    return `**${r.name}** [${icon}]: ${r.result?.output || r.result?.error || "No output"}`;
  });

  return {
    success: allSucceeded,
    agentCount: results.length,
    agents: results,
    summary: summaryParts.join("\n\n---\n\n"),
  };
}

/**
 * Synthesize results from multiple agents into a unified response
 */
export async function synthesizeResults(query, agentResults) {
  if (agentResults.agents.length <= 1) {
    return agentResults.agents[0]?.result?.output || "No results.";
  }

  const resultsSummary = agentResults.agents.map(a =>
    `[${a.name}]: ${a.result?.output || a.result?.error || "No output"}`
  ).join("\n\n");

  const prompt = `You are synthesizing results from multiple specialized agents into a unified response.

USER QUESTION: "${query}"

AGENT RESULTS:
${resultsSummary}

Combine these results into a single, coherent response. Reference all relevant information from each agent. Be comprehensive but concise.`;

  try {
    const response = await llm(prompt);
    return response?.data?.text || agentResults.summary;
  } catch {
    return agentResults.summary;
  }
}

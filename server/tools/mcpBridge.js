// server/tools/mcpBridge.js
// MCP Bridge — Model Context Protocol client for dynamic tool discovery
// Connects to local MCP servers over stdio, caches connections, and proxies tool calls.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CONFIG } from "../utils/config.js";

// ──────────────────────────────────────────────────────────────────────
// CONNECTION CACHE
// Keeps MCP server child processes alive between requests.
// Key = server name (e.g., "sqlite"), Value = { client, transport, connectedAt }
// If a server crashes, it's evicted from the cache on the next failed call.
// ──────────────────────────────────────────────────────────────────────
const connectionCache = new Map();

// Maximum time (ms) a cached connection stays alive before being recycled
const MAX_CONNECTION_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Parse the MCP_SERVERS configuration.
 * Expects a JSON string or object mapping server names to their spawn config.
 *
 * @example
 * // CONFIG.MCP_SERVERS (as JSON string in .env):
 * // {"sqlite": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite", "test.db"]}}
 *
 * @returns {Object} Map of server name → { command, args, env? }
 */
function getServerConfigs() {
  const raw = CONFIG.MCP_SERVERS;
  if (!raw) return {};

  if (typeof raw === "object") return raw;

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[mcpBridge] Failed to parse MCP_SERVERS config:", err.message);
    return {};
  }
}

/**
 * Connect to an MCP server by name, using the cached connection if available.
 * Spawns the server as a child process via StdioClientTransport.
 *
 * @param {string} serverName - Name matching a key in MCP_SERVERS config
 * @returns {Client} Connected MCP client
 * @throws {Error} If server is not configured or connection fails
 */
async function getOrCreateConnection(serverName) {
  // Check cache — reuse if alive and not stale
  if (connectionCache.has(serverName)) {
    const cached = connectionCache.get(serverName);
    const age = Date.now() - cached.connectedAt;

    if (age < MAX_CONNECTION_AGE_MS) {
      return cached.client;
    }

    // Connection is stale — close and reconnect
    console.log(`[mcpBridge] Recycling stale connection to "${serverName}" (age: ${(age / 60000).toFixed(1)}m)`);
    await closeConnection(serverName);
  }

  const configs = getServerConfigs();
  const serverConfig = configs[serverName];

  if (!serverConfig) {
    throw new Error(`MCP server "${serverName}" is not configured. Available: ${Object.keys(configs).join(", ") || "none"}`);
  }

  if (!serverConfig.command) {
    throw new Error(`MCP server "${serverName}" is missing the "command" field in its config.`);
  }

  console.log(`[mcpBridge] Connecting to MCP server "${serverName}": ${serverConfig.command} ${(serverConfig.args || []).join(" ")}`);

  // Spawn the MCP server process via stdio transport
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args || [],
    env: { ...process.env, ...(serverConfig.env || {}) }
  });

  const client = new Client(
    { name: "lanou-agent", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(`Failed to connect to MCP server "${serverName}": ${err.message}`);
  }

  // Cache the connection
  connectionCache.set(serverName, {
    client,
    transport,
    connectedAt: Date.now()
  });

  console.log(`[mcpBridge] Connected to "${serverName}" — cached`);
  return client;
}

/**
 * Gracefully close a cached connection and remove it from the cache.
 *
 * @param {string} serverName - The server to disconnect
 */
async function closeConnection(serverName) {
  if (!connectionCache.has(serverName)) return;

  const cached = connectionCache.get(serverName);
  connectionCache.delete(serverName);

  try {
    await cached.client.close();
  } catch (err) {
    console.warn(`[mcpBridge] Error closing "${serverName}":`, err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// INTENT PARSING
// Detects what the user wants: list servers, list tools, or call a tool
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse the user's request into an MCP action.
 *
 * @param {string} text - The user's message
 * @param {Object} context - Optional context with action/server/toolName/args
 * @returns {{ action: string, server?: string, toolName?: string, args?: object }}
 *
 * @example
 * parseIntent("list mcp servers")
 * // → { action: "list_servers" }
 *
 * @example
 * parseIntent("list tools on sqlite")
 * // → { action: "list_tools", server: "sqlite" }
 *
 * @example
 * parseIntent("call read_query on sqlite with {\"query\": \"SELECT * FROM users\"}")
 * // → { action: "call_tool", server: "sqlite", toolName: "read_query", args: { query: "SELECT * FROM users" } }
 */
function parseIntent(text, context = {}) {
  // Context overrides take priority (from planner or chain context)
  if (context.action) {
    return {
      action: context.action,
      server: context.server || null,
      toolName: context.toolName || null,
      args: context.args || {}
    };
  }

  const lower = text.toLowerCase();

  // Intent: list available MCP servers
  // Matches: "list mcp servers", "what mcp servers", "show mcp servers", "available mcp"
  if (/\b(list|show|what|which|available)\b.*\bmcp\s*(server|connection|bridge)s?\b/i.test(lower) ||
      /\bmcp\s*(server|connection)s?\b.*\b(list|show|available)\b/i.test(lower)) {
    return { action: "list_servers" };
  }

  // Intent: list tools on a specific MCP server
  // Matches: "list tools on sqlite", "what tools does the postgres mcp have", "mcp sqlite tools"
  const listToolsMatch = lower.match(/\b(?:list|show|what|which)\b.*\btools?\b.*\b(?:on|from|for|in)\s+(\w+)/i) ||
                          lower.match(/\bmcp\s+(\w+)\s+tools?\b/i) ||
                          lower.match(/\btools?\b.*\bmcp\s+(?:server\s+)?(\w+)/i);
  if (listToolsMatch) {
    return { action: "list_tools", server: listToolsMatch[1] };
  }

  // Intent: call a specific tool on an MCP server
  // Matches: "call read_query on sqlite with {...}", "use sqlite mcp tool read_query"
  // Also: "ask sqlite to read_query {...}"
  const callMatch = lower.match(/\b(?:call|run|execute|use|invoke)\s+(\w+)\s+(?:on|from|via)\s+(\w+)/i) ||
                    lower.match(/\bask\s+(\w+)\s+(?:mcp\s+)?(?:to\s+)?(\w+)/i);
  if (callMatch) {
    // Extract JSON args if present — look for { ... } in the original text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let args = {};
    if (jsonMatch) {
      try { args = JSON.parse(jsonMatch[0]); } catch { /* not valid JSON, ignore */ }
    }

    // Determine which capture is server vs tool based on pattern
    // "call TOOL on SERVER" vs "ask SERVER to TOOL"
    const isAskPattern = /\bask\b/i.test(lower);
    return {
      action: "call_tool",
      server: isAskPattern ? callMatch[1] : callMatch[2],
      toolName: isAskPattern ? callMatch[2] : callMatch[1],
      args
    };
  }

  // Intent: disconnect/close a server
  // Matches: "disconnect sqlite mcp", "close mcp sqlite"
  const disconnectMatch = lower.match(/\b(?:disconnect|close|stop|kill)\s+(?:mcp\s+)?(\w+)/i);
  if (disconnectMatch) {
    return { action: "disconnect", server: disconnectMatch[1] };
  }

  // Fallback: show help
  return { action: "help" };
}

// ──────────────────────────────────────────────────────────────────────
// ACTION HANDLERS
// ──────────────────────────────────────────────────────────────────────

/**
 * List all configured MCP servers and their connection status.
 */
function handleListServers() {
  const configs = getServerConfigs();
  const serverNames = Object.keys(configs);

  if (serverNames.length === 0) {
    return "No MCP servers configured. Add MCP_SERVERS to your .env file as a JSON string.\n\n" +
      'Example: MCP_SERVERS={"sqlite": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite", "test.db"]}}';
  }

  let output = `**🔌 MCP Servers (${serverNames.length} configured)**\n\n`;
  for (const name of serverNames) {
    const cfg = configs[name];
    const cached = connectionCache.get(name);
    const status = cached ? `🟢 connected (${((Date.now() - cached.connectedAt) / 60000).toFixed(1)}m)` : "⚪ idle";
    output += `- **${name}**: \`${cfg.command} ${(cfg.args || []).join(" ")}\` — ${status}\n`;
  }

  output += "\n**Commands:**\n";
  output += '- "list tools on [server]" — discover available tools\n';
  output += '- "call [tool] on [server] with {...}" — execute a tool\n';
  output += '- "disconnect [server]" — close connection\n';

  return output;
}

/**
 * Connect to a server and list its available tools.
 *
 * @param {string} serverName - The server to query
 * @returns {Promise<string>} Formatted list of tools
 */
async function handleListTools(serverName) {
  const client = await getOrCreateConnection(serverName);

  const result = await client.listTools();
  const tools = result.tools || [];

  if (tools.length === 0) {
    return `MCP server "${serverName}" has no tools available.`;
  }

  let output = `**🧰 Tools on "${serverName}" (${tools.length})**\n\n`;
  for (const tool of tools) {
    output += `- **${tool.name}**`;
    if (tool.description) output += ` — ${tool.description}`;
    output += "\n";

    // Show parameter schema if available
    if (tool.inputSchema?.properties) {
      const params = Object.entries(tool.inputSchema.properties);
      if (params.length > 0) {
        const required = new Set(tool.inputSchema.required || []);
        output += `  Parameters: ${params.map(([k, v]) => `${k}${required.has(k) ? "*" : ""} (${v.type || "any"})`).join(", ")}\n`;
      }
    }
  }

  return output;
}

/**
 * Call a specific tool on an MCP server.
 *
 * @param {string} serverName - The server hosting the tool
 * @param {string} toolName - The tool to call
 * @param {Object} args - Arguments to pass to the tool
 * @returns {Promise<string>} Formatted result
 */
async function handleCallTool(serverName, toolName, args = {}) {
  const client = await getOrCreateConnection(serverName);

  console.log(`[mcpBridge] Calling ${serverName}.${toolName} with args:`, JSON.stringify(args).slice(0, 200));

  const result = await client.callTool({ name: toolName, arguments: args });

  // Format the result for display
  if (result.content && Array.isArray(result.content)) {
    // MCP tools return content as an array of { type, text } blocks
    const textParts = result.content
      .filter(c => c.type === "text")
      .map(c => c.text);

    if (textParts.length > 0) {
      return `**📋 ${serverName}.${toolName} result:**\n\n${textParts.join("\n\n")}`;
    }
  }

  // Fallback: stringify the raw result
  return `**📋 ${serverName}.${toolName} result:**\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

/**
 * Disconnect a specific MCP server.
 *
 * @param {string} serverName - The server to disconnect
 * @returns {string} Status message
 */
async function handleDisconnect(serverName) {
  if (!connectionCache.has(serverName)) {
    return `MCP server "${serverName}" is not currently connected.`;
  }

  await closeConnection(serverName);
  return `🔌 Disconnected from MCP server "${serverName}".`;
}

// ──────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ──────────────────────────────────────────────────────────────────────

/**
 * MCP Bridge — connects to Model Context Protocol servers and proxies tool calls.
 * Manages server lifecycle with connection caching to avoid spawning new processes
 * on every request. Supports listing servers, discovering tools, and calling tools.
 *
 * @description Bridges the agent to external MCP servers (databases, APIs, services)
 *   via the Model Context Protocol. Servers are configured in CONFIG.MCP_SERVERS.
 *
 * @param {string|object} request - User input (string or {text, context})
 *   context.action: "list_servers" | "list_tools" | "call_tool" | "disconnect"
 *   context.server: MCP server name (e.g., "sqlite")
 *   context.toolName: Tool to call on the server
 *   context.args: Arguments for the tool call
 *
 * @returns {object} Standard tool response
 *   { tool: "mcpBridge", success: boolean, final: true, data: { text, preformatted } }
 *
 * @example
 * const result = await mcpBridge("list mcp servers");
 * // → { tool: "mcpBridge", success: true, final: true, data: { text: "🔌 MCP Servers...", preformatted: true } }
 *
 * @example
 * const result = await mcpBridge({ text: "call read_query on sqlite", context: { args: { query: "SELECT 1" } } });
 * // → { tool: "mcpBridge", success: true, final: true, data: { text: "📋 sqlite.read_query result:...", preformatted: true } }
 */
export async function mcpBridge(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};

    const intent = parseIntent(text, context);
    console.log(`[mcpBridge] Action: ${intent.action}${intent.server ? `, server: ${intent.server}` : ""}${intent.toolName ? `, tool: ${intent.toolName}` : ""}`);

    let output;

    switch (intent.action) {
      case "list_servers":
        output = handleListServers();
        break;

      case "list_tools":
        if (!intent.server) {
          output = "Please specify which MCP server to query. Example: \"list tools on sqlite\"";
          break;
        }
        output = await handleListTools(intent.server);
        break;

      case "call_tool":
        if (!intent.server || !intent.toolName) {
          output = "Please specify both the server and tool. Example: \"call read_query on sqlite with {\\\"query\\\": \\\"SELECT 1\\\"}\"";
          break;
        }
        output = await handleCallTool(intent.server, intent.toolName, intent.args || {});
        break;

      case "disconnect":
        if (!intent.server) {
          output = "Please specify which server to disconnect. Example: \"disconnect sqlite\"";
          break;
        }
        output = await handleDisconnect(intent.server);
        break;

      case "help":
      default:
        output = handleListServers();
        break;
    }

    return {
      tool: "mcpBridge",
      success: true,
      final: true,
      data: { text: output, preformatted: true }
    };

  } catch (err) {
    console.error("[mcpBridge] Error:", err.message);

    // If a connection failed, evict it from cache so it can be retried cleanly
    const context = typeof request === "object" ? (request?.context || {}) : {};
    const intent = parseIntent(typeof request === "string" ? request : (request?.text || ""), context);
    if (intent.server && connectionCache.has(intent.server)) {
      console.warn(`[mcpBridge] Evicting crashed connection: ${intent.server}`);
      connectionCache.delete(intent.server);
    }

    return {
      tool: "mcpBridge",
      success: false,
      final: true,
      error: err.message,
      data: { text: `MCP Bridge error: ${err.message}` }
    };
  }
}

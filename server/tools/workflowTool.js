// server/tools/workflowTool.js
// Tool wrapper for the workflow engine — bridges planner routing to workflow execution

import { getAllWorkflows, getWorkflow, executeWorkflow, createWorkflow, parseWorkflowFromText } from "../utils/workflow.js";

/**
 * Execute a tool by name (used by workflow engine)
 * Lazy-loads TOOLS to avoid circular dependency (index.js → workflowTool.js → index.js)
 */
async function toolExecutor(toolName, input, context) {
  const { TOOLS } = await import("./index.js");
  const tool = TOOLS[toolName];
  if (!tool) {
    return { success: false, error: `Tool "${toolName}" not found` };
  }
  try {
    return await tool(input, context);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Detect intent from query
 */
function detectWorkflowIntent(query) {
  const lower = (query || "").toLowerCase();

  if (/\b(create|make|set\s+up|define|new)\s+(a\s+)?workflow\b/i.test(lower)) {
    return "create";
  }
  if (/\b(list|show|available)\s+(my\s+)?workflow/i.test(lower)) {
    return "list";
  }
  if (/\b(delete|remove)\s+(the\s+)?workflow/i.test(lower)) {
    return "delete";
  }
  // Default: run a workflow
  return "run";
}

/**
 * Extract workflow name from query
 */
function extractWorkflowName(query) {
  const lower = (query || "").toLowerCase();

  // Direct names
  if (/morning\s+briefing/i.test(lower)) return "Morning Briefing";
  if (/market\s+check/i.test(lower)) return "Market Check";
  if (/code\s+review\s+cycle/i.test(lower)) return "Code Review Cycle";

  // "run the X workflow" or "run workflow X"
  const match = query.match(/(?:run|execute|start)\s+(?:the\s+)?(?:workflow\s+)?["']?([^"']+?)["']?\s*(?:workflow)?$/i);
  if (match) return match[1].trim();

  return null;
}

/**
 * Main workflow tool entry point
 */
export async function workflow(query) {
  const input = typeof query === "object" ? query.text || query.input || "" : query;
  const intent = detectWorkflowIntent(input);

  console.log(`[workflow] Intent: ${intent}, Query: "${input}"`);

  switch (intent) {
    case "list": {
      const workflows = getAllWorkflows();
      const lines = ["## Available Workflows\n"];
      lines.push("| Name | Description | Steps | Built-in |");
      lines.push("|------|------------|-------|----------|");
      for (const wf of workflows) {
        const stepList = wf.steps.map(s => s.label || s.tool).join(" → ");
        lines.push(`| ${wf.name} | ${wf.description || ""} | ${stepList} | ${wf.builtIn ? "Yes" : "No"} |`);
      }
      return {
        tool: "workflow",
        success: true,
        final: true,
        data: { preformatted: true, text: lines.join("\n") },
      };
    }

    case "create": {
      const parsed = parseWorkflowFromText(input);
      if (!parsed.steps || parsed.steps.length === 0) {
        return {
          tool: "workflow",
          success: false,
          error: "Could not parse workflow steps. Use format: 'create workflow MyFlow: check weather, browse emails, get news'",
        };
      }
      const result = createWorkflow({
        name: parsed.name,
        description: `Custom workflow: ${parsed.steps.map(s => s.label).join(", ")}`,
        steps: parsed.steps,
      });
      if (!result.success) {
        return { tool: "workflow", success: false, error: result.error };
      }
      return {
        tool: "workflow",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: `Workflow **${result.workflow.name}** created with ${result.workflow.steps.length} steps:\n${result.workflow.steps.map((s, i) => `${i + 1}. ${s.label} (${s.tool})`).join("\n")}`,
        },
      };
    }

    case "run":
    default: {
      const name = extractWorkflowName(input);
      if (!name) {
        // Show available workflows
        const workflows = getAllWorkflows();
        const names = workflows.map(w => `- **${w.name}**: ${w.description || "(no description)"}`).join("\n");
        return {
          tool: "workflow",
          success: true,
          final: true,
          data: {
            preformatted: true,
            text: `Which workflow would you like to run?\n\n${names}\n\nSay "run [workflow name]" to execute one.`,
          },
        };
      }

      const wf = getWorkflow(name);
      if (!wf) {
        return {
          tool: "workflow",
          success: false,
          error: `Workflow "${name}" not found. Say "list workflows" to see available ones.`,
        };
      }

      const result = await executeWorkflow(name, toolExecutor);
      return {
        tool: "workflow",
        success: result.success,
        final: true,
        data: {
          preformatted: true,
          text: result.summary,
        },
      };
    }
  }
}

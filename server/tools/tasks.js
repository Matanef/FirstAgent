// server/tools/tasks.js
// Task management with JSON file persistence

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TASKS_FILE = path.resolve(__dirname, "..", "data", "tasks.json");

async function loadTasks() {
  try {
    const data = await fs.readFile(TASKS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveTasks(tasks) {
  const dir = path.dirname(TASKS_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

export async function tasks(query) {
  const text = typeof query === "string" ? query : (query?.text || query?.input || "");
  const lower = text.toLowerCase();

  try {
    const taskList = await loadTasks();

    // ADD TASK
    if (/\b(add|create|new)\s+(task|todo|reminder)/i.test(lower) || /^add\s+/i.test(lower)) {
      const description = text
        .replace(/^(add|create|new)\s+(task|todo|reminder)\s*/i, "")
        .replace(/^add\s+/i, "")
        .trim() || text;

      const task = {
        id: Date.now(),
        description,
        status: "pending",
        createdAt: new Date().toISOString()
      };
      taskList.push(task);
      await saveTasks(taskList);

      return {
        tool: "tasks",
        success: true,
        final: true,
        data: {
          action: "added",
          task,
          preformatted: true,
          text: `Added task: "${description}"\n\nYou now have ${taskList.length} task${taskList.length !== 1 ? "s" : ""}.`
        }
      };
    }

    // COMPLETE TASK
    if (/\b(complete|done|finish|check off)\b/i.test(lower)) {
      const idMatch = text.match(/\b(\d+)\b/);
      const nameMatch = text.match(/(?:complete|done|finish|check off)\s+(?:task\s+)?["']?(.+?)["']?\s*$/i);

      let found = null;
      if (idMatch) {
        found = taskList.find(t => t.id === parseInt(idMatch[1]) || taskList.indexOf(t) + 1 === parseInt(idMatch[1]));
      }
      if (!found && nameMatch) {
        const search = nameMatch[1].toLowerCase();
        found = taskList.find(t => t.description.toLowerCase().includes(search));
      }

      if (found) {
        found.status = "completed";
        found.completedAt = new Date().toISOString();
        await saveTasks(taskList);
        return {
          tool: "tasks",
          success: true,
          final: true,
          data: { preformatted: true, text: `Completed task: "${found.description}"` }
        };
      }

      return {
        tool: "tasks",
        success: false,
        final: true,
        error: "Could not find the task to complete. Try 'list tasks' first."
      };
    }

    // DELETE TASK
    if (/\b(delete|remove)\s+(task|todo)/i.test(lower)) {
      const idMatch = text.match(/\b(\d+)\b/);
      if (idMatch) {
        const idx = taskList.findIndex(t => t.id === parseInt(idMatch[1]) || taskList.indexOf(t) + 1 === parseInt(idMatch[1]));
        if (idx !== -1) {
          const removed = taskList.splice(idx, 1)[0];
          await saveTasks(taskList);
          return {
            tool: "tasks",
            success: true,
            final: true,
            data: { preformatted: true, text: `Deleted task: "${removed.description}"` }
          };
        }
      }
      return { tool: "tasks", success: false, final: true, error: "Could not find the task to delete." };
    }

    // LIST TASKS (default)
    const pending = taskList.filter(t => t.status === "pending");
    const completed = taskList.filter(t => t.status === "completed");

    if (taskList.length === 0) {
      return {
        tool: "tasks",
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: "No tasks yet.\n\nAdd one with: 'add task buy groceries'"
        }
      };
    }

    let summary = `**Your Tasks** (${pending.length} pending, ${completed.length} completed):\n\n`;
    if (pending.length > 0) {
      summary += "**Pending:**\n";
      pending.forEach((t, i) => {
        summary += `${i + 1}. ${t.description}\n`;
      });
    }
    if (completed.length > 0) {
      summary += "\n**Completed:**\n";
      completed.forEach((t, i) => {
        summary += `${i + 1}. ~~${t.description}~~\n`;
      });
    }

    return {
      tool: "tasks",
      success: true,
      final: true,
      data: { tasks: taskList, preformatted: true, text: summary.trim() }
    };

  } catch (err) {
    console.error("[tasks] Error:", err);
    return { tool: "tasks", success: false, final: true, error: `Task operation failed: ${err.message}` };
  }
}

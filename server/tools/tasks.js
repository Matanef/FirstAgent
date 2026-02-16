// server/tools/tasks.js

export async function tasks(query) {
  // Simple stub: treat the whole query as a task description
  return {
    tool: "tasks",
    success: true,
    final: true,
    data: {
      text:
        "Task tool placeholder. No persistent storage yet. " +
        "You can extend this to store tasks in a file or database.",
      task: query
    }
  };
}
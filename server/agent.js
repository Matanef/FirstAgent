import { CONFIG } from "./utils/config.js";
import { Memory } from "./memory.js";
import { planNextAction } from "./planner.js";
import { TOOLS } from "./tools/tools.js";

export async function runAgent(userInput) {
  const memory = new Memory();
  let toolUsage = 0;

  for (let step = 1; step <= CONFIG.MAX_STEPS; step++) {
    console.log(`🤖 STEP ${step}`);

    const plan = await planNextAction(userInput, memory);

    if (plan.action === "final") {
      return plan.thought;
    }

    if (!TOOLS[plan.action]) {
      return "Unknown tool requested.";
    }

    if (toolUsage >= CONFIG.TOOL_BUDGET) {
      return "Tool budget exceeded.";
    }

    toolUsage++;

    const result = await TOOLS[plan.action](...(Object.values(plan.input)));

    memory.add({
      step,
      action: plan.action,
      input: plan.input,
      output: result,
    });
  }

  return "Max steps reached without final answer.";
}

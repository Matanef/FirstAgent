// server/utils/coordinator.js
import { plan } from "../planner.js";
import { executeStep, finalizeStep } from "../executor.js";
import { getBackgroundNLP } from "./nlpUtils.js";
import { resolveCityFromIp } from "./geo.js";

/**
 * Autonomous Coordinator
 * Manages the multi-step execution loop for the agent.
 */
export async function executeAgent({ message, conversationId, clientIp, onChunk, onStep }) {
    const queryText = typeof message === "string" ? message : message?.text || "";

    // 1. Initial Analysis
    const { sentiment, entities } = getBackgroundNLP(queryText);

    // 2. Multi-Step Planning
    console.log("🧠 Planning steps for:", queryText);
    const steps = await plan({ message });
    console.log(`🎯 Plan generated: ${steps.length} steps`);

    const stateGraph = [];
    let lastFinalized = null;

    // 3. Execution Loop
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepNumber = i + 1;

        console.log(`⚙️ Step ${stepNumber}/${steps.length}: Executing ${step.tool}`);

        if (onStep) {
            onStep({
                event: "step_start",
                step: stepNumber,
                total: steps.length,
                tool: step.tool
            });
        }

        // GEOLOCATION for weather
        if (step.tool === "weather" && step.context?.city === "__USE_GEOLOCATION__") {
            const city = await resolveCityFromIp(clientIp);
            if (city) step.context.city = city;
        }

        // Execute the tool
        const stepResult = await executeStep({
            tool: step.tool,
            message: (step.input !== undefined) ? { text: step.input, context: step.context } : message,
            conversationId,
            sentiment,
            entities,
            stateGraph
        });

        // Finalize (Summarize or Reformat)
        // We only stream chunks for the VERY LAST step to avoid mixing multiple summaries
        const isLastStep = (stepNumber === steps.length);

        const finalized = await finalizeStep({
            stepResult,
            message: (step.input !== undefined) ? step.input : message,
            conversationId,
            sentiment,
            entities,
            stateGraph, // NEW: Pass results of previous steps
            onChunk: isLastStep ? onChunk : null
        });

        stateGraph.push({
            step: stepNumber,
            tool: step.tool,
            input: (step.input !== undefined) ? step.input : message,
            output: finalized.reply,
            success: finalized.success,
            final: finalized.final
        });

        lastFinalized = finalized;

        if (onStep) {
            onStep({
                event: "step_end",
                step: stepNumber,
                success: finalized.success,
                reply: finalized.reply
            });
        }

        // If a step fails, we stop the sequence
        if (!finalized.success) {
            console.log(`⚠️ Step ${stepNumber} failed, stopping autonomous loop.`);
            break;
        }
    }

    return {
        ...lastFinalized,
        stateGraph
    };
}

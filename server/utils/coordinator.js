// server/utils/coordinator.js
// VERIFIED FIX: Multi-step execution with proper plan validation

import { plan } from "../planner.js";
import { executeStep, finalizeStep } from "../executor.js";
import { getBackgroundNLP } from "./nlpUtils.js";
import { resolveCityFromIp } from "./geo.js";

/**
 * Autonomous Coordinator
 * Manages the multi-step execution loop for the agent.
 */
export async function executeAgent({ message, conversationId, clientIp, fileIds = [], onChunk, onStep }) {
    const queryText = typeof message === "string" ? message : message?.text || "";

    // 1. Background NLP Analysis
    const { sentiment, entities } = getBackgroundNLP(queryText);

    // 2. Multi-Step Planning
    console.log("🧠 Planning steps for:", queryText);
    const chatContext = { conversationId };
    if (fileIds.length > 0) chatContext.fileIds = fileIds;
    const planResult = await plan({ message: queryText, chatContext });
    
    // CRITICAL: Validate and normalize plan result
    let steps;
    if (Array.isArray(planResult)) {
        steps = planResult;
    } else if (planResult && typeof planResult === 'object') {
        // Old planner returns single object - wrap it in array
        console.warn("⚠️ Planner returned single object, wrapping in array");
        steps = [planResult];
    } else {
        console.error("❌ Invalid plan result:", planResult);
        steps = [];
    }
    
    console.log(`🎯 Plan generated: ${steps.length} step${steps.length !== 1 ? 's' : ''}`);
    
    if (steps.length === 0) {
        return {
            reply: "I couldn't determine how to help with that request.",
            tool: "error",
            success: false,
            stateGraph: []
        };
    }

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
            if (city) {
                step.context.city = city;
                console.log(`📍 Resolved geolocation: ${city}`);
            }
        }

        // Build message object for this step
        // CONTEXT PIPING: enrich step context with previous step outputs
        // so downstream tools (e.g. applyPatch) can use review/trending results
        const enrichedContext = { ...(step.context || {}) };

        // Pass fileIds to fileReview tool
        if (step.tool === "fileReview" && fileIds.length > 0) {
            enrichedContext.fileIds = fileIds;
        }
        if (stateGraph.length > 0) {
            for (const prev of stateGraph) {
                if (prev.tool === 'review' && prev.success) {
                    enrichedContext.reviewSuggestions = prev.output;
                }
                if (prev.tool === 'githubTrending' && prev.success) {
                    enrichedContext.trendingPatterns = prev.output;
                }
            }
        }

        const stepMessage = {
            text: step.input !== undefined ? step.input : queryText,
            context: enrichedContext
        };

        // Execute the tool (with retry on transient failures)
        let stepResult = await executeStep({
            tool: step.tool,
            message: stepMessage,
            conversationId,
            sentiment,
            entities,
            stateGraph
        });

        // ERROR RECOVERY: retry once on transient/timeout failures
        if (!stepResult.success && step.tool !== "llm") {
            const errorStr = (stepResult.output?.error || "").toLowerCase();
            const isRetryable = /\b(timeout|econnreset|econnrefused|socket hang up|network|fetch failed|rate.?limit)\b/.test(errorStr);
            if (isRetryable) {
                console.log(`🔄 Retrying step ${stepNumber} (${step.tool}) after transient error...`);
                await new Promise(r => setTimeout(r, 1000)); // brief delay before retry
                stepResult = await executeStep({
                    tool: step.tool,
                    message: stepMessage,
                    conversationId,
                    sentiment,
                    entities,
                    stateGraph
                });
            }
        }

        // Finalize (Summarize or Return Raw)
        // Only stream chunks for the LAST step to avoid mixing
        const isLastStep = (stepNumber === steps.length);

        const finalized = await finalizeStep({
            stepResult,
            message: stepMessage.text,
            conversationId,
            sentiment,
            entities,
            stateGraph,
            onChunk: isLastStep ? onChunk : null
        });

        // Add to state graph
        stateGraph.push({
            step: stepNumber,
            tool: step.tool,
            input: stepMessage.text,
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
                tool: step.tool
            });
        }

        // Stop on failure
        if (!finalized.success) {
            console.log(`⚠️ Step ${stepNumber} failed, stopping execution`);
            break;
        }
    }

    console.log(`📊 Execution complete: ${stateGraph.length} steps executed`);

    return {
        ...lastFinalized,
        stateGraph,
        tool: lastFinalized?.tool || steps[0]?.tool || "unknown"
    };
}

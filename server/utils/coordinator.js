// server/utils/coordinator.js
// VERIFIED FIX: Multi-step execution with proper plan validation

import { plan } from "../planner.js";
import { executeStep, finalizeStep } from "../executor.js";
import { getBackgroundNLP } from "./nlpUtils.js";
import { resolveCityFromIp } from "./geo.js";
import { summarizeAndStoreConversation, shouldSummarize, getRelevantContext } from "./conversationMemory.js";
import { detectSatisfaction, updatePreferencesFromFeedback, extractPreferences, applyExtractedPreferences, buildStyleInstructions } from "./styleEngine.js";
import { appendSuggestion } from "./suggestions.js";

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

        // SELF-REFLECTION: Check for hallucinated placeholders in the reply
        if (finalized.reply && finalized.success) {
            const placeholderPattern = /\[(Date|Time|Opponent|Location|Team|Player|Score|Name|TBD|TBA)\]/gi;
            const placeholders = finalized.reply.match(placeholderPattern);
            if (placeholders && placeholders.length > 0) {
                console.warn(`🔍 Self-reflection: Detected ${placeholders.length} hallucinated placeholders in response: ${placeholders.join(", ")}`);
                // Replace placeholders with "information not available" notice
                finalized.reply = finalized.reply.replace(placeholderPattern, "*(data not available)*");
                finalized.reply += "\n\n⚠️ *Some information was not available from the data source and has been marked accordingly.*";
            }
        }

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

    // ──────────────────────────────────────────────────────────
    // POST-EXECUTION: Style, Satisfaction, Suggestions, Memory
    // ──────────────────────────────────────────────────────────

    // 4a. Track user satisfaction signals
    try {
        const satisfaction = detectSatisfaction(queryText);
        if (satisfaction.signal !== "neutral") {
            await updatePreferencesFromFeedback(satisfaction.signal);
        }
    } catch (e) {
        console.warn("[coordinator] Satisfaction tracking error:", e.message);
    }

    // 4b. Extract and apply implicit style preferences
    try {
        const prefs = extractPreferences(queryText);
        if (prefs) {
            await applyExtractedPreferences(prefs);
        }
    } catch (e) {
        console.warn("[coordinator] Preference extraction error:", e.message);
    }

    // 4c. Append proactive suggestions
    let finalReply = lastFinalized?.reply || "";
    try {
        if (lastFinalized?.success && lastFinalized?.tool) {
            finalReply = await appendSuggestion(
                finalReply,
                lastFinalized.tool,
                lastFinalized
            );
        }
    } catch (e) {
        console.warn("[coordinator] Suggestion engine error:", e.message);
    }

    // 4d. Conversation memory — periodically summarize long conversations
    try {
        const { getMemory } = await import("../memory.js");
        const memory = await getMemory();
        const convo = memory.conversations?.[conversationId] || [];
        if (shouldSummarize(convo.length)) {
            // Run async — don't block the response
            summarizeAndStoreConversation(conversationId).catch(e =>
                console.warn("[coordinator] Conversation summary failed:", e.message)
            );
        }
    } catch (e) {
        console.warn("[coordinator] Conversation memory error:", e.message);
    }

    return {
        ...lastFinalized,
        reply: finalReply,
        stateGraph,
        tool: lastFinalized?.tool || steps[0]?.tool || "unknown"
    };
}

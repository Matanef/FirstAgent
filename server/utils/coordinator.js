// server/utils/coordinator.js
// VERIFIED FIX: Multi-step execution with proper plan validation

import { plan } from "../planner.js";
import { executeStep, finalizeStep } from "../executor.js";
import { getBackgroundNLP } from "./nlpUtils.js";
import { resolveCityFromIp } from "./geo.js";
import { summarizeAndStoreConversation, shouldSummarize, getRelevantContext } from "./conversationMemory.js";
import { detectSatisfaction, updatePreferencesFromFeedback, extractPreferences, applyExtractedPreferences, buildStyleInstructions } from "./styleEngine.js";
import { appendSuggestion } from "./suggestions.js";

// ============================================================
// EMOTIONAL INTELLIGENCE LAYER (D5)
// ============================================================

const FRUSTRATION_WINDOW = 5; // Check last N messages for frustration patterns
const FRUSTRATION_THRESHOLD = 3; // Number of signals needed to trigger adaptation

/**
 * Detect user frustration from conversation patterns
 * Goes beyond basic sentiment — detects repeated queries, exasperation, confusion
 */
function detectFrustrationPatterns(queryText, conversationHistory) {
  const lower = (queryText || "").toLowerCase();
  const signals = [];

  // 1. Explicit frustration language
  if (/\b(doesn't work|not working|broken|useless|wrong|bad|terrible|frustrated|annoying|ugh|wtf|stop|enough)\b/i.test(lower)) {
    signals.push("explicit_frustration");
  }

  // 2. Repeated clarification ("I said", "I already told you", "I meant")
  if (/\b(i\s+said|i\s+already|i\s+meant|i\s+told\s+you|as\s+i\s+said|like\s+i\s+said|again|for\s+the\s+.+\s+time)\b/i.test(lower)) {
    signals.push("repeated_clarification");
  }

  // 3. Question about why something failed ("why did", "why didn't", "why can't")
  if (/\b(why\s+did(?:n't)?|why\s+can't|why\s+won't|why\s+isn't|why\s+not)\b/i.test(lower)) {
    signals.push("failure_questioning");
  }

  // 4. All caps (shouting)
  if (queryText.length > 5 && queryText === queryText.toUpperCase() && /[A-Z]/.test(queryText)) {
    signals.push("shouting");
  }

  // 5. Excessive punctuation (!!!, ???)
  if (/[!?]{2,}/.test(queryText)) {
    signals.push("excessive_punctuation");
  }

  // 6. Repeated similar queries in conversation history
  if (conversationHistory && conversationHistory.length >= 2) {
    const recentUserMessages = conversationHistory
      .filter(m => m.role === "user")
      .slice(-FRUSTRATION_WINDOW)
      .map(m => (m.content || "").toLowerCase());

    const currentWords = new Set(lower.split(/\s+/).filter(w => w.length > 3));

    let repeatCount = 0;
    for (const prev of recentUserMessages) {
      const prevWords = new Set(prev.split(/\s+/).filter(w => w.length > 3));
      const overlap = [...currentWords].filter(w => prevWords.has(w)).length;
      if (overlap >= currentWords.size * 0.6 && currentWords.size > 2) {
        repeatCount++;
      }
    }
    if (repeatCount >= 2) {
      signals.push("repeated_queries");
    }
  }

  // 7. Short terse messages after longer interactions
  if (queryText.length < 15 && conversationHistory && conversationHistory.length > 6) {
    const recentUserMsgs = conversationHistory.filter(m => m.role === "user").slice(-3);
    const avgLength = recentUserMsgs.reduce((sum, m) => sum + (m.content?.length || 0), 0) / (recentUserMsgs.length || 1);
    if (avgLength > 40 && queryText.length < 15) {
      signals.push("terse_response");
    }
  }

  const isFrustrated = signals.length >= 2;
  const frustrationLevel = Math.min(signals.length / FRUSTRATION_THRESHOLD, 1.0);

  return {
    isFrustrated,
    frustrationLevel,
    signals,
  };
}

/**
 * Generate empathetic response modifications based on emotional state
 */
function getEmotionalAdaptation(frustration, sentiment) {
  const adaptations = {
    prependText: "",
    toneModifier: "",
    shouldAcknowledge: false,
  };

  if (frustration.isFrustrated) {
    adaptations.shouldAcknowledge = true;

    if (frustration.signals.includes("repeated_queries")) {
      adaptations.prependText = "I understand this hasn't been working as expected. Let me try a different approach. ";
      adaptations.toneModifier = "Be extra clear and specific. Avoid repeating previous unsuccessful approaches.";
    } else if (frustration.signals.includes("explicit_frustration")) {
      adaptations.prependText = "I'm sorry for the difficulty. ";
      adaptations.toneModifier = "Be empathetic, direct, and solution-focused. Skip pleasantries and get to the answer.";
    } else if (frustration.signals.includes("repeated_clarification")) {
      adaptations.prependText = "";
      adaptations.toneModifier = "Pay close attention to what the user is asking. Don't repeat your previous response. Focus precisely on what they're clarifying.";
    } else {
      adaptations.toneModifier = "Be extra helpful and patient. Show you understand the user's frustration.";
    }
  } else if (sentiment?.sentiment === "negative") {
    adaptations.toneModifier = "Be warm and supportive while being helpful.";
  }

  return adaptations;
}

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

    // 2b. Emotional Intelligence — detect frustration from conversation patterns
    let emotionalAdaptation = null;
    try {
        const { getMemory } = await import("../memory.js");
        const memory = await getMemory();
        const convoHistory = memory.conversations?.[conversationId] || [];
        const frustration = detectFrustrationPatterns(queryText, convoHistory);

        if (frustration.isFrustrated) {
            console.log(`[coordinator] Frustration detected (level: ${(frustration.frustrationLevel * 100).toFixed(0)}%, signals: ${frustration.signals.join(", ")})`);
            emotionalAdaptation = getEmotionalAdaptation(frustration, { sentiment });
        }
    } catch (e) {
        console.warn("[coordinator] Emotional intelligence error:", e.message);
    }

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

        // Pass emotional adaptation to LLM steps
        if (emotionalAdaptation?.toneModifier) {
            enrichedContext.emotionalTone = emotionalAdaptation.toneModifier;
        }

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

            // TOOL CHAINING: pass previous step output as chainContext
            if (step.context?.useChainContext || step.context?.chainedFrom !== undefined) {
                const prevStep = stateGraph[stateGraph.length - 1];
                if (prevStep) {
                    enrichedContext.chainContext = {
                        previousTool: prevStep.tool,
                        previousOutput: prevStep.output,
                        previousSuccess: prevStep.success,
                    };
                }
            }

            // LONG-HORIZON: pass dependency outputs
            if (step.context?.dependsOn !== undefined) {
                const depStep = stateGraph[step.context.dependsOn - 1];
                if (depStep) {
                    enrichedContext.dependencyOutput = depStep.output;
                    enrichedContext.dependencyTool = depStep.tool;
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

    // 4c. Apply emotional adaptation to response
    let finalReply = lastFinalized?.reply || "";
    if (emotionalAdaptation?.shouldAcknowledge && emotionalAdaptation.prependText && finalReply) {
        finalReply = emotionalAdaptation.prependText + finalReply;
    }

    // 4d. Append proactive suggestions
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

    // 4e. Conversation memory — periodically summarize long conversations
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

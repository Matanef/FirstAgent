// server/utils/coordinator.js
// VERIFIED FIX: Multi-step execution with proper plan validation

import { plan } from "../planner.js";
import { executeStep, finalizeStep } from "../executor.js";
import { getBackgroundNLP } from "./nlpUtils.js";
import { resolveCityFromIp } from "./geo.js";
import { getMemory } from "../memory.js";

// ============================================================
// EMOTIONAL INTELLIGENCE LAYER (D5)
// ============================================================

const FRUSTRATION_WINDOW = 6; // Check last N messages for frustration patterns
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

// ── Known tools the reflection mechanism is allowed to suggest ──────────────
// Subset of stable, side-effect-safe tools. Excludes write/send/mutate tools
// to avoid reflection accidentally firing dangerous operations.
const REFLECTION_SAFE_TOOLS = new Set([
  "file", "folderAccess", "search", "webBrowser", "webDownload",
  "calculator", "weather", "news", "sports", "finance", "financeFundamentals",
  "youtube", "github", "githubScanner", "githubTrending", "gitLocal",
  "deepResearch", "codeRag", "codeReview", "nlp", "systemMonitor",
  "projectGraph", "projectIndex", "projectSnapshot", "duplicateScanner",
  "documentQA", "memoryTool", "selfImprovement", "obsidianWriter",
  "spotifyController", "tasks", "calendar", "contacts"
]);

/**
 * Parse a tool-failure reply for a suggested alternative tool name.
 *
 * Looks for patterns the LLM commonly uses when explaining the wrong tool was picked:
 *   "The correct tool is `folderAccess`"
 *   "should use `folderAccess` instead"
 *   "Try using `folderAccess`"
 *   "use the `folderAccess` tool"
 *
 * Returns the first safe, non-identical tool name found, or null.
 *
 * @param {string} reply         The finalized reply text from the failed step
 * @param {string} currentTool   The tool that just failed (to avoid suggesting itself)
 * @returns {string|null}
 */
function extractToolSuggestion(reply, currentTool) {
  if (!reply || typeof reply !== "string") return null;

  // Priority 1: explicit backtick-quoted tool names near suggestion keywords
  const backtickPatterns = [
    /(?:correct|proper|right|better|appropriate)\s+tool\s+(?:is|would\s+be|for\s+\w+\s+is)\s+[`'](\w+)[`']/i,
    /(?:should|try|use|using|switch\s+to|instead\s+use)\s+(?:the\s+)?[`'](\w+)[`'](?:\s+tool)?/i,
    /[`'](\w+)[`']\s+(?:tool\s+)?(?:is\s+(?:more\s+)?(?:appropriate|correct|suited)|would\s+work\s+better)/i,
    /use\s+the\s+[`'](\w+)[`']\s+tool/i
  ];

  for (const pat of backtickPatterns) {
    const m = reply.match(pat);
    if (m?.[1]) {
      const candidate = m[1].trim();
      if (candidate !== currentTool && REFLECTION_SAFE_TOOLS.has(candidate)) {
        return candidate;
      }
    }
  }

  // Priority 2: unquoted tool name directly after strong signal words
  const unquotedPatterns = [
    /(?:correct|proper|right|appropriate)\s+tool\s+(?:is|would\s+be)\s+(\w+)/i,
    /(?:should\s+use|try\s+using|use\s+the)\s+(\w+)\s+tool/i
  ];

  for (const pat of unquotedPatterns) {
    const m = reply.match(pat);
    if (m?.[1]) {
      const candidate = m[1].trim();
      if (candidate !== currentTool && REFLECTION_SAFE_TOOLS.has(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Autonomous Coordinator
 * Manages the multi-step execution loop for the agent.
 */
export async function executeAgent({ message, conversationId, clientIp, fileIds = [], onChunk, onStep, userProfile = null, userToneInstruction = "", signal }) {
    const startTime = performance.now();
    const queryText = typeof message === "string" ? message : message?.text || "";
    console.log(`\n🚀 [PIPELINE START] Task: "${queryText.substring(0, 50)}..."`);
    
    // ── Train of Thought: collect reasoning events ──
    const thoughtChain = [];
    const PHASE_ICONS = { THOUGHT: "🧠", PLAN: "📋", EXECUTION: "⚙️", OBSERVATION: "🔍", ANSWER: "✨" };
    function emitThought(phase, content, data = {}) {
        const thought = { type: "thought", phase, content, data, timestamp: new Date().toISOString() };
        thoughtChain.push(thought);
        console.log(`${PHASE_ICONS[phase] || "💭"} [ToT] ${phase}: ${content.length > 120 ? content.slice(0, 120) + "..." : content}`);
        if (onStep) onStep(thought);
    }

    // 1. Background NLP Analysis
    const { sentiment, entities } = getBackgroundNLP(queryText);

    // ── THOUGHT: report NLP analysis ──
    const entityParts = [];
    if (entities?.people?.length) entityParts.push(`people=[${entities.people.join(", ")}]`);
    if (entities?.places?.length) entityParts.push(`places=[${entities.places.join(", ")}]`);
    if (entities?.organizations?.length) entityParts.push(`orgs=[${entities.organizations.join(", ")}]`);
    if (entities?.dates?.length) entityParts.push(`dates=[${entities.dates.join(", ")}]`);
    emitThought("THOUGHT",
        `Analyzing: "${queryText.length > 80 ? queryText.slice(0, 80) + "..." : queryText}". ` +
        `Sentiment: ${sentiment?.sentiment || "neutral"} (${sentiment?.score ?? 0}). ` +
        `Entities: ${entityParts.length > 0 ? entityParts.join(", ") : "none detected"}.`,
        { sentiment, entities }
    );

    // 2. Multi-Step Planning
    console.log("🧠 Planning steps for:", queryText);
    const chatContext = { conversationId };
    if (fileIds.length > 0) chatContext.fileIds = fileIds;
    const planResult = await plan({ message: queryText, chatContext, signal });

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

    // ── PLAN: report routing decision ──
    if (steps.length > 0) {
        const planSummary = steps.map((s, i) => `${i + 1}. ${s.tool} (${s.reasoning || "auto"})`).join(", ");
        emitThought("PLAN",
            `Plan: ${steps.length} step${steps.length !== 1 ? "s" : ""} — ${planSummary}`,
            { steps: steps.map(s => ({ tool: s.tool, reasoning: s.reasoning })), stepCount: steps.length }
        );
    }

    if (steps.length === 0) {
        return {
            reply: "I couldn't determine how to help with that request.",
            tool: "error",
            success: false,
            stateGraph: [],
            thoughtChain
        };
    }

    const stateGraph = [];
    let lastFinalized = null;

    // 2b. Emotional Intelligence — detect frustration from conversation patterns
    let emotionalAdaptation = null;
    try {
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
        if (signal?.aborted) {
            console.log("🛑 [Coordinator] Abort signal detected, stopping pipeline.");
            break; 
        }
        const step = steps[i];
        const stepNumber = i + 1;

        console.log(`⚙️ Step ${stepNumber}/${steps.length}: Executing ${step.tool}`);

        // ── EXECUTION: announce tool call ──
        emitThought("EXECUTION",
            `Executing step ${stepNumber}/${steps.length}: ${step.tool} tool`,
            { step: stepNumber, total: steps.length, tool: step.tool }
        );

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
            let city = await resolveCityFromIp(clientIp);
            // Fallback for localhost: use saved location from memory
            if (!city && (clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1")) {
                try {
                    const memory = await getMemory();
                    city = memory.profile?.location || memory.profile?.city || null;
                    if (city) console.log(`📍 Localhost detected, using saved location: ${city}`);
                } catch (e) {
                    console.warn("[coordinator] Could not read memory for location fallback:", e.message);
                }
            }
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
            if (step.context?.useChainContext || step.context?.useLastResult || step.context?.chainedFrom !== undefined) {
                const prevStep = stateGraph[stateGraph.length - 1];
                if (prevStep) {
                    enrichedContext.chainContext = {
                        previousTool: prevStep.tool,
                        previousOutput: prevStep.output,
                        previousSuccess: prevStep.success,
                        previousRaw: prevStep.rawData || null,
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
            stateGraph,
            signal
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
                    stateGraph,
                    signal
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
            onChunk: isLastStep ? onChunk : null,
            signal
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

        // ── OBSERVATION: report tool result ──
        const obsPreview = typeof finalized.reply === "string"
            ? finalized.reply.slice(0, 150) + (finalized.reply.length > 150 ? "..." : "")
            : "structured data returned";
        emitThought("OBSERVATION",
            `${step.tool} ${finalized.success ? "completed successfully" : "failed"}. Preview: ${obsPreview}`,
            { step: stepNumber, tool: step.tool, success: finalized.success }
        );

        // Add to state graph (include rawData for chain context formatting)
        stateGraph.push({
            step: stepNumber,
            tool: step.tool,
            input: stepMessage.text,
            output: finalized.reply,
            success: finalized.success,
            final: finalized.final,
            rawData: stepResult.output?.data || stepResult.data || null
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

// Stop on failure ONLY if it's a critical tool
        const CRITICAL_TOOLS = ['fileWrite', 'applyPatch', 'moltbook', 'email_confirm', 'codeTransform'];
        if (!finalized.success && CRITICAL_TOOLS.includes(step.tool)) {
            console.log(`⚠️ Critical step ${stepNumber} (${step.tool}) failed, stopping execution`);
            break;
        } else if (!finalized.success) {
            console.log(`⚠️ Non-critical step ${stepNumber} (${step.tool}) failed, continuing to next step...`);

            // ── TOOL REFLECTION: one-shot self-correction ────────────────────
            // If the failure analysis mentions a different tool, try it automatically.
            // This catches wrong-tool routing (e.g. "file" used for a directory → "folderAccess").
            const suggestedTool = extractToolSuggestion(finalized.reply, step.tool);
            if (suggestedTool) {
                console.log(`🔄 [reflection] "${step.tool}" failed — trying suggested tool "${suggestedTool}"...`);
                if (onStep) onStep({ type: "thought", content: `🔄 Let me try **${suggestedTool}** instead — that's more appropriate for this request.` });
                try {
                    const reflectResult = await executeStep({
                        tool: suggestedTool,
                        message: stepMessage,
                        conversationId,
                        sentiment,
                        entities,
                        stateGraph,
                        signal
                    });
                    const reflectFinalized = await finalizeStep({
                        stepResult:    reflectResult,
                        message:       stepMessage.text,
                        conversationId,
                        sentiment,
                        entities,
                        stateGraph,
                        onChunk:       isLastStep ? onChunk : null,
                        signal
                    });

                    // Replace the failed state-graph entry with the reflection result
                    const prevEntry = stateGraph[stateGraph.length - 1];
                    stateGraph[stateGraph.length - 1] = {
                        ...prevEntry,
                        tool:     suggestedTool,
                        output:   reflectFinalized.reply,
                        success:  reflectFinalized.success,
                        final:    reflectFinalized.final,
                        rawData:  reflectResult.output?.data || reflectResult.data || null,
                        reflected: true,
                        originalTool: step.tool
                    };
                    lastFinalized = reflectFinalized;

                    const refPreview = typeof reflectFinalized.reply === "string"
                        ? reflectFinalized.reply.slice(0, 120)
                        : "(result)";
                    emitThought("OBSERVATION",
                        `[reflection] ${suggestedTool} ${reflectFinalized.success ? "succeeded" : "also failed"}. Preview: ${refPreview}`,
                        { step: stepNumber, tool: suggestedTool, reflected: true, success: reflectFinalized.success }
                    );
                    console.log(`🔄 [reflection] "${suggestedTool}" ${reflectFinalized.success ? "✅ succeeded" : "❌ also failed"}`);
                } catch (reflectErr) {
                    console.warn(`🔄 [reflection] "${suggestedTool}" threw: ${reflectErr.message}`);
                }
            }
        }
    }

    console.log(`📊 Execution complete: ${stateGraph.length} steps executed`);

    // ── Collect learned facts from all steps ──
    const allLearnedFacts = [];
    for (const s of stateGraph) {
        const facts = s.rawData?.learnedFacts;
        if (Array.isArray(facts)) {
            allLearnedFacts.push(...facts);
        }
    }

    // ── Append learning indicator to reply if facts were learned ──
    let finalReply = lastFinalized?.reply || "Task completed.";
    if (allLearnedFacts.length > 0) {
        const newFacts = allLearnedFacts.filter(f => f.action === "learned");
        const reinforced = allLearnedFacts.filter(f => f.action === "reinforced");
        const parts = [];
        if (newFacts.length > 0) {
            const topics = [...new Set(newFacts.map(f => f.topic))];
            parts.push(`📚 Learned: ${topics.join(", ")}${newFacts.some(f => f.ongoing) ? " *(ongoing)*" : ""}`);
        }
        if (reinforced.length > 0) {
            const topics = [...new Set(reinforced.map(f => f.topic))];
            parts.push(`🔄 Reinforced: ${topics.join(", ")}`);
        }
        if (parts.length > 0) {
            finalReply += `\n\n---\n${parts.join(" | ")}`;
        }
    }

    // ── ANSWER: announce final synthesis ──
    emitThought("ANSWER",
        `Synthesizing final response from ${lastFinalized?.tool || "unknown"} results (${stateGraph.length} step${stateGraph.length !== 1 ? "s" : ""} completed).`,
        { tool: lastFinalized?.tool, stepsCompleted: stateGraph.length }
    );

// Carry forward HTML widgets from intermediate steps (e.g., githubTrending → llm compound)
    // so the frontend can render the rich widget above the text summary
    let resultData = lastFinalized?.data || null;
    
    // 👉 ADDED CHECKS: Skip carrying forward HTML if the final tool is an email!
    if (stateGraph.length > 1 && lastFinalized?.tool !== "email" && lastFinalized?.tool !== "email_confirm") {
        const htmlStep = stateGraph.find(s => s.rawData?.html && s.tool !== lastFinalized?.tool);
        if (htmlStep?.rawData?.html) {
            resultData = { ...(resultData || {}), html: htmlStep.rawData.html, htmlSource: htmlStep.tool };
            console.log(`📊 Carrying forward HTML widget from intermediate step: ${htmlStep.tool}`);
        }
    }

    const endTime = performance.now();
    console.log(`🏁 [PIPELINE END] Total Execution Time: ${((endTime - startTime) / 1000).toFixed(2)} seconds\n`);
    return {
        reply: finalReply,
        tool: lastFinalized?.tool || "unknown",
        data: resultData,
        reasoning: lastFinalized?.reasoning || "Execution finished.",
        success: lastFinalized?.success ?? true,
        final: true,
        stateGraph: stateGraph || [],
        thoughtChain,
        learnedFacts: allLearnedFacts.length > 0 ? allLearnedFacts : undefined
    };
}
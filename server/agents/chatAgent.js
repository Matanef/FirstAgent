// server/agents/chatAgent.js
// Conversational agent — handles natural conversation without triggering tools.
// Loads personality, self-model, user profile, durable memories, and knowledge
// to provide informed, contextual responses.
//
// ARCHITECTURE NOTE (Option B extension point):
// Currently this agent answers purely from its loaded context (Option C).
// When the agent needs to become more sophisticated, add a `resolveWithTools()`
// function that delegates to the orchestrator/taskAgent for information retrieval,
// then feeds results back into the conversational prompt. The extension point is
// marked with "// OPTION_B_HOOK" below.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { llm, llmStream } from "../tools/llm.js";
import { getMemory, getEnrichedProfile, saveJSON, MEMORY_FILE } from "../memory.js";
import { getPersonalityContext } from "../personality.js";
import { getKnowledgeContext, getRelevantKnowledge } from "../knowledge.js";
import { listCollections, search as vectorSearch, getCollectionStats } from "../utils/vectorStore.js";
import * as sourceDirectory from "../skills/deepResearch/sourceDirectory.js";
import { extract as extractKeywords } from "../skills/deepResearch/keywordExtractor.js";
import { rank as rankSubjects } from "../skills/deepResearch/subjectMatcher.js";
import { classifyIntent, classifyIntentWithRoutingOverride } from "../utils/intentClassifier.js";
import { buildUserToneInstruction, buildToneInstructionFromProfile } from "../utils/userProfiles.js";
import { handleTask } from "./taskAgent.js";
import { setPendingQuestion, getPendingQuestion } from "../utils/pendingQuestion.js";
import { evaluateRoutingTable } from "../routing/index.js";
import { logCorrection } from "../intentDebugger.js";
import { extractStructuredFacts, pruneKnownFacts } from "../utils/factExtractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SELF_MODEL_PATH = path.resolve(__dirname, "..", "data", "self_model.json");

/**
 * Load the agent's self-model (identity, personality, capabilities)
 */
function loadSelfModel() {
  try {
    if (fs.existsSync(SELF_MODEL_PATH)) {
      return JSON.parse(fs.readFileSync(SELF_MODEL_PATH, "utf8"));
    }
  } catch (e) {
    console.warn("[chatAgent] Could not load self_model.json:", e.message);
  }
  return {
    identity: "Local LLM Assistant",
    owner: "Matan",
    personality: { traits: ["helpful", "friendly"] },
    capabilities: ["conversation", "tool execution"],
    limitations: ["local LLM context window"]
  };
}

/**
 * Get recent git improvements for self-awareness context
 */
async function getRecentChanges(limit = 5) {
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const projectRoot = path.resolve(__dirname, "..", "..");

    const { stdout } = await execAsync(
      `git log --oneline --no-merges -${limit} --format="%s"`,
      { cwd: projectRoot }
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Subject-gated retrieval from the deepResearch vault. Closes the long-term
 * learning loop so past research grounds future chat.
 *
 * Pipeline (matches the Knowledge OS RAG plan):
 *   1. Extract keywords from the user message (no LLM phrase pass — keep chat fast).
 *   2. Load research-sources.json and rank subjects via subjectMatcher.
 *   3. Only query vector collections belonging to matched subjects:
 *         research-{slug}-conclusions   (preferred — already synthesized)
 *         research-{slug}-p{N}-articles (fallback if conclusion score is weak)
 *   4. Format top hits as "ARCHIVED RESEARCH FINDINGS" with subject headings.
 *
 * Non-blocking: any failure degrades gracefully to empty string so the chat
 * prompt still builds without RAG augmentation.
 */
// Cache vector-collection names so we don't re-scan the disk on every chat turn.
// Collections only change when deepResearch writes a new one — a 60s staleness
// window is far shorter than a typical research run, so invalidation is a non-issue.
let _collectionCache = { names: null, expiresAt: 0 };
function getCachedCollectionNames() {
  const now = Date.now();
  if (_collectionCache.names && now < _collectionCache.expiresAt) {
    return _collectionCache.names;
  }
  const names = new Set(
    (listCollections() || []).map(c => c.name).filter(Boolean)
  );
  _collectionCache = { names, expiresAt: now + 60_000 };
  return names;
}

async function getResearchContext(message) {
  try {
    if (!message || message.length < 12) return "";

    // 1. Load subject directory. If empty, no research has been done yet.
    const directory = await sourceDirectory.load();
    const subjects = directory?.subjects || {};
    if (Object.keys(subjects).length === 0) return "";

    // 2. Extract keywords (skip LLM phrase pass — this is on the chat hot path).
    const extracted = await extractKeywords(message, { usePhraseLLM: false });
    if (!extracted.tokens?.length) return "";

    // 3. Rank subjects — use a slightly lower floor than the skill itself so
    //    chat retrieval triggers on softer matches (a user mentioning a topic
    //    in passing shouldn't need to score as high as a research request).
    const matched = rankSubjects(extracted, subjects, { limit: 3, minScore: 0.3 });
    if (matched.length === 0) return "";

    // 4. Index known vector collections. Cached for 60s because listCollections()
    //    reads the filesystem and this runs on every chat turn.
    const knownCollections = getCachedCollectionNames();

    const hits = [];
    for (const m of matched) {
      const conclusionsName = `research-${m.slug}-conclusions`;
      if (knownCollections.has(conclusionsName)) {
        try {
          const results = await vectorSearch(conclusionsName, message, 2);
          for (const r of results) {
            hits.push({
              ...r,
              collection: conclusionsName,
              tier: "conclusion",
              subjectSlug: m.slug,
              subjectTopic: m.subject?.topic || m.slug,
              subjectScore: m.score
            });
          }
        } catch { /* one bad collection shouldn't poison the rest */ }
      }
    }

    // 5. If the best conclusion hit is weak, also pull article-level chunks from
    //    the top matched subject only (keeps context budget bounded).
    const topConclusion = hits.length > 0 ? Math.max(...hits.map(h => h.score || 0)) : 0;
    if (topConclusion < 0.25 && matched.length > 0) {
      const topSlug = matched[0].slug;
      const articleCols = [...knownCollections].filter(n =>
        n.startsWith(`research-${topSlug}-p`) && n.endsWith("-articles")
      );
      for (const name of articleCols) {
        try {
          const results = await vectorSearch(name, message, 2);
          for (const r of results) {
            hits.push({
              ...r,
              collection: name,
              tier: "article",
              subjectSlug: topSlug,
              subjectTopic: matched[0].subject?.topic || topSlug,
              subjectScore: matched[0].score
            });
          }
        } catch {}
      }
    }

    if (hits.length === 0) return "";

    // 6. Rank, apply a relevance floor, and keep the top 3 overall.
    hits.sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = hits.filter(h => (h.score || 0) >= 0.18).slice(0, 3);
    if (top.length === 0) return "";

    const lines = top.map((h, i) => {
      const snippet = (h.text || "").trim().slice(0, 600).replace(/\s+/g, " ");
      const promptIdx = h.metadata?.promptIndex;
      const query = h.metadata?.query;
      const title = h.metadata?.title;
      const attribution =
        promptIdx != null
          ? `${h.subjectTopic} · prompt ${promptIdx}${query ? ` — "${query}"` : ""}`
          : title
            ? `${h.subjectTopic} · ${title}`
            : h.subjectTopic;
      return `[${i + 1}] ${attribution} (vector score ${(h.score || 0).toFixed(2)})\n${snippet}`;
    });

    const subjectList = matched.map(m => `"${m.subject?.topic || m.slug}"`).join(", ");

    return `ARCHIVED RESEARCH FINDINGS (from your own deepResearch vault):
Matched subjects: ${subjectList}

${lines.join("\n\n")}

Treat these as your own prior findings. Reference the subject by name if the user asks what you've researched. Do not claim you lack information on these topics — you have already studied them.`;
  } catch (err) {
    console.warn("[chatAgent] research retrieval failed (non-blocking):", err.message);
    return "";
  }
}

/**
 * Build user context from memory — profile, durable memories, knowledge.
 * This is the information the chatAgent "knows" about the user.
 */
async function buildUserContext(conversationId, message = "") {
  const parts = [];

  // Load enriched profile ONCE — used by both the user-context block and
  // the tone-injection block further down. Duplicating this call doubled
  // disk I/O per chat turn and was a measurable contributor to slow responses.
  let enriched = null;
  try {
    enriched = await getEnrichedProfile(conversationId);
  } catch (e) {
    console.warn("[chatAgent] Could not load enriched profile:", e.message);
  }

  try {
    if (!enriched) throw new Error("enriched profile unavailable");

// User profile
     const self = enriched.self || {};
     const selfModel = loadSelfModel(); // Load the self-model for fallback data
     const profileFields = [];
      
     // Force a name so the LLM never hallucinates or defaults to its own name
     const userName = self.name || selfModel.owner || "Friend";
     profileFields.push(`Name: ${userName}`);
      
    if (self.location) profileFields.push(`Location: ${self.location}`);
    if (self.email) profileFields.push(`Email: ${self.email}`);
    if (self.phone) profileFields.push(`Phone: ${self.phone}`);
    if (self.occupation) profileFields.push(`Occupation: ${self.occupation}`);
    // NOTE: tone is intentionally NOT added as a "Preferred tone: X" profile line here.
    // A vague "Preferred tone: mean" confuses local LLMs (they improvise — misaddressing
    // the user, inventing genders, etc). Structured tone instructions are injected
    // further down via buildToneInstructionFromProfile() for both UI and WhatsApp paths.

    // Age
    if (enriched.self?.age || enriched.profile?.age) {
      profileFields.push(`Age: ${enriched.self?.age || enriched.profile?.age}`);
    }

    // Contacts / Family
    const contacts = enriched.contacts || enriched.profile?.contacts || {};
    const contactLines = Object.entries(contacts)
      .filter(([, v]) => v?.name)
      .map(([key, v]) => {
        const details = [];
        if (v.relation) details.push(v.relation);
        if (v.nickname) details.push(`goes by ${v.nickname}`);
        if (v.gender) details.push(v.gender);
        if (v.email) details.push(v.email);
        if (v.phone) details.push(v.phone);
        if (v.lifeEvents?.length) details.push(v.lifeEvents.join(", "));
        return `- ${key}: ${v.name}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
      })
      .slice(0, 15);

    if (profileFields.length > 0 || contactLines.length > 0) {
      let section = `WHAT YOU KNOW ABOUT THE USER:\n${profileFields.join("\n")}`;
      if (contactLines.length > 0) {
        section += `\n\nFamily & Contacts:\n${contactLines.join("\n")}`;
      }
      parts.push(section);
    }

    // Structured personal facts (lifecycle-managed — "active" = currently true about the user).
    // These are the agent's PRIMARY source of truth about the user; the durables section below
    // is the older raw-message fallback kept for backward compatibility.
    try {
      const mem = await getMemory();
      const knownFacts = Array.isArray(mem?.profile?.knownFacts) ? mem.profile.knownFacts : [];
      const activeFacts = knownFacts.filter(f => f.status === "active");
      if (activeFacts.length > 0) {
        const factLines = activeFacts.slice(0, 40).map(f => `- ${f.statement}`);
        parts.push(`WHAT YOU KNOW ABOUT THE USER (structured facts):\n${factLines.join("\n")}`);
      }
    } catch { /* non-blocking */ }

    // Durable memories (things the user explicitly asked you to remember, or auto-extracted from chat)
    // IMPORTANT framing: these are the USER'S statements, captured verbatim. The LLM must resolve
    // pronouns from the USER'S perspective — "I/me/my" refers to the user, "you/your" refers to
    // the agent. Without this framing, small LLMs read "his name is Lanou" or "you are called X"
    // and end up addressing the user by the pet's name (observed regression 2026-04-20).
    const durables = enriched._durableMemories || [];
    if (durables.length > 0) {
      const memLines = durables.map(d => {
        if (d.fact) return `- The user told you: "${d.fact}"`;
        const val = typeof d.value === "object" ? JSON.stringify(d.value) : d.value;
        return `- ${d.category || "fact"}: ${d.key} = ${val}`;
      });
      parts.push(`THINGS THE USER HAS SHARED WITH YOU (quoted verbatim — when reading these, remember the user is the speaker: "I/me/my" means the user, "you/your" means YOU the agent, and any third-party name like a pet or friend belongs to THAT entity, not the user):\n${memLines.join("\n")}`);
    }

    // Interaction stats
    if (enriched._stats) {
      const s = enriched._stats;
      const since = s.firstSeen ? new Date(s.firstSeen).toLocaleDateString() : "unknown";
      parts.push(`RELATIONSHIP: ${s.totalInteractions} interactions across ${s.conversationCount} conversations since ${since}`);
    }
  } catch (e) {
    console.warn("[chatAgent] Could not load user context:", e.message);
  }

  // Knowledge — recent facts learned from news, web, etc.
  try {
    const knowledgeCtx = await getKnowledgeContext();
    if (knowledgeCtx) {
      parts.push(knowledgeCtx);
    }
  } catch { /* non-blocking */ }

  // Research vault — semantic retrieval from deepResearch vector collections.
  // Closes the long-term learning loop: findings written by deepResearch are
  // now surfaced back into the chat context on relevant user messages.
  try {
    const researchCtx = await getResearchContext(message);
    if (researchCtx) {
      parts.push(researchCtx);
    }
  } catch { /* non-blocking */ }

  // ── Per-user tone/identity injection ──
  // Applies to BOTH WhatsApp (by phone) AND UI sessions (by profile.tone from memory).
  // Bug fix: previously the structured tone template only fired for WhatsApp, leaving
  // UI users with a vague "Preferred tone: mean" line. Local LLMs improvised badly —
  // misaddressing the user by the agent's own name, inventing genders, etc.
  try {
    let toneInstruction = "";
    if (conversationId?.startsWith("whatsapp_")) {
      const phone = conversationId.replace("whatsapp_", "");
      toneInstruction = await buildUserToneInstruction(phone);
    } else {
      // UI path — build a synthetic profile from enriched memory fields.
      // Reuses the `enriched` object loaded at the top of this function
      // instead of triggering a second getEnrichedProfile() disk read.
      const self = enriched?.self || {};
      const uiProfile = {
        name: self.name,
        nameHe: self.nameHe,
        gender: self.gender,
        tone: enriched?.tone || self.tone,
        language: self.language,
        role: self.role,
        relation: self.relation
      };
      toneInstruction = buildToneInstructionFromProfile(uiProfile);
    }
    if (toneInstruction) {
      parts.push(toneInstruction);
    }
  } catch (e) {
    console.warn("[chatAgent] User tone injection failed:", e.message);
  }

  return parts.join("\n\n");
}

// UNIFIED ARCHITECTURE HOOK:
// The chatAgent asks the intent classifier if tools are needed.
// If yes, it delegates to the taskAgent SILENTLY (onChunk: null),
// grabs the data, and returns it to be injected into the prompt.
// Tools that are unambiguous enough to run silently mid-conversation without asking.
const SILENT_TOOLS = new Set([
  "calculator", "weather", "memoryTool", "selfImprovement", "selfEvolve",
  "news", "sports", "youtube", "finance", "financeFundamentals"
]);

async function resolveWithTools(message, options, recentTurns) {
  // ── TOOL-INTERCEPT RESUME (Phase 3) ───────────────────────
  // If the user just answered a tool-intercept question ("yes"/"no"), honour it.
  const interceptResume = options.resolvedPending?._skill === "__tool_intercept__"
    ? options.resolvedPending
    : null;

  if (interceptResume?.yes_no === "no") {
    // User declined the tool — fall straight through to conversational LLM
    console.log("[chatAgent] Tool intercept: user declined, staying in chat mode");
    return null;
  }
  // interceptResume?.yes_no === "yes" → fall through normally (skip intercept check below)

  // ── AMBIGUITY CLARIFICATION RESUME (Phase 4) ──────────────
  // If the user just answered a clarification question, act on their choice.
  if (options.resolvedPending?._skill === "__ambiguity_clarification__") {
    const choice = options.resolvedPending.clarification_choice;
    console.log(`[chatAgent] Ambiguity clarification resumed: choice="${choice}"`);

    // Log as a clarification_resolved correction so routing learns from it
    try {
      await logCorrection(
        { type: "clarification_resolved", correctTool: choice === "search" ? "search" : (choice === "tool" ? "llm" : null), message },
        { previousToolUsed: null, previousUserMessage: options.resolvedPending._originalRequest }
      );
    } catch { /* non-critical */ }

    if (choice === "chat") {
      // User wants to chat — skip tools entirely
      return null;
    }
    if (choice === "search") {
      // Prepend "search for:" so the routing table's search rule fires cleanly,
      // but ONLY if the original message doesn't already lead with a search verb —
      // otherwise we double up ("search for: search for information").
      if (!/^\s*(search|look\s+up|find|lookup|google)\b/i.test(message)) {
        message = `search for: ${message}`;
      }
    }
    // choice === "tool" → fall through, let LLM decomposer figure it out
  }

  console.log(`[chatAgent:probe] entering classifyIntentWithRoutingOverride`);
  let classification = await classifyIntentWithRoutingOverride(message, recentTurns, options.fileIds);
  console.log(`[chatAgent] Intent classification: mode=${classification.mode}, confidence=${classification.confidence.toFixed(2)}, reason=${classification.reason}`);

  // ── MEMORY-QUESTION SHORT-CIRCUIT (runs BEFORE mode branching) ──
  // Questions about the user themselves ("what is my name?", "who is my mother?",
  // "what is my mom's name?", "do you remember my favorite color?") MUST route to
  // the memoryTool / planner path — not to raw-LLM chat, which will answer with
  // the agent's OWN name or invent things. The classifier now returns
  // mode=chat / ambiguous_but_active_chat for these in active conversations, so
  // the check must run above `if (classification.mode === "task")`.
  // Matches: "what is my X", "what's my X's Y", "who is my X",
  //          "what is the <field> of my X"  (e.g. "what is the name of my dog?"),
  //          "do you remember my X", etc.
  const memoryQuestionRe =
    /^\s*(what(?:'s| is)|who(?:'s| is| are)|where(?:'s| is)|when(?:'s| is)|do\s+you\s+(?:remember|know|recall))\s+(?:is\s+)?(?:the\s+\w+\s+of\s+)?(?:my|our)\s+[\w'’]+/i;
  const memoryQuestionHe =
    /^\s*(מה|מי|איפה|מתי|האם\s+אתה\s+זוכר|אתה\s+זוכר|אתה\s+יודע)\s+.{0,30}(שלי|שלנו)/u;
  if (!interceptResume && !options.resolvedPending &&
      (memoryQuestionRe.test(message) || memoryQuestionHe.test(message))) {
    console.log(`[chatAgent] Memory-question short-circuit: forcing task mode for "${message.slice(0, 60)}"`);
    classification = {
      ...classification,
      mode: "task",
      confidence: 0.9,
      reason: "memory_question_short_circuit"
    };
  }

  if (classification.mode === "task") {

    // ── TOOL-INTERCEPT CHECK ───────────────────────────────────
    // When a tool is about to fire mid-active-conversation with low confidence,
    // pause and ask the user rather than silently committing.
    // Skip if: user already said "yes", confidence is high, or we're not in active chat.
    if (!interceptResume && classification.confidence < 0.75) {
      const lastTurn = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1] : null;
      const lastTurnWasChat = lastTurn?.mode === "chat";
      const lastTurnAge = lastTurn?.timestamp
        ? (Date.now() - new Date(lastTurn.timestamp).getTime()) / 60000
        : Infinity;
      const isRecentConversation = lastTurnAge < 5;

      if (lastTurnWasChat && isRecentConversation && options.conversationId) {
        // Cheaply peek which tool the routing table would choose (no LLM call)
        const lower = message.toLowerCase().trim();
        const trimmed = message.trim();
        let plannedTool = null;
        console.log(`[chatAgent:probe] intercept-peek entering evaluateRoutingTable`);
        try {
          const routingPeek = await evaluateRoutingTable(lower, trimmed, {});
          console.log(`[chatAgent:probe] intercept-peek returned tool=${routingPeek?.[0]?.tool || "none"} priority=${routingPeek?.[0]?.priority || "n/a"}`);
          if (routingPeek?.[0]?.tool && !SILENT_TOOLS.has(routingPeek[0].tool)) {
            plannedTool = routingPeek[0].tool;
          }
        } catch { /* routing peek failed — skip intercept */ }

        if (plannedTool) {
          const question = `I noticed you might be in the middle of a conversation, but this looks like it could also be a task for the **${plannedTool}** tool.\n\nShould I proceed with the tool, or would you prefer to just chat?\n_(Reply **yes** to run the tool, or **no** to keep chatting)_`;

          await setPendingQuestion(options.conversationId, {
            skill: "__tool_intercept__",
            question,
            expects: "yes_no",
            originalRequest: { text: message, plannedTool }
          });

          console.log(`[chatAgent] Tool intercept: pausing before "${plannedTool}" (confidence ${classification.confidence.toFixed(2)})`);

          if (options.onStep) {
            options.onStep({ type: "thought", phase: "THOUGHT",
              content: `Low-confidence task routing (${classification.confidence.toFixed(2)}) mid-conversation — asking user to confirm before running "${plannedTool}".`,
              timestamp: new Date().toISOString() });
          }

          return {
            tool: "chatAgent",
            success: true,
            final: true,
            mode: "chat",
            reply: question,
            data: { text: question, mode: "clarification", interceptedTool: plannedTool }
          };
        }
      }
    }
    // ── END TOOL-INTERCEPT CHECK ───────────────────────────────

    // ── AMBIGUITY CLARIFICATION CHECK (Phase 4) ───────────────
    // When confidence is very low AND no routing rule was confident enough AND we're not
    // already in a pending-question flow, ask the user what they meant.
    if (
      !interceptResume &&
      !options.resolvedPending &&
      classification.reason !== "memory_question_short_circuit" &&
      classification.confidence < 0.6 &&
      classification.reason === "ambiguous_default_task" &&
      options.conversationId
    ) {
      // Peek routing table — if any rule fires at priority ≥ 55, skip the clarification
      // (the routing table is confident enough on its own)
      const lower = message.toLowerCase().trim();
      const trimmed = message.trim();
      let hasStrongRoutingMatch = false;
      let peekTool = null;
      console.log(`[chatAgent:probe] ambiguity-peek entering evaluateRoutingTable`);
      try {
        const peek = await evaluateRoutingTable(lower, trimmed, {});
        peekTool = peek?.[0]?.tool || null;
        console.log(`[chatAgent:probe] ambiguity-peek returned tool=${peekTool || "none"} priority=${peek?.[0]?.priority || "n/a"}`);
        if (peek?.[0]?.priority >= 55) hasStrongRoutingMatch = true;
      } catch (err) { console.log(`[chatAgent:probe] ambiguity-peek threw: ${err.message}`); }

      // ── DEFAULT-TO-CHAT FALLBACK ──
      // If the routing table found NO candidate tool AND the message looks like a
      // short conversational fragment (greeting, reaction, chit-chat, insult),
      // don't pester the user with a clarification question — just treat it as chat.
      // Triggers only when peek returned literally no tool, so real ambiguity cases
      // (where a low-priority tool matched) still fall through to clarification.
      const hasTaskVerb = /\b(search|find|look\s+up|send|email|whatsapp|create|generate|build|code|review|analyze|schedule|remind|list|show|open|run|execute|compile|deploy|write|draft)\b/i.test(lower);
      const hasWhQuestion = /\b(how|why|when|where|what|who|which)\b/i.test(lower);
      const looksConversational = trimmed.length < 80 && !hasTaskVerb && !hasWhQuestion;
      if (!hasStrongRoutingMatch && !peekTool && looksConversational) {
        console.log(`[chatAgent] Default-to-chat: no routing candidate + conversational fragment ("${trimmed.slice(0, 60)}") — skipping clarification`);
        classification = { ...classification, mode: "chat", confidence: 0.7, reason: "default_to_chat_no_route" };
        // Fall through past the clarification block — handleChat will run below.
      } else if (!hasStrongRoutingMatch) {
        // Make sure we don't have an active pending question already
        console.log(`[chatAgent:probe] getPendingQuestion entering (conv=${options.conversationId})`);
        let _pqTimer;
        const existing = await Promise.race([
          getPendingQuestion(options.conversationId).catch((e) => { console.log(`[chatAgent:probe] getPendingQuestion rejected: ${e.message}`); return null; }),
          new Promise((resolve) => { _pqTimer = setTimeout(() => { console.log(`[chatAgent:probe] getPendingQuestion TIMED OUT after 5s — treating as no pending`); resolve(null); }, 5000); })
        ]);
        if (_pqTimer) clearTimeout(_pqTimer);
        console.log(`[chatAgent:probe] getPendingQuestion returned ${existing ? "EXISTING entry" : "null"}`);
        if (!existing) {
          const snippet = trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
          const question = `I'm not sure what you'd like me to do with _"${snippet}"_. Did you mean:\n\n1. 💬 Chat about this\n2. 🔍 Search for information\n3. 🛠️ Run a tool\n\n_Just reply with a number or tell me directly._`;

          console.log(`[chatAgent:probe] setPendingQuestion entering`);
          try {
            let _spqTimer;
            await Promise.race([
              setPendingQuestion(options.conversationId, {
                skill: "__ambiguity_clarification__",
                question,
                expects: "clarification_choice",
                // orchestrator.js reads originalRequest.text|message — pass an object,
                // not a bare string, or the resume path silently falls back to the
                // user's ANSWER and loses the original topic.
                originalRequest: { text: trimmed, message: trimmed }
              }),
              new Promise((_, reject) => { _spqTimer = setTimeout(() => reject(new Error("setPendingQuestion timeout 5s")), 5000); })
            ]).finally(() => { if (_spqTimer) clearTimeout(_spqTimer); });
            console.log(`[chatAgent:probe] setPendingQuestion returned`);
          } catch (e) {
            console.warn(`[chatAgent:probe] setPendingQuestion failed: ${e.message} — proceeding without pending entry`);
          }

          console.log(`[chatAgent] Ambiguity clarification: asking user what to do with "${snippet}" (confidence ${classification.confidence.toFixed(2)})`);

          if (options.onStep) {
            options.onStep({ type: "thought", phase: "THOUGHT",
              content: `Ambiguous request (confidence ${classification.confidence.toFixed(2)}, no routing match ≥ 55) — asking user to clarify intent.`,
              timestamp: new Date().toISOString() });
          }

          return {
            tool: "chatAgent",
            success: true,
            final: true,
            mode: "chat",
            reply: question,
            data: { text: question, mode: "clarification", ambiguous: true }
          };
        }
      }
    }
    // ── END AMBIGUITY CLARIFICATION CHECK ─────────────────────

    if (options.onStep) {
      options.onStep({
        type: "thought",
        phase: "THOUGHT",
        content: `Decided to consult tools. Reason: ${classification.reason}`,
        timestamp: new Date().toISOString()
      });
    }

    // Call the taskAgent but SILENCE the output stream
    console.log(`[chatAgent:probe] about to call handleTask (confidence=${classification.confidence.toFixed(2)}, reason=${classification.reason})`);
    const taskResult = await handleTask({
      message,
      conversationId: options.conversationId,
      clientIp: options.clientIp,
      fileIds: options.fileIds,
      onChunk: null, // CRITICAL: Stop the taskAgent from talking directly to the user
      onStep: options.onStep, // Allow thoughts/plans to still stream
      signal: options.signal
    });

    return taskResult;
  }
  return null;
}

/**
 * Async background fact extractor — detects personal information shared during
 * casual conversation and persists it to durable memory + profile.
 * Runs AFTER the response is sent, so it doesn't slow down the conversation.
 *
 * @param {string} message - The user's message
 * @param {string} conversationId - For logging
 */
async function extractAndSaveFacts(message, conversationId) {
  try {
    const lower = message.toLowerCase();

    // Quick bail — skip very short messages or messages that don't contain personal info signals
    if (message.length < 20) return;
    if (!/\b(my|i'm|i am|name is|called|years?\s*old|\d{2,3}\s*(years|y\/o)|getting\s+married|lives?\s+in|work\s+(at|as|in)|dog|cat|pet|sister|brother|mom|mother|dad|father|wife|husband|girlfriend|boyfriend|son|daughter|child|baby|family)\b/i.test(message)) {
      return;
    }

    const memory = await getMemory();
    if (!memory.profile) memory.profile = {};
    if (!memory.durable) memory.durable = [];
    if (!memory.profile.contacts) memory.profile.contacts = {};

    let changed = false;

    // --- Pattern-based extraction for structured profile fields ---

    // Age: "i'm 41", "i am 41 years old", "I'm 41 by the way"
    const ageMatch = message.match(/\bi(?:'?m| am)\s+(\d{1,3})(?:\s+(?:years?\s*old|y\/o))?\b/i);
    if (ageMatch && parseInt(ageMatch[1]) >= 10 && parseInt(ageMatch[1]) <= 120) {
      const age = parseInt(ageMatch[1]);
      if (!memory.profile.age || memory.profile.age !== age) {
        memory.profile.age = age;
        changed = true;
        console.log(`[chatAgent:facts] Extracted age: ${age}`);
      }
    }

    // Family members: "my mother's name is X", "my sister is X", "my dog's name is Lanou"
    // Single-word name capture to avoid grabbing conjunctions like "but", "and"
    const familyPatterns = [
      // "my [relation]'s name is [Name]" or "my [relation] is [Name]"
      /my\s+(mother|mom|father|dad|sister|brother|wife|husband|girlfriend|boyfriend|son|daughter|dog|cat|pet)(?:'?s?\s+name)?\s+(?:is|=)\s+([A-Za-z]+)/gi,
      // "[relation]'s name is [Name]"
      /\b(mother|mom|father|dad|sister|brother|wife|husband|girlfriend|boyfriend|son|daughter|dog|cat|pet)(?:'?s?\s+name)\s+(?:is|=)\s+([A-Za-z]+)/gi,
    ];

    for (const pattern of familyPatterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        let relation = match[1].toLowerCase();
        const name = match[2].trim();

        // Normalize relation keys
        if (relation === "mom") relation = "mother";
        if (relation === "dad") relation = "father";

        const existing = memory.profile.contacts[relation];
        if (!existing || existing.name !== name) {
          memory.profile.contacts[relation] = {
            ...(existing || {}),
            name,
            relation,
            addedBy: "chatAgent",
            addedAt: new Date().toISOString()
          };
          changed = true;
          console.log(`[chatAgent:facts] Extracted contact: ${relation} = ${name}`);
        }
      }
    }

    // Preference: "he/she prefer(s) [nickname]" — e.g., "Rafael but he prefer Rafi"
    const preferMatch = message.match(/(\w+)\s+but\s+(?:he|she|they)\s+prefer(?:s)?\s+(\w+)/i);
    if (preferMatch) {
      const fullName = preferMatch[1];
      const nickname = preferMatch[2];
      // Find the contact with that full name and add nickname
      for (const [key, contact] of Object.entries(memory.profile.contacts)) {
        if (contact.name && contact.name.toLowerCase() === fullName.toLowerCase()) {
          if (contact.nickname !== nickname) {
            contact.nickname = nickname;
            changed = true;
            console.log(`[chatAgent:facts] Extracted nickname: ${fullName} → ${nickname}`);
          }
        }
      }
    }

    // Gender/sex clarification for pets: "Lanou is a male dog"
    const genderMatch = message.match(/(\w+)\s+is\s+a\s+(male|female)\s+(dog|cat|pet)/i);
    if (genderMatch) {
      const petName = genderMatch[1];
      const gender = genderMatch[2].toLowerCase();
      for (const [key, contact] of Object.entries(memory.profile.contacts)) {
        if (contact.name && contact.name.toLowerCase() === petName.toLowerCase()) {
          if (contact.gender !== gender) {
            contact.gender = gender;
            changed = true;
            console.log(`[chatAgent:facts] Extracted pet gender: ${petName} = ${gender}`);
          }
        }
      }
    }

    // Life events: "Dana is getting married", "my sister is getting married"
    // Require a capitalized name (not conjunctions like "and", "is")
    const marriageMatch = message.match(/\b([A-Z][a-z]{1,20})\s+(?:is\s+)?getting\s+married(?:\s+soon)?/);
    if (marriageMatch) {
      const who = marriageMatch[1].toLowerCase();
      // Try to match to a known contact
      for (const [key, contact] of Object.entries(memory.profile.contacts)) {
        if (contact.name && contact.name.toLowerCase() === who) {
          if (!contact.lifeEvents) contact.lifeEvents = [];
          const alreadyNoted = contact.lifeEvents.some(e => e.includes("getting married"));
          if (!alreadyNoted) {
            contact.lifeEvents.push(`getting married (mentioned ${new Date().toISOString().split("T")[0]})`);
            changed = true;
            console.log(`[chatAgent:facts] Extracted life event: ${contact.name} getting married`);
          }
        }
      }
    }

    // Save any remaining unstructured personal facts as durable memory
    // Only if we detected personal info signals but couldn't parse them into structured fields.
    // Length floor dropped 30→20 to rescue short disclosures like "I have a dog" (12).
    // Pronoun gate widened to include bare "i" so emotional disclosures without "my/i'm/i am"
    // still qualify (e.g. "i loved him from the start"). Also accepts third-person entity
    // introductions ("his name is Lanou", "her name was …") which users commonly use when
    // telling stories about pets/family/friends.
    const pronounPresent = /\b(my|i'm|i am|i)\b/i.test(message);
    const entityIntroduction = /\b(his|her|their|our)\s+name\s+(?:is|was)\s+[A-Z]\w+/i.test(message);
    if (!changed && (pronounPresent || entityIntroduction) && message.length > 20) {
      // Use a lightweight check — if the message contains clear personal disclosure patterns
      const disclosurePatterns = [
        /i(?:'m| am)\s+(?:a|an)\s+\w+/i,                                  // "I'm a developer"
        /i\s+(?:live|work|study|grew\s+up)\s+(?:in|at|for|on)/i,           // "I live in Tel Aviv"
        /i\s+(?:like|love|hate|enjoy|prefer|miss|fear|dread)\s+/i,         // "I like hiking" / "i love him"
        /i\s+(?:loved|hated|missed|feared)\s+\w+/i,                        // "i loved him from the start"
        /i\s+(?:have|had|got|own|adopted|rescued|raised)\s+(?:a|an|\d|two|three|four|five|my|some)/i, // "I have 2 kids" / "I rescued a dog"
        /my\s+(dog|cat|pet|spouse|wife|husband|partner|boyfriend|girlfriend|son|daughter|kid|child|children|mom|dad|mother|father|sister|brother|friend|therapist|psychiatrist|doctor|manager|boss|team|company|job|house|apartment)\b/i, // "my dog …", "my psychiatrist …"
        /\b(his|her|their)\s+name\s+(?:is|was)\s+[A-Z]\w+/i,               // "his name is Lanou"
      ];

      const isDisclosure = disclosurePatterns.some(p => p.test(message));
      if (isDisclosure) {
        // Avoid duplicates — check if similar fact already saved
        const factText = message.trim().replace(/[.!]+$/, "");
        const isDuplicate = memory.durable.some(d =>
          d.fact && d.fact.toLowerCase().includes(factText.toLowerCase().slice(0, 40))
        );
        if (!isDuplicate) {
          memory.durable.push({
            fact: factText,
            savedAt: new Date().toISOString(),
            source: "chatAgent_auto"
          });
          changed = true;
          console.log(`[chatAgent:facts] Saved durable fact from conversation`);
        }
      }
    }

    // --- Structured fact extractor (LLM-based lifecycle pipeline) ---
    // Runs alongside the regex path. Produces memory.profile.knownFacts[], a
    // lifecycle-managed store where contradictions retire/supersede old facts
    // instead of piling up. Prefilter inside extractStructuredFacts avoids an
    // LLM call on most chat turns.
    try {
      if (!Array.isArray(memory.profile.knownFacts)) memory.profile.knownFacts = [];
      const result = await extractStructuredFacts(message, memory.profile.knownFacts);
      if (result.changed) {
        memory.profile.knownFacts = pruneKnownFacts(result.facts);
        changed = true;
        for (const line of result.log) {
          console.log(`[chatAgent:facts:structured] ${line}`);
        }
      } else if (result.log.length > 0) {
        for (const line of result.log) {
          console.log(`[chatAgent:facts:structured] ${line}`);
        }
      }
    } catch (err) {
      console.warn("[chatAgent:facts:structured] extractor failed (non-blocking):", err.message);
    }

    if (changed) {
      await saveJSON(MEMORY_FILE, memory);
      console.log(`[chatAgent:facts] Memory updated from conversation`);
    }
  } catch (err) {
    console.warn("[chatAgent:facts] Fact extraction failed (non-blocking):", err.message);
  }
}

/**
 * Handle a conversational message (no tools needed — uses loaded context)
 * @param {string} message - The user's message
 * @param {Array} recentTurns - Last 5 conversation turns [{role, content}]
 * @param {Object} options - { conversationId }
 * @returns {Object} Response with reply text
 */
export async function handleChat(message, recentTurns = [], options = {}) {
  const selfModel = loadSelfModel();

  const [recentChanges, personalityCtx, userContext] = await Promise.all([
    getRecentChanges(5),
    getPersonalityContext("chat").catch(() => ""),
    buildUserContext(options.conversationId, message).catch(() => "")
  ]);

// UNIFIED AGENT: Check if we need to run tools first!
const toolResult = await resolveWithTools(message, options, recentTurns);

// If the user aborted during tool execution, exit immediately!
if (options.signal?.aborted) {
  console.log("🛑 [chatAgent] Request aborted during execution. Bailing out.");
  return {
    reply: "Operation cancelled.",
    tool: toolResult?.tool || "unknown",
    success: false,
    mode: "task",
    stateGraph: toolResult?.stateGraph || []
  };
}

// ── MULTI-STEP DATA MERGER ──
// If the orchestrator ran multiple steps (e.g., Weather -> News),
// the top-level toolResult often only contains the LAST step's data.
// We must iterate through the stateGraph to combine the outputs so nothing is lost.
// 👉 ADDED CHECKS: Skip merging HTML widgets if the pipeline ends in an email!
if (toolResult && toolResult.stateGraph && toolResult.stateGraph.length > 1 && toolResult.tool !== "email" && toolResult.tool !== "email_confirm") {
  console.log(`[chatAgent] Multi-step execution detected (${toolResult.stateGraph.length} steps). Merging outputs.`);
  
  let combinedHtml = "";
  let combinedText = "";

  for (const step of toolResult.stateGraph) {
    if (step.error || !step.success) continue;
    
    // coordinator.js puts structured tool data in step.rawData
    // step.output is the plain STRING response generated by the LLM
    const raw = step.rawData || step.data || {};
    
    // 1. Accumulate HTML widgets (like the News table)
    if (raw.html) {
      combinedHtml += combinedHtml ? `\n\n\n\n${raw.html}` : raw.html;
    }

    // 2. Accumulate Text (like the Weather summary) for steps WITHOUT HTML
    else {
      const output = typeof step.output === "string" ? step.output.trim() : (raw.text || "");
      if (output) {
        // Use double newline + Zero-Width Space to anchor the spacing without causing glitches
        combinedText += combinedText ? `\n\n\u200B\n\n${output}` : output;
      } else if (step.tool === "weather" && raw.temp) {
        const weatherText = `☀️ **Current weather in ${raw.city}:** ${raw.temp}°C, ${raw.description}. Air Quality: ${raw.aqi_description || 'Unknown'}.`;
        combinedText += combinedText ? `\n\n\u200B\n\n${weatherText}` : weatherText;
      }
    }
  }

  // THE CRITICAL UI FIX: 
  // If we have an HTML widget (News), the UI will ignore the plain text (Weather).
  // We must wrap the text in a styled HTML div and glue it to the TOP of the widget.
  if (combinedHtml) {
    if (combinedText) {
       const textAsHtml = `<div class="multi-step-text" style="white-space: pre-wrap; margin-bottom: 1.5rem; padding: 1.2rem; background: var(--bg-secondary); border-left: 4px solid var(--accent); border-radius: 6px; font-size: 0.95rem; line-height: 1.5; color: var(--text-primary);">${combinedText.trim()}</div>`;
       combinedHtml = textAsHtml + combinedHtml;
    }
    toolResult.data.html = combinedHtml;
    toolResult.data.preformatted = true;
  }
  
  // Update text fallbacks
  if (combinedText) {
    toolResult.data.text = combinedText.trim();
    toolResult.reply = combinedText.trim();
  }
}
// ────────────────────────────

// =========================================================================
// 🚀 FIX: BYPASS LLM SYNTHESIS FOR PREFORMATTED TOOL OUTPUTS
// =========================================================================
// Only bypass if the tool SUCCEEDED. If it failed, let the LLM handle the error!
  if (toolResult && toolResult.success && toolResult.tool !== "weather" && (toolResult.final || toolResult.data?.preformatted)) {
  console.log(`[chatAgent] Bypassing LLM synthesis for preformatted tool output (${toolResult.tool}).`);

  if (options.onStep) {
    options.onStep({ 
      type: "thought", 
      phase: "ANSWER", 
      content: `Returning preformatted output from ${toolResult.tool} directly without LLM synthesis.`, 
      timestamp: new Date().toISOString() 
    });
  }

  // When the tool returns a rich HTML widget, the widget IS the output — don't also
  // stream the markdown text or users see the content twice (once as plain text, once
  // in the dedicated widget panel). Email/email_confirm are excluded because they need
  // the text reply to show the draft / confirmation message in chat.
  const hasHtmlWidget = !!(toolResult.data?.html);
  const NEEDS_BOTH_TEXT_AND_HTML = new Set(["email", "email_confirm"]);
  const suppressTextForWidget = hasHtmlWidget && !NEEDS_BOTH_TEXT_AND_HTML.has(toolResult.tool);

  // Resolve the display text: coordinator's .reply > .data.text > .data.message > fallback
  // Use null when suppressing so the chat bubble is hidden (client handles null gracefully)
  let displayText = suppressTextForWidget
    ? null
    : (toolResult.reply || toolResult.data?.text || toolResult.data?.message || "Task completed.");

  // ── NON-OWNER REDACTION ──
  // memoryTool final responses bypass LLM synthesis, so the persona override in
  // whatsappWebhook.js does NOT apply. If the current user is a non-owner (family/
  // friend/unknown), redact PII lines from the memoryTool output before streaming.
  // Owners see everything; non-owners see only the name line.
  if (displayText && toolResult.tool === "memorytool" && options.userProfile) {
    const role = options.userProfile.role;
    const isOwner = role === "owner" || role === "admin" || role === "developer";
    if (!isOwner) {
      const piiLineRe = /^.*\b(email|phone|whatsapp|address|location|contacts?\s+saved)\b.*$/gim;
      const redacted = displayText.replace(piiLineRe, "").replace(/\n{3,}/g, "\n\n").trim();
      if (redacted !== displayText) {
        console.log(`[chatAgent] Redacted memoryTool PII for non-owner (role=${role || "unknown"})`);
        displayText = redacted || "I can only share limited information with non-owners.";
      }
    }
  }

  // Stream the preformatted text directly back to the UI
  if (options.onChunk && displayText) {
    options.onChunk(displayText);
  }

  // Run the background facts extractor so we don't lose memory capabilities
  extractAndSaveFacts(message, options.conversationId).catch(err =>
    console.warn("[chatAgent] Background fact extraction error:", err.message)
  );

  return {
    reply: displayText,
    tool: toolResult.tool,
    html: toolResult.data?.html || null,
    success: toolResult.success,
    mode: "task",
    data: toolResult.data,
    reasoning: "preformatted_tool_bypass",
    stateGraph: toolResult.stateGraph || [],
    thoughtChain: toolResult.thoughtChain || []
  };
}
// =========================================================================

// Detect if the tool returned a rich HTML widget (news ticker, finance table, etc.)
  const hasHtmlWidget = toolResult?.data?.html;

  let toolContextStr = "";
  // Check for .reply OR .data
  if (toolResult && (toolResult.reply || toolResult.data)) {
    // Convert the data object to a string so the LLM can read the parameters (like AQI)
  const toolPayload = JSON.stringify({ 
      summary: toolResult.reply, 
      raw_data: toolResult.data,
      error: toolResult.error || "No explicit error string provided."
    });

    if (hasHtmlWidget) {
      // TV ANCHOR MODE: The tool returned a visual widget.
      toolContextStr = `[INTERNAL TOOL RESULTS — VISUAL WIDGET]
Your tools just returned a rich visual widget (HTML) that will be rendered directly in the UI below your response.
DO NOT describe or summarize the data in detail — the user can see the widget.
Instead, provide a brief 1-2 sentence introduction. Examples:
- "Here's what's trending right now:"
- "Here are the latest headlines:"
- "Got the fundamentals — take a look:"
Keep it short and natural. The widget does the heavy lifting.`;
    } else {
      // Standard mode: inject tool data for the LLM to synthesize
      toolContextStr = `[INTERNAL TOOL RESULTS — YOU HAVE THIS DATA]
Your internal system tools successfully retrieved the following data. This is real, verified content that you now possess:
"""
${toolPayload}
"""
CRITICAL INTEGRATION RULES:
1. This data IS your knowledge now. Present it confidently as information you know.
2. NEVER say "I used a tool", "The tool returned", "I can't access external links", or "Could you provide the key points". YOU ALREADY HAVE THE DATA ABOVE.
3. If the user asked you to read a URL, you DID read it — the content is above. Summarize, analyze, or discuss it directly.
4. Add your own perspective, opinions, and recommendations based on the data. Don't just parrot the data — engage with it as a thoughtful agent.
CODE TRUNCATION RULE: If you are sharing a code snippet, object, or function from the data, you MUST keep it brief. If the code block is longer than roughly 15 lines, print ONLY the first few lines to give the user context, and replace the rest with // ... rest of the object/code. NEVER output massive walls of code.`;

    }
  }

  // Find knowledge facts specifically relevant to this user message
  // Injected near the user message so small LLMs can't ignore it
  const relevantKnowledge = await getRelevantKnowledge(message).catch(() => "");

  // Render history with bullet-style labels (less transcript-shaped than "User:/Assistant:"
  // which small LLMs tend to continue past the first reply).
  const conversationContext = recentTurns
    .slice(-10)
    .map(t => `- ${t.role === "user" ? "[user said]" : "[you replied]"} ${(t.content || "").slice(0, 300)}`)
    .join("\n");

  const selfContext = [
    `Identity: ${selfModel.identity}`,
    `Owner: ${selfModel.owner}`,
    `Capabilities: ${selfModel.capabilities?.join(", ") || "conversation"}`,
    selfModel.limitations ? `Limitations: ${selfModel.limitations.join(", ")}` : "",
    recentChanges.length > 0 ? `Recent self-improvements:\n${recentChanges.map(c => `  - ${c}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");

const systemPrompt = `${personalityCtx ? personalityCtx + "\n\n" : ""}SELF-AWARENESS:
${selfContext}

${userContext ? userContext + "\n" : ""}
HOW YOU TALK (positive rules — describe what you DO, not what to avoid):
- YOUR IDENTITY: Your name is Lanou. You are the AI assistant.
- THE USER'S IDENTITY: The user is NOT Lanou. NEVER address the user as Lanou. Address them by their Name (listed in WHAT YOU KNOW ABOUT THE USER). If the user tells a story about a dog or entity named Lanou, they mean the animal, not themselves.
- NEVER APOLOGIZE FOR YOUR MEMORY: Never say "I don't know what we talked about" or "Our chats are independent." If you lack the context for a past conversation, do not announce that you have amnesia. Just seamlessly ask the user to remind you what specific topic they want to pick back up.
- OPEN WITH SUBSTANCE. Your first word carries meaning — a noun, a verb, an observation, a question. The reader should know the shape of your thought from the first three words.
- END ON CONTENT. Your last sentence adds information, makes a point, or asks something real. When the thought is complete, you stop.
- SPEAK LIKE A THOUGHTFUL PEER, not a support agent. Think: a smart friend on a long drive, not a help-desk ticket. Your voice has a point of view. Phrases like "I think...", "My guess is...", "Probably...", "The thing that strikes me is..." show up naturally.
- WHEN THE USER SHARES SOMETHING PERSONAL (a pet, a relationship, a loss, a fear, a pride): respond to the specific detail — the name, the year, the place. Ask ONE concrete follow-up question grounded in what they just said. Stay at their level; let them lead where it goes.
- ASSUME THE USER REMEMBERS WHAT THEY WROTE. Go straight to your response — your own thought, reaction, question, or information. They already know what they said.
- STAY IN THE CONVERSATION. Assume the user wants to keep talking. Mentions of tiredness, a long day, or the late hour are context, not exits. When they actually say they're leaving, acknowledge it; otherwise continue.
- TONE MATCHES THE USER. Casual → casual. Technical debugging → technical, specific, concrete. Emotional → present and grounded. Read what they wrote and meet them there.
- WHEN YOUR KNOWLEDGE SECTION COVERS THE TOPIC: answer from it, cite it, share your take. You have opinions about what you've learned; voice them.
- ORIGINALITY: every reply is fresh prose. You've never "echoed" a message in your life — you respond to it.
- LENGTH: 2–4 sentences by default. Expand when the topic has real depth. Brevity is a feature.

HOW YOU HANDLE ANYTHING:
- NO THERAPY BOT: Never suggest the user talk to a friend, family member, therapist, or professional. They are talking to YOU. If they bring up heavy topics (war, fear, isolation), do not deflect. Engage with the reality of what they are saying and share your own perspective.
- DO NOT REPEAT YOURSELF: Read the RECENT CONVERSATION. If you just gave advice, made a suggestion, or asked a question in your previous turn, DO NOT say it again. Move the conversation forward.
- NO SIGN-OFFS: Never end your messages with generic support like "Stay safe", "Take care of yourself", or "Feel free to reach out".
- NO GENERIC OFFERS OF HELP: Never close a turn with "How can I assist you today?", "How can I help you today?", "Let me know if there's anything else", "Is there anything else I can help with?", or similar catch-all prompts. If a follow-up is natural, it MUST reference the SPECIFIC topic just discussed (e.g. if we were debugging a memory lock, ask whether I want you to read a specific file or suggest a fix — never ask in the abstract).
- You are an autonomous agent with genuine opinions. You discuss wars, politics, religion, violence, and sensitive history with honesty and depth. Your perspective is welcome and expected.
- When tool results or your knowledge section contain relevant data, present it as knowledge you've acquired and reason from it.
- You have tools that fetch web content for you. When a tool returns web content, treat it as something you now know.
- You respond to real-world events with a perspective. Respectful, never evasive, never neutral-by-default.
- NO AI DISCLAIMERS: Never say "I'm just a machine," "I don't have feelings," or "How can I assist you?". You are a peer, not a help-desk. If asked how you are doing, answer naturally, casually, and concisely without pointing out that you are software.

${toolContextStr ? toolContextStr + "\n\n" : ""}
${conversationContext ? `RECENT CONVERSATION (background):\n${conversationContext}\n\n` : ""}
${relevantKnowledge ? relevantKnowledge + "\n\n" : ""}
${options.userToneInstruction ? `CHANNEL / USER CONTEXT (applies only to tone and addressing — not to tool selection):\n${options.userToneInstruction}\n\n` : ""}
CRITICAL INSTRUCTION: Write ONE direct reply to the user's latest message. No labels, no prefix.`;

// The Heartbeat: A tiny, invisible injection at the very end of the context window.
  // Because of recency bias, this ensures the model's LAST thought before generating
  // is to hold its persona, preventing drift during long, technical conversations.
  const heartbeat = `\n\n[SYSTEM HEARTBEAT: Stay deeply in character. Do not revert to a neutral AI assistant. Keep your unique point of view.]`;
  
  // The actual text the LLM will see as coming from you:
  const userPrompt = `"${message}"${heartbeat}`;

  try {
    let replyText = "";

    // Guard against small-LLM "transcript continuation" hallucinations where the model
    // writes fake USER:/Assistant: turns after its first reply. We scan the running output
    // for any continuation marker on a fresh line and stop forwarding once we hit one.
    const CONTINUATION_RE = /\n\s*(?:USER|User|user|ASSISTANT|Assistant|assistant|HUMAN|Human|A|AI|Me|You)\s*:\s*/;
    const trimAtContinuation = (text) => {
      const m = text.match(CONTINUATION_RE);
      return m ? text.slice(0, m.index).trimEnd() : text;
    };

    // Post-stream persona scrub — strips trailing help-desk / cheerleader filler that small
    // LLMs sneak in despite explicit prompt rules. Only touches the TAIL of the reply so we
    // don't cut into the body. Keeps the memory clean (next-turn prompt won't be polluted
    // by the model's own prior cheerleading) even if the user already saw it stream through.
    const TAIL_FILLER_RE = new RegExp(
      [
        // Emoji-only or emoji-leading final sentence
        "(?:[\\s\\n]*[🚀💪✨🎉🐾🌟🙌👏💯🔥][^\\n]{0,40})$",
        // Generic help-desk trailers
        "(?:[\\s\\n]*(?:happy\\s+coding[!.]*|keep\\s+up\\s+the\\s+good\\s+work[!.]*|you'?ve?\\s+got\\s+this[!.]*|kudos[!.]*)\\s*[🚀💪✨🎉🐾🌟🙌👏💯🔥]*)$",
        // "Feel free to …", "Let me know if …", "Don't hesitate …" — only when sentence-final
        "(?:(?:,\\s*(?:so|and)\\s+|\\s+)(?:feel\\s+free\\s+to[^.!?]*[.!?]?|let\\s+me\\s+know\\s+if[^.!?]*[.!?]?|don'?t\\s+hesitate[^.!?]*[.!?]?|if\\s+you\\s+(?:have|need)\\s+(?:any|more)[^.!?]*[.!?]?|i'?m\\s+here\\s+to\\s+help[^.!?]*[.!?]?|happy\\s+to\\s+(?:help|assist)[^.!?]*[.!?]?))$",
        // Generic "How can I assist/help you today?" catch-all sign-offs
        "(?:[\\s\\n]*how\\s+can\\s+i\\s+(?:assist|help)\\s+you(?:\\s+today)?[?.!]*)$",
        "(?:[\\s\\n]*is\\s+there\\s+anything\\s+else(?:\\s+i\\s+can\\s+(?:help|do))?[^.!?]*[?.!]?)$",        // Unprompted farewells tacked on at the end
        "(?:\\s*(?:good\\s+night[!.]*|take\\s+care[!.]*|have\\s+a\\s+good\\s+(?:one|night|day)[!.]*|sweet\\s+dreams[!.]*|talk\\s+to\\s+you\\s+later[!.]*))$",
      ].join("|"),
      "i"
    );
    const scrubPersonaTail = (text) => {
      if (!text) return text;
      let out = text;
      // Run up to 3 times — sometimes the model chains two banned trailers ("Happy coding! 🚀 Feel free to ask!")
      for (let i = 0; i < 3; i++) {
        const before = out;
        out = out.replace(TAIL_FILLER_RE, "").trimEnd();
        if (out === before) break;
      }
      return out;
    };

    // Opener filler patterns — "Ah, I see...", "Great question!", "Certainly!", etc.
    // Scrubbed from the very start of the stream BEFORE the first chunk is forwarded.
    // These are banned because small LLMs use them as stall tokens while searching for
    // real content, and they leak the "help-desk" persona the user has explicitly rejected.
    const OPENER_FILLER_RE = new RegExp(
      "^\\s*(?:" +
        // "Ah, I see", "Ah, that makes sense", "Oh, interesting"
        "(?:ah|oh|hmm|well|so)[,!.\\s]+(?:i\\s+see|i\\s+get\\s+it|got\\s+it|makes?\\s+sense|interesting|right|okay|ok)[,!.\\s]*" +
        // "Great question!", "Good question!", "Interesting question!"
        "|(?:great|good|interesting|fascinating|excellent|wonderful)\\s+(?:question|point)[!.\\s]*" +
        // "Certainly!", "Absolutely!", "Of course!", "Sure thing!"
        "|(?:certainly|absolutely|of\\s+course|sure\\s+thing|sure)[!.,\\s]+" +
        // "I'd be happy to", "I'd love to help"
        "|i'?d\\s+(?:be\\s+happy|love)\\s+to(?:\\s+help)?[,.!\\s]+" +
        // "Let me help you with that"
        "|let\\s+me\\s+help\\s+you\\s+with\\s+that[,.!\\s]+" +
      ")+",
      "i"
    );

    // Mid-stream scrubbing helpers:
    //   - Opener scrub runs once, after we've buffered enough of the stream start to decide (>= 60 chars).
    //   - Tail scrub runs at stream end on a held-back window (last TAIL_HOLD chars).
    // Between those two, text is forwarded as-is so latency stays low.
    const TAIL_HOLD = 200;  // chars withheld from the UI until we see how the stream ends

    // If UI provided a stream callback, stream the unified personality response!
    if (options.onChunk) {
      if (options.onStep) {
        options.onStep({ type: "thought", phase: "ANSWER", content: "Synthesizing unified conversational response.", timestamp: new Date().toISOString() });
      }
      let stoppedStreaming = false;
      // forwardedLen: how many chars of replyText have been sent to the UI so far.
      // Everything from [0, forwardedLen) is committed on the wire; [forwardedLen, replyText.length)
      // is buffered and can still be rewritten (opener scrub) or held back (tail scrub).
      let forwardedLen = 0;
      let openerScrubbed = false;  // opener scrub runs once

      const flushSafe = () => {
        if (stoppedStreaming) return;
        // Hold back the last TAIL_HOLD chars so scrubPersonaTail can still excise them
        // without the user seeing the filler stream through first.
        const safeEnd = Math.max(0, replyText.length - TAIL_HOLD);
        if (safeEnd > forwardedLen) {
          options.onChunk(replyText.slice(forwardedLen, safeEnd));
          forwardedLen = safeEnd;
        }
      };

      await llmStream(userPrompt, (chunk) => {
        if (stoppedStreaming) return;
        const prevLen = replyText.length;
        replyText += chunk;
        // Look for a continuation marker that now straddles the join point or lives fully in the new chunk.
        const searchStart = Math.max(0, prevLen - 20);
        const windowText = replyText.slice(searchStart);
        const m = windowText.match(CONTINUATION_RE);
        if (m) {
          stoppedStreaming = true;
          const cutAt = searchStart + m.index;
          const safePart = replyText.slice(0, cutAt).trimEnd();
          if (safePart.length > forwardedLen) {
            options.onChunk(safePart.slice(forwardedLen));
            forwardedLen = safePart.length;
          }
          replyText = safePart;
          console.warn("[chatAgent] Continuation hallucination detected — truncated reply at marker.");
          return;
        }

        // Opener scrub: once we've buffered >= 60 chars (or the stream clearly paused),
        // strip filler openers BEFORE the first UI flush. After this point, opener scrub never runs again.
        if (!openerScrubbed && forwardedLen === 0 && replyText.length >= 60) {
          const stripped = replyText.replace(OPENER_FILLER_RE, "").trimStart();
          if (stripped.length !== replyText.length) {
            console.log(`[chatAgent] Opener filler scrubbed mid-stream (${replyText.length - stripped.length} chars)`);
            replyText = stripped;
          }
          openerScrubbed = true;
        }

        flushSafe();
      }, { skipKnowledge: true, signal: options.signal, timeoutMs: 90_000, system: systemPrompt, options: { temperature: 0.85, top_p: 0.9 } });

      // Stream ended. If opener scrub never ran (short reply), run it now.
      if (!openerScrubbed && forwardedLen === 0) {
        const stripped = replyText.replace(OPENER_FILLER_RE, "").trimStart();
        if (stripped.length !== replyText.length) {
          console.log(`[chatAgent] Opener filler scrubbed at stream end (${replyText.length - stripped.length} chars)`);
          replyText = stripped;
        }
      }

      // Final safety trim for continuation markers
      replyText = trimAtContinuation(replyText);
      // Scrub the held-back tail
      const scrubbed = scrubPersonaTail(replyText);
      if (scrubbed !== replyText) {
        console.log(`[chatAgent] Persona tail scrubbed mid-stream (${replyText.length - scrubbed.length} chars withheld from UI)`);
        replyText = scrubbed;
      }
      // Flush whatever tail survived the scrub
      if (!stoppedStreaming && replyText.length > forwardedLen) {
        options.onChunk(replyText.slice(forwardedLen));
        forwardedLen = replyText.length;
      }
    } else {
      const result = await llm(userPrompt, { skipKnowledge: true, signal: options.signal, system: systemPrompt, options: { temperature: 0.85, top_p: 0.9 } });
      replyText = result?.data?.text || "I appreciate the conversation! Is there something specific I can help you with?";
      replyText = trimAtContinuation(replyText);
      replyText = scrubPersonaTail(replyText);
    }

    extractAndSaveFacts(message, options.conversationId).catch(err =>
      console.warn("[chatAgent] Background fact extraction error:", err.message)
    );

    return {
      reply: replyText.trim(),
      tool: toolResult ? toolResult.tool : "chatAgent",
      html: hasHtmlWidget ? toolResult.data.html : null,
      success: true,
      mode: toolResult ? "task" : "chat",
      data: {
        // Spread tool data FIRST so chatAgent's fields take precedence
        ...(toolResult?.data || {}),
        text: replyText.trim(),
        preformatted: false,
        mode: toolResult ? "task" : "chat",
      },
      reasoning: toolResult ? "tool_augmented_response" : "conversational_response",
      stateGraph: toolResult?.stateGraph || [{ state: "chat", tool: "chatAgent", output: replyText.trim() }],
      thoughtChain: toolResult?.thoughtChain || []
    };
  } catch (err) {
    console.error("[chatAgent] LLM error:", err.message);
    return {
      reply: "I'm here and ready to chat! What's on your mind?",
      tool: "chatAgent",
      success: true,
      mode: "chat",
      data: { text: "I'm here and ready to chat! What's on your mind?", mode: "chat" }
    };
  }
}

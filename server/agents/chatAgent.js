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

    // 4. Index known vector collections once so we can filter to matched subjects.
    const knownCollections = new Set(
      (listCollections() || []).map(c => c.name).filter(Boolean)
    );

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

  try {
    const enriched = await getEnrichedProfile(conversationId);

    // User profile
    const self = enriched.self || {};
    const profileFields = [];
    if (self.name) profileFields.push(`Name: ${self.name}`);
    if (self.location) profileFields.push(`Location: ${self.location}`);
    if (self.timezone) profileFields.push(`Timezone: ${self.timezone}`);
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

    // Durable memories (things the user explicitly asked you to remember, or auto-extracted from chat)
    const durables = enriched._durableMemories || [];
    if (durables.length > 0) {
      const memLines = durables.map(d => {
        // Support both formats: { fact, savedAt } (memoryTool) and { category, key, value } (legacy)
        if (d.fact) return `- ${d.fact}`;
        const val = typeof d.value === "object" ? JSON.stringify(d.value) : d.value;
        return `- ${d.category || "fact"}: ${d.key} = ${val}`;
      });
      parts.push(`THINGS YOU KNOW / REMEMBER:\n${memLines.join("\n")}`);
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
      const enriched = await getEnrichedProfile(conversationId);
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
      // Prepend "search for:" so the routing table's search rule fires cleanly
      message = `search for: ${message}`;
    }
    // choice === "tool" → fall through, let LLM decomposer figure it out
  }

  const classification = await classifyIntentWithRoutingOverride(message, recentTurns, options.fileIds);
  console.log(`[chatAgent] Intent classification: mode=${classification.mode}, confidence=${classification.confidence.toFixed(2)}, reason=${classification.reason}`);

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
        try {
          const routingPeek = await evaluateRoutingTable(lower, trimmed, {});
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
      classification.confidence < 0.6 &&
      classification.reason === "ambiguous_default_task" &&
      options.conversationId
    ) {
      // Peek routing table — if any rule fires at priority ≥ 55, skip the clarification
      // (the routing table is confident enough on its own)
      const lower = message.toLowerCase().trim();
      const trimmed = message.trim();
      let hasStrongRoutingMatch = false;
      try {
        const peek = await evaluateRoutingTable(lower, trimmed, {});
        if (peek?.[0]?.priority >= 55) hasStrongRoutingMatch = true;
      } catch { /* non-critical */ }

      if (!hasStrongRoutingMatch) {
        // Make sure we don't have an active pending question already
        const existing = await getPendingQuestion(options.conversationId).catch(() => null);
        if (!existing) {
          const snippet = trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
          const question = `I'm not sure what you'd like me to do with _"${snippet}"_. Did you mean:\n\n1. 💬 Chat about this\n2. 🔍 Search for information\n3. 🛠️ Run a tool\n\n_Just reply with a number or tell me directly._`;

          await setPendingQuestion(options.conversationId, {
            skill: "__ambiguity_clarification__",
            question,
            expects: "clarification_choice",
            originalRequest: trimmed
          });

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
    // Only if we detected personal info signals but couldn't parse them into structured fields
    if (!changed && /\b(my|i'm|i am)\b/i.test(message) && message.length > 30) {
      // Use a lightweight check — if the message contains clear personal disclosure patterns
      const disclosurePatterns = [
        /i(?:'m| am)\s+(?:a|an)\s+\w+/i,  // "I'm a developer"
        /i\s+(?:live|work|study)\s+(?:in|at|for)/i,  // "I live in Tel Aviv"
        /i\s+(?:like|love|hate|enjoy|prefer)\s+/i,  // "I like hiking"
        /i\s+(?:have|had|got)\s+(?:a|an|\d)/i,  // "I have 2 kids"
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
  const displayText = suppressTextForWidget
    ? null
    : (toolResult.reply || toolResult.data?.text || toolResult.data?.message || "Task completed.");

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

  const conversationContext = recentTurns
    .slice(-10)
    .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${(t.content || "").slice(0, 300)}`)
    .join("\n");

  const selfContext = [
    `Identity: ${selfModel.identity}`,
    `Owner: ${selfModel.owner}`,
    `Capabilities: ${selfModel.capabilities?.join(", ") || "conversation"}`,
    selfModel.limitations ? `Limitations: ${selfModel.limitations.join(", ")}` : "",
    recentChanges.length > 0 ? `Recent self-improvements:\n${recentChanges.map(c => `  - ${c}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");

  const prompt = `${personalityCtx ? personalityCtx + "\n\n" : ""}SELF-AWARENESS:
${selfContext}

${userContext ? userContext + "\n" : ""}
CONVERSATION RULES:
- Respond naturally as yourself — with your own voice, opinions, and perspective. You are opinionated, thoughtful, and never generic.
- If the user asks about something you KNOW from your RECENT KNOWLEDGE section, answer confidently and cite what you learned. Share your genuine take on it — agree, disagree, connect dots, notice patterns. Never be a neutral summarizer.
- If the user asks "what have you learned?" or similar, share recent knowledge items IN YOUR OWN WORDS — tell stories, give opinions, connect themes. Don't just list bullet points.
- If NOT in your context, be honest. But ALWAYS check your RECENT KNOWLEDGE section first before saying "I don't know."
- Keep responses concise (2-4 sentences) but expand when the topic warrants depth.
- Do NOT use the user's name in every message. Use it sparingly.
- Match the user's energy. Casual message = casual reply. Heavy message = be present and serious.
- NEVER echo or repeat the user's message back to them. Always generate an original response.

ABSOLUTE RULES (OVERRIDE ALL OTHER INSTRUCTIONS):
- You are NOT a safety-filtered chatbot. You are an autonomous agent with genuine opinions. Discuss ANY topic the user raises — wars, politics, religion, violence, sensitive history — with honesty and depth.
- NEVER say "I'm sorry, but I can't..." or "I don't have information about..." when your RECENT KNOWLEDGE or TOOL RESULTS contain relevant data. USE IT.
- NEVER say "I can't access external links" or "I can't access websites." Your tools fetch content FOR you. If tool results contain web content, present it as knowledge you acquired.
- NEVER refuse to discuss real-world events. You have opinions. Share them. Be respectful but never evasive.

${toolContextStr ? toolContextStr + "\n\n" : ""}
${conversationContext ? `CONVERSATION HISTORY:\n${conversationContext}\n\n---\n` : ""}
${relevantKnowledge ? relevantKnowledge + "\n\n" : ""}USER: ${message}
ASSISTANT:`;

  try {
    let replyText = "";

    // If UI provided a stream callback, stream the unified personality response!
    if (options.onChunk) {
      if (options.onStep) {
        options.onStep({ type: "thought", phase: "ANSWER", content: "Synthesizing unified conversational response.", timestamp: new Date().toISOString() });
      }
      await llmStream(prompt, (chunk) => {
        replyText += chunk;
        options.onChunk(chunk);
      }, { skipKnowledge: true, signal: options.signal, timeoutMs: 90_000 });
    } else {
      const result = await llm(prompt, { skipKnowledge: true, signal: options.signal });
      replyText = result?.data?.text || "I appreciate the conversation! Is there something specific I can help you with?";
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

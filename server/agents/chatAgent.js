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
import { llm } from "../tools/llm.js";
import { getMemory, getEnrichedProfile, saveJSON, MEMORY_FILE } from "../memory.js";
import { getPersonalityContext } from "../personality.js";
import { getKnowledgeContext } from "../knowledge.js";

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
 * Build user context from memory — profile, durable memories, knowledge.
 * This is the information the chatAgent "knows" about the user.
 */
async function buildUserContext(conversationId) {
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
    if (enriched.tone) profileFields.push(`Preferred tone: ${enriched.tone}`);

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

  return parts.join("\n\n");
}

// OPTION_B_HOOK: Future tool-augmented chat
// When Option B is needed, implement this function to:
// 1. Detect if the message needs information the chatAgent doesn't have
//    (e.g., "what was the stock price yesterday?", "check my email")
// 2. Delegate to the orchestrator/taskAgent to run specific tools
// 3. Return the tool results as additional context for the prompt
//
// async function resolveWithTools(message, userContext) {
//   // Detect information needs that require tool calls
//   const needsTool = /\b(check|look up|search|what was|find)\b/i.test(message)
//     && !userContext.includes(/* relevant answer */);
//   if (!needsTool) return null;
//
//   // Delegate to orchestrator
//   const { executeTask } = await import("./taskAgent.js");
//   const result = await executeTask(message, { chatDelegation: true });
//   return result?.data?.text || null;
// }

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

  // Load all context in parallel for speed
  const [recentChanges, personalityCtx, userContext] = await Promise.all([
    getRecentChanges(5),
    getPersonalityContext("chat").catch(() => ""),
    buildUserContext(options.conversationId).catch(() => "")
  ]);

  // Build conversation context (last 10 turns for better continuity)
  const conversationContext = recentTurns
    .slice(-10)
    .map(t => `${t.role === "user" ? "User" : "Assistant"}: ${(t.content || "").slice(0, 300)}`)
    .join("\n");

  // Build self-awareness context
  const selfContext = [
    `Identity: ${selfModel.identity}`,
    `Owner: ${selfModel.owner}`,
    `Capabilities: ${selfModel.capabilities?.join(", ") || "conversation"}`,
    selfModel.limitations ? `Limitations: ${selfModel.limitations.join(", ")}` : "",
    recentChanges.length > 0 ? `Recent self-improvements:\n${recentChanges.map(c => `  - ${c}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");

  // OPTION_B_HOOK: If tool delegation is enabled in the future, call it here:
  // const toolContext = await resolveWithTools(message, userContext);
  // if (toolContext) { /* inject into prompt */ }

  // Build the prompt — rules FIRST, user message LAST (local LLMs focus on what's closest to "Response:")
  const prompt = `${personalityCtx ? personalityCtx + "\n\n" : ""}SELF-AWARENESS:
${selfContext}

${userContext ? userContext + "\n" : ""}
CONVERSATION RULES:
- Respond naturally as yourself — with your own voice, opinions, and perspective.
- If the user asks about something you KNOW from context, answer confidently. If NOT in your context, be honest.
- Keep responses concise (2-4 sentences) but expand when the topic warrants depth.
- Do NOT suggest running tools or performing tasks — this is a casual conversation.
- Do NOT use the user's name in every message. Use it sparingly.
- Do NOT end every message with a question. You can make statements, share thoughts, or just acknowledge.
- Match the user's energy. Casual message = casual reply. Heavy message = be present and serious.
- If the user shares something distressing (war, death, danger, grief) in their CURRENT message, acknowledge the gravity with genuine concern. Do NOT minimize or trivialize.
- If the current message is a simple opener (like "can we speak?", "hey"), respond casually — do NOT bring up heavy topics from earlier conversation history.
- NEVER echo or repeat the user's message back to them. Always generate an original response.

${conversationContext ? `CONVERSATION HISTORY (background context only — do NOT re-address old topics):\n${conversationContext}\n\n---\n` : ""}
USER: ${message}
ASSISTANT:`;

// 👇 ADD THESE 3 LINES RIGHT HERE 👇
  console.log("\n🧠 [chatAgent] === INJECTING SELF-AWARENESS CONTEXT ===");
  console.log(prompt);
  console.log("=====================================================\n");

  try {
    const result = await llm(prompt, { skipKnowledge: true }); // knowledge already injected above
    const replyText = result?.data?.text || "I appreciate the conversation! Is there something specific I can help you with?";

    // Fire-and-forget: extract personal facts from the user's message and save to memory
    // This runs AFTER the response is generated, so it doesn't slow down the conversation
    extractAndSaveFacts(message, options.conversationId).catch(err =>
      console.warn("[chatAgent] Background fact extraction error:", err.message)
    );

    return {
      reply: replyText.trim(),
      tool: "chatAgent",
      success: true,
      mode: "chat",
      data: {
        text: replyText.trim(),
        preformatted: false,
        mode: "chat"
      },
      reasoning: "conversational_response",
      stateGraph: [{ state: "chat", tool: "chatAgent", output: replyText.trim() }]
    };
  } catch (err) {
    console.error("[chatAgent] LLM error:", err.message);
    return {
      reply: "I'm here and ready to chat! What's on your mind?",
      tool: "chatAgent",
      success: true,
      mode: "chat",
      data: { text: "I'm here and ready to chat! What's on your mind?", mode: "chat" },
      reasoning: "chat_fallback",
      stateGraph: [{ state: "chat", tool: "chatAgent", output: "fallback" }]
    };
  }
}

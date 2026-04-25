// server/tools/memoryTool.js
// COMPLETE FIX: Memory tool with profile retrieval functionality

import { getMemory, saveJSON, reloadMemory, MEMORY_FILE } from "../memory.js";

export async function memorytool(request) {
  const text = request?.text || request || "";
  const lower = text.toLowerCase();
  const context = request?.context || {};

  // --- FORGET LOCATION ---
  if (
    lower.includes("forget my location") ||
    lower.includes("clear my location") ||
    lower.includes("remove my location") ||
    lower.includes("delete my location") ||
    context.raw === "forget_location"
  ) {
    const memory = await getMemory();
    if (memory.profile?.location) {
      delete memory.profile.location;
      await saveJSON(MEMORY_FILE, memory);
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: "I've forgotten your saved location." }
      };
    }
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: "I don't have any saved location to forget." }
    };
  }

  // --- REMEMBER PROFILE FIELDS ---
  // Handles: "remember my name is X", "my email is X", "remember my location is London",
  //          "remember my phone is 050...", "save my tone as friendly"
  const profileFieldMatch = text.match(/(?:remember(?:\s+that)?|save|set|update|store)?\s*my\s+(name|email|e-mail|location|city|phone|number|tone|whatsapp|address)\s+(?:is|to|as|=)\s+(.+)$/i);
  if (profileFieldMatch) {
    let [, rawField, value] = profileFieldMatch;
    value = value.trim().replace(/[.!]+$/, '');
    const memory = await getMemory();
    if (!memory.profile) memory.profile = {};

    // Normalize field name
    let field = rawField.toLowerCase();
    if (field === "e-mail") field = "email";
    if (field === "city") field = "location";
    if (field === "number" || field === "whatsapp") field = "phone";

    memory.profile[field] = value;
    await saveJSON(MEMORY_FILE, memory);
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: `I've saved your ${field} as "${value}".` }
    };
  }

  // --- UPDATE CONTACT DETAILS ---
  // "remember mom's phone is 0505576150", "save John's email as john@x.com",
  // "mom's number is 050...", "update Dad's address to 123 Main St"
  const contactUpdateMatch = lower.match(/(?:remember|save|update|set|store)?\s*(\w+?)[''\u2019]?s?\s+(phone|email|e-mail|address|number|whatsapp)\s+(?:is|number\s+is|to|as|=)\s+(.+)/i);
  if (contactUpdateMatch) {
    const [, contactName, field, value] = contactUpdateMatch;

    // Guard: if the "contact name" is a self-referential pronoun, this is actually
    // a profile field update (e.g., "my email is X" → save to profile, not a "My" contact).
    if (["my", "i", "me", "myself"].includes(contactName.toLowerCase())) {
      const fieldName = (field === "number" || field === "whatsapp") ? "phone" : (field === "e-mail" ? "email" : field.toLowerCase());
      const cleanValue = value.trim().replace(/[.!]+$/, '');
      const memory = await getMemory();
      if (!memory.profile) memory.profile = {};
      memory.profile[fieldName] = cleanValue;
      await saveJSON(MEMORY_FILE, memory);
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `I've saved your ${fieldName} as "${cleanValue}".` }
      };
    }
    const memory = await getMemory();
    if (!memory.profile) memory.profile = {};
    if (!memory.profile.contacts) memory.profile.contacts = {};

    // Find existing contact by fuzzy match
    const contactKey = Object.keys(memory.profile.contacts).find(
      k => k.toLowerCase() === contactName.toLowerCase() ||
           memory.profile.contacts[k]?.name?.toLowerCase() === contactName.toLowerCase()
    );

    const fieldName = (field === "number" || field === "whatsapp") ? "phone" : (field === "e-mail" ? "email" : field);
    const cleanValue = value.trim().replace(/[.!]+$/, '');

    if (contactKey) {
      memory.profile.contacts[contactKey][fieldName] = cleanValue;
    } else {
      // Create new contact entry
      const key = contactName.toLowerCase();
      memory.profile.contacts[key] = {
        name: contactName.charAt(0).toUpperCase() + contactName.slice(1),
        [fieldName]: cleanValue,
        aliases: [],
        dateAdded: new Date().toISOString()
      };
    }

    await saveJSON(MEMORY_FILE, memory);
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: `✅ Saved ${contactKey || contactName}'s ${fieldName}: ${cleanValue}` }
    };
  }

  // PROFILE RETRIEVAL - "what do you remember about me?", "who am i?"
  if (
    lower.includes("who am i") ||
    lower.includes("what do you remember") ||
    lower.includes("what do you know about me") ||
    lower.includes("tell me about myself") ||
    lower.includes("what is my information") ||
    lower.includes("show my profile") ||
    lower.includes("my profile") ||
    lower.includes("what's in my profile")
  ) {
    const memory = await getMemory();
    const profile = memory.profile || {};
    // Support both flat (profile.name) and nested (profile.self.name) layouts
    const self = profile.self || {};

    const name = profile.name || self.name;
    const location = profile.location || self.location;
    const email = profile.email || self.email;
    const phone = profile.phone || self.phone;
    const whatsapp = profile.whatsapp || self.whatsapp;
    const address = profile.address || self.address;
    const tone = profile.tone || self.tone;
    const contacts = profile.contacts || {};

    const hasAnyData = name || location || email || phone || address || tone || Object.keys(contacts).length > 0;

    if (!hasAnyData) {
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: {
          profile: {},
          message: "I don't have any information saved about you yet.\n\nYou can tell me things like:\n• 'remember my name is John'\n• 'remember my location is London'"
        }
      };
    }

    // Build profile summary
    let summary = "📋 **Here's what I remember about you:**\n\n";
    if (name) summary += `• **Name:** ${name}\n`;
    if (location) summary += `• **Location:** ${location}\n`;
    if (email) summary += `• **Email:** ${email}\n`;
    if (phone) summary += `• **Phone:** ${phone}\n`;
    if (whatsapp && whatsapp !== phone) summary += `• **WhatsApp:** ${whatsapp}\n`;
    if (address) summary += `• **Address:** ${address}\n`;
    if (tone) summary += `• **Preferred tone:** ${tone}\n`;

    // Include contacts if any
    if (contacts && Object.keys(contacts).length > 0) {
      summary += `\n**Contacts saved:** ${Object.keys(contacts).length}\n`;
      const contactList = Object.entries(contacts)
        .slice(0, 5)
        .map(([key, c]) => `• ${c.name || key}: ${c.email || c.phone || c.relation || 'No details'}`)
        .join('\n');
      summary += contactList;
      if (Object.keys(contacts).length > 5) {
        summary += `\n• ... and ${Object.keys(contacts).length - 5} more`;
      }
    }

    // Return ONLY the explicitly formatted summary — NEVER the raw `profile` object.
    // Returning raw profile leaks any future-added nested fields (e.g. private_notes,
    // knownFacts, contacts PII) downstream. Scoped `summary` contains just what the
    // message body already showed the user.
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: {
        summary: {
          name: name || null,
          location: location || null,
          email: email || null,
          phone: phone || null,
          whatsapp: (whatsapp && whatsapp !== phone) ? whatsapp : null,
          address: address || null,
          tone: tone || null,
          contactCount: Object.keys(contacts).length
        },
        message: summary
      }
    };
  }

  // FIX #5: META QUESTIONS - "what can you remember?"
  if (
    lower.includes("what can you remember") ||
    lower.includes("what do you store") ||
    lower.includes("what information do you keep")
  ) {
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: {
        message: `🧠 **Memory Capabilities:**

I can remember:
• Your name
• Your location
• Your email
• Your preferred communication tone
• Your contacts (with email/phone)

**To save information, just tell me:**
• "remember my name is [name]"
• "remember my location is [city]"
• "add [name] as a contact, email: [email]"

**To retrieve information:**
• "what do you remember about me?"
• "show my profile"
• "list my contacts"

**To forget information:**
• "forget my location"
• "delete contact [name]"`
      }
    };
  }

  // --- CONTACT LOOKUP: "what's mom's phone?", "John's email?", "what is my mom's name?" ---
  // Accepts either "mom's FIELD" or "my mom's FIELD". FIELD now includes "name".
  // Matches either possessive form ("my mom's name") OR "the NAME of my mom" phrasing.
  let contactLookupMatch = lower.match(
    /(?:what(?:'s| is)|who(?:'s| is))?\s*(?:my\s+)?([\w\u0590-\u05FF]+?)[''\u2019]?s\s+(name|phone|email|address|number|contact|birthday)/i
  );
  if (!contactLookupMatch) {
    const ofMatch = lower.match(
      /what(?:'s| is)\s+the\s+(name|phone|email|address|number|birthday)\s+of\s+(?:my\s+)?([\w\u0590-\u05FF]+)/i
    );
    if (ofMatch) {
      // Rebuild as [full, contactName, queryField] to match downstream destructure
      contactLookupMatch = [ofMatch[0], ofMatch[2], ofMatch[1]];
    }
  }
  if (contactLookupMatch) {
    const [, contactName, queryField] = contactLookupMatch;
    const memory = await getMemory();
    const contacts = memory.profile?.contacts || {};
    // Look up by contact key, name, OR relation ("mom" → contact with relation: "mother")
    const relationAliases = {
      mom: "mother", mum: "mother", mama: "mother", mother: "mother",
      dad: "father", papa: "father", father: "father",
      sis: "sister", sister: "sister",
      bro: "brother", brother: "brother",
      wife: "wife", husband: "husband"
    };
    const canonRelation = relationAliases[contactName.toLowerCase()];
    const needle = contactName.toLowerCase();
    const contactKey = Object.keys(contacts).find(k => {
      const c = contacts[k];
      const byKey = k.toLowerCase() === needle;
      const byName = c?.name?.toLowerCase() === needle;
      const byRelation = canonRelation && c?.relation?.toLowerCase() === canonRelation;
      // Aliases: stored contacts often have aliases like ["mother", "mama"] on the
      // "mom" contact. Match if the query term OR its canonical relation appears in aliases.
      const aliasList = Array.isArray(c?.aliases) ? c.aliases.map(a => String(a).toLowerCase()) : [];
      const byAlias = aliasList.includes(needle) || (canonRelation && aliasList.includes(canonRelation));
      return byKey || byName || byRelation || byAlias;
    });
    if (contactKey) {
      const contact = contacts[contactKey];
      const lookupField = (queryField === "number") ? "phone" : queryField;
      // Name query that matched by relation/alias → "Your {relation} is {name}"
      // instead of the echoey "{name}'s name: {name}".
      if (lookupField === "name") {
        const matchedByRelationOrAlias = canonRelation && (
          contact?.relation?.toLowerCase() === canonRelation ||
          (Array.isArray(contact?.aliases) && contact.aliases.map(a => String(a).toLowerCase()).includes(canonRelation))
        );
        if (matchedByRelationOrAlias) {
          return {
            tool: "memorytool",
            success: true,
            final: true,
            data: { message: `Your ${canonRelation} is ${contact.name || contactKey}.` }
          };
        }
        return {
          tool: "memorytool",
          success: true,
          final: true,
          data: { message: `Their name is ${contact.name || contactKey}.` }
        };
      }
      const val = lookupField === "contact"
        ? JSON.stringify(contact)
        : (contact[lookupField] || contact[`${lookupField}He`] || "not saved");
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `${contact.name || contactKey}'s ${lookupField}: ${val}` }
      };
    }
    // Contact not in memory.profile.contacts — try userProfiles registry (family/friends
    // from data/user-profiles.json, keyed by phone number).
    try {
      const { getAllProfiles } = await import("../utils/userProfiles.js");
      const profiles = await getAllProfiles();
      const canon = canonRelation || contactName.toLowerCase();
      for (const [phone, prof] of Object.entries(profiles)) {
        if (phone.startsWith("_")) continue;
        const relMatch = prof.relation?.toLowerCase() === canon;
        const nameMatch = prof.name?.toLowerCase() === contactName.toLowerCase();
        if (relMatch || nameMatch) {
          const field = (queryField === "number") ? "phone" : queryField;
          // For NAME queries that matched via relation, phrase as "Your {relation} is {name}"
          // instead of the awkward "{name}'s name: {name}" echo.
          if (field === "name") {
            if (relMatch && !nameMatch) {
              return {
                tool: "memorytool",
                success: true,
                final: true,
                data: { message: `Your ${canon} is ${prof.name}.` }
              };
            }
            return {
              tool: "memorytool",
              success: true,
              final: true,
              data: { message: `Their name is ${prof.name}.` }
            };
          }
          const val = field === "phone" ? phone : (prof[field] || "not saved");
          return {
            tool: "memorytool",
            success: true,
            final: true,
            data: { message: `${prof.name || contactName}'s ${field}: ${val}` }
          };
        }
      }
    } catch { /* userProfiles not available */ }

    // Last resort: scan profile.knownFacts[] (structured, higher quality) + durable[]
    // (raw) for mentions of the keyword. knownFacts are scanned FIRST.
    const keyword = contactName.toLowerCase();

    // Helper: try to extract a name from "... named X", "X is <keyword>", etc.
    // Returns a clean attribution string or null.
    const extractNamedAnswer = (stmt) => {
      if (queryField !== "name") return null;
      // "The user has a dog named Lanou." → "Lanou"
      const m1 = stmt.match(new RegExp(`${keyword}\\s+(?:named|called)\\s+([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)?)`, "i"));
      if (m1) return `Your ${keyword}'s name is ${m1[1]}.`;
      // "<Name>'s name is <Subject>" doesn't match here; covers "my dog, Lanou" style
      const m2 = stmt.match(new RegExp(`${keyword}[,:]\\s+([A-Z][\\w'-]+)`, "i"));
      if (m2) return `Your ${keyword}'s name is ${m2[1]}.`;
      return null;
    };

    const structuredHits = [];
    for (const f of (memory.profile?.knownFacts || [])) {
      if (f?.status === "retired") continue; // skip superseded facts
      const stmt = typeof f === "string" ? f : (f?.statement || f?.fact);
      if (stmt && stmt.toLowerCase().includes(keyword)) structuredHits.push(stmt);
    }

    // Prefer a structured "named X" extraction from knownFacts first.
    for (const stmt of structuredHits) {
      const answer = extractNamedAnswer(stmt);
      if (answer) {
        return {
          tool: "memorytool",
          success: true,
          final: true,
          data: { message: answer }
        };
      }
    }

    const rawHits = [];
    for (const d of (memory.durable || [])) {
      const fact = typeof d === "string" ? d : d?.fact;
      if (fact && fact.toLowerCase().includes(keyword)) rawHits.push(fact);
    }

    const combinedHits = [...structuredHits, ...rawHits];
    if (combinedHits.length > 0) {
      const top = combinedHits.slice(0, 3).map(h => `• ${h}`).join("\n");
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `I don't have "${contactName}" as a contact, but here's what I remember related to "${contactName}":\n${top}` }
      };
    }
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: `I don't have a contact named "${contactName}" saved.` }
    };
  }

  // --- SELF LOOKUP: "what is my name?", "what's my email?" ---
  // Questions about the owner themselves. Profile stores these directly.
  const selfLookupMatch = lower.match(
    /(?:what(?:'s| is)|where(?:'s| is))\s+my\s+(name|email|e-mail|location|city|phone|number|tone|whatsapp|address|birthday)/i
  );
  if (selfLookupMatch) {
    const field = selfLookupMatch[1].toLowerCase() === "e-mail" ? "email"
      : selfLookupMatch[1].toLowerCase() === "city" ? "location"
      : selfLookupMatch[1].toLowerCase() === "number" ? "phone"
      : selfLookupMatch[1].toLowerCase();
    const memory = await getMemory();
    const profile = memory.profile || {};
    const self = profile.self || {};
    const val = profile[field] || self[field];
    if (val) {
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `Your ${field} is: ${val}` }
      };
    }
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: `I don't have your ${field} saved yet. You can tell me by saying "remember my ${field} is <value>".` }
    };
  }

// --- GENERIC "FORGET THAT ..." ---
  // Deletes arbitrary facts from durable memory or structured known facts
  const genericForget = lower.match(/(?:forget|remove|delete)\s+(?:that\s+)?(.{5,})$/i);
  if (genericForget && !lower.includes("location")) {
    const targetFact = genericForget[1].trim().replace(/[.!]+$/, '');
    const memory = await getMemory();
    let removed = false;

    // 1. Try removing from durable memories
    if (memory.durable && Array.isArray(memory.durable)) {
      const initialLength = memory.durable.length;
      memory.durable = memory.durable.filter(d => !d.fact.toLowerCase().includes(targetFact));
      if (memory.durable.length < initialLength) removed = true;
    }

    // 2. Try removing from structured knownFacts
    if (memory.profile?.knownFacts && Array.isArray(memory.profile.knownFacts)) {
      const initialLength = memory.profile.knownFacts.length;
      memory.profile.knownFacts = memory.profile.knownFacts.filter(f => !f.statement.toLowerCase().includes(targetFact));
      if (memory.profile.knownFacts.length < initialLength) removed = true;
    }

    if (removed) {
      await saveJSON(MEMORY_FILE, memory);
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `I have successfully removed "${targetFact}" from my memory.` }
      };
    } else {
       return {
        tool: "memorytool",
        success: false,
        final: true,
        error: `I couldn't find any memory matching "${targetFact}" to forget.`
      };
    }
  }

  // --- GENERIC "REMEMBER THAT ..." ---
  // Save arbitrary facts to durable memory
  const genericRemember = text.match(/(?:remember|save|note|store)\s+(?:that\s+)?(.{5,})$/i);
  if (genericRemember) {
    const fact = genericRemember[1].trim().replace(/[.!]+$/, '');
    const memory = await getMemory();
    if (!memory.durable) memory.durable = [];
    memory.durable.push({
      fact,
      savedAt: new Date().toISOString()
    });
    await saveJSON(MEMORY_FILE, memory);
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: `I'll remember: "${fact}"` }
    };
  }

  // --- FALLBACK: keyword scan over durable + knownFacts for natural-language
  // "do you remember / what about / tell me about my <X>" queries.
  const scanMatch = lower.match(
    /(?:what(?:'s| is|\s+about)|who(?:'s| is)|do\s+you\s+(?:remember|know|recall)|tell\s+me\s+about)\s+(?:my\s+)?([\w\u0590-\u05FF][\w\u0590-\u05FF\s'’-]{1,40})/i
  );
  if (scanMatch) {
    const keyword = scanMatch[1].trim().toLowerCase().replace(/[?.!]+$/, "");
    // Strip trailing filler words to isolate the subject
    const stopTail = /\b(name|phone|email|address|birthday|please|anyway)$/i;
    const core = keyword.replace(stopTail, "").trim();
    if (core.length >= 2) {
      const memory = await getMemory();
      const hits = [];
      for (const d of (memory.durable || [])) {
        const fact = typeof d === "string" ? d : d?.fact;
        if (fact && fact.toLowerCase().includes(core)) hits.push(fact);
      }
      for (const f of (memory.profile?.knownFacts || [])) {
        const stmt = typeof f === "string" ? f : (f?.statement || f?.fact);
        if (stmt && stmt.toLowerCase().includes(core)) hits.push(stmt);
      }
      if (hits.length > 0) {
        const top = hits.slice(0, 5).map(h => `• ${h}`).join("\n");
        return {
          tool: "memorytool",
          success: true,
          final: true,
          data: { message: `Here's what I remember related to "${core}":\n${top}` }
        };
      }
    }
  }

  return {
    tool: "memorytool",
    success: false,
    final: true,
    error: "Memory request not understood.\n\nTry:\n• 'what do you remember about me?'\n• 'remember my name is John'\n• 'remember my location is Paris'\n• 'forget my location'"
  };
}

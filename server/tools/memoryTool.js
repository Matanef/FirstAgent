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

    if (Object.keys(profile).length === 0) {
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
    if (profile.name) summary += `• **Name:** ${profile.name}\n`;
    if (profile.location) summary += `• **Location:** ${profile.location}\n`;
    if (profile.email) summary += `• **Email:** ${profile.email}\n`;
    if (profile.phone) summary += `• **Phone:** ${profile.phone}\n`;
    if (profile.address) summary += `• **Address:** ${profile.address}\n`;
    if (profile.tone) summary += `• **Preferred tone:** ${profile.tone}\n`;

    // Include contacts if any
    if (profile.contacts && Object.keys(profile.contacts).length > 0) {
      summary += `\n**Contacts saved:** ${Object.keys(profile.contacts).length}\n`;
      const contactList = Object.entries(profile.contacts)
        .slice(0, 5)
        .map(([key, c]) => `• ${c.name}: ${c.email || c.phone || 'No details'}`)
        .join('\n');
      summary += contactList;
      if (Object.keys(profile.contacts).length > 5) {
        summary += `\n• ... and ${Object.keys(profile.contacts).length - 5} more`;
      }
    }

    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: {
        profile,
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

  // --- CONTACT LOOKUP: "what's mom's phone?", "John's email?" ---
  const contactLookupMatch = lower.match(/(?:what(?:'s| is))?\s*(\w+?)[''\u2019]?s?\s+(phone|email|address|number|contact)/i);
  if (contactLookupMatch) {
    const [, contactName, queryField] = contactLookupMatch;
    const memory = await getMemory();
    const contacts = memory.profile?.contacts || {};
    const contactKey = Object.keys(contacts).find(
      k => k.toLowerCase() === contactName.toLowerCase() ||
           contacts[k]?.name?.toLowerCase() === contactName.toLowerCase()
    );
    if (contactKey) {
      const contact = contacts[contactKey];
      const lookupField = (queryField === "number") ? "phone" : queryField;
      const val = lookupField === "contact" ? JSON.stringify(contact) : (contact[lookupField] || "not saved");
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `${contact.name || contactKey}'s ${lookupField}: ${val}` }
      };
    }
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: `I don't have a contact named "${contactName}" saved.` }
    };
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

  return {
    tool: "memorytool",
    success: false,
    final: true,
    error: "Memory request not understood.\n\nTry:\n• 'what do you remember about me?'\n• 'remember my name is John'\n• 'remember my location is Paris'\n• 'forget my location'"
  };
}
